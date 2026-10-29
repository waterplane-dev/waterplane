/**
 * How long one dial may sit in CONNECTING before `ws.ts` gives it up and dials again.
 *
 * A handshake that never completes fires no `onclose` for as long as the browser's
 * own TCP connect timeout — minutes, on a phone whose 5G path was swapped under it —
 * and the 1 s retry only runs after a close. The reload watchdog does not cover it
 * either: it is armed by a wake or a tap, not by a drop while the app is in front.
 * Measured 2026-10-27: tailnet ping direct at 240 ms, uploads landing, the socket
 * on "connecting" until a manual reload.
 *
 * The fuse doubles per consecutive dial it cuts, so a link that is merely slow
 * (a cold radio, a long first TLS round) still gets a dial long enough to finish,
 * and resets when a socket opens.
 */
export const DIAL_TIMEOUT_MS = 10_000;
export const DIAL_TIMEOUT_MAX_MS = 40_000;

/** The fuse for the next dial, after `cut` consecutive dials were given up. */
export function dialTimeoutMs(cut: number): number {
  const n = Number.isFinite(cut) ? Math.max(0, Math.floor(cut)) : 0;
  return Math.min(DIAL_TIMEOUT_MS * 2 ** Math.min(n, 8), DIAL_TIMEOUT_MAX_MS);
}
