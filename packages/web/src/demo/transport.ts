/**
 * The demo's swap point (demo-mode-plan.md §2, WP1): everything the page would
 * send to a desktop goes to the in-bundle fake one (`demo/host/`) instead, and
 * nothing at all leaves the device.
 *
 * Its OWN install, not a branch inside `hostUrl.ts`'s routing — that patch is
 * inert exactly where the demo runs (a browser, an unpaired APK). Installed by
 * `main.tsx` before `installLinkMeters()`, so the byte meters wrap THIS and
 * still count what the demo moves.
 *
 * Four doors, one answerer:
 *
 *  - **WebSocket.** `ws.ts` keeps its single owner; `makeConnection()` dials
 *    through `demoTransport().dial()` here instead of `new WebSocket`. `DemoSocket` is the
 *    slice of `WebSocket` that `HostConnection` touches, wired to
 *    `DemoHost.connect()`. The core never sleeps — every frame's `afterMs` is
 *    honoured with a timer HERE, and `advance()` (the scenario script) runs off
 *    an interval here.
 *  - **fetch, XHR `send`, `sendBeacon`.** Each reduces a request to
 *    `DemoHttpRequest` and back. `/api/*` on this origin → the fake desktop;
 *    the page's own static files (the bundle, `/demo/media/…`) → the network
 *    stack as before (same origin: the asset server or the static host);
 *    **anything else is refused** — loud in dev, a sentence in the error.
 *    XHR gets a synthetic `readyState`/`status`/`upload.onprogress`, because the
 *    two uploads (inbox, dictation) read exactly those.
 *  - **Persistence.** The core keeps nothing; after every `onChange` the
 *    snapshot is written to sessionStorage under `demoSnapKey(scenario)`, and a
 *    boot hands it back to `restoreDemoHost` — all or nothing. That is what lets
 *    the watchdog's reload (a dropped demo socket probes `/api/health`, which
 *    the demo answers) come back to the same demo with the same ack ledger.
 *
 * Built as `createDemoTransport(cfg)` over an injected target so node tests
 * drive it without a browser; `installDemoTransport()` is the page's one call.
 */
import { decode, encode } from "@waterplane/shared";
import type { ClientMessage } from "@waterplane/shared";
import { assertShippable, createDemoHost, restoreDemoHost } from "./host/index.ts";
import type { DemoClock, DemoConnection, DemoFaultRule, DemoHost, DemoHttpRequest, DemoHttpResponse, DemoOut, DemoScenario } from "./host/index.ts";
import { demoSnapKey } from "../storage.ts";
import { DEMO_SCENARIOS } from "./scenarios/index.ts";
import { demoScenarioId, setDemoActive } from "./mode.ts";
import { rememberDemoUpload } from "./media.ts";
export { DEMO_WS_URL } from "./mode.ts";

/** How often the scenario script is asked whether anything is due. */
const ADVANCE_MS = 200;

/** What every refusal says. The URL is named so a dev console points at it. */
export const OFF_DEVICE = "Not in the demo — the demo makes no request off this device";

/** The slice of the browser the transport patches and reads. */
export interface DemoTarget {
  fetch: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  navigator?: { sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean };
  /** Shifted once a scenario's `clock` step moves the demo ahead (`shiftDate`). */
  Date?: DateConstructor;
}

/** The sessionStorage slice persistence needs. */
export interface DemoStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface DemoTransportConfig {
  scenario: DemoScenario;
  /** The page URL requests are resolved against (`location.href`). */
  href: string;
  /** Patched in place. */
  target: DemoTarget;
  /** sessionStorage, or null when it is unavailable (the demo then lasts one page life). */
  store: DemoStore | null;
  clock?: DemoClock;
  /** Run the script timer (off in tests, which call `host.advance()`). */
  tick?: boolean;
  /** Called on a refused off-device request — dev makes it loud. */
  onRefused?: (url: string, via: string) => void;
}

