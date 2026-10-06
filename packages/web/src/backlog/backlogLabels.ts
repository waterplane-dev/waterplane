/**
 * The backlog sheet's tables, as DATA: what each verdict is called and which
 * icon it wears, the engine words of the last-look strip, the closed-target
 * group key, and the one edge that decides which rows offer *drop the clock*.
 * No React here beyond the icon components themselves — `ActivitySheet` and
 * `AssessSheet` import the verdict and kind tables from this file, so a verdict
 * reads the same on every screen. Shape: docs/notes/backlog-architecture.md.
 */
import { Bug, Check, CircleDashed, CircleHelp, Hourglass, Lightbulb, Loader, TrendingUp, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import type { BacklogCheckStatus, BacklogItem, BacklogValidateStatus, ItemCategory, SmartPickSummary } from "@waterplane/shared";

/**
 * **Which rows offer *drop the clock*, in one place.**
 *
 * Three things on a timed row are drawn from this answer — the hold chip's
 * extra clause, the note under the chips, and the verb itself — and they are
 * three statements about one tap. A second copy of the edge is how a row grows
 * a sentence about a button it does not have, or a button with nothing said
 * about it. A `running` row is excluded because the host refuses an edit to
 * work already in flight, and a settled one because there is nothing left to
 * re-time.
 */
export const dropOffered = (it: BacklogItem): boolean => it.status === "queued" || it.status === "failed";

/**
 * The sentences a merged ROW says are `backlogFilter.ts`'s, beside the filter
 * rules — pure, and therefore pinned by `backlogFilter.test.mjs`. Only the
 * sheet knows which side of a merge is on screen, but the words themselves are
 * the deliverable and belong where a test can read them.
 *
 * The STRIP's wording is `@waterplane/shared`'s (`smartpickOutcomeText`) and is never
 * restated here either — the host writes the same sentence into its record and
 * its notification, and a second copy on the phone is a third chance for one of
 * them to stop being true.
 */
/** What ran the pass, when the engine did not name a model. `claude-p` and
 *  `openai-compat` are wire words, not English, and the strip is read by a
 *  person deciding whether to leave an automatic spender switched on. */
export const ENGINE_LABEL: Record<SmartPickSummary["engine"], string> = {
  "claude-p": "claude, headless",
  "openai-compat": "the local runner",
};

/**
 * The check verdicts, in words. Exported because `ActivitySheet` renders the
 * same verdict on its own rows, and two screens wording one fact two ways is
 * how a person ends up believing they are two facts.
 *
 * The glyphs that used to be glued to the front of these — `✓ ~ ? ✗ ⚠ ⏳` — are
 * `CHECK_ICON` now. Two of them were emoji, which Android renders as full-
 * colour pictures a third larger than the line they sit on, and all six were
 * doing an icon's job in a string that also has to be readable as words.
 */
export const CHECK_LABEL: Record<BacklogCheckStatus, string> = {
  checking: "checking…",
  done: "implemented",
  partial: "partial",
  questions: "open questions",
  not_done: "not done",
  error: "check failed",
  // Not a verdict about the work: the reviewer never ran. Worded as the quota
  // fact it is, so nobody reads it as "the check says no".
  limited: "not checked — usage limit",
};
/** …and the icon each verdict wears, from `lucide-react` like every other icon
 *  in this app. Exported with the labels, because a verdict drawn with one
 *  screen's icon and another screen's words is the disagreement the shared
 *  label exists to prevent. */
export const CHECK_ICON: Record<BacklogCheckStatus, LucideIcon> = {
  checking: Loader,
  done: Check,
  partial: CircleDashed,
  questions: CircleHelp,
  not_done: X,
  error: TriangleAlert,
  limited: Hourglass,
};
export const VALIDATE_LABEL: Record<BacklogValidateStatus, string> = {
  validating: "validating…",
  achieved: "outcome achieved",
  likely: "likely achieved",
  unlikely: "likely not achieved",
  unclear: "unclear",
  error: "validate failed",
  limited: "not validated — usage limit",
};
export const VALIDATE_ICON: Record<BacklogValidateStatus, LucideIcon> = {
  validating: Loader,
  achieved: Check,
  likely: CircleDashed,
  unlikely: X,
  unclear: CircleHelp,
  error: TriangleAlert,
  limited: Hourglass,
};
/**
 * **What KIND of thing a row is, as an icon — and deliberately NOT as a
 * colour.**
 *
 * The obvious design is a red `bug` chip, and it is wrong here for a reason
 * this list makes unusually sharp: the row beside it already wears a red
 * `failed` tag, and a column of red `bug` chips down a backlog reads as a
 * column of failures. The kinds differ by WORD and by ICON; the palette in this
 * sheet is reserved for what HAPPENED to a row (`--dead` for a failure,
 * `--sched` for a clock, `--accent` for what runs next), which is the axis a
 * person triages on.
 *
 * `lucide-react`, never emoji — Android draws an emoji as a full-colour picture
 * a third larger than the line it sits on, and this one sits in a meta row of
 * 11px text.
 */
export const CATEGORY_ICON: Record<ItemCategory, LucideIcon> = {
  bug: Bug,
  feature: Lightbulb,
  enhancement: TrendingUp,
  chore: Wrench,
};

/** Group key for rows aimed at a session that has since closed. Not a session
 *  id and not the default group: those rows run nowhere until a person moves
 *  them, which is a third thing to say and so a third heading. */
export const CLOSED_GROUP = "__closed";
