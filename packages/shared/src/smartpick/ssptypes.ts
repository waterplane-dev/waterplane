/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */
/**
 * The look a repo takes over its own waiting items before one of them fires.
 *
 * ── The three verbs, and nothing else ──────────────────────────────────────
 *
 * When a repo's *smart pick* tick is on, the moment its next automatic backlog
 * item would fire the host first buys one cheap unattended completion over that
 * repo's remaining items, and the answer may do exactly three things: **pick**
 * which one runs next, **merge** items that are one job into a single item, and
 * **sort** the rest. Not "drop what is already done", not "split what is too
 * big" — those were asked for and declined, and a fourth verb added here is a
 * fourth way for a model to rewrite somebody's list.
 *
 * ── What is in this file, and what is deliberately not ─────────────────────
 *
 * Everything here is pure: `cleanSmartPick` reads what the model wrote,
 * `applySmartPick` turns a surviving proposal into a PLAN, `smartpickFingerprint`
 * says whether anything has changed since the last look, and
 * `smartpickOutcomeText` says what happened in the words the strip shows. No
 * filesystem, no `Date.now()`, no host imports — `assess.ts`'s posture, for
 * `assess.ts`'s reason: the whole rule set is then pinnable from literals by
 * `packages/shared/test/smartpick.test.mjs` in milliseconds, with nothing
 * spawned and no daemon booted, which is what lets the rules be settled before
 * there is anything that can run them.
 *
 * **A pass produces a plan and never a mutation.** CLAUDE.md's *nothing applies
 * itself* is knowingly excepted for this feature — the user chose, with the
 * trade-off spelled out, that all three verbs apply with no approval step — but
 * the SPLIT still belongs in the code: this module decides, the host writes. A
 * proposal that never reaches the host changes nothing, and there is exactly one
 * function that turns a proposal into work.
 *
 * ── The two rules that are not negotiable ──────────────────────────────────
 *
 * **Nothing here invents an item, and nothing here loses one.** Every id the
 * model names is checked against the candidates it was given; an id that is not
 * there is DROPPED with a note, never spawned as a row. An item the model failed
 * to mention keeps its place rather than vanishing. And a merged text has to
 * name every transport path (`.claude/inbox/…`, `.claude/outbox/…`) and every
 * image path that any member named — a merged prompt that silently loses
 * `.claude/inbox/foo.png` is a prompt that will tell an agent to look at a file
 * it was never handed, so the group is dropped rather than repaired.
 *
 * **A hand-placed row is never moved.** `SmartPickCandidate.handOrdered` marks a
 * position a PERSON set by dragging. A drag is the one explicit act in the
 * backlog sheet and the whole of this feature is otherwise automatic; the sort
 * therefore places the machine's rows AROUND the hand-placed ones and never
 * through them (see `applySmartPick`).
 *
 * **A row with a CLOCK is pinned like a hand-placed one, is never the pick, and
 * merges only with a row on the IDENTICAL clock.** `SmartPickCandidate.atKey`
 * marks a row whose WHEN a person set as an instant — a one-off schedule, which
 * is an ordinary backlog row since recurrence and not trigger kind decides which
 * list a row lives in (`isTimedWorkRow`). A clock is a STRONGER statement than a
 * drag: a drag says where in the queue the work goes, a clock says when it may
 * run at all. So each verb meets it differently and each refusal is a sentence:
 *
 *  • **sort** — the GROUP's slots are its clock's. A timed row never moves past
 *    an item with a different clock or with none, which is the part pinned by
 *    exactly the mechanism `handOrdered` is pinned by. **Inside one clock the
 *    pass may sequence freely**: a person who queues seven items on one instant
 *    has said when they may run and nothing at all about which goes first, and
 *    on this desktop that was twelve live one-offs on one reset — seven in a
 *    single repo — running in the order they happened to be typed. A
 *    `handOrdered` member keeps its seat inside the group too: a drag is the
 *    stronger statement in there as well as out here.
 *  • **pick** — never. A timed row is not "next" because a model said so; its
 *    clock says when. A pick naming one is corrected to the first entity without
 *    a clock, and the note says that is what happened.
 *  • **merge** — only when every member carries the same `atKey` (all untimed,
 *    or all on the identical rule, grace and hold). Mixed, or two different
 *    clocks, is REFUSED: which of two times the merged row should carry is a
 *    guess, and CLAUDE.md's rule is that an ambiguous heuristic answers nothing
 *    rather than a wrong number. Twins on one clock merge into a row that
 *    CARRIES it (`SmartPickMergePlan.atKey`, which the host turns back into the
 *    trigger). The host-wide HOLD is asked separately and on the same terms
 *    (`holdForHost`), because the key only carries it for a row that has a
 *    clock and *drop the clock* leaves the hold behind on a row that has not.
 */

// ── The candidates, the answer, and the plan ─────────────────────────────────

