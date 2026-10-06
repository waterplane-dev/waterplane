/**
 * What the ladder READS (`IntentFacts`, `IntentSettlement`,
 * `busyIntentGroups`) and what it ANSWERS (`IntentVerdict`).
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { BudgetCeiling } from "../budget.js";
import type { SerialHolder, SerialSessionState } from "../queue.js";
import { serialHolders } from "../queue.js";
import type { BlockReason } from "./types.js";

// ── The facts the rule reads ─────────────────────────────────────────────────

/**
 * Everything `intentVerdict` is allowed to know, flattened to primitives.
 *
 * Primitives rather than live objects for the same reason `LaneSessionState`
 * and `SerialSessionState` are: this module has to stay node-runnable and
 * DOM-free so both ends and a bare `node --test` can compute the same answer.
 * The caller does the looking-up; the rule does the deciding.
 */
export interface IntentFacts {
  /** `files` trigger: which of the intent's `needs` exist under `cwd`. The
   *  caller stats exactly those paths — a test hands in a literal set. */
  present: ReadonlySet<string>;
  /** Live sessions, so `laneBusy()`'s and `autoFireBlocker()`'s ladder is
   *  computable here rather than in two places that drift. `turnActive` carries
   *  the host's own answer — exact on a hooked session, its silence guess
   *  otherwise — so the guess stays in the one place that can make it. */
  sessions: readonly SerialSessionState[];
  /**
   * **Nothing reads this any more.** Kept only so the host keeps compiling
   * while it stops building it.
   *
   * It answered "which session does a `{kind:"repo"}` target resolve to", for
   * the legacy non-`fresh` repo branch in rung 5 — and that branch is gone:
   * `cleanTarget` normalises every repo target to `fresh`, opening the session
   * IS the work, and the rung passes unconditionally before any map is
   * consulted. A required fact nobody reads still costs the host a map per
   * tick, so this is optional and deprecated rather than quietly load-bearing.
   *
   * @deprecated Stop passing it; the field goes when the host no longer does.
   */
  repoSession?: ReadonlyMap<string, string | null>;
  /** Serialization groups that are occupied — `serialGroup(cwd)` keys. Build it
   *  with `busyIntentGroups()` so both sources are counted the same way. */
  busyCwds: ReadonlySet<string>;
  /**
   * WHO holds each busy group (`intentSerialHolders`, the same inputs as `busyCwds`),
   * so the `serial` wait can name the session instead of "the session before
   * it". Optional: absent, or no entry for a group, is the generic sentence.
   * Never consulted for the DECISION — `busyCwds` alone decides.
   */
  serialHolders?: ReadonlyMap<string, readonly SerialHolder[]>;
  /**
   * Sessions an intent is already `starting`/`running` in.
   *
   * The backlog's `sessionBusy()`: one item at a time per session, so two
   * sessions in one repo still advance in parallel. It is a separate fact from
   * `sessions` because of the DELIVERY window — an intent flipped to `starting`
   * has not made its session `turnActive` yet (the TUI is sitting at its prompt
   * waiting to be typed into), and that quiet is exactly what a second intent
   * would read as "free".
   */
  busySessions?: ReadonlySet<string>;
  /** Sessions whose own budget is spent (`sessionBudgetHeld`). Absent = nobody
   *  said = none held. Only a row aimed AT a session reads it. */
  budgetHeldSessions?: ReadonlySet<string>;
  /** `shared/budget.ts`'s verdict: the account is past the ceiling. */
  budgetBlocked: boolean;
  /** The account's own sentence for that pause — which ceiling, and when it
   *  lifts. Optional because the rule must answer without one (a test hands in
   *  a bare boolean); when present it IS the answer, because "resumes at 14:20"
   *  is the only actionable half of a pause. */
  budgetDetail?: string;
  /**
   * Every ceiling the budget has tripped, session first (`budgetCeilings`).
   * What lets rung 2 lift for a before-reset row against the SAME window's
   * cap while still holding it on the other's. ABSENT means nobody said which
   * cap ⇒ the old behaviour, hold on `budgetBlocked`; present and empty while
   * `budgetBlocked` is true is read the same way.
   */
  budgetOver?: readonly BudgetCeiling[];
  /** The global auto-fire switch. */
  autoFire: boolean;
  /** Directories a sweep may legally name — `discoverTargets()`'s answer.
   *  Unknown dirs are dropped, never spawned. */
  knownDirs: ReadonlySet<string>;
  /**
   * Any OTHER intent is `starting`/`running`, anywhere on this host.
   *
   * Only rung 4.5's `holdForHost` reads it. A `repo`-with-`fresh` target never
   * passes through rung 5's session check at all — nothing has been created
   * yet for the tick to see busy — so several such intents due at the same
   * instant (the shape a "right after the weekly window resets" schedule
   * takes in every repo at once) each read the world as idle and each open a
   * session. This is the fact that lets an intent opt out of being one of
   * that pile: wait for the desktop to be doing nothing else first.
   */
  hostBusy: boolean;
  /**
   * How many more sessions MACHINERY may open right now — `BACKLOG_SESSIONS_MAX`
   * minus the automatic sessions currently alive.
   *
   * It is counted off the SESSIONS and never off a map of rows, which is the
   * same rule `repoSession` has and for the same reason: the cap is about how
   * many `claude` processes are running, so a session opened by the sheet's own
   * button counts against it exactly like one an intent opened. A bookkeeping
   * map would count the host's intentions instead of the host's processes, and
   * those two disagree after every crash, every restart and every session a
   * person closed by hand.
   *
   * Zero or less is a real value and means "none left", which is why this is a
   * number and not a boolean: the manager decrements it per fire within one
   * pass (the `hostBusy`/`busyCwds` trick), so five rows due in five repos in
   * one tick open min(5, free) sessions rather than five.
   */
  autoSlotsFree: number;

