// Cut from schedule.ts (move only): actions, results and entries
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import type { LaunchOpts } from "../index.js";
import type { SessionBudget } from "../sessionbudget.js";
import type { ScheduleRule } from "./schedrule.js";

/**
 * Hard bound on a chain's turns — `ScheduleAction.backlog.steps` here and
 * `IntentPayload.steps` downstream, which are the same list at two ages.
 *
 * It lives in THIS file, the leaf, and `intent.ts` re-exports it under its own
 * name (`INTENT_MAX_STEPS`): the dependency runs one way, so the constant has
 * to live at the bottom of it or be spelled twice. It was spelled twice — a
 * bare `40` in `cleanAction` under a comment explaining why — and a cap with
 * two homes is a cap that drifts the first time one of them is raised.
 */
export const INTENT_MAX_STEPS = 40;

/** What a schedule does when it fires. */
export type ScheduleAction =
  /** One prompt into a FRESH session per repo — the maintenance sweep. */
  | { kind: "fanout"; dirs: string[]; text: string; launch?: LaunchOpts; budget?: SessionBudget | null }
  /** Queue an item in a repo's backlog (auto-firing by default: the user asked
   *  for this at a specific time, so waiting for a manual tap defeats it).
   *
   *  `steps` is the WHOLE chain and `steps[0]` repeats `text` — the same
   *  contract `backlog.add` uses, so one rule covers both and a reader of
   *  either does not have to remember which one repeats its head. It exists
   *  because a scheduled chain had nowhere on the wire to sit: `text` alone
   *  meant `dispatchIntent` dropped turns 2..n and had to SAY it was dropping
   *  them. Absent ⇒ `[text]`, which is what every stored rule written before
   *  this field means. */
  | { kind: "backlog"; repoDir: string; text: string; label?: string; autoFire?: boolean; steps?: string[];
    /** The item's own close-when-done override (`Intent.closeWhenDone`);
     *  absent follows the global setting. Carried both ways by `adapters.ts`
     *  so renaming a rule cannot drop it. */
    closeWhenDone?: boolean;
    /** "Flag for follow up when done" for the item each firing adds (`Intent.flagWhenDone`). */
    flagWhenDone?: boolean;
    /** The budget the session this item opens is born with (`Intent.budget`).
     *  `null` CLEARS a stored one on a re-save (`schedule.save` upserts, and
     *  absent there keeps the old cap — `actionBudget`). */
    budget?: SessionBudget | null;
    /** The model/effort/backend each occurrence's session starts with
     *  (`Intent.launch`); absent is the desktop's new-session defaults —
     *  the fan-out arm's rule, so an edit that omits it clears it. */
    launch?: LaunchOpts }
  /** Run one configured build command (`BuildConfig.id` in `repoDir`'s
   *  builds) — each occurrence posts ONE ordinary build run, stamped with
   *  this rule's origin (`scheduleItemOrigin`). There is NO `text`: a build
   *  has no prose, so a reader wanting a line for any action asks
   *  `scheduleActionText`. `params` are the values picked on the schedule
   *  form; a parameter with neither a value here nor a stored default makes
   *  the occurrence FAIL in words, never guess. */
  | { kind: "build"; repoDir: string; buildId: string; params?: Record<string, string> };

/**
 * The one line an action is about, for any arm — the prompt for a sweep or a
 * work item, "run build <id>" for a build. Every reader that used to say
 * `action.text` and may now meet a build asks this instead, so a build rule
 * never renders as an empty card or a crash on `.split`.
 */
export function scheduleActionText(action: ScheduleAction): string {
  return action.kind === "build" ? `run build ${action.buildId}` : action.text;
}

/** Which repos an action touches: a sweep's dirs, else its one repo. */
export function scheduleActionDirs(action: ScheduleAction): string[] {
  return action.kind === "fanout" ? action.dirs : [action.repoDir];
}

/**
 * **The schedules that run a given build** — the Build sheet's cue and the cut
 * it opens are the SAME list (a count is a filter): one predicate, here, so the
 * number on the entry and the rules the tap shows cannot disagree.
 * Order is the input's. Matches on the exact `repoDir` and `buildId`.
 */
export function schedulesForBuild<E extends Pick<ScheduleEntry, "action">>(entries: readonly E[], repoDir: string, buildId: string): E[] {
  return entries.filter((e) => e.action.kind === "build" && e.action.repoDir === repoDir && e.action.buildId === buildId);
}

/** Outcome of the last time a schedule fired — the row's honesty budget. */
export interface ScheduleResult {
  at: number;
  ok: boolean;
  /** One line: what ran, or why it didn't. */
  detail: string;
  /** The occurrence this was (the scheduled instant, which may be < `at`). */
  occurrence?: number;
  /** Ran late after a missed window (host asleep) rather than on time. */
  late?: boolean;
  /** The work item this fire created (a `backlog` action creates one and
   *  finishes). See `IntentResult.childId` — it is what makes the row's own
   *  "open the session this ran in" possible at all. */
  childId?: string;
}

/** A stored schedule. Persisted host-side in `<STATE_DIR>/schedules.json`. */
export interface ScheduleEntry {
  id: string;
  /** User-facing name ("weekly security sweep"). Falls back to the prompt. */
  name: string;
  enabled: boolean;
  rule: ScheduleRule;
  action: ScheduleAction;
  createdAt: number;
  /** Next fire instant, epoch ms — computed by the host, null when nothing is due
   *  (a spent `once`, or a disabled entry). Read-only for clients. */
  nextAt: number | null;
  /** The occurrence instant already fired, so a tick that runs twice, a restart
   *  mid-fire, or a clock nudge can't run the same sweep again. */
  lastOccurrence?: number;
  lastResult?: ScheduleResult;
  /** How late a missed occurrence may still run (minutes). 0 = skip it. */
  graceMin: number;
  /** Keep a fired `once` in the list (disabled) instead of deleting it. */
  keepAfterRun?: boolean;
  /**
   * An ADDITION to the anchor above, not an alternative to it — ticking this
   * does not change WHEN the rule is due, it holds the fire once it is due
   * until the desktop is doing nothing else. Maps onto the intent store's
   * `serial` (this repo) and `holdForHost` (the whole host) together: a
   * schedule anchored to "right after it resets" exists in a dozen repos at
   * once and, ticked in every one of them, all become due in the same
   * instant. Without this they all fire together; with it, one at a time.
   */
  waitUntilFree?: boolean;
  /** Transient: the action is in flight right now. Stamped on by the host when
   *  it sends the list, never persisted — a restart mid-fan-out must not leave a
   *  row claiming to be running something no process is doing. */
  running?: boolean;
}
