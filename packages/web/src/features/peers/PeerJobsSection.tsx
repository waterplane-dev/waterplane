/**
 * Activity's "peer jobs" section: every job THIS desktop handed to a paired one,
 * open or settled — its state, how long it ran, what it cost there, and a way to
 * both sessions (the one that asked, here; the one that worked, on the peer).
 *
 * Read off the asker's ledger (`GET /api/peerjobs`, trusted path, read-only) —
 * the same rows the asking sessions' facts are built from, so the two cannot
 * disagree. Words are `logic.ts`'s `peerJobRowFacts` over shared `peer.ts`.
 *
 * Absent entirely on a desktop that never delegated (a section saying "none"
 * on every Activity visit is furniture); a read that failed says so. Nothing
 * here acts on a job: a link opens a session, it never cancels or re-sends.
 */
import { Link2, Terminal } from "lucide-react";
import type { PeerJobLedgerRow, SessionInfo } from "@waterplane/shared";
import { api } from "../../api";
import { Empty, useRemoteResource, Button, Row, RowTitle, RowSub, Hint } from "../../kit";
import { activeHost } from "../../hosts";
import { useNow } from "../../useNow";
import { openPeerSession, pairableHosts } from "./actions";
import { noHostText, peerJobRowFacts, peerTagFacts } from "./logic";

const ICON = 14;

export function PeerJobsSection({ sessions, onOpenSession }: {
  sessions: readonly SessionInfo[];
  onOpenSession: (sessionId: string) => void;
}) {
  const now = useNow(30_000);
  const res = useRemoteResource<PeerJobLedgerRow[]>("peerjobs", () => api.peerJobs());
  const rows = res.data ?? [];
  // Never delegated (or not read yet): no section. A read that FAILED is said.
  if (!rows.length && res.state !== "error") return null;

  return (
    <div className="peer-jobs">
      <Hint style={{ marginTop: 10 }}><Link2 size={12} /> Peer jobs — work this desktop handed to another</Hint>
      <Empty res={res} empty={rows.length === 0} thing="this desktop's peer jobs" noun="job list" />
      <div className="list">
        {rows.map((r) => {
          const f = peerJobRowFacts(r, now);
          const asker = r.sessionId ? sessions.find((s) => s.id === r.sessionId && s.running) : undefined;
          const tag = peerTagFacts({ peerWait: { peer: r.peer, jobId: r.jobId, state: r.state, since: r.since, ...(r.peerSessionId ? { peerSessionId: r.peerSessionId } : {}), ...(r.peerBase ? { peerBase: r.peerBase } : {}) } },
            pairableHosts(), activeHost()?.id ?? null, now);
          return (
            <Row key={r.jobId} kind="wrap">
              <Row kind="grow">
                <RowTitle>{f.title}</RowTitle>
                <RowSub className={f.bad ? "warn" : undefined}>{f.state}</RowSub>
                {f.cost && <RowSub>{f.cost}</RowSub>}
                {f.tokens && <RowSub>{f.tokens}</RowSub>}
                {f.costNote && <RowSub>{f.costNote}</RowSub>}
                {!f.cost && !f.tokens && <RowSub>{r.peer} has not said what it cost{r.closed ? "" : " yet"}</RowSub>}
                {f.asker && <RowSub>asked by {f.asker}</RowSub>}
                {f.detail && <RowSub>{f.detail}</RowSub>}
                <span className="act-acts">
                  {asker
                    ? <Button onClick={() => onOpenSession(asker.id)}><Terminal size={ICON} /> the asking session</Button>
                    : <RowSub>the asking session is no longer open here</RowSub>}
                  {tag?.target
                    ? <Button title={tag.title} onClick={() => openPeerSession(tag, r.peer)}><Link2 size={ICON} /> {r.peerSessionId ? `its session on ${r.peer}` : `open ${r.peer}`}</Button>
                    : <RowSub>{noHostText(r.peer)}</RowSub>}
                </span>
              </Row>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