  // ── What the `after` trigger reads ───────────────────────────────────────
  //
  // Five facts rather than one, because the five questions a chain asks have
  // five different wrong answers and only one shape keeps them apart:
  // "has it finished?", "is it still there at all?", "does this chain bite
  // its own tail?", "is it the KIND of row that ever finishes?" and "is
  // anybody still expecting it to run?". All five
  // are OPTIONAL, and an absent one always means the host has not said — never
  // "no". A chain whose facts nobody supplied waits, which is the only
  // direction that cannot do damage: it neither runs work whose predecessor
  // may still be going, nor fails a row whose predecessor is alive and well.

  /**
   * How the rows that have FINISHED finished, by intent id.
   *
   * Membership is the settled test: a row in here is over, and `at` is when it
   * went terminal (`Intent.settledAt`). The manager builds it from the live
   * rows plus the tail of `intents-archive.jsonl`, so a predecessor that
   * finished last week and has since been compacted still releases its chain
   * instead of stranding it.
   */
  settled?: ReadonlyMap<string, IntentSettlement>;
  /**
   * Every intent id this host holds — live, terminal or archived.
   *
   * It is what tells "not finished yet" from "gone", which `settled` alone
   * cannot: absence from `settled` is both. Without the distinction a chain
   * whose predecessor was cancelled and dismissed waits for ever with a
   * perfectly reasonable-looking sentence under it, which is the exact failure
   * mode this whole store was built to stop — work that is never going to run
   * and never says so.
   */
  knownIntents?: ReadonlySet<string>;
  /**
   * Who waits for whom: the id of every `after` row, mapped to the id it waits
   * on. The one fact that makes a CYCLE visible from inside a single row —
   * A after B after A settles nothing, so neither row can ever see anything but
   * "not finished yet", and two rows waiting politely for each other for ever
   * is indistinguishable on screen from two rows that are simply next. The
   * manager already walks every row per tick to build `settled`; this is the
   * same walk's other half.
   */
  chainWaits?: ReadonlyMap<string, string>;
  /**
   * The rows that can never go terminal, and therefore can never release a
   * chain — today, exactly the RECURRING schedules.
   *
   * `settled` is terminal-only by contract, and a recurring rule never becomes
   * terminal: it fires, records its occurrence and re-arms, for ever. So a row
   * chained to "the nightly sweep" reads `not settled` on every tick until the
   * desktop is switched off, under the most reassuring sentence in this file —
   * *waits for “the nightly sweep” to finish*. That is the exact shape the
   * store exists to prevent: work that is never going to run and never says
   * so. It is the same failure `knownIntents` turns into a sentence, one
   * question earlier — that one is "is it there?", this one is "is it the kind
   * of thing that ends?".
   *
   * The PICKER already declines to offer one (`sendIntent.ts`'s
   * `chainCandidates`), and that is a courtesy, never the guard: a rule can be
   * edited from *once* to *every day* long after the chain behind it was made,
   * at which point no filter that ran at pick time is in a position to help.
   * Absent = nobody said = the old behaviour, which is to wait.
   */
  neverSettles?: ReadonlySet<string>;
  /**
   * The rows somebody has ARCHIVED and which have not finished — filed away,
   * still `queued`, still in the store.
   *
   * The fifth fact, and the fifth different wrong answer: "has it finished?",
   * "is it still there?", "does this bite its own tail?", "is it the kind of
   * thing that ends?" and now "is anybody still expecting it to run?". An
   * archived predecessor is in `knownIntents` (it has not left the store) and
   * out of `settled` (it has not finished), so the ladder answered *waits for
   * “X” to finish* on every tick, for ever, about work nobody is going to
   * start — with nothing on either row saying that un-archiving X is what
   * releases this one.
   *
   * It is a WAIT and not a `neverSettles`-style fail: bringing the row back is
   * a real fix, one tap away, and failing the chain would throw away the work
   * of the person who was only tidying a list. Absent = nobody said = the old
   * wait, wearing the old sentence.
   */
  setAside?: ReadonlySet<string>;
}

