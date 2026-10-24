/**
 * The proposed new items and the pad notes offered as items.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { Check, NotebookPen, Plus, X } from "lucide-react";
import { LEAVE_WORDS, NEW_ITEM_WORDS, NOTE_ITEM_WORDS, assessNoteItemNote, assessNewItemNote } from "../assessRows";
import { track } from "../usage";
import { ICON } from "./asxConst";
import { NameHead, ItemFiles } from "./AsxParts";
import type { AssessModel } from "./useAssessSheet";
import { Button } from "../kit/Button";

export function AsxNews({ m }: { m: AssessModel }) {
  const { p, proposal, pickedNews, setPickedNews, rejected, toggleNew, toggleReject } = m;
  return (
    <>
      {proposal && proposal.news.length ? (
        <>
          {/* **The head has to be true of BOTH kinds of card below it.**
              It said "these are new items, not verdicts on yours", which is
              exactly wrong about an offer: an offer IS a row of yours, word
              for word, and the reason it is here rather than in a strip is
              that the pad is the one store nothing on this screen can edit
              in place. So the hint names what is actually in the list. */}
          <div className="section section-head">
            <span>{proposal.news.some((n) => n.fromNote) ? "what it proposes to add" : "missing pieces it proposes"}</span>
            <span className="section-hint">
              {proposal.news.some((n) => n.fromNote)
                ? "new items the run wrote, and pad notes of yours it says are still worth doing — offered in your own words"
                : "prose and a position, and nothing else — these are new items, not verdicts on yours"}
            </span>
          </div>
          {/* What accepting one of these does, in the same voice the strips
              use, because `accept` here means the opposite of `accept` twelve
              rows above: nothing is retired, one new item is POSTED.

              Drawn only where there IS a proposed new item. An offer carries
              its own sentence on its own card (`assessNoteItemNote`), because
              what happens to it is a different thing — it is filed, and a
              note comes off the pad — and a strip-wide line claiming the
              run's promise over somebody's own words is the confusion this
              whole section is arranged to prevent. */}
          {proposal.news.some((n) => !n.fromNote)
            ? <div className="act-verdict assess-effect">{assessNewItemNote(p.repoName)}</div>
            : null}
          {proposal.news.map((n, i) => {
            /**
             * **Whose words are on this card.**
             *
             * `fromNote` is set by `cleanAssessment` alone, and only where it
             * COPIED a pad note the run said is still wanted — so it is a
             * fact about provenance, not a hint. The two cards must not look
             * alike: side by side, one holds a sentence a model wrote and one
             * holds a sentence the person wrote, and telling them apart is
             * the entire reason the offer carries the note's text verbatim.
             *
             * Everything structural stays shared — the same `pickedNews`
             * index, the same rejected key, the same leave button, no extra
             * control. What changes is the head (a `NotebookPen`, not a
             * `Plus`), the effect line and the verb.
             */
            const offer = !!n.fromNote;
            const words = offer ? NOTE_ITEM_WORDS : NEW_ITEM_WORDS;
            return (
            <div key={i} className={`q-card${offer ? " asr-offer" : ""}${rejected.has(`new:${i}`) ? " act-filed" : ""}`}>
              <div className="q-head">
                {offer ? <NotebookPen size={14} /> : <Plus size={14} />}
                <span className="bl-group-title">{offer ? "from your pad" : "a new item"}</span>
                {n.rank != null ? <span className="act-count">position {n.rank}</span> : null}
              </div>
              {/* Same as a merge's, and for the same reason: a new item's
                  title is part of the row being posted, not a decision about
                  words somebody else wrote.

                  On an offer the TITLE is still the run's — a naming is a
                  reading of the words, and `Sparkles` says so — while the
                  prompt underneath it is not. That is the one place the two
                  voices meet on one card, and the mark is what keeps them
                  told apart. */}
              {n.headline || n.category ? (
                <div className="act-head asr-namehead">
                  <NameHead headline={n.headline} suggested={!!n.headline} category={n.category} />
                </div>
              ) : null}
              {/* The offer's own promise, on the card, because it is a
                  promise about THIS card: the words are filed and the note
                  comes off the pad — after the desktop confirms, never on
                  the tick. TEXT, never a `title` (`Unavailable.tsx`'s rule:
                  a tooltip is invisible on a phone). */}
              {offer ? <div className="act-verdict assess-effect">{assessNoteItemNote(p.repoName)}</div> : null}
              <div className="act-text act-text-full">{n.prompt}</div>
              {/* A proposed prompt may name a file too — usually one it
                  inherited from the items it was written out of. A note's
                  own words routinely name one outright. */}
              <ItemFiles text={n.prompt} repoId={p.repoId} outbox={p.outbox} online={p.online} />
              <div className="act-acts">
                <Button className={pickedNews.has(i) ? "primary" : undefined}
                  title={pickedNews.has(i) ? words.pickedTitle : words.title}
                  onClick={() => { track(offer ? "action:assess.accept.note" : "action:assess.accept.new"); toggleNew(i); }}>
                  <Check size={ICON} /> {pickedNews.has(i) ? words.picked : words.label}
                </Button>
                <Button className={rejected.has(`new:${i}`) ? "active" : undefined}
                  title={rejected.has(`new:${i}`)
                    ? LEAVE_WORDS.pickedTitle
                    : offer ? "leave the note on the pad — nothing is filed and nothing is removed" : "do not add this"}
                  onClick={() => { track("action:assess.leave"); toggleReject(`new:${i}`, () => setPickedNews((s) => { const x = new Set(s); x.delete(i); return x; })); }}>
                  <X size={ICON} /> {rejected.has(`new:${i}`) ? LEAVE_WORDS.picked : LEAVE_WORDS.label}
                </Button>
              </div>
            </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}
