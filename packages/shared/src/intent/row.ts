/**
 * `Intent` — one durable row — and the module's limits (`ON_TIME_MS`,
 * `HELD_MAX_MS`, the `INTENT_MAX_*` count caps).
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { ItemCategory, NameAuthor } from "../naming.js";
import type { SessionBudget } from "../sessionbudget.js";
import type { LaunchOpts } from "../wire/session.js";
import type { AssessPayload, BlockReason, BudgetPass, BudgetWaiver, BuildPayload, CapturePayload, IntentPayload, IntentRequeue, IntentResult, IntentTarget, IntentTrigger, Lifecycle } from "./types.js";

/**
 * One durable intent.
 *
 * Fields are stored flat rather than as the wire message that created them, for
 * the reason `LaunchIntent` states: it keeps the persisted file readable, and a
 * wire type change cannot silently rewrite rows already on disk.
 */
export interface Intent {
  /** Client-minted, and THE at-most-once key — for the row's whole life, not
   *  for the ack ledger's 45 minutes. A replayed post upserts. */
  id: string;
  /** The repo. Known at post time, so the user is never asked twice which repo
   *  their own words were for. */
  cwd: string;
  payload: IntentPayload | BuildPayload | AssessPayload | CapturePayload;
  target: IntentTarget;
  trigger: IntentTrigger;
  /** One at a time within this cwd. The group is `serialGroup(cwd)` — the
   *  WORKTREE, deliberately not the repo, so two worktrees stay independent. */
  serial?: boolean;
  /** Hold this fire until nothing else on the host is `starting`/`running` —
   *  the schedule sheet's "wait until it's free". An ADDITION to whatever the
   *  trigger already says, never a substitute for it: `serial` alone stops two
   *  fires piling into the SAME repo, this stops N schedules — each aimed at
   *  its own, otherwise-idle repo — firing together. */
  holdForHost?: boolean;
  /**
   * A person let this row past the usage BUDGET, for its next start and inside
   * the budget window it was granted against — and nothing else. Rung 2 and
   * the `budget` trigger skip it (`budgetWaived`); every rung below (serial,
   * `holdForHost`, `noSlot`, target readiness) still holds it,
   * which is the whole point: the re-time sheet's bulk release used to send
   * `intent.run` per row and four rows in one worktree started at once.
   *
   * `until` is the latest reset among the ceilings tripped when `intent.waive`
   * set it (`budgetWaiverUntil`): a waiver is an answer about THAT window, and
   * a fresh block in the next one is a new question nobody has answered — a
   * one-off for tomorrow waived tonight must not fire tomorrow past a budget
   * block nobody saw. Honoured only while `now < until`; the tick drops an
   * expired one. Kept through `starting` (a restart's requeue keeps it) and
   * cleared once the start's outcome is known, except a provable retry.
   * `bdd2968`'s `budgetPass` is the same shape of answer — a lift that ends at
   * a reset — for a row timed before one.
   */
  pastBudget?: BudgetWaiver;
  /**
   * This row was fired on behalf of a BEFORE-reset occurrence — today only a
   * recurring schedule's child, minted by `workItem` — and may run past the
   * `window` ceiling between `from` (the occurrence) and `until` (the reset it
   * was timed ahead of). A ceiling saves allowance for later in the window;
   * a row timed to spend what is left before the reset has no later.
   *
   * Stamped by `workItemInherits` from the parent's `lastOccurrence`, never
   * derived: a row with its own `at` clock is read off that clock instead
   * (`budgetPassOf`). A `weekly` pass covers the session cap too; a `session`
   * pass never covers the weekly one, and the real usage limit holds either.
   */
  budgetPass?: BudgetPass;
  /**
   * The weekly reset this row outlived without starting, after being let past
   * that week's budget by a person's waiver — stamped by the tick as it drops
   * the expired waiver, cleared by the row's next start. The before-reset
   * PASS needs no stamp: it is still on the row (`budgetPassOf`), so
   * `budgetLeftoverOf` reads it off that. Rung 2 holds a leftover row while the
   * leftover ceiling is tripped (`shared/budget.ts`'s `leftoverCeiling`).
   */
  leftoverOf?: number;
  /**
   * Posted by machinery rather than by a person mid-tap.
   *
   * Only `auto` intents are held by the gate and the budget: a person spending
   * the remaining budget is exactly what the remaining budget is for, and the
   * auto-fire switch was never a statement about a hand-fired item.
   */
  auto?: boolean;
  /**
   * The user aimed this at a particular session themselves — the compose bar's
   * "queue for this session".
   *
   * It still waits for that session to be free and the ACCOUNT-wide budget
   * still holds it, but the global auto-fire SWITCH does not: that switch
   * routes machinery, and this was a tap. It is the backlog's per-item
   * `autoFire` flag, which meant exactly this and nothing else.
   */
  pinned?: boolean;
  /**
   * May be typed into a session another intent is already holding.
   *
   * The one-intent-at-a-time-per-session rule exists so a repo's queued work
   * does not stack two prompts into one composer. A fan-out FOLLOW-UP is not a
   * competitor for that session: it is the next turn of the same sweep, aimed
   * at a session this very run opened and is still holding. Without this it
   * would wait for a target that (on an unhooked session) never finishes.
   */
  interject?: boolean;
  /** Resume the repo's existing conversation when a `fresh` target opens a
   *  session (`claude --continue`) — the review verbs' "carry on where that
   *  work left off", which is worthless in a session with no context. */
  resume?: boolean;
  /**
   * Close the session this row OPENS once the work is done and it has
   * lingered (`WATERPLANE_BACKLOG_LINGER_MS`) — or keep it open until a person
   * closes it. **Absent INHERITS** the person's global setting
   * (`CLOSE_WHEN_DONE_KEY`, off by default), which is why `false` is a real
   * value and never folded into absent: "keep THIS one open" must survive the
   * global being switched on. Read by the backlog's linger sweep and slot reap
   * through `closeWhenDoneOf`; meaningless on a row typed into a session that
   * was already there (it opened nothing).
   */
  closeWhenDone?: boolean;
  /**
   * "Flag for follow up when done" (R-sessions-043): the session this row
   * OPENS gets a `launch` follow-up flag once the row settled `done` and the
   * session is no longer working (`slotBusy` false). Off unless a person ticked
   * it — `true` or absent, no global setting. A row that FAILED never flags,
   * and neither does one parked on a usage limit (it has not settled).
   */
  flagWhenDone?: boolean;
  /**
   * Set aside: kept in full, listed on demand, never run until it is brought
   * back. The backlog's `archived`, which was never a delete and must not
   * become one.
   */
  archived?: boolean;
  /**
   * **Waits for a person's tap — nothing starts it by itself.** Set on a
   * backlog item an AGENT added (`agentintents.ts`): the agent may put words
   * on the person's list, never start work on it, so auto-fire may not take it. Rung 1 holds it (`MANUAL_HOLD_TEXT`); the row's own
   * `fire` is `runNow`, which skips the ladder, and is the one way it runs.
   * Absent on every row a person made, which is what every row before this
   * field was.
   */
  manual?: boolean;
  /** Explicit sort position — the backlog's drag-and-drop. Lower is earlier;
   *  absent falls back to `createdAt`. Note 0 is a real value. */
  order?: number;
  /**
   * A PERSON put this row where it is.
   *
   * Set by the two gestures that are a statement about run order and by nothing
   * else — `BacklogManager.reorder()` (a drag) and `swap()` (the one-step move).
   * Machinery never sets it: `add()` puts a new row on top with
   * `min(orders) - 1`, and that is a position nobody chose. Machinery never
   * clears it either, so a row dragged once keeps its slot until it runs.
   *
   * The row says so ("placed by you"), and an assessment that pins its order
   * writes the same mark. Without a field recording it, a drag to the top is
   * indistinguishable afterwards from a row that was simply added last — and
   * anything that ever re-sorts rows must sort AROUND the ones a person placed.
   * (The automatic smart pick that read it was removed 2026-10-16.)
   *
   * `true` or absent, never `false`: "nobody has placed this" is the absence of
   * a statement, not a statement that nobody has.
   */
  handOrdered?: true;
  /**
   * Deliveries that provably typed NOTHING and were requeued.
   *
   * The cap (`INTENT_MAX_ATTEMPTS`) is stated once here for every executor,
   * because the rule it enforces is one rule: only a `retry` verdict requeues,
   * `unconfirmed` never does, and a genuinely stuck session must stop churning
   * rather than retry for ever.
   */
  attempts?: number;
  label?: string;
  title?: string;
  /**
   * **A title a MACHINE wrote for this row.** A person's own is `label`, and
   * the two never share a field — see `BacklogItem.headline`, which is this on
   * the wire.
   *
   * Stored with `headlineBy` or not at all: the pair is what makes "may this be
   * overwritten" answerable, and `cleanIntentRow` drops one without the other
   * rather than inventing an author for a title that arrived without one.
   */
  headline?: string;
  /** Who wrote `headline` — `hand` is the one value that makes it
   *  un-overwritable, which is why it may never be defaulted. */
  headlineBy?: NameAuthor;
  /**
   * What KIND of thing this row is — one of `ITEM_CATEGORIES`.
   *
   * **Absent means NOBODY SAID**, never "chore": a word outside the four is
   * dropped rather than rounded, because a row filed under a heading its author
   * never chose is a row they will not find again.
   */
  category?: ItemCategory;
  /** Who said so. Paired with `category` exactly as `headlineBy` is with
   *  `headline`, and dropped with it. */
  categoryBy?: NameAuthor;
  cols?: number;
  rows?: number;
  /** The model/effort/backend the session this row OPENS is started with —
   *  a parked create's own, a sweep's, or a later "new session" a person picked
   *  a model for on the send sheet. Absent = the desktop's new-session
   *  defaults. Always `cleanLaunchOpts`'s shape: never trusted raw off disk. */
  launch?: LaunchOpts;
  /** A budget the session this row OPENS is born with (`sessionbudget.ts`).
   *  Not part of `launch`: a backlog item opens its session without one. Absent
   *  = none; a fork or a reopened closed row never inherits it. */
  budget?: SessionBudget;
  replaceSessionId?: string;

