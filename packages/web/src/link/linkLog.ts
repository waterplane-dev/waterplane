import { lsGet, lsSet } from "../storage";
import type { LinkLog } from "./linkTypes";
import { DEVICE_KEY, SAMPLE_CAP, blankLog, doc, persist, persistNow } from "./linkDoc";
import { status } from "./linkStatus";
import { emit, invalidate } from "./linkBus";
import { buckets } from "./linkTraffic";

/**
 * The phone's half of `host/netstats.ts`.
 *
 * The host can count sockets opening and closing and how its own deliveries
 * ended. It cannot see any of the things that decide whether the app FEELS
 * broken, because they all happen on this side of the tunnel: how long a ping
 * takes to come back, how much of the last hour had no socket at all, how long
 * text sat in the outbox before it went out, how often the watchdog gave up and
 * reloaded the page. "I typed that twenty minutes ago and nothing happened" is
 * answered by those numbers or by nothing.
 */

/** Keep the newest `SAMPLE_CAP`. Newest-wins rather than reservoir sampling on
 *  purpose: a link that was bad an hour ago and is fine now should read as fine. */
function sample(arr: number[], v: number): void {
  if (!Number.isFinite(v) || v < 0) return;
  arr.push(Math.round(v));
  if (arr.length > SAMPLE_CAP) arr.splice(0, arr.length - SAMPLE_CAP);
}

function pct(arr: readonly number[], p: number): number | undefined {
  if (!arr.length) return undefined;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

/** Stable-enough id for "which phone reported this". Not an identity: it is
 *  minted here, never derived from anything about the device, and it exists only
 *  so two phones on one host don't average their very different links together. */
export function deviceId(): string {
  const cur = lsGet(DEVICE_KEY);
  if (cur) return cur;
  try {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    const id = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    lsSet(DEVICE_KEY, id);
    return id;
  } catch {
    // No `crypto` (an insecure origin that also has no polyfill) — the roll-up
    // still posts, it just cannot say which phone it came from.
    return "unknown";
  }
}

/** A heartbeat pong came back. NOT the pulse probe — see the pulse section's
 *  second rule; these are what deadlines are sized from. */
export function noteRtt(ms: number): void { sample(doc.log.rtt, ms); persist(); }

/** The `ws.ts` watchdog is about to hard-reload the page. Recorded BEFORE the
 *  reload, and written through synchronously — a debounced write would not
 *  survive the navigation it is describing. */
export function noteReload(): void {
  doc.log.reloads++;
  persistNow();
}

/** A send was confirmed. `queuedMs` is queue time → receipt, which is the number
 *  that matches the user's complaint ("it took how long?"), not the wire time. */
export function noteSendConfirmed(queuedMs: number): void {
  doc.log.sent++;
  sample(doc.log.send, queuedMs);
  doc.log.queuedMaxMs = Math.max(doc.log.queuedMaxMs, Math.round(queuedMs));
  persist();
  invalidate("log");
}

/** A send gave up. One call per row, whatever killed it — the names and the
 *  words stay on the row in the send queue, which this deliberately knows
 *  nothing about (the roll-up is POSTed to the host; prompt text never is). */
export function noteSendFailed(): void { doc.log.failed++; persist(); invalidate("log"); }

/** …and it was the attempts cap that killed it. A subset of `failed`, counted
 *  alongside it and never instead of it. */
export function noteSendExpired(): void { doc.log.expired++; persist(); invalidate("log"); }

/** A receipt deadline passed with nothing back — the entry goes round again. */
export function noteAckTimeout(): void { doc.log.ackTimeouts++; persist(); invalidate("log"); }

export function rollup(): LinkLog {
  const now = Date.now();
  // Include the stretch still in progress, or a phone that has been offline for
  // ten minutes straight reports 0% offline until the moment it reconnects.
  const pendingOffline = doc.log.online ? 0 : Math.max(0, now - doc.log.markTs);
  const span = Math.max(1, now - doc.log.since);
  return {
    since: doc.log.since,
    rttP50: pct(doc.log.rtt, 0.5),
    rttP95: pct(doc.log.rtt, 0.95),
    reconnects: doc.log.reconnects,
    reloads: doc.log.reloads,
    offlineShare: Math.min(1, (doc.log.offlineMs + pendingOffline) / span),
    sendP50: pct(doc.log.send, 0.5),
    sendP95: pct(doc.log.send, 0.95),
    sent: doc.log.sent,
    failed: doc.log.failed,
    expired: doc.log.expired,
    ackTimeouts: doc.log.ackTimeouts,
    queuedMaxMs: doc.log.queuedMaxMs,
    ua: navigator.userAgent.slice(0, 120),
  };
}

/**
 * The measured round trip, for callers that need to size a deadline rather than
 * display a number — see the ack windows in App.tsx. p95 rather than the mean:
 * a deadline is about the bad case, and a receipt window shorter than the link's
 * bad case burns the send queue's give-up budget on the network being slow.
 * `null` until there are enough samples to mean anything.
 */
export function rttP95(): number | null {
  if (doc.log.rtt.length < 4) return null;
  return pct(doc.log.rtt, 0.95) ?? null;
}

/**
 * Wipe the window: the delivery counters AND the byte totals, which are one
 * reading in the health sheet's "reset" and were two calls before.
 *
 * The sync stamps are deliberately NOT reset — "last connected" is a fact about
 * the tunnel, not a tally somebody chose to start.
 */
export function resetLinkWindow(): void {
  doc.log = blankLog(Date.now());
  doc.log.online = status === "open";
  doc.traffic = { since: Date.now(), up: 0, down: 0 };
  for (const b of buckets) { b.slot = -1; b.up = 0; b.down = 0; }
  persistNow();
  invalidate("log", "traffic");
  emit();
}

/**
 * How many sends have given up and not been dealt with.
 *
 * Pushed by App rather than read from the queue: those rows hold prompt text and
 * belong on this phone only, and the strip repaints once a second while the
 * queue is a parse of up to five hundred rows. This file holds the number and
 * nothing else — which is the same line the roll-up above draws.
 */
export let stuckSends = 0;
export function noteStuckSends(n: number): void {
  const v = Math.max(0, n | 0);
  if (v === stuckSends) return;
  stuckSends = v;
  invalidate("sends");
  emit();
}

/**
 * How much this phone is still holding alone — the queue plus the settings
 * pushes — and, once it reaches zero, the one positive thing this strip says.
 *
 * Pushed by App for the same two reasons `noteStuckSends` is: the rows carry
 * prompt text that belongs on this phone only, and the strip repaints once a
 * second while the queue can be five hundred rows. The number is the whole of
 * what crosses.
 *
 * `everOutstanding` latches and is never cleared. That is deliberate: it is not
 * a claim about now (`outstanding` is), it is the reason the all-clear is worth
 * printing at all, and a phone that has had something in flight once has a
 * person who wants to know it got there. It needs no store of its own — the
 * snapshot ORs it with `doc.log.sent`, which is persisted and answers the same
 * question across reloads.
 */
export let outstanding = 0;
export let everOutstanding = false;
export function noteOutstanding(n: number): void {
  const v = Math.max(0, n | 0);
  if (v === outstanding) return;
  outstanding = v;
  if (v > 0) everOutstanding = true;
  invalidate("sends");
  emit();
}
