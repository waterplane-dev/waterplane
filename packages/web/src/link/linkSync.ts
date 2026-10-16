import { hhmm } from "../format";
import type { LinkSync, SyncPart } from "./linkTypes";
import { doc, persistNow } from "./linkDoc";
import { connectedSince } from "./linkStatus";
import { emit, invalidate } from "./linkBus";

const PARTS: SyncPart[] = ["sessions", "repos"];

/**
 * The strip's graph answers "is the link good", and the banner answers "is the
 * socket up". Neither answers the question you ask while looking at a list of
 * fifteen repos on a bad tunnel: **is any of this current?** A reconnect takes
 * seconds; a session list from before a fifteen-minute dead stretch looks
 * exactly like one from now, and this app is specifically built to keep
 * rendering from snapshots when the host is unreachable — which is right, and
 * which is precisely why the screen has to say how old the snapshot is.
 *
 * Two facts, deliberately kept apart:
 *
 *  • **Last connected** — the newest moment a frame came in over the socket, not
 *    the moment we opened it. An open socket that has gone silent behind a dead
 *    tunnel still reads as "open" for up to a heartbeat, and a phone that was
 *    connected an hour ago should not be able to claim it is connected now
 *    because `readyState` says so. `ws.ts` already treats ANY inbound frame as
 *    proof of life; `noteHostSeen()` stamps the same event.
 *
 *  • **Last full sync** — when the two things the main screen is built from were
 *    BOTH refreshed on the current connection: the session list (pushed over the
 *    socket after `hello`) and the repo listing (a separate HTTP call, which can
 *    fail on its own while the socket is fine). The reported time is the OLDER
 *    of the two, because that is when everything on screen was last current —
 *    taking the newer would let a fresh session list paper over a repo listing
 *    that has been stale for an hour.
 */


/** `noteHostSeen()` fires on every inbound frame — thousands a minute on a busy
 *  PTY. The stamp is a variable assignment; only the WRITE is rationed, and
 *  nothing is emitted (the readout is a "how long ago", drawn off the clock). */
const SEEN_WRITE_EVERY_MS = 10_000;
let lastSeenWrite = 0;

export function noteHostSeen(): void {
  const now = Date.now();
  doc.sync.lastSeenAt = now;
  if (now - lastSeenWrite > SEEN_WRITE_EVERY_MS) { lastSeenWrite = now; persistNow(); }
}

/** A screen-defining refresh landed. */
export function noteSynced(part: SyncPart): void {
  doc.sync.parts[part] = Date.now();
  persistNow();
  invalidate("sync");
  emit();
}

export function syncSnapshot(): LinkSync {
  const online = connectedSince != null;
  // A part counts as current only if it refreshed AFTER this socket came up.
  // Nothing else is honest: the session list from the previous connection is
  // exactly the stale data this readout exists to declare.
  const pending = online ? PARTS.filter((p) => doc.sync.parts[p] < (connectedSince as number)) : [];
  const stamps = PARTS.map((p) => doc.sync.parts[p]);
  const syncedAt = !online || pending.length || stamps.some((t) => !t) ? null : Math.min(...stamps);
  return { online, connectedSince, lastSeenAt: doc.sync.lastSeenAt || null, syncedAt, pending };
}

/** The last full sync ignoring whether it is still current — what the health
 *  sheet shows while offline, where "null because the socket is down" would
 *  throw away the one number being asked for. */
export function lastSyncEver(): number | null {
  const stamps = PARTS.map((p) => doc.sync.parts[p]);
  if (stamps.some((t) => !t)) return null;
  return Math.min(...stamps);
}

/** A moment, spelled out — for tooltips and the health sheet, where the compact
 *  "14m" of the strip is not enough to act on. */
export function whenText(ts: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? hhmm(ts) : `${d.toLocaleDateString([], { weekday: "short" })} ${hhmm(ts)}`;
}