  state: Lifecycle;
  /** Present iff `state === "blocked"`. Recomputed every tick, never trusted
   *  from disk — it is a fact about right now. */
  blockReason?: BlockReason;
  /** The finished human sentence, from `intentReasonText`. */
  blockDetail?: string;
  /** The session holding this row's repo when it is blocked on `serial` and
   *  the sentence names a live one (`IntentVerdict.holderSessionId`), so the
   *  row can offer to open it. Written by every `block()`; the many places
   *  that clear `blockReason` leave it, so it MEANS something only beside
   *  `state === "blocked" && blockReason === "serial"` — read it there only
   *  (`intentToBacklogItem` does), and `cleanIntentRow` drops it otherwise. */
  blockSessionId?: string;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  /**
   * What makes a row tappable — and, for a finished fan-out target, what makes
   * it followable-up.
   *
   * It used to be dropped on load, on the rule that a session id is per-boot.
   * That is true of a plain PTY and false under `WATERPLANE_TMUX=1`, where the
   * `claude` processes live in a private tmux server and are re-adopted under
   * the same id by `sessions.rediscover()`. So the id is kept across a restart
   * and the manager's `reconcile()` — which runs after the re-adoption, i.e. at
   * the first moment the question is answerable — clears the ones whose session
   * genuinely did not come back.
   */
  sessionId?: string;
  result?: IntentResult;
  /**
   * Every time this row was put back in the queue after it had settled, oldest
   * first — so the LAST entry is the one that put it where it is now.
   *
   * Beside `result` deliberately: this is the history `result` does not keep,
   * and the pair is read together. Absent on the overwhelming majority of rows,
   * which have never settled twice. Capped at `REQUEUE_KEEP` entries and at
   * nothing else — so this is the WORDS, and `requeueCount` beside it is the
   * NUMBER. `requeues.length` is a floor on that number, never the number.
   */
  requeues?: IntentRequeue[];
  /**
   * **How many times this row has been put back after settling — all of them.**
   *
   * ── Why a second field for something the list "already says" ──────────────
   *
   * It did not say it. `requeues` is capped at `REQUEUE_KEEP`, so its length
   * stops rising at five; anything reading `requeues.length` as the count says
   * *(5th time)* on the sixth re-queue, on the ninth, and for ever after. A row
   * being put back for the ninth time is exactly the row a person most needs
   * told about — "this keeps coming back and keeps failing" is the entire
   * decision the history exists to support — and a number frozen at five is the
   * failure mode CLAUDE.md names by name: a reading that degrades to a WRONG
   * number rather than to an absent one. It does not even look wrong. It looks
   * like a row that has been re-queued five times, which is a thing that
   * happens.
   *
   * ── Why the list is capped and this is not ────────────────────────────────
   *
   * They are capped by different things because they COST different things. An
   * entry carries a `result` — a run's full sentences about somebody's work, a
   * `detail` and every `targets[].error` — and this file rewrites the whole row
   * on every tick, so an unbounded list of those is an unbounded file. A count
   * is one number. There is no version of "a row re-queued weekly for a year"
   * where an integer is the problem, and there is no version of it where the
   * integer is allowed to lie.
   *
   * ── What it is not ────────────────────────────────────────────────────────
   *
   * Absent means **nobody counted** — every row written before this field, and
   * any row whose stored value could not be read — never "zero times". Zero is
   * spelled by absence too: a row that has never been put back has no history
   * and no count, and one fact must not have two spellings. So a reader that
   * wants the ordinal ("the 9th time") has it or has nothing to say, and must
   * never fall back to `requeues.length` to fill the gap — that is the wrong
   * number this field was added to delete.
   */
  requeueCount?: number;
  /** `at` trigger bookkeeping. `null` (not `undefined`) means nothing is armed:
   *  a disabled rule or a spent `once`. */
  nextAt?: number | null;
  /** The occurrence already spent. Written BEFORE the executor runs, so a tick
   *  that runs twice or a crash mid-fire cannot run it again. */
  lastOccurrence?: number;
  /**
   * The `at` occurrence rung 3 has ALREADY released — it was due, it was inside
   * its grace, and the only thing holding it is a rung BELOW rung 3.
   *
   * **This is the fix for a real, observed loss of somebody's work.** Audited
   * out of a live `.waterplane/intents.json`: a `once` rule — *right after the weekly
   * window resets*, **wait until free**, grace 120 min — sat `failed` wearing
   * *“missed — the desktop was not running when it was due (more than 120 min
   * late)”*. The desktop had been running the entire time. The chain was: rung
   * 3 said *due, and within grace*; rung 4.5 (`holdForHost`) then held the row,
   * exactly as the user had asked it to; the clock kept moving while it was
   * held; and two ticks later rung 3 — which re-runs from scratch every tick and
   * remembers nothing — judged the same occurrence missed and failed the row.
   * It was killed for doing precisely what it was told, and then blamed the
   * machine for it.
   *
   * So the invariant: **a row's deadline may not be spent by the waits the row
   * was told to perform.** Once rung 3 has released an occurrence, rung 3 does
   * not re-judge it — see `HELD_MAX_MS` for the ceiling that still can.
   *
   * ── Why a persisted stamp and not a derivation ────────────────────────────
   * The fact needed is a PAIR: *which occurrence* was released, and that it
   * was. Nothing else on the row carries both. The nearest derivation —
   * "`blockReason` is one of the rungs below 3" — is wrong twice: it cannot
   * tell a hold below rung 3 from `gate`/`budget` ABOVE it (which never reached
   * rung 3 and must still be able to miss), and it is anonymous about the
   * occurrence, so last week's hold would exempt this week's occurrence. And it
   * is persisted rather than in-memory because the hold outlives the process:
   * `npm run restart` mid-hold would otherwise re-arm the very bug this closes.
   *
   * Set by the manager from `IntentVerdict.clearedOccurrence`; cleared when the
   * occurrence is spent or recorded missed.
   */
  clearedOccurrence?: number;
  /** `files` trigger: the subset of `needs` still absent at the last check. */
  missing?: string[];
  /** Terminal rows may only leave the live file once this is set — "a terminal
   *  state the user has seen", made mechanical. */
  dismissedAt?: number;
  /**
   * This row has FOLLOWED its own session through a usage-limit resurrection at
   * least once, and must keep following rather than ever being requeued.
   *
   * The exemption used to be read off the row's TARGET — `needsSlot(row)`, i.e.
   * "this row opens its own session". That is true of the row on the way into
   * the first wall and false on the way out of it: the re-aim rewrites the
   * target to `{kind:"session", sessionId: S2}`, so at the SECOND wall the row
   * takes the ordinary branch — `queued`, "it will run again when the session
   * reopens" — and the tick's `session`-target re-aim then delivers the whole
   * item into S3, the session that `--continue`d the item's own conversation and
   * is already resuming it. The words are typed twice, which is the one thing
   * this store exists to prevent.
   *
   * And it is the NORMAL path, not an edge: `maybeScheduleResurrect` reopens a
   * WEEKLY-limited session at `now + 5_000` ("an upgraded plan continues now"),
   * so S2 opens five seconds later and hits the same wall by construction. Every
   * weekly wall is a two-wall sequence.
   *
   * So the fact is about the ROW, recorded at the moment the manager learns it,
   * and persisted for the same reason every other fact here is: the gap to the
   * reset is HOURS, and a restart inside it must not turn the row back into one
   * that can be requeued.
   */
  followed?: boolean;
  /** Where this came from ("rescue", "retry:<id>", "schedule"). */
  origin?: string;
  /** Ties a fan-out's children to their parent sweep. */
  groupId?: string;
}

