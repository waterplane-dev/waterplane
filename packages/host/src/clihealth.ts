/**
 * The CLI integration's own health, host-side: the file it is kept in, the ten
 * places the daemon feeds it, and the one alert that makes a degrading
 * heuristic loud.
 *
 * The rule half lives in `@waterplane/shared`'s `clihealth.ts` — the catalog, the
 * rolling window, the verdict, the redaction and the sentence — pure, unit-
 * pinned, and shared with the phone so a badge and a notification cannot word
 * the same fact two ways. This half owns the three things a pure rule cannot:
 * the JSON on disk, the clock, and the broadcast.
 *
 * Three properties of the shape are load-bearing, and each is here because the
 * obvious version of it is worse:
 *
 *   • **Module-level singleton plus a free `noteHealth()`.** The same argument
 *     `sentlog.ts` and `opendeliveries.ts` make: the observation points are ten
 *     files deep in the delivery path, the prompt detector and the transcript
 *     reader, and threading a handle through all of them means call site eleven
 *     forgets. Unset — a unit import, a test that constructs a manager without
 *     booting a daemon — is a silent no-op, so nothing here can ever be the
 *     reason something else fails to run.
 *   • **Debounced writes, debounced broadcast.** `observe()` is called from a
 *     delivery and from a prompt check; a file write or a socket frame per
 *     observation would make the measurement the cost of the thing measured,
 *     which is exactly the failure `nettraffic.ts` names about itself. The
 *     persist is flushed on SIGTERM beside `acks.flush()`.
 *   • **Notify on a verdict TRANSITION, never on an observation.** A signal
 *     sitting at `broken` is one fact, not one fact per miss. The last verdict
 *     per signal is seeded from what came off disk, so a restart does not
 *     re-announce a state the user was already told about.
 *
 * On the samples: a `line` capture is TUI chrome the CLI drew — a dialog
 * footer, a meter row, a block notice — kept as text because "this line no
 * longer matches" is only actionable with the line in hand. `observe()` applies
 * the redaction itself, per signal, so a call site cannot leak prose into a
 * record that was declared to hold none. One of those samples is captured
 * BLOCK-NOTICE text, and it has exactly one rule attached: it may reach disk,
 * the wire and the phone, and it must never be routed back into a PTY — printed
 * on a claude screen it would false-positive the very detector it documents.
 * Nothing in this file writes to a session, and nothing downstream may make it
 * do so.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { 
  clearSeen, cleanHealth, emptyHealth, healthRollup, healthSentence, noteCliVersion, observe, signalSpec, signalVerdict,
  type CliHealth, type CliSignalId, type HealthOutcome, type HealthRollup, type HealthVerdict } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { FixtureShelf, type FixtureSource } from "./clifixtures.js";

/** What a call site may hand an observation. `fixture` is asked only on a
 *  `good`, and only while no capture of this signal on this CLI version is
 *  kept (`clifixtures.ts`). */
export interface HealthOpts { raw?: string; via?: string; fixture?: FixtureSource }

/**
 * How long a write waits for its neighbours.
 *
 * A fan-out records a delivery verdict per repo inside a second or two, and a
 * screen-reading signal can fire twice in a row while a box is drawn and
 * answered. Two seconds coalesces every one of those into a single rename;
 * losing the last two seconds of health history to a hard kill costs nothing
 * anybody can act on.
 */
const PERSIST_DEBOUNCE_MS = 2_000;
/**
 * …and how long the broadcast waits.
 *
 * Longer than the persist on purpose. A health record must not become a frame
 * source on the link this app spends its life apologising for: nothing on the
 * phone is time-critical here (a signal that went bad five seconds ago is
 * equally bad now), and the alert path — which IS time-critical — does not go
 * through this at all.
 */
const CHANGE_DEBOUNCE_MS = 5_000;

/** How the store reaches the user. `main.ts` hands it `notify()`, so a health
 *  alert obeys the notification-kind gate like every other alert. */
export type HealthAlert = (
  kind: "cli" | "info",
  p: { title: string; body: string; tag: string },
) => void;

export class CliHealthStore {
  private path: string;
  private health: CliHealth = emptyHealth();
  private saveTimer: NodeJS.Timeout | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  /**
   * The verdict each signal was last KNOWN to hold — the thing a transition is
   * measured against.
   *
   * Seeded from the record that came off disk rather than left empty, because
   * an empty map makes the first observation after every restart look like a
   * transition. `npm run restart` is routine in this project, so that version
   * would announce a week-old `broken` every time the daemon came up, which is
   * the notification nobody reads.
   */
  private lastVerdict = new Map<string, HealthVerdict>();
  private shelf: FixtureShelf;

  constructor(
    root: string,
    private onChange: (health: CliHealth, rollup: HealthRollup) => void,
    private alert: HealthAlert,
  ) {
    this.path = join(hostStateDir(root), "clihealth.json");
    this.shelf = new FixtureShelf(join(hostStateDir(root), "clifixtures"));
    try {
      if (existsSync(this.path)) this.health = cleanHealth(readJsonGuarded<any>(this.path, null));
    } catch {
      // Corrupt or unreadable ⇒ start empty, which reads `unknown` everywhere.
      // The alternative is a boot that throws inside a readout whose whole job
      // is to be the reliable thing on the screen.
      this.health = emptyHealth();
    }
    const now = Date.now();
    for (const [id, sig] of Object.entries(this.health.signals)) {
      this.lastVerdict.set(id, signalVerdict(sig, now).verdict);
    }
  }

  get(): CliHealth { return this.health; }

  rollup(now = Date.now()): HealthRollup { return healthRollup(this.health, now); }

