/**
 * The launcher row's "waiting on pc · 4 min" tag. The words are
 * `sessionFacts.tsx`'s `peerWaitPill` (shared `peerWaitWords`); this is only the
 * tap: switch to the saved desktop the peer's address names and open the job's
 * session there. No saved desktop matches ⇒ the tap says so in text.
 *
 * Drawn only when the session waits on a peer, so a row that never delegated
 * is exactly what it was. A span with role="button", like the row's other
 * tappable tags (`tag-filter`), because it sits beside a row `<button>`.
 */
import type { SessionInfo } from "@waterplane/shared";
import { peerWaitPill } from "../../sessionFacts";
import { useNow } from "../../useNow";
import { openPeerSession, pairableHosts } from "./actions";
import { peerTagFacts } from "./logic";
import { activeHost } from "../../hosts";

export function PeerWaitTag({ s }: { s: SessionInfo }) {
  // A minute grain: the age is in whole minutes.
  const now = useNow(30_000);
  if (!s.peerWait) return null;
  const pill = peerWaitPill(s, now);
  const facts = peerTagFacts(s, pairableHosts(), activeHost()?.id ?? null, now);
  if (!pill || !facts) return null;
  const open = () => openPeerSession(facts, s.peerWait!.peer);
  return (
    <span className={`tag ${pill.cls} tag-filter`} role="button" tabIndex={0} title={facts.title}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); } }}
      onClick={(e) => { e.stopPropagation(); open(); }}>
      {pill.body}
      {!facts.target && <> · not a saved desktop</>}
    </span>
  );
}