export interface DemoTransport {
  readonly host: DemoHost;
  /** The `WebSocket` stand-in `HostConnection` dials in the demo. */
  dial(url: string, protocols?: string | string[]): WebSocket;
  /** Undo nothing — a page in the demo stays in it — but stop the timer (tests). */
  stop(): void;
}

// ── Routing ───────────────────────────────────────────────────────────────

export type DemoRoute = "host" | "local" | "refuse";

/** Which door a URL goes through. `data:`/`blob:` never leave the device. */
export function routeOf(url: string, href: string): { route: DemoRoute; u: URL | null } {
  let u: URL;
  try { u = new URL(url, href); } catch { return { route: "refuse", u: null }; }
  if (u.protocol === "data:" || u.protocol === "blob:") return { route: "local", u };
  let origin: string;
  try { origin = new URL(href).origin; } catch { return { route: "refuse", u }; }
  if (u.origin !== origin) return { route: "refuse", u };
  if (u.pathname === "/api" || u.pathname.startsWith("/api/") || u.pathname === "/ws") return { route: "host", u };
  return { route: "local", u };
}

/** A body's size in bytes, when it is one the demo can measure without reading. */
function sizeOf(body: unknown): number | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

/** A text body as the core wants it: parsed when it is JSON, else the string. */
function textBody(text: string, contentType: string | null): unknown {
  if (/json/i.test(contentType ?? "") || /^\s*[[{]/.test(text)) {
    try { return JSON.parse(text); } catch { /* not JSON after all */ }
  }
  return text;
}

/** Reduce a request to what the core reads. Byte bodies (uploads) arrive as their size only. */
export function toDemoRequest(method: string, u: URL, body: unknown, contentType: string | null): DemoHttpRequest {
  const req: DemoHttpRequest = { method: method.toUpperCase(), path: u.pathname };
  const q: Record<string, string> = {};
  let any = false;
  // A repeated key (`?w=a&w=b`) arrives comma-joined: the request shape is one string per key.
  u.searchParams.forEach((v, k) => { q[k] = k in q ? `${q[k]},${v}` : v; any = true; });
  if (any) req.query = q;
  if (typeof body === "string") {
    req.body = textBody(body, contentType);
    req.bodyBytes = sizeOf(body);
  } else if (body instanceof URLSearchParams) {
    req.body = body.toString();
  } else if (body != null) {
    const n = sizeOf(body);
    if (n != null) req.bodyBytes = n;
  }
  return req;
}

/** The core answering, with a handler's throw turned into a 500 rather than a dead page. */
function ask(host: DemoHost, req: DemoHttpRequest): DemoHttpResponse {
  try { return host.request(req); } catch (e) {
    return { status: 500, contentType: "text/plain", body: `demo host failed on ${req.method} ${req.path}: ${String(e)}` };
  }
}

const NULL_BODY = new Set([101, 204, 205, 304]);

// ── The socket ────────────────────────────────────────────────────────────

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

/**
 * The part of `WebSocket` `HostConnection` uses: `readyState`, the four `on*`
 * handlers, `send(string)`, `close()`. Opens asynchronously, like a real one —
 * `ws.ts` assigns its handlers after the constructor returns.
 */
export class DemoSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readyState = CONNECTING;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private readonly host: DemoHost;
  private conn: DemoConnection | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** True while the host handles a `session.attach` (see `send`). */
  private attaching = false;
  /** PTY frames scheduled and not yet delivered. */
  private ptyQueued = 0;

  constructor(host: DemoHost, url: string) {
    this.host = host;
    this.url = url;
    this.later(0, () => this.open());
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, ms));
    this.timers.add(t);
  }

  private open(): void {
    if (this.readyState !== CONNECTING) return;
    let shut: DemoOut | null = null;
    const sink = (out: DemoOut) => {
      // An offline fault closes from INSIDE `connect`, before there is a socket to open.
      if (this.readyState === CONNECTING) { if (out.kind === "close") shut = out; return; }
      // The first keyframe of a session being opened is handed over before `send` returns: the tap that
      // opened it then renders ONE screen with the terminal already filled, never the "no output yet"
      // card for the moment a network hop would take. Only a full replay, only with no PTY frame still queued
      // (it would land after the keyframe and be appended twice), never one a fault delays.
      const pty = out.kind === "frame" && out.msg.t === "pty" ? out.msg : null;
      if (pty?.full && this.attaching && out.kind === "frame" && out.afterMs == null && this.ptyQueued === 0) {
        this.deliver(out);
        return;
      }
      if (pty) this.ptyQueued++;
      this.later(out.afterMs ?? 0, () => { if (pty) this.ptyQueued--; this.deliver(out); });
    };
    const conn = this.host.connect(sink);
    const early = shut as DemoOut | null;
    if (early?.kind === "close") { this.finish(early.code, early.reason); return; }
    this.conn = conn;
    this.readyState = OPEN;
    this.onopen?.(new Event("open"));
  }

  private deliver(out: DemoOut): void {
    if (this.readyState !== OPEN) return;
    if (out.kind === "close") { this.conn = null; this.finish(out.code, out.reason); return; }
    this.onmessage?.(new MessageEvent("message", { data: encode(out.msg) }));
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const ev = Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }) as CloseEvent;
    this.onclose?.(ev);
  }

  send(data: string): void {
    if (this.readyState === CONNECTING) throw new DOMException("still connecting", "InvalidStateError");
    if (this.readyState !== OPEN || !this.conn) return;
    let msg: ClientMessage;
    try { msg = decode<ClientMessage>(data); } catch { return; }
    this.attaching = msg.t === "session.attach";
    try { this.conn.receive(msg); } finally { this.attaching = false; }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.conn?.close();
    this.conn = null;
    // A real socket reports its close asynchronously; `ws.ts` nulls its handlers
    // first when it does not want to hear it.
    setTimeout(() => this.finish(code, reason), 0);
  }

  addEventListener(): void { /* HostConnection uses the on* handlers only */ }
  removeEventListener(): void { /* see above */ }
}