/**
 * Hard bound on `payload.steps`. A chain longer than this is a bug in the
 * sender, not a plan — and the cap is on the COUNT, never on the words.
 *
 * DECLARED in `schedule.ts` and re-exported here, because both files cap the
 * same list and the dependency only runs one way (`intent.ts` imports
 * `schedule.ts`, never the reverse). It used to be declared here and spelled
 * `40` by hand in `cleanAction`, under a comment explaining the duplication —
 * which is a comment saying "there are two homes for this number", and the two
 * would have drifted the first time anybody raised one of them.
 */
export { INTENT_MAX_STEPS } from "../schedule.js";

/**
 * How late is still "on time", whatever grace was configured.
 *
 * The manager has no timer at `nextAt`: it ticks (`TICK_MS`, 2 s) and asks this
 * ladder about every row, so `now` is always 0–2000 ms past the instant a row
 * became due. A bare `lateBy > graceMs` therefore reads `graceMin: 0` — the
 * "skip it" chip the send sheet ships — as "run only on the exact millisecond",
 * i.e. never: a daily rule with that chip wore *missed — …(more than 0 min
 * late)* on every occurrence while the desktop was running the whole time, and
 * a chain with it failed TERMINALLY 1.5 s after its predecessor settled.
 *
 * So every miss test is `lateBy > max(grace, ON_TIME_MS)`, and "skip it" means
 * what the chip implies: unless it can start within a minute of the moment it
 * was allowed to. One constant, one comparison, shared by the `at` arm, the
 * `after` arm and the `hours` opening — three edges of the same bug.
 *
 * A minute rather than a tick, because it is the SAME slack the row already
 * uses to decide whether to call a run late at all (`late` below): one number
 * for "nobody would call this late" is one fact, and two would have to agree.
 */
