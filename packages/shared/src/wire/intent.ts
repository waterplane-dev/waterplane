/**
 * What a CLIENT may say about an intent — the two DTOs the wire carries, kept
 * apart from the model itself.
 *
 * `shared/intent.ts` is the stored row: it has a lifecycle, a block reason, a
 * result, and half a dozen fields only the host may write. None of those may
 * arrive off a socket — a client that could set `state` could mark work `done`
 * that never ran, and one that could set `lastOccurrence` could make a weekly
 * sweep fire twice by claiming it had not fired at all. So the wire carries a
 * DRAFT (what to do, where, and when) and a PATCH (absolute values for the
 * three fields an unrun intent may still change), and the host derives
 * everything else.
 *
 * Both are deliberately structural subsets of `Intent` rather than
 * `Partial<Intent>`: `Partial` would have admitted every host-only field as
 * optional, which is exactly the hole this file exists to close.
 */
import type { AssessPayload, BudgetPass, BudgetWaiver, BuildPayload, CapturePayload, IntentPayload, IntentTarget, IntentTrigger } from "../intent.js";
import type { ItemCategory, NameAuthor } from "../naming.js";
import type { SessionBudget } from "../sessionbudget.js";

/**
 * A new intent, as posted.
 *
 * `id` is client-minted and is THE at-most-once key — not for the ack ledger's
 * 45 minutes, but for the row's whole life. A post replayed after the ledger has
 * forgotten the ackId finds the row by this id and returns it, rather than
 * doing the work a second time.
 *
 * `target` is optional because `cwd` is not: an absent target means "in this
 * repo", which is the only reading it can have (`cleanTarget`).
 */
export interface IntentDraft {
  id: string;
  cwd: string;
  payload: IntentPayload | BuildPayload | AssessPayload | CapturePayload;
  target?: IntentTarget;
  trigger: IntentTrigger;
  serial?: boolean;
  /** See `Intent.holdForHost` — hold this fire until nothing else on the host
   *  is starting or running. */
  holdForHost?: boolean;
  /** See `Intent.pastBudget` — a person already let this past the budget, until
   *  the reset of the window they did it in. The HOST posts it (a smart-pick
   *  merge, a recurring rule's child); a client lifts the budget with
   *  `intent.waive`, never by posting it — `intent.post` strips it off the wire.
   *  Not on `IntentPatch`: a waiver is not an edit to the row. */
  pastBudget?: BudgetWaiver;
  /** See `Intent.budgetPass` — the before-reset lift a recurring rule's child
   *  is minted with. The HOST posts it (`workItemInherits`); cleaned strictly
   *  by `cleanIntentRow`. */
  budgetPass?: BudgetPass;
  auto?: boolean;
  /** Aimed at one session by hand — exempt from the global auto-fire switch,
   *  never from the account's budget. See `Intent.pinned`. */
  pinned?: boolean;
  /** May be typed into a session another intent holds. See `Intent.interject`. */
  interject?: boolean;
  /** `--continue` the repo's conversation when this opens a fresh session. */
  resume?: boolean;
  /** Close the session this opens once done (`true`), keep it open (`false`),
   *  or — absent — follow the person's global setting. See
   *  `Intent.closeWhenDone`. */
  closeWhenDone?: boolean;
  /** Set aside on arrival — kept in full, never run until brought back. */
  archived?: boolean;
  /** Waits for a person's tap — see `Intent.manual`. */
  manual?: boolean;
  /** Explicit sort position (0 is a value). */
  order?: number;
  label?: string;
  title?: string;
  /**
   * A title a MACHINE wrote, with the author that says so — see
   * `Intent.headline`. The pair is required together and `cleanIntentRow` drops
   * one without the other, so a client that sends a title and forgets to say
   * who wrote it posts a row with no title rather than one that cannot defend
   * itself against the next naming run.
   *
   * A PERSON'S title does not come in here: it goes through the host's `edit()`
   * as a `label`, which is the one write path that stamps `hand`.
   */
  headline?: string;
  headlineBy?: NameAuthor;
  /** What KIND of thing this is — one of `ITEM_CATEGORIES`, dropped rather than
   *  rounded if it is not, and paired with its author the same way. Absent means
   *  nobody said, never "chore". */
  category?: ItemCategory;
  categoryBy?: NameAuthor;
  cols?: number;
  rows?: number;
  launch?: unknown;
  /** The budget the session this opens is born with (`Intent.budget`).
   *  `null` is an explicit CLEAR, for `upsert()` re-saving a row: absent there
   *  means "this draft never heard of budgets" and keeps the stored cap, so a
   *  person blanking it needs a value that says so. */
  budget?: SessionBudget | null;
  replaceSessionId?: string;
  /** Provenance, for a row that was made by another row ("retry:<id>"). */
  origin?: string;
  /** Ties a sweep's children to the parent that made them. */
  groupId?: string;
}