// ── Building it ───────────────────────────────────────────────────────────

/** The persisted snapshot, parsed, or undefined — never a throw. */
function readSaved(store: DemoStore | null, id: string): unknown {
  if (!store) return undefined;
  try {
    const raw = store.getItem(demoSnapKey(id));
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

/**
 * `Real` with "now" moved `by()` ms ahead: `Date.now()` and an argument-less
 * `new Date()` read the shifted instant; a `Date` built FROM a value is that
 * value, untouched, and every instance is still a real `Date`. Read live, so a
 * second jump needs no second patch. Demo only — installed by the transport.
 */
export function shiftDate(Real: DateConstructor, by: () => number): DateConstructor {
  function Shifted(this: unknown, ...args: unknown[]): unknown {
    const at = Real.now() + by();
    if (!new.target) return new Real(at).toString();
    return Reflect.construct(Real, args.length ? args : [at], new.target);
  }
  Shifted.prototype = Real.prototype;
  Object.setPrototypeOf(Shifted, Real); // parse, UTC and the rest come from Real
  Object.defineProperty(Shifted, "now", { value: () => Real.now() + by(), configurable: true, writable: true });
  return Shifted as unknown as DateConstructor;
}

export function createDemoTransport(cfg: DemoTransportConfig): DemoTransport {
  const { scenario, target, store } = cfg;
  // The UNSHIFTED clock, captured before `shiftDate` may replace `target.Date`:
  // the core adds its own shift, so reading the shifted one would count it twice.
  const RealDate = target.Date ?? Date;
  const clock = cfg.clock ?? { now: () => RealDate.now() };
  const href = () => cfg.href;
  const id = scenario.meta.id;
  const saved = readSaved(store, id);
  const host = saved === undefined ? createDemoHost(scenario, clock) : restoreDemoHost(scenario, clock, saved);

  // A scenario's `clock` step moved the demo ahead: the page's clock follows,
  // so "resets in 4h 58m" is counted from the instant the desktop is at. Only
  // ever installed once a jump happened (or a restored snapshot carries one).
  let shifted = false;
  const followClock = () => {
    if (shifted || !target.Date || host.clockShift() === 0) return;
    target.Date = shiftDate(target.Date, () => host.clockShift());
    shifted = true;
  };
  host.onChange(followClock);
  followClock();

  const persist = () => {
    if (!store) return;
    // Synchronous on purpose: the reload this exists for is a navigation, and a
    // debounced write would not survive it.
    try { store.setItem(demoSnapKey(id), JSON.stringify(host.snapshot())); } catch { /* quota — one page life only */ }
  };
  host.onChange(persist);
  // Written at once, so a reload before the first tap still keeps `startedAt`
  // (the script's clock) instead of starting the scenario over.
  persist();

  const refused = (url: string, via: string) => { try { cfg.onRefused?.(url, via); } catch { /* reporting only */ } };

  // fetch ────────────────────────────────────────────────────────────────
  const origFetch = target.fetch;
  target.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isReq = typeof input !== "string" && !(input instanceof URL);
    const url = isReq ? (input as Request).url : String(input);
    const { route, u } = routeOf(url, href());
    if (route === "local") return origFetch(input as RequestInfo, init);
    if (route === "refuse" || !u) { refused(url, "fetch"); throw new TypeError(`${OFF_DEVICE}: ${url}`); }
    const method = init?.method ?? (isReq ? (input as Request).method : "GET");
    const headers = new Headers(init?.headers ?? (isReq ? (input as Request).headers : undefined));
    let body: unknown = init?.body;
    if (body == null && isReq && method !== "GET" && method !== "HEAD") {
      try { body = await (input as Request).text(); } catch { body = undefined; }
    }
    const signal = init?.signal ?? (isReq ? (input as Request).signal : undefined);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const res = ask(host, toDemoRequest(method, u, body, headers.get("content-type")));
    if (res.afterMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, res.afterMs);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    }
    const bytes = new TextEncoder().encode(res.body).length;
    const noBody = NULL_BODY.has(res.status) || method.toUpperCase() === "HEAD";
    return new Response(noBody ? null : res.body, {
      status: res.status,
      headers: { "content-type": res.contentType, "content-length": String(noBody ? 0 : bytes) },
    });
  }) as typeof fetch;

  // XHR ──────────────────────────────────────────────────────────────────
  const X = target.XMLHttpRequest;
  if (X) patchXhr(X, host, href, refused);

  // sendBeacon ───────────────────────────────────────────────────────────
  const nav = target.navigator;
  if (nav) {
    const origBeacon = typeof nav.sendBeacon === "function" ? nav.sendBeacon.bind(nav) : null;
    nav.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      const s = String(url);
      const { route, u } = routeOf(s, href());
      if (route === "local") return origBeacon ? origBeacon(url, data) : false;
      if (route === "refuse" || !u) { refused(s, "sendBeacon"); return false; }
      // Answered NOW, and a Blob by its size only: a beacon fires on `pagehide`, and reading a
      // Blob there is a load into a dying document — WebKit reports it as an uncaught page
      // error. Both beacons (`/api/netstats`, `/api/ui-usage`) are telemetry the demo keeps none of.
      const type = typeof Blob !== "undefined" && data instanceof Blob ? data.type : null;
      ask(host, toDemoRequest("POST", u, data, type));
      return true;
    };
  }

  // the script ───────────────────────────────────────────────────────────
  let timer: ReturnType<typeof setInterval> | null = null;
  if (cfg.tick !== false) timer = setInterval(() => host.advance(), ADVANCE_MS);

  return {
    host,
    dial: (url) => new DemoSocket(host, url) as unknown as WebSocket,
    stop() { if (timer !== null) { clearInterval(timer); timer = null; } },
  };
}