export const ON_TIME_MS = 60_000;

/**
 * The ceiling on a HELD occurrence — the one thing that may still expire a row
 * rung 3 has already released (`Intent.clearedOccurrence`).
 *
 * "Held for ever, silently" is not an improvement on "failed wrongly". A
 * desktop that is permanently busy, a `serial` group with a wedged session, a
 * local model that never finishes loading: each of those can hold a released row
 * indefinitely, and a row that waits for a week without a word is the same
 * disappearance as one that failed — just quieter.
 *
 * 24 hours, and NEVER shorter than the configured grace (`max(graceMs,
 * HELD_MAX_MS)`), because the grace is capped at 7 days and a person who typed
 * one is entitled to it. It is deliberately an order of magnitude past the
 * grace the send sheet offers (0–120 min) — the point is that it is not a
 * second, competing deadline, it is a backstop for work nobody is ever going to
 * get to. And the sentence it writes (`heldOutText`) claims only the clock: it
 * does NOT say the desktop was off, because in this branch the desktop was
 * demonstrably on and the row was demonstrably waiting.
 */
export const HELD_MAX_MS = 24 * 60 * 60_000;

/** Hard bound on a `files` trigger's `needs`, matching `launch.ts`. */
export const INTENT_MAX_NEEDS = 20;

/** Hard bound on a sweep's repo list, matching `schedule.ts`'s `cleanAction`. */
export const INTENT_MAX_DIRS = 60;

/**
 * How many times a delivery that provably typed NOTHING is re-attempted.
 *
 * The backlog's `MAX_FIRE_ATTEMPTS`, lifted here so it is one rule for every
 * executor rather than one manager's private policy: a transient block (a
 * repaint, a session still booting) should not kill the work, and a session
 * that is genuinely stuck should not be hammered for ever.
 */
export const INTENT_MAX_ATTEMPTS = 5;
