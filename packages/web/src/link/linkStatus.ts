import { setSyncOnline } from "../syncState";
import type { LinkStatus } from "./linkTypes";
import { doc, persist, persistNow } from "./linkDoc";
import { emit, invalidate } from "./linkStore";

export let connectedSince: number | null = null;

export let status: LinkStatus = "connecting";

/**
 * The transport's status changed. **The single entry point for online-ness** —
 * `ws.ts` reports its own `status` here and every reading in the app derives
 * from this one variable.
 *
 * Idempotent on purpose: today the socket announces an open three times (the
 * old `noteSocketOpen` + `noteConnected` + `notePulseStatus` call sites) and a
 * close twice, and the reconnect counter must not move three times for one
 * event. Only a genuine transition does anything.
 */
export function noteLinkStatus(next: LinkStatus): void {
  if (next === status) return;
  const prev = status;
  status = next;
  const now = Date.now();

  // ── the offline clock (was `netlog.mark`) ──
  // Close off the stretch that just ended and start a new one, on EVERY edge, so
  // `offlineMs` is the real total rather than a guess from counting reconnects.
  // A `connecting` stretch is part of the offline stretch either side of it —
  // accrual is additive over contiguous not-open time, so it does not matter
  // which of the two edges books it.
  if (!doc.log.online) doc.log.offlineMs += Math.max(0, now - doc.log.markTs);
  doc.log.markTs = now;
  doc.log.online = next === "open";
  // The one writer of online-ness tells the one store that renders "is this on
  // the desktop yet?" — rather than `syncState.ts` deriving it a fifth time.
  // That derivation was the whole complaint behind this module existing.
  setSyncOnline(next === "open");
  // Entering `closed` IS the reconnect edge: `ws.ts` closes and then reconnects
  // on a timer, and a socket that never opened at all (connection refused) is
  // just as much a failed connection as one that dropped.
  if (next === "closed") doc.log.reconnects++;

  // ── "is any of this current?" (was `netsync`) ──
  if (next === "open") {
    connectedSince = now;
    // An open socket is itself the newest proof the desktop is there.
    doc.sync.lastSeenAt = now;
  } else {
    // Cleared on `connecting` too, not only on a close: `reconnect()` tears the
    // old socket down with its handlers nulled, so there is no `onclose` to
    // clear it and the old code carried a stale "connected since" across the
    // whole reconnect.
    connectedSince = null;
  }

  // Written through immediately rather than debounced: the number people come
  // looking for is "how long have I been cut off", and the answer has to survive
  // the reload that a long cut-off ends in.
  if (prev === "open" || next === "open") persistNow(); else persist();
  invalidate("status");
  emit();
}

/** The transport's own word for what it is doing. */
export function linkStatus(): LinkStatus { return status; }

/**
 * **Is there a live link to the desktop, right now?**
 *
 * The one function every "offline" branch in the app should ask. Not
 * `navigator.onLine` — a phone on 5G is online while the Tailscale path is dead
 * — and not a socket's `readyState`, which stays `OPEN` under a tunnel that has
 * already died until the heartbeat notices.
 */
export function linkOnline(): boolean { return status === "open"; }