// ── XHR ───────────────────────────────────────────────────────────────────

interface XhrMeta { method: string; url: string; timer?: ReturnType<typeof setTimeout>; demo?: boolean; headers?: Record<string, string> }

function progress(type: string, loaded: number, total: number): Event {
  const init = { lengthComputable: total > 0, loaded, total };
  return typeof ProgressEvent === "function" ? new ProgressEvent(type, init) : Object.assign(new Event(type), init);
}

/** An inbox upload the fake desktop accepted: its bytes stay in this page as an
 *  object URL, so the picture that was just marked shows where its path does. */
function keepUpload(u: URL, body: unknown, res: DemoHttpResponse): void {
  const repo = /^\/api\/repos\/([^/]+)\/inbox$/.exec(u.pathname);
  if (!repo || res.status !== 200 || typeof Blob === "undefined" || !(body instanceof Blob)) return;
  try {
    const saved = (JSON.parse(res.body) as { saved?: { name?: string }[] }).saved?.[0]?.name;
    if (saved) rememberDemoUpload(decodeURIComponent(repo[1]), saved, URL.createObjectURL(body));
  } catch { /* not the answer shape: nothing to keep */ }
}

/** Pin a read-only XHR attribute on THIS instance (an own property shadows the prototype's getter). */
function pin(x: object, name: string, value: unknown): void {
  Object.defineProperty(x, name, { value, configurable: true, writable: true });
}