/**
 * One item the pass is allowed to decide about — the host's `Intent` reduced to
 * the facts a decision can be made from.
 *
 * `order` is the row's CURRENT slot value (`order ?? createdAt` on the host).
 * The sort re-assigns these same values rather than renumbering 0..n, so rows in
 * the repo that are not candidates — a session-target row, a chained row — keep
 * their relative places around the ones that move.
 */
export interface SmartPickCandidate {
  id: string;
  /** The user's own words, whole. Nothing in this file clips them. */
  text: string;
  label?: string;
  order: number;
  /** `claude --continue`: members of a merge must agree on it. */
  resume?: boolean;
  /** A person dragged this row here. The sort places around it, never through
   *  it; machinery never sets this. */
  handOrdered?: boolean;
  /** How many turns the item carries. `> 1` is a chain, and a chain cannot be
   *  merged — see `cleanSmartPick`. */
  steps: number;
  /** The prompt sent to the model carried only this item's first few hundred
   *  characters (the budget ran out). It may be sorted; it may not be merged,
   *  because the model never read the words it would be folding. */
  clipped?: boolean;
  /**
   * The transport files this item's words name, **as they are spelled on
   * disk** — the host's inbox/outbox listing, filtered to the names that appear
   * in `text`.
   *
   * `TRANSPORT_RE` is a GUESS at this listing, and it guesses wrong on a name
   * with a space in it, which is the commonest name there is:
   * `.claude/inbox/Screenshot 2026-09-17 at 10.00.00.png` (macOS's own spelling;
   * `safeName` keeps spaces) matches as `.claude/inbox/Screenshot` plus a stray
   * `10.00.00.png`. A merged text that "tidied" the name to
   * `Screenshot_2026-09-17.png` still contains both fragments, so the merge
   * SURVIVED the one check it must never survive, and the merged item told an
   * agent to look at a file that does not exist. Only the host can know the
   * real names; this is it telling us, so the check stops guessing.
   *
   * Absent ⇒ the regex alone, which is exactly today's behaviour. Present, it
   * is required VERBATIM in the merged text, and `cleanSmartPick` still applies
   * the regex on top: the two sets overlap and neither is a superset (an image
   * outside the transport is only ever found by the regex).
   */
  paths?: string[];
  /**
   * WHEN this row runs, in the words the person set it in (`describeRule`) —
   * present only on a row that carries a clock.
   *
   * It goes in the prompt so the model's `why` is not nonsense about ordering
   * something it may not order, and it is what the notes name the clock by. It
   * is PROSE: nothing decides anything on it — see `atKey`.
   */
  at?: string;
  /**
   * The equality that decides "these two wait on the SAME clock" — the host's
   * `timedWorkKey`, which is the rule, the grace and the host-wide hold
   * together.
   *
   * Absent ⇒ this row has no clock, which is the ordinary case and exactly
   * today's behaviour. Present ⇒ the sort pins the row and the pick skips it,
   * and a merge survives only among members whose keys are identical.
   *
   * Deliberately the KEY and not `at`: two rules can render the same sentence
   * and differ in grace or hold, and `describeRule` is locale-formatted for a
   * `once` rule. Equality has to be on the fact, never on the rendering of it.
   */
  atKey?: string;
  /**
   * This row waits until nothing anywhere on the desktop is starting or running
   * (rung 4.5). Members of a merge must agree on it, exactly like `resume`.
   *
   * It IS inside `atKey` — but only for a row that has a clock, and that is the
   * hole this field closes. *Drop the clock* leaves the hold on (the chip says
   * so, deliberately), so the rows most likely to reach this pass are untimed
   * rows that still hold: both keys are then absent, the clock rule sees two
   * identical `""`s and waves the merge through, and the row that replaced them
   * fires while another repo's item is mid-turn. A hold is a person's statement
   * about when work may run — the same kind of statement a clock is — so
   * machinery may carry it or refuse the merge, never quietly drop it.
   */
  holdForHost?: boolean;
  /**
   * A person let this row past the usage budget and the waiver is IN FORCE now
   * (`budgetWaived` over `Intent.pastBudget`). Members of a merge must agree on
   * it, for the hold's reason one rung up: a merged row that waived words
   * nobody let past spends past the budget without anyone saying so, and one
   * that dropped a waiver silently waits for a budget a person already
   * answered. Refused in words on a disagreement, never repaired.
   */
  pastBudget?: boolean;
}

/** One group the model says is a single job, plus the text it wrote for them. */
export interface SmartPickMerge {
  /** 2..`MAX_MERGE_SIZE` candidate ids, each in this group and no other. */
  ids: string[];
  /** The text that replaces them. Full, never clipped — see the header. */
  text: string;
  /** One sentence: why these are one job. */
  why: string;
}

/**
 * What survived the sanitiser: the answer, with every claim checked.
 *
 * `order` carries candidate ids AND merge keys (`merge:0`, `merge:1`, …) — a
 * merged group occupies ONE place in the running order, at its earliest member's
 * position, and its members are gone from the list.
 */
