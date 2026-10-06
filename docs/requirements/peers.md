# peers

### R-peers-001 · requested
Two desktops running waterplane (a Mac and a Windows box via WSL2) cooperate: a session on one can delegate a job to the other and gets the answer back, so a repo can be tested on both machines.
- asked: 2026-10-02 (user request: cooperate across Mac + Windows hosts, test ciqkit and waterplane itself on both)

### R-peers-002 · requested
Delegation is delegate-and-report only: the job opens ONE session on the peer and its final answer returns as ONE prompt into the asking session. No remote shell, no remote terminal on the phone's socket, no second WebSocket.
- asked: 2026-10-02 (same request)

### R-peers-003 · requested
Code reaches the peer through the shared git remote: the asking agent pushes its branch and the job names branch and commit; the peer checks out a detached worktree at that commit and never touches its clone's working tree. A repo the peer has no clone of is refused with a sentence, never cloned; with two clones the request's `peerDir` (a path on the peer) picks one.
- asked: 2026-10-02 (same request)

### R-peers-004 · requested
Pairing is explicit and symmetric, managed from the phone on the trusted path only (loopback and Tailscale, never LAN). An unlisted peer is refused. A peer token unlocks only the peer routes and a device token never does; changing the password does not rotate peer tokens.
- asked: 2026-10-02 (same request)

### R-peers-005 · requested
Peer addresses are tailnet or loopback only (100.64/10, `*.ts.net`, 127.0.0.1), never `*.local` or a LAN address. `GET /api/peers` (from loopback or Tailscale) lists the peers and says this daemon's own tailnet `ip:port` (`self.addr`, null when unbound), which pairing uses even for a host saved as an https front door.
- asked: 2026-10-02 (same request)

### R-peers-006 · requested
A delegated job is a row on the peer's own backlog, held by the peer owner's auto-fire switch, budget and slot cap: nothing runs on a machine whose owner did not allow it, and the job is visible there on the phone.
- asked: 2026-10-02 (same request)

### R-peers-007 · requested
A job never rebuilds or restarts the peer's running waterplane (its worktree `<clone>/.claude/worktrees/peer-<from>-<key>` is marked, and `scripts/restart.sh` and `deploy/install-service.sh` refuse there), and a job aimed at the peer's own live checkout is refused, so waterplane can be tested on a peer without taking that peer down.
- asked: 2026-10-02 (same request: test waterplane itself on both)

### R-peers-008 · requested
The asking session shows what it waits on ("waiting on pc", with how long), and a tap opens the peer session on the phone through the host switcher. An unreachable peer is shown as unreachable, never as failed.
- asked: 2026-10-02 (same request)

### R-peers-009 · requested
A peer version mismatch is refused both ways with a sentence naming both versions and which side is older; nothing is opened.
- asked: 2026-10-02 (same request)

### R-peers-010 · requested
A retried request with the same key is the same job on both hosts and the report arrives once. If the asking session has closed, the report becomes a manual backlog row in the repo plus a notification. Report files land in the asking repo as `.claude/outbox/peer-<peer>-<stem>-<timestamp>.<ext>`.
- asked: 2026-10-02 (same request)

### R-peers-011 · requested
The first peer to build against is a Linux VM on the Mac (OrbStack) with Tailscale inside it, then the WSL2 box; the docs say what the VM does and does not cover.
- asked: 2026-10-02 (same request)

### R-peers-012 · requested
A person can see where a peer got involved and what it cost there. The asking session lists every job it sent ("sent to pc: <label> · <state> · $0.84 · 6 min"), its cost is shown split by desktop ("$22.28 here + $0.84 on pc", never one summed figure), the report prompt's head carries the measured cost parts, the weekly-limit estimate counts peer-job spend on the same account and says so ("incl. $0.84 on pc"), Activity has a peer-jobs section linking both sessions, and the peer's job session says why it exists ("job from mac · <asking session> · <label>"). Every figure is the peer's own ledger reading and is absent, never zero, when unmeasured. The pairing sheet says a job only runs while the other desktop's auto-run is on and its budget pause applies.
- asked: 2026-10-02 ("How will we surface that a peer got involved in sessions? Clear transparency for the user, and a feel for the cost caused there.")
