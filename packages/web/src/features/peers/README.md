# peers

Peer desktops (plan: `docs/analysis/peer-hosts-plan.md`): one waterplane host hands a job to another
and gets the answer back. This folder is the PHONE's half — it pairs two saved desktops and shows
that a session is waiting on one. The wire types and every sentence about a wait are
`@waterplane/shared`'s `peer.ts` (`peerAddressOk`, `peerWaitWords`) and are never re-worded here.

**Owns**

- `PeersSheet.tsx` — pick two saved desktops, pair both ways, list pairings (one line per pair, the
  two halves folded), unpair. Not a registered sheet: it is drawn inside the Hosts sheet
  (`HostSwitcherSheet.tsx`, a "peers" entry), so it has no `Overlay` id and Back returns to the list.
  Android shell only — a browser page knows one host.
- `actions.ts` — `loadPeers`, `pairHosts`, `unpair`, `openPeerSession`. Each host is called at its
  OWN base with its own device token (`api.peers.on`, absolute base like `api.pair.redeem`), the
  active one's from `deviceToken()`, a parked one's from its parked key.
- `logic.ts` — pure: `hostPeerAddr` (saved base → `host:port`, or why not), `pairRefusal`,
  `pairBodies` (who is told which token), `pairedRows` (fold the two halves), `sidesText` (which
  side failed), `hostForPeerBase`, `peerTagFacts`, `peerSignInNote` (a peer that said claude is not
  signed in there, off each host's `GET /api/peers/<name>/status`; any other answer says nothing).
- `PeerWaitTag.tsx` — the launcher row's tag; the pill itself is `sessionFacts.tsx`'s `peerWaitPill`.
- `PeerFacts.tsx` — `PeerRowTags` (launcher row: the cost SPLIT by desktop, "$22.28 here + $0.84 on
  pc", and on the peer "job from mac · <asking session> · <label>") and `PeerSessionFacts` (the
  session header: those two plus one "sent to pc: <label> · <state> · $0.84 · 6 min" line per job).
  Pills and lines are `sessionFacts.tsx`'s (`peerSpendPill`, `peerOriginPill`, `peerJobLines`) over
  shared `peerSpendSplit` / `peerJobOriginText` / `peerJobLine`. A total is never printed without
  its split.
- `PeerJobsSection.tsx` — Activity's "peer jobs" section off `GET /api/peerjobs` (the asker's
  ledger, trusted path, read-only): state, age, the peer's measured cost (tokens by kind), both
  labels, and links to both sessions. Absent on a desktop that never delegated; words are
  `logic.ts`'s `peerJobRowFacts`.

**Cost**: every figure is the PEER's own ledger reading (`PeerJobView.cost`, host `peerJobCostOf`),
absent field by field. The weekly calibration (`features/tokens` `calibrateWeek`) adds peer-job spend
that started and ended inside the week to its spend side (same account) and the turn note SAYS so
(`incl. $0.84 on pc`).

**Pairing, in order:** the phone mints one random token per direction and POSTs `/api/peers` to BOTH
hosts. A gets B's name and address, `outboundToken` = what A presents to B, `inboundToken` = what B
presents to A; B gets the mirror. The tokens are shown to no one and kept nowhere on the phone.
A host whose saved address has no port or is not a Tailscale / loopback address is refused in text
before anything is sent. A one-sided result (one host unreachable) says which side failed.

**Rules**: nothing greyed (a refused pairing is a sentence); removal asks through `Confirm.tsx`;
no second socket; lucide icons only.

**Reads from core**: `say.toast`, `say.track`. Track ids: `action:peers.pair`, `action:peers.unpair`,
`action:peers.open`.

**Tests**: `logic.test.mjs`.
