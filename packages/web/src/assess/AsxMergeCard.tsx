/**
 * One merge card.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { AlertTriangle, Check, Merge, X } from "lucide-react";
import { assessRowHead, type AssessMergeCard } from "../assessRows";
import type { OutboxEntry } from "../outbox";
import { ICON } from "./asxConst";
import { NameHead, ItemFiles } from "./AsxParts";

/**
 * A merge, whole.
 *
 * Every rule the spec puts on this row type is structural here rather than
 * stated: it does not collapse, the proposed prompt is rendered in full, all N
 * originals are rendered in full underneath it, and the ids are named. Nothing
 * about a merge is behind a disclosure, because a disclosure left shut is how
 * somebody approves a prompt they never saw.
 */
export function MergeCard({ card, accepted, rejected, onAccept, onReject, repoId, outbox, online }: {
  card: AssessMergeCard;
  accepted: boolean;
  rejected: boolean;
  onAccept: () => void;
  onReject: () => void;
  repoId: string;
  outbox: readonly OutboxEntry[];
  online: boolean;
}) {
  const n = card.originals.length || card.ids.length;
  return (
    <div className={`q-card${rejected ? " act-filed" : ""}`}>
      <div className="q-head">
        <Merge size={14} />
        <span className="bl-group-title">one prompt in place of {n}</span>
        {card.rank != null ? <span className="act-count">position {card.rank}</span> : null}
      </div>
      <div className="act-verdict">
        {card.rationale || "no rationale was given — the prompt and the originals below are all there is to judge it on"}
      </div>

      <div className="section section-head">
        <span>the prompt it would run</span>
        <span className="section-hint">written by the assessment, not by you</span>
      </div>
      {/* What the posted row would be CALLED, above the words it would carry.
          A merge's name rides with its prompt whatever the naming switch says
          (`AssessPost.headline`) — a row the run wrote has no sentence of
          anybody's for a title to sit on top of — so it is shown here as part
          of the thing being approved, not as a separate decision. */}
      {card.headline || card.category ? (
        <div className="act-head asr-namehead">
          <NameHead headline={card.headline} suggested={!!card.headline} category={card.category} />
        </div>
      ) : null}
      <div className="act-text act-text-full">{card.prompt}</div>
      {/* The proposed prompt keeps whatever file mentions it inherited, and
          whether it still names the right picture is part of judging it. */}
      <ItemFiles text={card.prompt} repoId={repoId} outbox={outbox} online={online} />

      <div className="section section-head">
        <span>it replaces these {n}, in full</span>
        <span className="section-hint mono">{card.ids.join(" · ")}</span>
      </div>
      {card.originals.map((o) => {
        const oh = assessRowHead(o);
        return (
          <div key={o.id} className="act-row">
            <div className="act-body">
              <span className="act-head">
                {oh.headline ? null : <span className="act-when">{oh.kind}</span>}
                <NameHead headline={oh.headline} suggested={oh.suggested} category={oh.category} />
                {oh.id ? <span className="act-when mono">{oh.id}</span> : null}
              </span>
              {o.missing
                ? <span className="act-stale"><AlertTriangle size={11} /> not on this phone</span>
                : <span className="act-text act-text-full">{o.text}</span>}
              {/* Each original's own pictures: a merge is approved on what it
                  REPLACES, and a screenshot one of the N carried is part of
                  what the one new prompt has to still cover. */}
              <ItemFiles text={o.text} repoId={repoId} outbox={outbox} online={online} />
            </div>
          </div>
        );
      })}
      {card.missingIds.length ? (
        <div className="act-stale">
          <AlertTriangle size={11} /> {card.missingIds.length} of the items this merge names
          {card.missingIds.length === 1 ? " is" : " are"} not on this phone, so
          {card.missingIds.length === 1 ? " its words are" : " their words are"} not shown above.
        </div>
      ) : null}

      <div className="act-acts">
        <button className={`key${accepted ? " primary" : ""}`}
          title={accepted ? "approved — tap to un-approve" : `approve this merge: one new item, and all ${n} retired with a reason`}
          onClick={onAccept}>
          <Check size={ICON} /> {accepted ? "approved" : "approve the merge"}
        </button>
        <button className={`key${rejected ? " active" : ""}`}
          title={rejected ? "un-mark it" : "leave all of them exactly as they are"}
          onClick={onReject}>
          <X size={ICON} /> leave all {n}
        </button>
      </div>
    </div>
  );
}
