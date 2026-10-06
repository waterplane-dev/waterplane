/**
 * A prompt sent "when it's free" to ONE session, run the way the host runs it.
 *
 * The phone's *When free* is a `backlog.add` aimed at a session (`autoFire`);
 * the host keeps it as an intent (`intents/adapters.ts` `backlogDraft`) and its
 * ladder decides, every tick, whether the session can take it — which is where
 * a session's OWN budget holds it (`sessionBudget`, above the session's walls),
 * and where a limit or a running turn makes it wait. The demo asks that same
 * ladder (`@waterplane/shared`'s `intentVerdict`) about the same facts, so the
 * row says the host's sentence and runs when the host would run it, once.
 *
 * Only rows the demo minted from a person's send are judged here (`m.runs`): a
 * scenario's seeded intents keep their scripted lives (queue-and-schedule's runs
 * on its own script), and nothing else the demo holds starts by itself.
 */
import { cleanIntentRow, intentVerdict, sessionBudgetHeld } from "@waterplane/shared";
import type { BacklogItem, Intent, IntentFacts } from "@waterplane/shared";
import { backlogFrame, findSession, sessions, submit } from "./desk.ts";
import type { Desk } from "./model.ts";

/** The twin intent of a *when it's free* item, as `backlogDraft` makes it. */
export function addWaiting(d: Desk, it: BacklogItem): void {
  if (!it.targetSessionId) return;
  const row = cleanIntentRow({
    id: it.id, cwd: it.repoDir, payload: { kind: "prompt", steps: [it.text] },
    target: { kind: "session", sessionId: it.targetSessionId }, trigger: { kind: "idle" },
    auto: true, pinned: it.autoFire || undefined, label: it.label, order: it.order,
    state: "queued", createdAt: d.now(),
  }, d.now());
  if (!row) return;
  (d.m.intents ??= []).push(row);
  (d.m.runs ??= []).push(row.id);
  d.broadcast({ t: "intent.changed", intent: row });
  tickWaiting(d);
}

function facts(d: Desk): IntentFacts {
  const live = sessions(d.m);
  const repos = (d.m.repos ?? []).map((r) => (r as { worktreePath?: string }).worktreePath).filter((p): p is string => !!p);
  return {
    present: new Set(),
    sessions: live.map((s) => ({
      id: s.id, cwd: s.cwd, running: s.running, turnStartedAt: s.turnStartedAt, turnActive: s.turnActive,
      limitBlocked: s.limit?.blocked, promptKind: s.prompt?.kind, awaitingInput: s.awaitingInput, convId: s.claudeSessionId,
    })),
    busyCwds: new Set(),
    busySessions: new Set((d.m.intents ?? []).filter((i) => i.state === "running" || i.state === "starting").map((i) => i.sessionId).filter((x): x is string => !!x)),
    budgetHeldSessions: new Set(live.filter(sessionBudgetHeld).map((s) => s.id)),
    budgetBlocked: false,
    autoFire: d.m.backlog?.auto ?? false,
    knownDirs: new Set(repos),
    hostBusy: false,
    autoSlotsFree: 1,
  };
}

const item = (d: Desk, id: string) => (d.m.backlog?.items ?? []).find((x) => x.id === id);

/** Re-judge every row the demo runs; start the ones the ladder lets go. */
export function tickWaiting(d: Desk): void {
  const mine = new Set(d.m.runs ?? []);
  if (!mine.size) return;
  for (const i of d.m.intents ?? []) {
    if (!mine.has(i.id)) continue;
    if (i.state === "running") { settle(d, i); continue; }
    if (i.state !== "queued" && i.state !== "blocked") continue;
    const v = intentVerdict(i, facts(d), d.now());
    if (v.kind === "wait") {
      if (i.state === "blocked" && i.blockReason === v.reason && i.blockDetail === v.detail) continue;
      Object.assign(i, { state: "blocked", blockReason: v.reason, blockDetail: v.detail });
      d.broadcast({ t: "intent.changed", intent: i });
      continue;
    }
    if (v.kind === "fail") continue;
    const sid = v.sessionId ?? (i.target.kind === "session" ? i.target.sessionId : undefined);
    const s = sid ? findSession(d.m, sid) : undefined;
    if (!s || i.payload.kind !== "prompt") continue;
    const now = d.now();
    Object.assign(i, { state: "running", startedAt: now, sessionId: s.id } satisfies Partial<Intent>);
    delete i.blockReason;
    delete i.blockDetail;
    d.broadcast({ t: "intent.changed", intent: i });
    const b = item(d, i.id);
    if (b) { Object.assign(b, { status: "running", sessionId: s.id, startedAt: now }); d.broadcast(backlogFrame(d.m)); }
    submit(d, s.id, i.payload.steps[0]);
  }
}

/** A running row is done when its turn is: the session is quiet and NOT parked
 *  at a usage wall — a turn stopped by the wall is one the reset continues. */
function settle(d: Desk, i: Intent): void {
  const s = i.sessionId ? findSession(d.m, i.sessionId) : undefined;
  if (s && (s.turnActive || s.limit?.blocked)) return;
  const now = d.now();
  Object.assign(i, { state: "done", settledAt: now, result: { at: now, ok: true, detail: `ran in ${s?.tabTitle ?? s?.title ?? "the session"}` } });
  d.broadcast({ t: "intent.changed", intent: i });
}
