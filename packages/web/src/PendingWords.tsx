/**
 * **The words waiting for a session that does not exist yet, on that session's
 * own screen** (`features/activity/PendingPrompts.tsx` wires it).
 *
 * The owner's report (2026-11-20): a new session opened while the desktop was
 * unreachable showed one line ("starts when the desktop is back") over an empty
 * page, and the prompt written for it was only reachable through the queue
 * bar's *Waiting work* — another screen, a filter and a scroll away, for the one
 * thing this screen is about.
 *
 * So the pending screen draws the rows itself: the create (when it carries the
 * first prompt) and every prompt chained behind it (`createAck`). They are the
 * SAME rows Waiting work draws — `activityRows` builds them, `Row` paints them,
 * and the caller hands in Activity's own `act`/`retarget` — so *rewrite it*,
 * *discard* and *more* mean exactly what they mean there. No second set of verbs.
 */
import { useMemo } from "react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { activityRows, type ActivityActionId, type ActivityRow } from "./activityRows";
import { Row } from "./activity/ActivityRowCard";
import { isCreateOp, isEditableEntry, type OutboxEntry } from "./outbox";
import type { ActivityInput } from "./activity/activityTypes";

/** This create's own words: the create when it carries a prompt, and what is chained behind it. */
export function pendingWordsEntries(outbox: readonly OutboxEntry[], createAck: string): OutboxEntry[] {
  return outbox.filter((e) => e.createAck === createAck
    || (e.ackId === createAck && isCreateOp(e) && !!(e.op as { prompt?: string } | undefined)?.prompt));
}

export function PendingWords(p: {
  createAck: string;
  outbox: readonly OutboxEntry[];
  now: number;
  online: boolean;
  hostSeenAt: number | null;
  laneLabel: ActivityInput["deps"]["laneLabel"];
  repoName: (cwd: string) => string;
  queueBlocked: ActivityInput["queueBlocked"];
  goneLanes: readonly string[];
  sessions: readonly SessionInfo[];
  repos: readonly RepoTarget[];
  repoIdForCwd: (cwd: string) => string | null;
  onAction: (id: ActivityActionId, row: ActivityRow) => void;
  onRetarget: (row: ActivityRow, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const mine = useMemo(() => pendingWordsEntries(p.outbox, p.createAck), [p.outbox, p.createAck]);
  const rows = useMemo(() => !mine.length ? [] : activityRows({
    now: p.now, online: p.online, hostSeenAt: p.hostSeenAt,
    deps: { isEditableEntry, isCreateOp, laneLabel: p.laneLabel, repoName: p.repoName },
    outbox: mine,
    queueBlocked: p.queueBlocked,
    goneLanes: new Set(p.goneLanes),
    sessions: p.sessions,
  }), [mine, p.now, p.online, p.hostSeenAt, p.laneLabel, p.repoName, p.queueBlocked, p.goneLanes, p.sessions]);
  if (!rows.length) return null;
  return (
    <div className="term-pending-words" aria-label="waiting to go in">
      {rows.map((r) => (
        <Row key={r.key} row={r} now={p.now} sessions={p.sessions} repos={p.repos}
          outbox={p.outbox} online={p.online} repoIdForCwd={p.repoIdForCwd}
          onAction={p.onAction} onRetarget={p.onRetarget} onOpenSession={p.onOpenSession} />
      ))}
    </div>
  );
}
