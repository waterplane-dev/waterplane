/**
 * The list: its empty state (keyed on the UNFILTERED rows — a cut matching
 * nothing must not claim the repo has no backlog), the group heads by where
 * a row will run, and the rows.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { ArrowRight, CircleDot, CircleOff } from "lucide-react";
import { BacklogRow } from "./BacklogRow";
import { Empty } from "../Empty";
import type { BacklogModel } from "./backlogTypes";
import { CLOSED_GROUP } from "./backlogLabels";
import { Tag } from "../kit/Tag";

export function BacklogList({ m }: { m: BacklogModel }) {
  const { base, displayOrder, dragId, groups, hereInRepo, q } = m;
  return (
      <div
        className="list"
        style={{ touchAction: dragId ? "none" : undefined }}
      >
        {displayOrder.length === 0 && (
          // Keyed on the UNFILTERED list: a cut that matches nothing must not
          // claim the repo has no backlog.
          <Empty>{
            base.length === 0 ? "Nothing waiting for this repo — “send…” above writes one."
            : q ? "No match in this repo."
            : `Nothing here matches that filter — ${base.length} item${base.length === 1 ? "" : "s"} are hidden by it.`
          }</Empty>
        )}
        {groups.map((g) => (
          <div key={g.key || "__default"} className="bl-group">
            <div className="bl-group-head">
              <span className="bl-group-title">
                {g.key === CLOSED_GROUP ? <><CircleOff size={13} /> {g.title}</>
                  : g.key ? <><ArrowRight size={13} /> {g.title}</>
                    : <><CircleDot size={13} /> {g.title}</>}
                {/* Which of these queues is the one you are looking at.
                    The groups ARE the per-session queues and the numbers down
                    the left ARE the run order, so *queue here* needed no new
                    view — only wayfinding: with three sessions open in a repo
                    there were four identical-looking groups and nothing saying
                    which one a tap had just added to. */}
                {hereInRepo && g.key === hereInRepo.id && <Tag className="bl-here">on screen</Tag>}
              </span>
              <span className="bl-group-meta">
                {`${g.items.length} item${g.items.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {/* What to DO about it, once per group rather than once per row —
                these rows are not waiting on anything that will happen, so the
                heading alone would leave a reader watching a queue that never
                moves. */}
            {g.key === CLOSED_GROUP && (
              <div className="empty bl-group-empty">
                The session each of these was aimed at has exited. Nothing re-aims them: edit one to
                pick another session or a new one, take the aim off, or remove it.
              </div>
            )}
        {g.items.map((it, idx) => <BacklogRow key={it.id} m={m} g={g} it={it} idx={idx} />)}
          </div>
        ))}
      </div>
  );
}
