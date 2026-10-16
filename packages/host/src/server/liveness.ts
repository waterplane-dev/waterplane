/**
 * The host's half of "is anybody still on the other end of this socket?" —
 * the pure policy, with no socket and no timer in it, so
 * `packages/host/test/liveness.test.mjs` can pin every edge.
 *
 * Why the host needs its own: the heartbeat used to be client-only (`web/ws.ts`
 * pings at the app level and reconnects when nothing comes back). That covers
 * the PHONE noticing a dead link and never the HOST: a phone that sleeps, or a
 * tailnet that flaps, leaves a half-open TCP socket that `ws` reports as OPEN
 * for as long as the kernel cares to keep it. Such a socket stayed in
 * `ctx.clients` and stayed attached, so every repaint was queued for it in
 * memory without bound, and `isAttachedToSomeone` counted it as a person
 * watching — which kept `lingerSweep` and the plugins' `watched` set from ever
 * letting an automatic session go.
 *
 * Two mechanisms, both invisible on the wire (no new frame, no
 * `PROTOCOL_VERSION` move — browsers and `ws` answer a protocol-level ping by
 * themselves):
 *   • liveness — `wsops.ts` pings each socket every `WS_PING_MS`; a socket that
 *     misses `MISSED_PONGS_TO_TERMINATE` pings in a row is `terminate()`d,
 *     which runs the ordinary close path (netstats, `recomputeWatched`).
 *   • backpressure — `sessionEvents.ts`'s PTY fan-out stops queueing deltas
 *     on a socket whose send buffer is past `WS_PTY_BACKLOG_BYTES`, remembers
 *     that the socket's copy of that terminal is now torn, and heals it with
 *     ONE full replay once the buffer drains. Only PTY frames: a repaint can be
 *     redrawn from scrollback, an ack or a prompt cannot be re-derived.
 */

/** Consecutive unanswered pings before the socket is declared dead. Two, not
 *  one: a single ping can sit behind a backlog that is still draining, and
 *  terminating a slow-but-live phone would cost it a full replay for nothing. */
export const MISSED_PONGS_TO_TERMINATE = 2;

/**
 * A ping tick's decision. `missed` is the count of pings sent since the last
 * pong, BEFORE this tick. Returns what to do now and the count to store.
 */
export function pingTick(missed: number): { action: "ping" | "terminate"; missed: number } {
  if (missed >= MISSED_PONGS_TO_TERMINATE) return { action: "terminate", missed };
  return { action: "ping", missed: missed + 1 };
}

/**
 * What one PTY delta does on one socket.
 *
 * - `skip` — the socket's buffer is past the threshold: queueing more is how a
 *   dead or crawling link turned into unbounded host memory. The terminal on
 *   that socket is now missing bytes, so the caller marks it starved.
 * - `resync` — the socket was starved and has drained: send ONE `full: true`
 *   replay built from scrollback INSTEAD of this delta (the replay already
 *   contains it — the session's `seq` moved before `data` fired), then clear
 *   the mark. The client treats `full` as "reset and repaint" and takes its
 *   `seq` as the new resume point, exactly as on a fresh attach.
 * - `send` — the ordinary case.
 *
 * A threshold of 0 or less turns the guard off (always `send`, never starve).
 */
export function ptyFrameAction(bufferedAmount: number, threshold: number, starved: boolean): "send" | "skip" | "resync" {
  if (threshold > 0 && bufferedAmount > threshold) return "skip";
  return starved ? "resync" : "send";
}

/**
 * Whether a socket's PTY holds its plugin streams back right now (`plugins/pluginstreams.ts`).
 * PTY first: one TCP connection carries both, and a frame of video must never stand between a
 * terminal and the phone. Held while the buffer is past the PTY's own line (its deltas are being
 * skipped), and while a terminal on this socket is torn (`starved`, waiting for its one full
 * replay) with bytes still queued — video yields until the socket has drained, so the replay
 * goes first. A threshold of 0 turns the first half off, as it does for the PTY.
 */
export function ptyHoldsStreams(bufferedAmount: number, threshold: number, starved: boolean): boolean {
  if (threshold > 0 && bufferedAmount > threshold) return true;
  return starved && bufferedAmount > 0;
}