  /**
   * Record one observation, and say something if it changed the verdict.
   *
   * Every caller of this is EDGE-TRIGGERED — a box became published, a session
   * became hooked, a block began, a delivery finished. That rule lives at the
   * call sites rather than here on purpose: this function cannot tell a
   * transition from a poll, and a `good` recorded twice a second by a detector
   * that runs twice a second would fill the twenty-slot window with successes
   * in ten seconds and make the misses mathematically invisible. Which is the
   * precise failure the feature exists to prevent.
   */
  observe(id: CliSignalId, outcome: HealthOutcome, opts: HealthOpts = {}): void {
    const now = Date.now();
    const { fixture, ...rest } = opts;
    const sig = observe(this.health, id, outcome, { at: now, ...rest });
    if (outcome === "good" && fixture) this.shelf.offer(id, this.health.version, fixture);
    this.schedulePersist();
    this.scheduleChange();

    const verdict = signalVerdict(sig, now).verdict;
    const was = this.lastVerdict.get(id);
    this.lastVerdict.set(id, verdict);
    if (verdict === was) return;
    // Into trouble only. Recovering is worth a broadcast (the badge clears) and
    // is not worth a buzz: nobody needs waking to be told a thing works.
    if (verdict !== "degraded" && verdict !== "broken") return;
    this.alert("cli", {
      title: `Claude CLI: ${signalSpec(id).name.toLowerCase()}`,
      body: healthSentence(sig, now),
      // Per signal, so two signals failing say two things and one signal
      // failing twice replaces its own row rather than stacking.
      tag: `clihealth-${id}`,
    });
  }

  /** Is a fixture of this signal still wanted on the installed CLI? (`clifixtures.ts`) */
  wantsFixture(id: CliSignalId): boolean { return this.shelf.wants(id, this.health.version); }

  /**
   * Tell the record which `claude` is installed — driven by `update.ts`'s
   * existing `claude --version` reading.
   *
   * A null or empty reading is IGNORED rather than recorded. `UpdateInfo.current`
   * is absent until the first `brew`/version probe answers and can go absent
   * again on a failed one, and `noteCliVersion` treats any difference as a
   * change: passing the gap through would re-arm every heuristic — wiping the
   * history this whole file exists to keep — because a subprocess did not
   * answer. A version we could not read is not a version change.
   */
  noteVersion(version: string | null | undefined): void {
    if (!version) return;
    const now = Date.now();
    const { changed, from } = noteCliVersion(this.health, version, now);
    this.schedulePersist();
    this.scheduleChange();
    if (!changed) return;
    for (const id of this.lastVerdict.keys()) this.lastVerdict.set(id, "unknown");
    // Said ONCE, before the readout goes grey, because it is the most likely
    // explanation for whatever the readout says next — and working that out
    // afterwards from ten signals that all went unknown in the same minute is
    // strictly harder than being told.
    this.alert("info", {
      title: "Claude CLI updated",
      body: `claude is now ${version}${from ? ` (was ${from})` : ""}. Every screen-reading heuristic has been re-armed: each one reads “not checked yet” until it has been seen to work against this build.`,
      tag: "clihealth-version",
    });
  }

  /**
   * A person cleared the warnings they read: per signal, the newest miss their
   * board showed (`clearSeen`). Unknown ids and non-numbers are ignored.
   *
   * The verdict it leaves is the new baseline for `lastVerdict`, so the next
   * miss that tips a signal back into trouble alerts again — that is the way
   * back, and it needs no button.
   */
  clear(through: Record<string, number>): void {
    const now = Date.now();
    let touched = false;
    for (const [id, at] of Object.entries(through ?? {})) {
      const sig = this.health.signals[id];
      if (!sig || typeof at !== "number" || !Number.isFinite(at)) continue;
      const next = clearSeen(sig, Math.min(at, now));
      this.health.signals[id] = next;
      this.lastVerdict.set(id, signalVerdict(next, now).verdict);
      touched = true;
    }
    if (!touched) return;
    this.schedulePersist();
    this.scheduleChange();
  }

  /** Write now — SIGTERM, beside the other flushes. */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.persist();
  }

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persist(); }, PERSIST_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  private scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      try { this.onChange(this.health, this.rollup()); } catch { /* a broadcast that threw is not worth a delivery */ }
    }, CHANGE_DEBOUNCE_MS);
    if (typeof this.changeTimer.unref === "function") this.changeTimer.unref();
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, this.health, { space: 2 });
    } catch { /* best-effort — the in-memory record still answers for this boot */ }
  }
}

/**
 * Module-level singleton, set once at boot by `main.ts`.
 *
 * See the note at the top: the observation points are spread across the prompt
 * detector, the delivery path, the transcript reader and the limit scheduler,
 * and a handle threaded through all of them is a handle the eleventh call site
 * omits. A forgotten one here is a heuristic that quietly stops being watched,
 * which is the same shape as the bug this feature is about.
 */
let current: CliHealthStore | null = null;
export function setCliHealth(store: CliHealthStore | null): void { current = store; }
export function cliHealth(): CliHealthStore | null { return current; }

/**
 * Record one observation against a signal, or do nothing if no store is
 * installed.
 *
 * **Call this on a state TRANSITION, never from inside a polling body.** Every
 * call site in this repo is one, and the comment above each says which
 * transition it is. See `CliHealthStore.observe`.
 */
export function noteHealth(
  id: CliSignalId,
  outcome: HealthOutcome,
  opts: HealthOpts = {},
): void {
  current?.observe(id, outcome, opts);
}

/** Whether a `fixture` passed with the next `good` of this signal would be
 *  kept — false with no store. Lets a call site read an input that will not
 *  last (the composer) only when it is wanted, once per CLI version. */
export function fixtureWanted(id: CliSignalId): boolean {
  return current?.wantsFixture(id) ?? false;
}
