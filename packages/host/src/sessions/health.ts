/**
 * The health record's gate for sessions (package S3 of the split,
 * docs/notes/host-architecture.md): `noteFor` is the ONE place under
 * `sessions/` that calls `noteHealth` directly, so a backend out of the
 * record's scope (`healthScope: false`) files nothing. The edge-triggered
 * context-meter and conversation-log observations sit beside it.
 *
 * Stateless: the "what was last said" fields live on the `Session` record.
 */
import type { CliSignalId, HealthOutcome } from "@waterplane/shared";
import { noteHealth, type HealthOpts } from "../clihealth.js";
import type { FixtureSource } from "../clifixtures.js";
import { contextMeterRow } from "../context.js";
import type { Session, SessionCore } from "./core.js";
import { HEALTH_SPAWN_GRACE_MS } from "./knobs.js";

/**
 * May the health record hear about this session at all?
 *
 * The same question `noteFor` asks itself, asked from OUTSIDE — because
 * `deliver.ts` files health observations too (`deliver.echo`, `deliver.submit`,
 * `slash.local`) and had no gate on them. Every confirmed delivery into an
 * opencode session recorded a `deliver.submit fallback` (opencode is never
 * hooked, so the submit proof is always press-and-look) and a missed echo
 * recorded a `deliver.echo miss` — rows about a backend those rules were never
 * written for, on a board whose whole purpose is measuring how well this app's
 * readers track the claude TUI. That is exactly what `healthScope` exists to
 * prevent, and the delivery path was the half it did not reach.
 *
 * Asked of the SESSION rather than passed down from each caller on purpose:
 * `deliverPrompt` is reached from the compose bar (`server/deliveries.ts`), the backlog,
 * the fan-out, chains, the sweep's re-delivery and the limit scheduler, and
 * the repo's own rule about this — `clihealth.ts`'s reason for being a
 * singleton, and `noteFor`'s for being a helper — is that call site eleven
 * forgets. A delivery already holds the session id; it does not need to be
 * told a second time which backend that id is running.
 *
 * **Unknown id ⇒ TRUE**, which is today's behaviour unchanged: `noteHealth`
 * fires for a session this manager has never heard of, and a delivery into one
 * bails long before it could file anything anyway. Narrowing that here would
 * be a behaviour change smuggled in beside a data plumb.
 */
export function healthScope(core: SessionCore, id: string): boolean {
  const s = core.sessions.get(id);
  return s ? s.backend.healthScope : true;
}

/**
 * File one health observation ABOUT A SESSION — or file nothing, when the
 * session's backend is out of the health record's scope.
 *
 * Every `noteHealth` call in this file goes through here, and that is the
 * point: the record measures how well THIS APP's readers track the claude TUI,
 * so a session on a backend those readers were never written for must record
 * neither a miss nor a `good`. Not a miss, because the rule was never the
 * right rule and correctly declined to fire — the "was this the right rule"
 * mistake `shared/clihealth.ts` names, and the one that teaches the person
 * reading the board to stop reading it. Not a `good` either, because nothing
 * was seen to WORK: a success per non-event would fill the twenty-slot window
 * and make the real misses arithmetically invisible.
 *
 * A helper rather than a guard repeated at ten call sites, for the reason
 * `clihealth.ts` gives for its own singleton: call site eleven forgets.
 */
export function noteFor(s: Session | null | undefined, id: CliSignalId, outcome: HealthOutcome, opts: HealthOpts = {}): void {
  if (!s?.backend.healthScope) return;
  noteHealth(id, outcome, opts);
}

/**
 * Whether the context meter can still be read — recorded on the TRANSITION,
 * never on the scan.
 *
 * Two gates, and both are the difference between a signal and a drip. The
 * first is `contextMeterRow`: a session that simply is not printing a context
 * indicator proves nothing about the parse, so it records nothing at all
 * rather than a miss per scan. The second is the stored last answer: the scan
 * runs on every idle tick, so a session that has been showing its meter all
 * afternoon would otherwise contribute twenty successes an hour and drown
 * every other signal's misses out of a shared window.
 */
export function noteContextHealth(s: Session, cleaned: string, pct: number | null): void {
  const row = contextMeterRow(cleaned);
  if (!row) return;                     // nothing to read — not an observation
  const outcome = pct != null ? "good" : "miss";
  if (s.ctxHealth === outcome) return;  // already said; a state, not an event
  s.ctxHealth = outcome;
  noteFor(s, "context.meter", outcome, outcome === "miss" ? { raw: row } : { fixture: () => cleaned });
}

/**
 * Whether the CLI's conversation log can still be read — on the TRANSITION.
 *
 * `getTranscript` is polled: by the reader view, by the phone's offline
 * sweep, and by `settle.ts` for every ambiguous delivery in a queue. Recording
 * per call would put hundreds of successes a minute into a twenty-slot window
 * that nine other signals share, which is the arithmetic that hides a miss.
 * So this stores the last answer per session and speaks only when it changes:
 * one observation when a session's log starts parsing, one when it stops.
 *
 * Two gates on top. A CLOSED session is skipped (no `Session`, so nowhere to
 * hang the edge — and its log is a historical artifact, not a live check), and
 * a session inside its spawn grace is skipped because the CLI writes the log
 * when it accepts the first prompt: a reader opened on a two-second-old
 * session would otherwise record a fallback for every session ever created.
 */
export function noteLogHealth(s: Session | null, outcome: "good" | "miss" | "fallback" | null, raw: string, fixture?: FixtureSource): void {
  if (!s || outcome == null) return;
  if (Date.now() - s.spawnedAt < HEALTH_SPAWN_GRACE_MS) return;
  if (s.logHealth === outcome) return;
  s.logHealth = outcome;
  noteFor(s, "transcript.jsonl", outcome, {
    ...(outcome === "fallback" ? { via: "our own record of what we typed" } : {}),
    raw,
    ...(fixture ? { fixture } : {}),
  });
}
