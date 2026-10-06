import { api } from "../api";
import { FLUSH_MS, persistNow } from "./linkDoc";
import { noteTraffic } from "./linkTraffic";
import { deviceId, rollup } from "./linkLog";

/** Best-effort size of a request body. `null` = we cannot know (a stream, a
 *  FormData with files), which is counted as nothing rather than as a guess. */
function bodyBytes(body: unknown): number | null {
  if (body == null) return null;
  if (typeof body === "string") {
    // `length`, not an encode: bodies here are JSON and base64 (ASCII, so this
    // is exact), and running a TextEncoder over every request to be right about
    // the occasional é is a cost the readout does not justify.
    return body.length;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString().length;
  return null;
}

/**
 * Everything that fetches without going through `fetch` or `XHR` — every
 * `<img>` in the gallery, the video poster, a stylesheet.
 *
 * Thumbnails are most of what this app actually downloads, and none of them is
 * a fetch: the grid points an `<img>` at a versioned thumb URL and the browser
 * does the rest. Resource Timing is the only place those bytes are visible.
 *
 * `transferSize` is what came off the network, so a picture served out of the
 * page's own thumb cache correctly costs nothing — and a cross-origin response
 * reports zero unless the server allows it, which is why the host now sends
 * `timing-allow-origin` (see `host/origin.ts`). `fetch`/`XHR` entries are
 * skipped: those are already counted below, exactly once.
 */
function installResourceMeter(): void {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const kind = e.initiatorType;
        if (kind === "fetch" || kind === "xmlhttprequest" || kind === "beacon") continue;
        const n = e.transferSize || e.encodedBodySize || 0;
        if (n > 0) noteTraffic("down", n);
      }
    });
    // `buffered` so the shell's own boot assets are in the total rather than
    // being missed by having loaded before this line ran.
    obs.observe({ type: "resource", buffered: true });
  } catch { /* no PerformanceObserver — HTTP through fetch/XHR is still counted */ }
}

let installed = false;

/**
 * Patch `fetch` and `XMLHttpRequest` so every HTTP byte is counted wherever it
 * was issued from — including `api.ts`'s wrapped helpers, the background polls
 * that deliberately bypass them, the chunked Range loop in `pull.ts` and the
 * XHR uploads in the compose bar — and install the one write-through handler
 * for the whole document.
 *
 * Call once at boot, and AFTER `installHostRouting()`: this wrapper delegates to
 * whatever `fetch` was in place when it ran, so installing it second means the
 * host-routing rewrite still happens.
 */
export function installLinkMeters(): void {
  if (installed) return;
  installed = true;

  try {
    const orig = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const up = bodyBytes(init?.body);
      if (up != null) noteTraffic("up", up);
      const res = await orig(input as RequestInfo, init);
      // `content-length` only. The alternative — wrapping the body stream to
      // count it as it is read — means rebuilding the Response, which loses
      // `url`/`redirected` for every caller in the app to buy a number for the
      // rare chunked reply. The host sets the header on every route it serves.
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) noteTraffic("down", len);
      return res;
    }) as typeof fetch;
  } catch { /* exotic environment with a frozen global — no counting, nothing else changes */ }

  try {
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      // Upload progress is the accurate figure for the one path that moves real
      // bytes out of this app (inbox uploads, which use XHR precisely because
      // they need these events). Deltas, not the total: `loaded` is cumulative.
      let sentSoFar = 0;
      try {
        this.upload?.addEventListener("progress", (e: ProgressEvent) => {
          if (e.loaded > sentSoFar) { noteTraffic("up", e.loaded - sentSoFar); sentSoFar = e.loaded; }
        });
      } catch { /* no upload object — fall through to the size below */ }
      let gotSoFar = 0;
      try {
        this.addEventListener("progress", (e: ProgressEvent) => {
          if (e.loaded > gotSoFar) { noteTraffic("down", e.loaded - gotSoFar); gotSoFar = e.loaded; }
        });
        this.addEventListener("loadend", () => {
          // A small JSON reply can finish without ever firing `progress`; take
          // the header then, and only for what the progress events missed.
          const len = Number(this.getResponseHeader?.("content-length"));
          if (Number.isFinite(len) && len > gotSoFar) noteTraffic("down", len - gotSoFar);
          if (sentSoFar === 0) {
            const n = bodyBytes(body as unknown);
            if (n != null) noteTraffic("up", n);
          }
        });
      } catch { /* best effort */ }
      return origSend.call(this, body as XMLHttpRequestBodyInit | null);
    } as typeof XMLHttpRequest.prototype.send;
  } catch { /* best effort */ }

  installResourceMeter();

  // ONE write-through, for all four sections. The debounced write is a lost
  // write if the phone is backgrounded first, and backgrounding is how this app
  // is usually "closed" — this used to be the same eight lines in three files,
  // which is three chances for a section added later to be the one that isn't
  // flushed.
  try {
    window.addEventListener("pagehide", () => { persistNow(); beacon(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { persistNow(); beacon(); }
    });
  } catch { /* no DOM */ }
}

/**
 * Ship the roll-up. `api.netstats.report` is the SILENT path on purpose: a
 * background flush that registered in the ops ledger would blink the activity
 * bar every minute on an idle screen, and a bar that blinks for nothing is what
 * makes a real one invisible. It still takes the fuse — a flush that hangs for
 * ever is a flush that never carries the next window either.
 */
function post(): void {
  // Offline is not an error here: the next flush carries the same window.
  void api.netstats.report({ deviceId: deviceId(), report: rollup() });
}

/** Same payload on the way out, but `sendBeacon` so a backgrounding phone (which
 *  is how this app is usually "closed") still delivers it.
 *
 *  Gated on reporting having started: `installLinkMeters()` runs at boot, which
 *  in the Android shell can be in front of the pairing screen, and a beacon at
 *  `/api/netstats` with no host paired posts a roll-up at whatever origin the
 *  bundle happens to be served from. */
function beacon(): void {
  if (!reporting) return;
  const body = JSON.stringify({ deviceId: deviceId(), report: rollup() });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/netstats", new Blob([body], { type: "application/json" }));
    else post();
  } catch { /* best effort */ }
}

let reporting = false;
/** Start the once-a-minute roll-up to the host. Separate from
 *  `installLinkMeters` because it needs a paired host and `api.ts`, and separate
 *  from `startLinkProbes` because it runs whether or not the strip is on. */
export function startLinkReporting(): void {
  if (reporting) return;
  reporting = true;
  window.setInterval(post, FLUSH_MS);
}
