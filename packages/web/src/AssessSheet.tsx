/**
 * The assessment, as a diff a person approves.
 *
 * ── What goes wrong without it ─────────────────────────────────────────────
 *
 * A run reads a whole repo and comes back saying, of eighty-four things
 * somebody wrote, which are already done, which no longer apply, which are
 * covered elsewhere and which are really one job. Applied on its own that is a
 * model deleting a person's words on its own recognisance, and "a CLI saying
 * implemented about something half-implemented" is the EXPECTED failure here,
 * not a surprising one. Two things contain it, and this file is the second:
 * `shared/assess.ts` refuses any verdict that cites nothing, and NOTHING APPLIES
 * ITSELF — the run produces a proposal, and every retirement on this screen is a
 * tap somebody made with the words in front of them.
 *
 * So the screen is built around one question per row: *do I agree?* Which is
 * why every row shows the item's own words IN FULL rather than a clipped line.
 * A triage list can clip — you are looking for one thing you recognise. A diff
 * cannot: the sentence being retired is the entire content of the decision, and
 * two lines and an ellipsis is how you approve something you did not read.
 *
 * ── Merges get the whole card ──────────────────────────────────────────────
 *
 * Approving a merge means approving text the user did not write, in place of
 * text they did. There is no summary of that which is safe, so the card shows
 * the proposed prompt in full NEXT TO all N originals in full, names the ids it
 * was built from, and does not collapse. It is one decision about all N —
 * `applyAssessment`'s rule — so the tick lives on the card and every `merged`
 * row refuses its own accept with a sentence saying where the decision is.
 *
 * ── Where the confirmations are, and where they are not ────────────────────
 *
 * On the BULK buttons, which is where the danger is: one tap over thirty-one
 * prompts. `askConfirm` (never `window.confirm` — a native modal blocks the
 * WebView's event loop and renders in the APK as a system dialog stamped with
 * the local asset server's origin) with the repo NAMED and three REAL prompts
 * shown, because a person can check three sentences they recognise and cannot
 * check "31 rows". Applying is deliberately NOT behind a second dialog: every
 * decision in the set was either taken one row at a time with the words on
 * screen, or came through a bulk confirm that already showed them, and a dialog
 * that appears after every path is a dialog people learn to dismiss. The apply
 * button restates the whole decision instead.
 *
 * ── Nothing on this screen is greyed out ───────────────────────────────────
 *
 * There is no `disabled` attribute in this file, and adding one is the bug.
 * `Unavailable.tsx`'s rule, which this sheet broke in four places: a verb that
 * cannot run is not rendered as a control at all — it becomes a sentence
 * (`Unavailable` in the footer and the header, `CantInline` on a row) saying
 * what is unavailable and why. The reason used to live in a `title`, which on a
 * phone is invisible: what a person actually met was a button with the same
 * border, the same icon and the same label as the live one beside it, at
 * `opacity: .4`. On this screen that cost more than a dead tap — the row whose
 * accept is refused is a row somebody is trying to agree with.
 *
 * ── A pad note is judged and left — unless the run still wants it ──────────
 *
 * The pad is synced client state the host does not own, so no verdict on a note
 * is applicable: `assessAcceptBlocker` refuses every one of them and the row
 * draws a sentence where its buttons would be. That was the whole rule, and it
 * left `still wanted` — the one verdict meaning the words are worth doing —
 * with nowhere to go at all.
 *
 * `cleanAssessment` now closes it, on the shared side and structurally: a
 * `wanted` note is copied, verbatim, into `proposal.news` as an OFFER carrying
 * the note's id in `AssessNew.fromNote`. "Verbatim" is therefore a property of
 * the code that built the row rather than an instruction the CLI was asked to
 * follow. An offer ticks like any other new item — same `pickedNews` index,
 * same rejected key, no control of its own — and is DRAWN apart, because the
 * one thing a person must be able to do on this screen is tell their own words
 * from words the run invented: a `NotebookPen` head reading *from your pad*, a
 * `file it` verb (`NOTE_ITEM_WORDS`), and its own effect line.
 *
 * The half the host cannot do is the note coming OFF the pad, and `App` does it
 * on the `op.ack` receipt, never on the tick — see `onApply` there. Nothing on
 * this sheet touches the pad.
 *
 * ── Pictures ───────────────────────────────────────────────────────────────
 *
 * An item's words routinely NAME a file — a screenshot of the thing that is
 * wrong is how most of them get written — and a decision to retire those words
 * is a decision about what the picture showed. Reported, in those words: *"I
 * want to see the images and be able to tap them."* So every place this sheet
 * renders somebody's text, `ItemFiles` renders the files that text names
 * underneath it: the same `AttachStrip`, in the same `compact` mode, that the
 * queue, the pad and Activity draw. Not a second thumbnail path and not
 * `Markdown` — on this screen the words ARE the decision and re-typesetting
 * them would change what is being approved. The strip already owns the hard
 * cases and all three matter here: a file that is gone reads as a stated fact,
 * offline reads as "can't check without a connection", and every thumbnail
 * OPENS through the one `requestAttachOpen` route App already listens on.
 *
 * ── Ticks survive a side trip ──────────────────────────────────────────────
 *
 * `App` returns early once per overlay, so opening the plan, an item, or a
 * picture UNMOUNTS this sheet — and forty rows of decisions went with it. The
 * ticks are therefore kept per run in `assessPicks.ts` (in memory, per tab,
 * never persisted) and read back at mount. It is the precondition for the
 * pictures above: tapping a thumbnail is now something this screen actively
 * invites, and inviting somebody out of a half-made decision that is then
 * thrown away is worse than not offering the tap.
 *
 * ── What this file is not ──────────────────────────────────────────────────
 *
 * It is a VIEW. Every sentence about a verdict comes from `@waterplane/shared`
 * (`assessVerdictLabel`, `assessRowSentence`, `downgradeText`) so the phone's row
 * and the host's stored reason cannot word one fact two ways — `clihealth.ts`'s
 * rule — and every rule about order, grouping, refusals and confirmation text
 * comes from `assessRows.ts`, where it is pinned by `node --test`. It opens no
 * socket, reads no App state and fetches nothing: it takes props and calls back,
 * and the callers are expected to say what happened, because a tap on this
 * screen that produces silence is indistinguishable from one that lost the work.
 */
