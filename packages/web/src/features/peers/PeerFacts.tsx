/**
 * What a session's peer jobs say about it, outside the one "waiting on pc" tag
 * (`PeerWaitTag`): on the ASKING desktop, its cost split by desktop and one line
 * per job it sent; on the PEER, why the session exists. Every word is
 * `sessionFacts.tsx`'s (over shared `peer.ts`) — this file only places them.
 *
 * Readouts, never controls: nothing here is tappable, disabled or greyed, and a
 * session that never delegated (and is no job's) draws nothing at all.
 */
import type { SessionInfo } from "@waterplane/shared";
import { peerJobLines, peerOriginPill, peerSpendPill } from "../../sessionFacts";
import { RowSub, Tag } from "../../kit";

/** The launcher row's tags: "$22.28 here + $0.84 on pc", "job from mac · …". */
export function PeerRowTags({ s }: { s: SessionInfo }) {
  const spend = peerSpendPill(s);
  const origin = peerOriginPill(s);
  if (!spend && !origin) return null;
  return (
    <>
      {origin && <Tag className={origin.cls} title={origin.title}>{origin.body}</Tag>}
      {spend && <Tag className={spend.cls} title={spend.title}>{spend.body}</Tag>}
    </>
  );
}

/**
 * The session screen's facts: the same two tags, then one line per job this
 * session sent — "sent to pc: run e2e · done · $0.84 · 6 min" — open or settled,
 * so a job that finished an hour ago is still said where the session is read.
 */
export function PeerSessionFacts({ s }: { s: SessionInfo }) {
  const lines = peerJobLines(s);
  return (
    <>
      <PeerRowTags s={s} />
      {lines.map((j) => <RowSub key={j.key} className="peer-job-line">{j.text}</RowSub>)}
    </>
  );
}