function patchXhr(
  X: typeof XMLHttpRequest, host: DemoHost, href: () => string,
  refused: (url: string, via: string) => void,
): void {
  const proto = X.prototype;
  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();
  const origOpen = proto.open;
  const origSend = proto.send;
  const origAbort = proto.abort;
  const origHeader = proto.setRequestHeader;

  // Kept for the core: the inbox upload names its file in `x-file-name`.
  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const m = meta.get(this);
    if (m) (m.headers ??= {})[name.toLowerCase()] = value;
    return origHeader.call(this, name, value);
  };

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    meta.set(this, { method, url: String(url) });
    // @ts-expect-error — variadic passthrough of the optional async/user/pass args
    return origOpen.call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    if (!m) return origSend.call(this, body as XMLHttpRequestBodyInit | null);
    const { route, u } = routeOf(m.url, href());
    if (route === "local") return origSend.call(this, body as XMLHttpRequestBodyInit | null);
    m.demo = true;
    const fire = (t: EventTarget | null | undefined, ev: Event) => { try { t?.dispatchEvent(ev); } catch { /* a listener threw */ } };
    if (route === "refuse" || !u) {
      refused(m.url, "XMLHttpRequest");
      m.timer = setTimeout(() => {
        pin(this, "readyState", 4); pin(this, "status", 0);
        fire(this, new Event("readystatechange")); fire(this, progress("error", 0, 0)); fire(this, progress("loadend", 0, 0));
      }, 0);
      return;
    }
    const up = sizeOf(body);
    const ct = typeof Blob !== "undefined" && body instanceof Blob ? body.type : null;
    const req = toDemoRequest(m.method, u, typeof body === "string" ? body : body ?? undefined, ct);
    if (m.headers) req.headers = m.headers;
    const res = ask(host, req);
    keepUpload(u, body, res);
    const x = this;
    m.timer = setTimeout(() => {
      m.timer = undefined;
      // The upload half first, as the network would: the inbox strip and the
      // dictation queue both read `upload.onprogress` for "how far".
      if (up != null && up > 0 && x.upload) {
        fire(x.upload, progress("loadstart", 0, up));
        fire(x.upload, progress("progress", up, up));
        fire(x.upload, progress("load", up, up));
        fire(x.upload, progress("loadend", up, up));
      }
      const len = new TextEncoder().encode(res.body).length;
      pin(x, "readyState", 2); fire(x, new Event("readystatechange"));
      pin(x, "readyState", 3); fire(x, new Event("readystatechange"));
      pin(x, "status", res.status);
      pin(x, "statusText", String(res.status));
      pin(x, "responseURL", u.toString());
      pin(x, "responseText", res.body);
      let response: unknown = res.body;
      if (x.responseType === "json") { try { response = JSON.parse(res.body); } catch { response = null; } }
      pin(x, "response", response);
      const headers: Record<string, string> = { "content-type": res.contentType, "content-length": String(len) };
      pin(x, "getResponseHeader", (h: string) => headers[h.toLowerCase()] ?? null);
      pin(x, "getAllResponseHeaders", () => Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join(""));
      pin(x, "readyState", 4);
      fire(x, new Event("readystatechange"));
      fire(x, progress("progress", len, len));
      fire(x, progress("load", len, len));
      fire(x, progress("loadend", len, len));
    }, res.afterMs ?? 0);
  } as typeof proto.send;

  proto.abort = function (this: XMLHttpRequest) {
    const m = meta.get(this);
    if (!m?.demo) return origAbort.call(this);
    if (m.timer === undefined) return;
    clearTimeout(m.timer);
    m.timer = undefined;
    pin(this, "readyState", 4); pin(this, "status", 0);
    try {
      this.dispatchEvent(new Event("readystatechange"));
      this.dispatchEvent(progress("abort", 0, 0));
      this.dispatchEvent(progress("loadend", 0, 0));
    } catch { /* a listener threw */ }
    pin(this, "readyState", 0);
  };
}

