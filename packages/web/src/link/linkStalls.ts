import type { ClientMessage, HostMessage } from "@waterplane/shared";
import { StallRecorder, type StallContext, type WireHandle } from "./stallRecorder.ts";
import { status } from "./linkStatus";
import { labelForUrl } from "./linkOps";

/**
 * The DOM half of the stall diagnostics (`shared/netstall.ts`,
 * `stallRecorder.ts`): which facts the page can read at a stall, and how the
 * record reaches the desktop.
 *
 * **Over the socket, never a POST.** The question is whether the HTTP pool is
 * stuck; a report that queued behind the stuck requests would arrive exactly
 * when it no longer mattered, or not at all. The one WebSocket is not in that
 * pool. Diagnostics only — nothing here changes how a request is made.
 */

let lastPongAt: number | null = null;
let lastRtt: number | null = null;
/** A heartbeat pong came back (`linkLog.noteRtt`). */
export function noteStallPong(rttMs: number): void {
  lastPongAt = Date.now();
  lastRtt = Math.round(rttMs);
}

/** When the page entered its current visibility. Null until the first change:
 *  a page load is not a wake, and claiming one would be a wrong number. */
let visSince: number | null = null;
try {
  document.addEventListener("visibilitychange", () => { visSince = Date.now(); });
} catch { /* no DOM */ }

function context(): StallContext {
  const now = Date.now();
  const c: StallContext = {};
  const ws: StallContext["ws"] = { open: status === "open" };
  if (lastPongAt != null) ws.pongAgeMs = Math.max(0, now - lastPongAt);
  if (lastRtt != null) ws.rttMs = lastRtt;
  c.ws = ws;
  try { c.visible = document.visibilityState === "visible"; } catch { /* no DOM */ }
  if (visSince != null) c.visForMs = Math.max(0, now - visSince);
  try { if (typeof navigator.onLine === "boolean") c.online = navigator.onLine; } catch { /* no navigator */ }
  return c;
}

export const stalls = new StallRecorder({
  now: () => Date.now(),
  context,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  changed: () => flushSoon(),
});

/** Register one HTTP request. Called by `linkMeters`' fetch/XHR patches. */
export function wireBegin(url: string, method: string, via: "fetch" | "xhr"): WireHandle {
  return stalls.begin(labelForUrl(url, method), method, via);
}

/** A JSON body's own fuse fired (`webapiFetch.fusedJson`). */
export function noteBodyTimeout(url: string, method: string, ms: number): void {
  stalls.bodyTimeout(labelForUrl(url, method), method, ms);
}

/** `TimeoutError` by shape, not `instanceof`, so a second copy of the shared
 *  bundle (the demo, a test) still reads as a fuse. */
export function fuseMsOf(reason: unknown): number | undefined {
  const r = reason as { name?: unknown; ms?: unknown } | null | undefined;
  return r && r.name === "TimeoutError" && typeof r.ms === "number" ? r.ms : undefined;
}

/** The fuse an XHR was aborted by. */
const xhrFuse = new WeakMap<XMLHttpRequest, number>();
/** Abort an XHR on its signal's behalf, keeping a fuse's reason for the record. */
export function abortXhr(xhr: XMLHttpRequest, reason: unknown): void {
  const fuse = fuseMsOf(reason);
  if (fuse != null) xhrFuse.set(xhr, fuse);
  xhr.abort();
}

const xhrTarget = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

/**
 * Register EVERY fetch and XHR, for the in-flight count — the HTTP/1.1 pool is
 * filled by polls and telemetry too, not only by the calls that blink the bar.
 * Called by `installLinkMeters` after its own patches, so this wraps them.
 */
export function installStallMeters(): void {
  try {
    const orig = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : req?.url ?? "";
      const wire = wireBegin(url, init?.method ?? req?.method ?? "GET", "fetch");
      try {
        const res = await orig(input as RequestInfo, init);
        wire.end({ answered: true });
        return res;
      } catch (e) {
        // `timedFetch` aborts with its `TimeoutError` as the signal's reason.
        wire.end({ answered: false, fuseMs: init?.signal?.aborted ? fuseMsOf(init.signal.reason) : undefined });
        throw e;
      }
    }) as typeof fetch;
  } catch { /* frozen global — no record, nothing else changes */ }

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      xhrTarget.set(this, { method: String(method || "GET"), url: String(url) });
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    const origSend = proto.send;
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const t = xhrTarget.get(this);
      const wire = wireBegin(t?.url ?? "", t?.method ?? "GET", "xhr");
      // Bytes sent tell a request that never got a socket (0 B) from a socket
      // that died under it.
      const total = typeof Blob !== "undefined" && body instanceof Blob ? body.size : undefined;
      if (total) wire.progress(0, total);
      try {
        this.upload?.addEventListener("progress", (e: ProgressEvent) => wire.progress(e.loaded, e.lengthComputable ? e.total : total));
        this.addEventListener("loadend", () => wire.end({ answered: this.status > 0, fuseMs: xhrFuse.get(this) }));
      } catch { wire.end({ answered: false }); }
      return origSend.call(this, body as XMLHttpRequestBodyInit | null);
    } as typeof proto.send;
  } catch { /* best effort */ }
}

// ── the sender ──────────────────────────────────────────────────────────────

interface StallSink {
  status: "connecting" | "open" | "closed";
  send(msg: ClientMessage): void;
  on(listener: (msg: HostMessage) => void): () => void;
}

let sink: StallSink | null = null;
let deviceIdOf: (() => string) | null = null;
let lastSent = "";
let soon: ReturnType<typeof setTimeout> | null = null;
/** Re-check cadence while something is stalled: the open list changes with no
 *  event of its own. Nothing is sent when nothing changed. */
const CHECK_MS = 15000;

function openKey(): string {
  return stalls.openStalls().map((e) => e.k).join(",");
}

function flush(force = false): void {
  if (!sink || sink.status !== "open" || !deviceIdOf) return;
  const id = deviceIdOf();
  if (!id || id === "unknown") return;
  // The ring only grows at its tail, and the open list is its keys: together
  // they say whether there is anything the host has not been told.
  const key = `${stalls.ring.length}:${stalls.ring[stalls.ring.length - 1]?.k ?? ""}|${openKey()}`;
  if (!force && key === lastSent) return;
  sink.send({ t: "net.stalls", deviceId: id, report: stalls.report() });
  lastSent = key;
}

function flushSoon(): void {
  if (soon) return;
  soon = setTimeout(() => { soon = null; flush(); }, 1000);
}

/** Attach to the one socket. Idempotent. Re-sends the whole ring on every
 *  `welcome` — the host may be a different desktop, or a restarted one; it
 *  merges on each event's key, so a repeat costs nothing. */
export function startNetStalls(source: StallSink, deviceId: () => string): void {
  if (sink) return;
  sink = source;
  deviceIdOf = deviceId;
  source.on((msg) => { if (msg.t === "welcome") { lastSent = ""; flush(true); } });
  setInterval(() => flush(), CHECK_MS);
}