/**
 * An edit to an intent that has not started.
 *
 * Every field is an ABSOLUTE value, never a delta, which is what makes the
 * message idempotent by construction: a patch replayed after the receipt was
 * lost lands the same row in the same state. The host refuses one aimed at a
 * `starting`/`running` or terminal row — an edit to work already in flight is a
 * different prompt than the one that ran, and pretending otherwise is how a row
 * ends up describing something that never happened.
 */
export interface IntentPatch {
  payload?: IntentPayload | BuildPayload | AssessPayload | CapturePayload;
  trigger?: IntentTrigger;
  label?: string;
  title?: string;
  serial?: boolean;
  auto?: boolean;
  /**
   * Hold the fire until nothing else on the host is starting or running
   * (`Intent.holdForHost`) — the send sheet's *wait until it's free* ticked
   * beside a clock.
   *
   * Here for `resume`'s reason, one field along: a clock aimed at a SESSION is
   * re-timed through this message (`whenRoute` routes that pair to a patch,
   * because `ScheduleEntry` cannot name a session), and a patch that could not
   * carry the hold would drop a decision the person had made in the same
   * breath as the time — silently, which is the one way this app may not lose
   * an answer.
   */
  holdForHost?: boolean;
  /** Where it lands. `intent.retarget` is the recovery verb for this; the patch
   *  carries it too because a backlog edit moves an item between repos and
   *  between sessions in the same breath as its words. */
  cwd?: string;
  target?: IntentTarget;
  archived?: boolean;
  order?: number;
  /**
   * The "a person aimed this here themselves" exemption (`Intent.pinned`), as a
   * patch — the backlog's per-item auto-fire flag on a row that already exists.
   * Only ever set by a tap that says exactly that; nothing infers it.
   */
  pinned?: boolean;
  /**
   * `--continue` the repo's last conversation when this row opens its fresh
   * session (`Intent.resume`).
   *
   * It was missing here while `Intent` had it and `cleanIntentRow` already read
   * it, so `backlog.update` — the one message that edits an item somebody has
   * already posted — carried it through a locally widened
   * `IntentPatch & { resume?: boolean }` in the host. A type widened at the
   * call site is a field with no owner: nothing documents it, nothing else can
   * find it, and the next surface that wants to edit the flag widens the type
   * a second time.
   *
   * ABSENT leaves the row's own value alone, which is what makes `false`
   * meaningful — "start clean after all" is a decision a person can make about
   * an item they already queued, and a patch that could only ever turn the flag
   * on would make that decision unsayable without deleting the words and
   * posting them again.
   */
  resume?: boolean;
  /**
   * The per-item *close the session when done* override (`Intent.
   * closeWhenDone`): `true`/`false` set it, `null` CLEARS it back to "follow
   * the global setting", absent leaves it alone. `null` rather than overloading
   * `false`, because `false` is itself an answer ("keep this one open").
   */
  closeWhenDone?: boolean | null;
}
