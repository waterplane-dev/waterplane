import { useState } from "react";
import { CheckCheck, ChevronDown, ChevronUp, Copy, Square, SquareCheck } from "lucide-react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import type { ActivityActionId, ActivityGroup, ActivityRow } from "../activityRows";
import { ago } from "../format";
import type { OutboxEntry } from "../outbox";
import { track } from "../usage";
import { Row } from "./ActivityRowCard";
import type { ReviewMarks } from "./activitySheetTypes";

/**
 * A group of rows that say the same thing.
 *
 * The report behind this screen: the unresolved sends are "mostly repeated
 * re-sends of the same few texts" — which is what a person does when the app
 * tells them their prompt did not run. So the collapsed group is the unit of
 * DECISION: one strip, one set of words, and the two numbers that actually
 * change the answer — how many copies there are, and whether one of them ran.
 *
 * The lead row keeps all of its own buttons. A group is a reading aid and a
 * selection handle; it never merges two rows into one thing that can be acted
 * on as a whole by anything but the bulk bar, which says what it will cover.
 */
export function Group({ g, now, sessions, repos, outbox, online, reviews, repoIdForCwd, selecting, selected, onToggleRow, onToggleGroup, onAction, onRetarget, onOpenSession }: {
  g: ActivityGroup;
  now: number;
  sessions: readonly SessionInfo[];
  repos: readonly RepoTarget[];
  outbox: readonly OutboxEntry[];
  online: boolean;
  reviews?: Readonly<Record<string, ReviewMarks>>;
  repoIdForCwd: (cwd: string) => string | null;
  selecting: boolean;
  selected: ReadonlySet<string>;
  onToggleRow: (key: string) => void;
  onToggleGroup: (g: ActivityGroup) => void;
  onAction: (id: ActivityActionId, row: ActivityRow) => void;
  onRetarget: (row: ActivityRow, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const n = g.rows.length;
  const also = g.elsewhere.done;
  const pickOf = (r: ActivityRow) => (selecting ? { checked: selected.has(r.key), onToggle: () => onToggleRow(r.key) } : undefined);
  if (n === 1 && also === 0 && g.elsewhere.other === 0) {
    return <Row row={g.rows[0]} now={now} sessions={sessions} repos={repos} pick={pickOf(g.rows[0])}
      outbox={outbox} online={online} review={reviews?.[g.rows[0].id]} repoIdForCwd={repoIdForCwd}
      onAction={onAction} onRetarget={onRetarget} onOpenSession={onOpenSession} />;
  }
  const allPicked = g.rows.every((r) => selected.has(r.key));
  return (
    <div className="act-group">
      <div className="act-group-head">
        {selecting ? (
          <button className={`act-pick${allPicked ? " on" : ""}`} aria-label={allPicked ? "deselect these" : "select these"}
            title={allPicked ? `deselect all ${n}` : `select all ${n}`} onClick={() => onToggleGroup(g)}>
            {allPicked ? <SquareCheck size={18} /> : <Square size={18} />}
          </button>
        ) : null}
        {n > 1 ? <span className="act-group-n"><Copy size={11} /> ×{n}</span> : null}
        {n > 1 ? <span className="act-group-span">{ago(g.oldestAt)} → {ago(g.newestAt)}</span> : null}
        {/* The one fact that decides "already done", and the reason grouping
            counts against the WHOLE list and not the filtered one: a copy that
            ran is sitting under `done`, which is exactly the chip somebody
            triaging failures is not looking at. */}
        {also > 0 ? <span className="act-group-ran"><CheckCheck size={11} /> {also === 1 ? "one of these already ran" : `${also} of these already ran`}</span> : null}
        {g.elsewhere.other > 0 ? <span className="act-group-else">{g.elsewhere.other} more elsewhere in the list</span> : null}
        {n > 1 ? (
          <button className="key act-group-more" title={open ? "collapse these" : `show all ${n} copies`}
            onClick={() => { track("action:activity.expand"); setOpen((v) => !v); }}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : null}
      </div>
      {(open ? g.rows : g.rows.slice(0, 1)).map((r) => (
        <Row key={r.key} row={r} now={now} sessions={sessions} repos={repos} pick={pickOf(r)}
          outbox={outbox} online={online} review={reviews?.[r.id]} repoIdForCwd={repoIdForCwd}
          onAction={onAction} onRetarget={onRetarget} onOpenSession={onOpenSession} />
      ))}
    </div>
  );
}
