/**
 * The slot check's two cards: a CONFLICT (words — no tick, nothing applied) and
 * a SPLIT (one row as two; approve or leave). `MergeCard`'s rules: every text
 * in full, every id named, nothing behind a disclosure.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { AlertTriangle, Check, ExternalLink, GitFork, Pencil, Scale, X } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import {
  CONFLICT_DROP_CONFIRM, CONFLICT_DROP_LABEL, CONFLICT_DROP_TITLE, CONFLICT_IGNORE_LABEL, CONFLICT_NOTE,
  type SlotCardRow,
} from "../slotCheck";
import { track } from "../usage";
import { ICON } from "./asxConst";
import { ItemFiles } from "./AsxParts";
import type { AssessModel } from "./useAssessSheet";
import { Button } from "../kit/Button";
import { Hint } from "../kit/Hint";
import { Tag } from "../kit/Tag";

function Words({ row, m }: { row: SlotCardRow; m: AssessModel }) {
  const { p } = m;
  return row.text == null
    ? <span className="act-stale"><AlertTriangle size={11} /> {row.id} — its words are not on this phone</span>
    : <>
      <span className="act-text act-text-full">{row.text}</span>
      <ItemFiles text={row.text} repoId={p.repoId} outbox={p.outbox} online={p.online} />
    </>;
}

export function AsxSlotCards({ m }: { m: AssessModel }) {
  const { p, conflicts, splits, pickedSplits, setPickedSplits, rejected, setRejected, acceptSplit, itemsById } = m;
  if (!conflicts.length && !splits.length) return null;
  const flip = (key: string) => setRejected((s) => { const n = new Set(s); if (!n.delete(key)) n.add(key); return n; });
  return (
    <>
      {conflicts.length ? (
        <div className="act-group">
          <div className="act-group-head"><Tag className="tag-failed">contradict</Tag><span className="act-group-n">{conflicts.length}</span></div>
          <div className="act-verdict assess-effect">{CONFLICT_NOTE}</div>
          {conflicts.map((c) => {
            const left = rejected.has(`conflict:${c.cid}`);
            return (
              <div key={c.cid} className={`q-card${left ? " act-filed" : ""}`}>
                <div className="q-head"><Scale size={14} /><span className="bl-group-title">{c.sentence}</span></div>
                {c.rows.map((r) => {
                  const item = itemsById.get(r.id);
                  return (
                    <div key={r.id} className="act-row">
                      <div className="act-body">
                        <span className="act-head"><span className="act-when mono">{r.id}</span></span>
                        <Words row={r} m={m} />
                        {p.online || (item && p.onOpenItem) ? (
                          <div className="act-acts">
                            {item && p.onOpenItem ? (
                              <Button title="show it where its words live"
                                onClick={() => { track("action:assess.conflict.open"); p.onOpenItem?.(item); }}>
                                <ExternalLink size={ICON} /> open
                              </Button>
                            ) : null}
                            {p.online && p.onEditItem ? (
                              <Button title="change its words or its time — the send sheet, with this row in it"
                                onClick={() => { track("action:assess.conflict.edit"); p.onEditItem?.(r.id); }}>
                                <Pencil size={ICON} /> edit
                              </Button>
                            ) : null}
                            {p.online && p.onDropItem ? (
                              <ConfirmButton confirm={CONFLICT_DROP_CONFIRM} title={CONFLICT_DROP_TITLE}
                                onConfirm={() => { track("action:assess.conflict.drop"); p.onDropItem?.(r.id); }}>
                                <X size={ICON} /> {CONFLICT_DROP_LABEL}
                              </ConfirmButton>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {!p.online ? <Hint>No connection — edit and drop wait for the link.</Hint> : null}
                <div className="act-acts">
                  <Button className={left ? "active" : undefined} title={left ? "un-mark it" : "leave every row here as it is — nothing is sent either way"}
                    onClick={() => { track("action:assess.conflict.ignore"); flip(`conflict:${c.cid}`); }}>
                    <Check size={ICON} /> {left ? "left as they are" : CONFLICT_IGNORE_LABEL}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {splits.length ? (
        <div className="act-group">
          <div className="act-group-head"><Tag className="tag-running">split</Tag><span className="act-group-n">{splits.length}</span></div>
          {splits.map((s) => {
            const on = pickedSplits.has(s.sid);
            const left = rejected.has(`split:${s.sid}`);
            return (
              <div key={s.sid} className={`q-card${left ? " act-filed" : ""}`}>
                <div className="q-head"><GitFork size={14} /><span className="bl-group-title">{s.sentence}</span></div>
                <div className="section section-head"><span>the item as written</span><span className="section-hint mono">{s.id}</span></div>
                <div className="act-row"><div className="act-body"><Words row={s.original} m={m} /></div></div>
                <div className="section section-head"><span>the two it would become</span><span className="section-hint">written by the assessment, not by you</span></div>
                {s.texts.map((t, i) => (
                  <div key={i} className="act-row"><div className="act-body">
                    <span className="act-text act-text-full">{t}</span>
                    <ItemFiles text={t} repoId={p.repoId} outbox={p.outbox} online={p.online} />
                  </div></div>
                ))}
                <div className="act-acts">
                  <Button className={on ? "primary" : undefined}
                    title={on ? "approved — tap to un-approve" : "approve: the original is archived (words kept) and these two are posted on its clock"}
                    onClick={() => acceptSplit(s)}>
                    <Check size={ICON} /> {on ? "approved" : "approve the split"}
                  </Button>
                  <Button className={left ? "active" : undefined} title={left ? "un-mark it" : "keep it as one item"}
                    onClick={() => {
                      track("action:assess.split.leave");
                      flip(`split:${s.sid}`);
                      setPickedSplits((x) => { const n = new Set(x); n.delete(s.sid); return n; });
                    }}>
                    <X size={ICON} /> keep it as one
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
