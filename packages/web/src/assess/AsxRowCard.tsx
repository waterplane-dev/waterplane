/**
 * One assessed row.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { AlertTriangle, Check, FileText, X } from "lucide-react";
import { LEAVE_WORDS, assessMissingWords, assessRowHead, assessRowPosition, assessAcceptWords, type AssessDisplayRow } from "../assessRows";
import type { OutboxEntry } from "../outbox";
import { CantInline } from "../Unavailable";
import { ICON } from "./asxConst";
import { NameHead, ItemFiles } from "./AsxParts";

/** One assessed item: its words, whole, the pictures they name, and what the
 *  run concluded. */
export function RowCard({ r, accepted, rejected, onAccept, onReject, onOpen, repoId, outbox, online }: {
  r: AssessDisplayRow;
  accepted: boolean;
  rejected: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpen?: () => void;
  repoId: string;
  outbox: readonly OutboxEntry[];
  online: boolean;
}) {
  /**
   * **The row's own state decides the verb** — `keep it` on a queued row,
   * `put it back` on one that failed.
   *
   * Read off `r.failed` rather than asked here: `assessGroups` took it from the
   * item's `state`, which is the same field `applyAssessment` reads to choose
   * between a rank and a re-queue. Two readings of one fact is how a button
   * promises something the apply does not do — which is precisely what this row
   * did before the field existed, offering `keep it` over "position 1 in the
   * order" on a row nothing was ever going to look at again.
   */
  const words = assessAcceptWords(r.verdict, r.source, r.failed);
  /**
   * **The head names the row; it does not sample it.**
   *
   * It used to fall back to `r.id`'s label — and `label` is what `backlog.add()`
   * fills with `text.slice(0, 40)`, so what a reader actually met was the first
   * forty characters of the words, one line above the same words in full. Two
   * copies of one sentence, the shorter of which is a cut nobody made.
   * `assessRowHead` gives the store it came from, a name only where somebody
   * typed one, and the id only where the id is all there is: a row whose words
   * this phone does not hold.
   */
  const head = assessRowHead(r);
  /**
   * Why accepting this row would mean nothing — and then no accept and no leave
   * at all, rather than two controls that look live and are not.
   *
   * Read off the ROW rather than re-asked. `assessGroups` already answered it
   * for every row, with the one input this component cannot see from here
   * (whether the run's record holds the words at all), and a second call taking
   * a subset of the arguments is how a row comes to draw a button the bulk
   * button's own filter has excluded.
   */
  const blocked = r.acceptBlocked;
  return (
    <div className={`act-row${rejected ? " act-filed" : ""}${accepted ? " act-running" : ""}`}>
      <div className="act-body">
        {/* **The head names the row, and says whose name it is.** `kind` —
            *backlog item* over a list of backlog items — survives only where
            there is nothing better, which is where the word does its one piece
            of work: a `pad note` nobody has named reads as a pad note, and the
            refusal underneath it is about that store. */}
        <span className="act-head">
          {head.headline ? null : <span className="act-when">{head.kind}</span>}
          <NameHead headline={head.headline} suggested={head.suggested} category={head.category} />
          {head.id ? <span className="act-when mono">{head.id}</span> : null}
        </span>
        {/* The words, in FULL. This is the whole point of the screen: what is
            being retired is the sentence, and a clipped sentence is a decision
            taken about something nobody read.

            A row whose words are not in the run's record says so and stops
            there: what the absence COSTS is the `CantInline` below, where the
            buttons would have been, because that is the sentence that replaces
            a control. It used to say the desktop still had them and applying
            still worked — a promise about the one case in which nothing is
            applied at either end. */}
        {r.missing
          ? <span className="act-stale"><AlertTriangle size={11} /> {assessMissingWords(r.id)}</span>
          : <span className="act-text act-text-full">{r.text}</span>}
        {/* …and the pictures those words name, because for a great many items
            the screenshot IS what the sentence is about. */}
        <ItemFiles text={r.text} repoId={repoId} outbox={outbox} online={online} />
        {/* The finished sentence from `@waterplane/shared`, verbatim. A downgraded row
            says, in the shared module's words, that a claim was made and lost
            for want of a citation — which is the one thing a person scanning
            "could not tell" needs to see. */}
        <span className={`act-verdict${r.downgraded ? " act-last-bad" : ""}`}>
          {r.downgraded ? <AlertTriangle size={11} /> : null}{r.sentence}
        </span>
        {/* **What approving this verdict does to this row's PLACE** — and on a
            failed row that is not a position at all, it is a return to the
            queue. The literal that used to be here said "position N in the
            order" over a terminal row, which is a position in a queue the row
            is not in: `assessRowPosition` says the thing that will actually
            happen, and says it from the same module that says what Apply
            does. */}
        {(() => {
          const pos = assessRowPosition(r);
          return pos ? <span className="act-verdict">{pos}</span> : null;
        })()}
        {r.supersededByText
          ? <span className="act-verdict">the item said to cover it: “{r.supersededByText}”</span>
          : null}
        {blocked ? <CantInline>{blocked}</CantInline> : null}
        {rejected ? <span className="act-filed-note">left exactly as it is — nothing will happen to it</span> : null}
      </div>
      <div className="act-acts">
        {/* Where accepting would do nothing, there is no accept and no leave —
            the sentence above is the whole answer. A greyed pair here was two
            controls indistinguishable at a glance from the live ones on the row
            below, on the screen where the tap is the decision. `open` stays,
            and on an `unclear` row it is the only thing worth doing. */}
        {blocked ? null : (
          <>
            <button
              className={`key${accepted ? " primary" : ""}`}
              title={accepted ? words.pickedTitle : words.title}
              onClick={onAccept}
            >
              {/* **The EFFECT, not the verb** — before the tap and after it.
                  "accept" on a screen full of work items reads as "accept this
                  task", i.e. go and build it, which is the one thing this
                  screen never does; and "accepted" afterwards names no effect
                  at all. The words are `assessRows.ts`'s, per verdict and per
                  store. */}
              <Check size={ICON} /> {accepted ? words.picked : words.label}
            </button>
            <button
              className={`key${rejected ? " active" : ""}`}
              title={rejected ? LEAVE_WORDS.pickedTitle : LEAVE_WORDS.title}
              onClick={onReject}
            >
              <X size={ICON} /> {rejected ? LEAVE_WORDS.picked : LEAVE_WORDS.label}
            </button>
          </>
        )}
        {onOpen ? (
          <button className="key" title="show this item where it lives" onClick={onOpen}>
            <FileText size={ICON} /> open
          </button>
        ) : null}
      </div>
    </div>
  );
}