// ── The page's one call ───────────────────────────────────────────────────

let installed: DemoTransport | null = null;

/** The live transport, or null outside the demo. `ws.ts` reads it. */
export function demoTransport(): DemoTransport | null {
  return installed;
}

/**
 * Turn the demo on for this page when one was asked for and this build has it.
 * Idempotent. Returns whether the page is now in the demo. An asked-for id this
 * build does not ship leaves the page as it was and says why (`demoProblem()`).
 */
export function installDemoTransport(): boolean {
  if (installed) return true;
  const id = demoScenarioId();
  if (!id) return false;
  const scenario = DEMO_SCENARIOS[id];
  if (!scenario) {
    setDemoActive(null, `There is no demo called "${id}" in this build.`);
    return false;
  }
  let store: DemoStore | null = null;
  try { store = globalThis.sessionStorage ?? null; } catch { store = null; }
  const dev = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  // This runs at module top of `main.tsx`, BEFORE React mounts: a throw here (a scenario with a
  // fault rule, a protocol it cannot speak, a snapshot it cannot restore) would leave a white
  // page — in the APK with no address bar to get out. A refusal becomes the demo problem
  // instead, so the "Demo not available / Leave the demo" screen draws.
  try {
    assertShippable(scenario);
    installed = createDemoTransport({
      scenario,
      href: location.href,
      target: globalThis as unknown as DemoTarget,
      store,
      onRefused: (url, via) => {
        // Loud in dev: a request leaving the device is a bug in a guard, and the
        // zero-network journey (WP7) would fail on it later anyway.
        if (dev) console.error(`[demo] refused ${via} to ${url} — the demo makes no request off this device`);
      },
    });
  } catch (e) {
    installed = null;
    setDemoActive(null, `The demo "${id}" could not start in this build: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
  setDemoActive(id);
  // Tests only: the fault journeys' handle (scripts/ui/journey-fault-*.mjs),
  // `globalThis.__demoFaultHook = { set(rules), fired(), snapshot() }`.
  // The condition is a build-time constant — a literal `import.meta.env.X`,
  // which vite folds (`?.` would defeat that; the `typeof` is for node, which
  // has no `env`) — so a build made without VITE_DEMO_FAULTS=1, every shipped
  // one, carries none of this, and no tap or URL can reach a fault rule.
  if (typeof import.meta.env !== "undefined" && import.meta.env.VITE_DEMO_FAULTS === "1") {
    const host = installed.host;
    (globalThis as Record<string, unknown>)["__demoFaultHook"] = {
      set: (rules: DemoFaultRule[]) => host.faults.set(rules),
      fired: () => host.faults.fired(),
      snapshot: () => host.snapshot(),
    };
  }
  return true;
}
