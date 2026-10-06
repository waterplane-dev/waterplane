/**
 * The verdict strips and their rows and merge cards.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { CheckCheck, ChevronDown, ChevronUp } from "lucide-react";
import { assessBulkWords, assessDowngradeTally, assessAcceptWords } from "../assessRows";
import { track } from "../usage";
import { VERDICT_TAG } from "./asxConst";
import { RowCard } from "./AsxRowCard";
import { MergeCard } from "./AsxMergeCard";
import type { AssessModel } from "./useAssessSheet";

export function AsxStrips({ m }: { m: AssessModel }) {
  const { p, pickedRows, setPickedRows, pickedMerges, setPickedMerges, rejected, flipped, setFlipped, groups, itemsById, toggleRow, toggleReject, bulkGroup, acceptMerge } = m;
  return (
    <>
      {groups.map((g) => {
        const open = g.fixedOpen || (flipped.has(g.verdict) ? !g.defaultOpen : g.defaultOpen);
        const tally = g.verdict === "unclear" ? assessDowngradeTally(g.rows) : [];
        /** How many of this strip's rows are ticked right now — what turns
         *  `accept all 12` into `un-tick 12`, decided in `assessRows.ts`. */
        const pickedInStrip = g.rows.filter((r) => !r.acceptBlocked && pickedRows.has(r.id)).length;
        const bulk = assessBulkWords(g, pickedInStrip, { repoName: p.repoName });
        return (
          <div key={g.verdict} className="act-group">
            <div className="act-group-head">
              <span className={VERDICT_TAG[g.verdict]}>{g.label}</span>
              {/* **The number is the ITEMS this strip is about**, which is not
                  `rows.length` on the merged strip: a merge is one card
                  standing for N items, and counting cards there said "1" over
                  a decision about five things somebody wrote. */}
              <span className="act-group-n">{g.count}</span>
              {/* No button at all where a bulk tap could not mean anything —
                  merged (the decision is on the card), unclear (nothing was
                  decided), a strip of pad notes. Never a dead one. */}
              {bulk ? (
                <button className="key" title={bulk.title} onClick={() => bulkGroup(g, bulk)}>
                  <CheckCheck size={14} /> {bulk.label}
                </button>
              ) : null}
              {g.fixedOpen ? null : (
                <button className="key act-group-more" title={open ? "collapse this" : "show these"}
                  onClick={() => { track(`action:assess.strip.${g.verdict}`); setFlipped((s) => { const n = new Set(s); if (!n.delete(g.verdict)) n.add(g.verdict); return n; }); }}>
                  {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              )}
            </div>
            {/* **What accepting anything on this strip DOES**, said once per
                strip rather than left to a verb. "accept" reads as "accept
                this task, go and build it" on a list of work items, which is
                the one thing this screen never does. Not on `merged`: that
                strip's decision is stated on the card it is taken on, and a
                second wording of it above would be two answers to one
                question.

                Asked of the VERDICT and nothing else. It used to be asked of
                the strip's first ROW, "because a backlog item is retired and
                a pad note is judged and left" — which has not been what
                happens since the pad became a case `assessAcceptBlocker`
                refuses outright: no note ever reaches these words, and the
                lookup was a fact about one row dressed as a fact about all of
                them. Which store a row is in decides whether it can be ticked
                AT ALL, and that is said on the row, where the tap is.

                Still true with the offer in: a `wanted` note's refusal now
                POINTS at the offer card instead of closing the row, but it is
                a refusal all the same — the tick that does something is on
                the card, under *what it proposes to add*, and never here. */}
            {/* `g.failed` and not a row lookup: the strip's line has to
                cover a strip that holds both kinds of `wanted` row, and it
                is the strip's own count — the one the bulk button's
                confirmation names — that decides whether the going-back-in-
                the-queue half is said at all. */}
            {open && g.verdict !== "merged"
              ? <div className="act-verdict assess-effect">{assessAcceptWords(g.verdict, undefined, g.failed > 0).effect}</div>
              : null}
            {open && tally.length ? (
              <div className="act-group-head">
                {tally.map((t) => <span key={t.down} className="act-count">{t.n} × {t.text}</span>)}
              </div>
            ) : null}
            {open ? g.merges.map((card) => (
              <MergeCard key={card.gid} card={card}
                accepted={pickedMerges.has(card.gid)}
                rejected={rejected.has(`merge:${card.gid}`)}
                repoId={p.repoId} outbox={p.outbox} online={p.online}
                onAccept={() => acceptMerge(card)}
                onReject={() => toggleReject(`merge:${card.gid}`, () => setPickedMerges((s) => { const n = new Set(s); n.delete(card.gid); return n; }))} />
            )) : null}
            {open ? g.rows.map((r) => {
              const item = itemsById.get(r.id);
              return (
                <RowCard key={r.id} r={r}
                  accepted={pickedRows.has(r.id)}
                  rejected={rejected.has(`row:${r.id}`)}
                  repoId={p.repoId} outbox={p.outbox} online={p.online}
                  onAccept={() => { track(`action:assess.accept.${r.verdict}`); toggleRow(r.id); }}
                  onReject={() => { track("action:assess.leave"); toggleReject(`row:${r.id}`, () => setPickedRows((s) => { const n = new Set(s); n.delete(r.id); return n; })); }}
                  onOpen={item && p.onOpenItem ? () => { track("action:assess.open"); p.onOpenItem?.(item); } : undefined} />
              );
            }) : null}
          </div>
        );
      })}
    </>
  );
}