/** How one intent finished: `ok` as its `IntentResult` recorded it, `at` the
 *  instant it went terminal. The unit `facts.settled` is keyed on. */
export interface IntentSettlement {
  ok: boolean;
  at: number;
  /**
   * It was CANCELLED, rather than having run and failed.
   *
   * A separate flag and not an `ok: false` reading, because the two release a
   * chain differently and `ok` alone cannot tell them apart: a failure is the
   * work having happened and gone wrong ("run the tests, then tell me what
   * happened" still wants to run), a cancel is a person saying "not this" —
   * which is not "afterwards". Optional, so a host that does not set it keeps
   * the old behaviour exactly.
   */
  canceled?: boolean;
}

/**
 * WHO holds each serial group for the intent ladder — `serialHolders` in its
 * `automaticOnly` reading, and the ONE derivation behind both the hold
 * (`busyIntentGroups`) and the sentence (`IntentFacts.serialHolders`).
 *
 * The owner's rule: no parallel CODING by queued work, but a predecessor that
 * finished and is idle lets the next one start, and one with a question open
 * holds it. So only work the queue itself put there holds a group — rows
 * `starting`/`running` (`occupied`, wherever they run) and sessions opened FOR
 * queued work (`SerialSessionState.automatic`). A session a person opened by
 * hand never does: the owner runs several in one repo all day, and one of them
 * mid-turn held a serial row for five hours.
 */
export function intentSerialHolders(
  sessions: readonly SerialSessionState[],
  occupied: Iterable<{ cwd: string; sessionId?: string; name?: string }>,
): Map<string, SerialHolder[]> {
  return serialHolders(sessions, occupied, { automaticOnly: true });
}

/**
 * Which serialization groups are occupied, from the host's own facts.
 *
 * Two sources, both QUEUED work (`intentSerialHolders` says why):
 *
 *   • a live AUTOMATIC session in that directory behind a wall — mid-turn,
 *     parked on a question (a box, an unparsable dialog, or a turn that ended
 *     asking in prose), or blocked on a usage limit. A hand session is not
 *     this rung's business; the phone's own send queue (`busySerialGroups`)
 *     still counts every session, because its serial entries are a person's
 *     own sequential creates.
 *   • any cwd where an intent is `starting` or `running` right now.
 *
 * What it does NOT need is `busySerialGroups`' whole `SerialWatch` startup-grace
 * apparatus. That machinery exists only because the PHONE cannot see the gap
 * between `op.ack` naming a new session and that session reporting its first
 * turn — during which the repo looks idle and the queue would happily start a
 * second one. The host is on the other side of that gap: it holds the intent in
 * `starting` across exactly that window, so the second source above covers it
 * with a fact instead of a timer.
 */
export function busyIntentGroups(
  sessions: readonly SerialSessionState[],
  occupiedCwds: Iterable<string>,
): Set<string> {
  // Built FROM `intentSerialHolders`, so the holders a sentence names and the
  // groups the ladder holds are one derivation (`sessionWall`), never two.
  return new Set(intentSerialHolders(sessions, [...occupiedCwds].map((cwd) => ({ cwd }))).keys());
}

/** What the world says about one intent right now. */
export type IntentVerdict =
  /** Run it. `sessionId` is the resolved target, when there is one. */
  | { kind: "go"; sessionId?: string; occurrence?: number; late?: boolean }
  /**
   * Not yet, and here is the one sentence for the row.
   *
   * `detail` is the FINISHED sentence (already through `intentReasonText`), not
   * a fragment — a UI renders it as-is and must not re-weave it.
   *
   * `missedOccurrence` is the one piece of bookkeeping a wait can carry: a
   * recurring `at` whose occurrence blew past its grace window is not run late
   * and is not failed either — the manager records that occurrence as missed,
   * recomputes `nextAt`, and the row keeps standing. Silently advancing would
   * leave a row that looks like it fired.
   *
   * `missing` is the `files` trigger's outstanding paths, so the row can name
   * them without the manager re-deriving the same subtraction.
   *
   * `clearedOccurrence` is the other half of that bookkeeping, and the one that
   * keeps work alive rather than merely honest about being lost: it is present
   * on every wait produced BELOW rung 3, and it names the `at` occurrence rung 3
   * released before the lower rung took over. The manager stamps it on the row
   * (`Intent.clearedOccurrence`) so the next tick's rung 3 does not re-judge an
   * occurrence it has already let through. See `Intent.clearedOccurrence` for
   * the real case this was found in.
   *
   * `holderSessionId` rides a `serial` wait only: the live session the
   * sentence names (`serialLead`), so the row can offer to OPEN it — the
   * question a person has to answer before the row behind it may start.
   */
  | { kind: "wait"; reason: BlockReason; detail: string; missedOccurrence?: number; missing?: string[]; clearedOccurrence?: number; holderSessionId?: string }
  /** It will never run. */
  | { kind: "fail"; detail: string; missing?: string[] };