import { ClipboardCheck } from "lucide-react";
import { Sheet } from "./Sheet";
import type { AssessSheetProps } from "./assess/asxTypes";
import { useAssessSheet } from "./assess/useAssessSheet";
import { AsxActions } from "./assess/AsxActions";
import { AsxFooter } from "./assess/AsxFooter";
import { AsxHead } from "./assess/AsxHead";
import { AsxNews } from "./assess/AsxNews";
import { AsxSlotCards } from "./assess/AsxSlotCards";
import { AsxStrips } from "./assess/AsxStrips";
import { AsxTail } from "./assess/AsxTail";
import { AsxTop } from "./assess/AsxTop";

export type { AssessSheetProps } from "./assess/asxTypes";

// This file is the FACADE. `assess/useAssessSheet.ts` holds every hook, in the
// order they were declared; `assess/Asx*.tsx` are the regions, with no hooks of
// their own (docs/notes/assess-architecture.md).
export function AssessSheet(p: AssessSheetProps) {
  const m = useAssessSheet(p);
  const { run, proposal } = m;

  /**
   * **One scroll region, and a head that holds only what is true at every
   * scroll position.**
   *
   * `BuildSheet`'s `.build-body` rule, arrived at here the expensive way. The
   * guide block, the verdict summary and the run's own detail line were all
   * drawn ABOVE the list, so the head grew to five rows of chrome and the rows
   * a person came here to read were a strip 81 px tall — measured, at 400×850,
   * over 9,361 px of proposal. A screen whose whole purpose is *read the words,
   * decide* had been letterboxed by the explanation of how to read the words.
   *
   * So everything explanatory scrolls WITH what it explains, in `.sheet-scroll`
   * (the sheet's own container — never a second scroller nested in a scroller,
   * which on a phone is its own bug), and what stays pinned is the title row,
   * the actions and the run's status. Those three answer "what am I looking at"
   * identically at row one and at row sixty; nothing else here does.
   *
   * The verdict pills scroll rather than pin, deliberately. They are a summary
   * of the whole proposal, not a control — no tap, no filter — and they cost
   * two of the six lines the head had at 400 px wide. A summary is worth
   * reading once, at the top, on the way to the rows; a fifth of the screen,
   * for ever, is not what it is worth.
   */
  return (
    <Sheet
      className="assess-sheet"
      title={<span title={p.repoDir}>{p.repoName}</span>}
      icon={<ClipboardCheck size={18} />}
      onClose={p.onClose}
      footer={proposal ? <AsxFooter m={m} /> : null}
      actions={<AsxActions m={m} />}
      head={run ? <AsxHead m={m} /> : null}
    >
      <div className="sheet-scroll">
        <AsxTop m={m} />
        <div className="list act-list">
          <AsxSlotCards m={m} />
          <AsxStrips m={m} />
          <AsxNews m={m} />
          <AsxTail m={m} />
        </div>
      </div>
    </Sheet>
  );
}