export interface SmartPickProposal {
  /** Which entity runs next: a candidate id, a merge key, or null when there is
   *  nothing to pick. */
  pick: string | null;
  /** Every surviving entity exactly once, in the order they should run. */
  order: string[];
  merges: SmartPickMerge[];
  /** The model's one sentence about the whole pass. */
  why: string;
  /**
   * What the sanitiser refused, one sentence each.
   *
   * Shown, never swallowed: a merge group dropped silently is indistinguishable
   * from a merge group nobody proposed, and the difference is whether the pass
   * was worth buying. `assess.ts` learned this first.
   */
  notes: string[];
}

/** A new slot value for a row that already exists. */
export interface SmartPickOrder {
  id: string;
  order: number;
}

/**
 * A merged row as the host must create it.
 *
 * `key` is the proposal's merge key, not an id: the real id is minted by the
 * host from the pass id (it has to be deterministic across a crash and a replay,
 * and a pass id is not a pure fact). `order` is already the FINAL slot — the
 * post and the sort are one decision here, so the host never has to place the
 * row twice.
 */
export interface SmartPickMergePlan {
  key: string;
  ids: string[];
  text: string;
  why: string;
  order: number;
  /** The value every member agreed on, or absent when they all had none. */
  resume?: boolean;
  /** Any member was hand-placed ⇒ so is the row that replaces it. */
  handOrdered?: boolean;
  /**
   * The clock every member waits on, when they all wait on the same one — the
   * host turns it back into the merged row's `at` trigger and its hold.
   *
   * `cleanSmartPick` has already refused any group whose members disagree, so
   * this is only ever one value; it is recomputed here anyway and left ABSENT
   * on a disagreement, because a merged row that quietly lost a clock would be
   * work rescheduled by a machine. The host refuses to write a merge whose
   * members carry a clock this field does not (see its `apply`).
   */
  atKey?: string;
  /**
   * The host-wide hold every member agreed on — absent when none of them held.
   *
   * Recorded for a TIMED and an UNTIMED group alike, which `atKey` cannot do:
   * a row that has had its clock dropped still holds, and a merged row that
   * quietly lost that hold would run work at a moment the person said it may
   * not. `cleanSmartPick` has already refused a group that disagreed; the host
   * asks the live rows again before it writes.
   */
  holdForHost?: boolean;
  /** Every member was let past the budget — absent when none was. A mixed
   *  group is refused by `cleanSmartPick`, and the host asks the live rows
   *  again before it writes. */
  pastBudget?: boolean;
}

/** What the host performs. Nothing else. */
export interface SmartPickPlan {
  /** Rows whose slot actually changes. A row already in the right place is not
   *  listed, so `orders.length` is the honest "sorted N". */
  orders: SmartPickOrder[];
  merges: SmartPickMergePlan[];
  /** The entity that should run next — a candidate id or a merge key — or null.
   *  Informational: the slot values already say it. */
  pick: string | null;
  notes: string[];
}

/**
 * How a pass ended.
 *
 * Every value except `applied` and `noop` means **the backlog fired in exactly
 * the order it would have without the feature**. That is the whole safety
 * property: CLAUDE.md's *heuristics degrade to null or absent, never to a wrong
 * number*, applied to an ordering rather than a number.
 *
 * `late` is its own outcome and not a failure: the answer was fine, it simply
 * arrived after the watchdog had released the row, and applying it then would
 * reorder a backlog whose next item had already started.
 */
export type SmartPickOutcome =
  | "applied" | "noop" | "skipped" | "failed" | "timeout" | "limited" | "late";

export const SMARTPICK_OUTCOMES: readonly SmartPickOutcome[] = [
  "applied", "noop", "skipped", "failed", "timeout", "limited", "late",
];

/**
 * The facts `smartpickOutcomeText` needs, and no more.
 *
 * `wire/work.ts`'s `SmartPickSummary` extends this rather than this file
 * importing the wire type, so the dependency runs one way (wire → pure) and the
 * sentences can be pinned without the protocol in the room.
 */
export interface SmartPickOutcomeFacts {
  outcome: SmartPickOutcome;
  /** One line about what actually happened, when the outcome alone is not it.
   *  Read by `failed` and `limited`; ignored elsewhere. */
  detail?: string;
  /** The name of the item that was picked, for `applied`. */
  picked?: string;
  /** How many ORIGINAL items were folded away. */
  merged: number;
  /** How many rows they became. Both numbers are kept because "merged 5 → 2" is
   *  not derivable from either one alone. */
  mergedInto?: number;
  /** How many rows actually changed slot. */
  sorted: number;
  /** How long the pass took (or how long it was allowed to take, on a timeout). */
  durationMs: number;
  /** `skipped` only: how long ago the previous look was. Absent means the skip
   *  was "the fingerprint has not moved", which makes no claim about time. */
  sinceMs?: number;
}