import {
  PROTOCOL_VERSION,
  decode,
  encode,
  logTag,
  withSentAt,
  type ClientMessage,
  type HostMessage,
} from "@waterplane/shared";
import { wsUrl } from "./hostUrl";
import { noteHostSeen, noteLinkStatus, noteReload, noteRtt, noteTraffic } from "./link";
import { SHELL_NUDGE_EVENT } from "./shellLink";
import { deviceToken, wsProtocols } from "./deviceToken";
import { LS } from "./storage";
import { demoTransport } from "./demo/transport";
import { HeldFrames } from "./heldFrames";
import { bgFresh, parksWhenHidden } from "./core/term/bgFresh";

/** How a socket is made: the browser's `WebSocket`, or the demo's in-memory one. */
export type Dialer = (url: string, protocols?: string[]) => WebSocket;

type Listener = (msg: HostMessage) => void;
/** A binary frame: a plugin stream's (`shared/stream.ts`), routed by `core/streamRouter.ts`. */
type BinaryListener = (data: ArrayBuffer) => void;

/** Encode a frame and count what it weighs (`nettraffic.ts`). Every byte this
 *  app puts on the socket goes out through here, so the meter cannot be wrong
 *  by a send site somebody forgot — what it does NOT see is permessage-deflate,
 *  so a chatty stream is over-stated rather than missed. */
function wire(msg: ClientMessage): string {
  // `sentAt` is stamped HERE, at the write, on every durable frame that says
  // when it was first sent (`shared/sendstamp.ts`): the host reads the pair as
  // an age on the phone's own clock, so the stamp must not include time spent
  // waiting in `this.queue` for a socket to open.
  const s = encode(withSentAt(msg, Date.now()));
  noteTraffic("up", s.length);
  return s;
}

/** What a binary frame weighs: an ArrayBuffer's or a view's byteLength, a Blob's size, else 0
 *  (`noteTraffic` ignores a 0 rather than guessing). */
function binaryBytes(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

const HEARTBEAT_MS = 12000; // ping cadence; a missed pong by the next tick ⇒ dead socket
const VERIFY_TIMEOUT_MS = 1200;   // wake-time ping must be answered within this, else retry once, then zombie.
                                  // Kept short so a socket that died while backgrounded is caught and
                                  // reconnected inside the UI's banner grace window (no visible flash on a
                                  // quick return). One retry absorbs radio-wake latency spikes so a LIVE
                                  // socket isn't torn down for one slow pong.
const VERIFY_MAX_PINGS = 2;       // probe attempts before the socket is declared a zombie
const RELOAD_AFTER_MS = 8000;     // a wake/manual reconnect must yield an open socket within this, else hard-reload
const RELOAD_MIN_GAP_MS = 30000;  // rate-limit forced reloads so a down host can't cause a reload loop
const REACH_TIMEOUT_MS = 4000;    // how long the pre-reload reachability probe waits for /api/health

/**
 * Veto for the last-resort reload, registered by the UI.
 *
 * The watchdog exists to rescue a wedged page, and everything the app holds is
 * persisted (drafts, outbox, parked upload bytes) precisely so that reload
 * costs nothing. The one exception is work still being COMPOSED in memory — an
 * image being annotated has no durable form until it is sent — and reloading
 * through that is the app destroying the user's work to fix its own socket.
 */
let reloadGuard: (() => boolean) | null = null;
export function setReloadGuard(fn: (() => boolean) | null): void { reloadGuard = fn; }

/**
 * Thin reconnecting WebSocket client. Components subscribe to typed host
 * messages; sends are fire-and-forget (queued until the socket opens).
 */
export class HostConnection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  /** Binary frames go here and never to `listeners`, whose contract is a decoded HostMessage. */
  private binaryListeners = new Set<BinaryListener>();
  /** The hello batch can land before App's effect subscribes (`heldFrames.ts`). */
  private early = new HeldFrames<HostMessage>();
  private queue: ClientMessage[] = [];
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private awaitingPong = false; // a ping is outstanding (no pong yet)
  /** When the outstanding ping went out, so the pong can be priced. The socket
   *  already pings twice a minute for liveness; timing the answer costs nothing
   *  and is the only round-trip number the app can measure for itself — see
   *  netlog.ts, and the receipt deadlines it sizes in App.tsx. */
  private pingAt = 0;
  /** The display probe (`probe()`): its resolver, its deadline, and when it went
   *  out. Kept apart from `pingAt` so a probe and a heartbeat that overlap don't
   *  price each other's pong. */
  private probeResolve: ((ms: number | null) => void) | null = null;
  private probeTimer: number | null = null;
  private probeAt = 0;
  private verifyTimer: number | null = null;   // wake-time ping deadline
  private verifyPending = false;               // wake-time ping outstanding
  private verifyPings = 0;                     // probes sent in the current verify round
  private watchdogTimer: number | null = null; // last-resort reload deadline
  private authPaused = false;                   // gated by the host (needs password) — stop auto-reconnecting
  /** Set by `redial`: the next dial is to exactly this url, no guard asked. */
  private redialing = false;
  /**
   * Asked before every dial that is NOT a `redial`: which url to use. The LAN
   * route (`lanLink.ts`) uses it so a socket that drops while on the LAN
   * reconnects over the tailnet — the LAN is only ever dialled right after its
   * MAC was verified, never by a reconnect loop on its own.
   */
  private dialGuard: ((url: string) => string) | null = null;
  status: "connecting" | "open" | "closed" = "connecting";

  /** `dial` is the one seam the demo uses (`demo/transport.ts`): the class,
   *  its wake/verify/watchdog logic and the single-owner rule stay as they are. */
  constructor(private url: string, private readonly dial: Dialer | null = null) {
    this.connect();
    // Mobile browsers freeze JS/timers when backgrounded and silently drop the
    // socket; the close-driven 1s timer may never run on resume, leaving the UI
    // stuck on "connection lost" until a manual refresh. Verify liveness (never
    // trust readyState — see verifyAlive) whenever the page comes back to the
    // foreground / regains network.
    const wake = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      this.verifyAlive();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", wake);
      // Page Lifecycle: entering the frozen state (Android tab freeze / bfcache)
      // kills the network stack while readyState keeps claiming OPEN. Close the
      // socket NOW while we still can, so resume starts from a clean "closed"
      // and reconnects immediately instead of trusting a zombie.
      document.addEventListener("resume", wake);
      document.addEventListener("freeze", () => this.dropSocketForSleep());
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      window.addEventListener("pageshow", wake);
      window.addEventListener("pagehide", () => this.dropSocketForSleep());
      // The Android shell saying the phone's network changed. Deliberately NOT
      // routed through `wake`: every event above is a VIEWPORT event and `wake`
      // returns early when the page is not visible, which is precisely the case
      // this one exists for — the APK's foreground service keeps the page ALIVE
      // while it is off screen, so a tunnel that flaps behind a backgrounded app
      // gets no signal at all without this.
      window.addEventListener(SHELL_NUDGE_EVENT, () => this.verifyAlive());
    }
  }

  /** Close the socket ahead of a freeze/bfcache park (the connection won't
   *  survive it anyway) so the resumed page reconnects from a clean state. */
  private dropSocketForSleep(): void {
    this.stopHeartbeat();
    try { this.ws?.close(); } catch { /* already dead */ }
  }

  /**
   * Wake-time liveness check. A resumed page's socket often *says* OPEN but is
   * dead (the network changed while the tab was frozen; no FIN ever arrived),
   * so readyState can't be trusted here. Not open → reconnect now. Open → ping
   * and demand a pong within VERIFY_TIMEOUT_MS, else tear it down and
   * reconnect. Either path arms the reload watchdog, so a reconnect that goes
   * nowhere ends in a full page reload (the thing that always recovers)
   * instead of a dead-looking UI.
   */
  private verifyAlive(): void {
    if (this.authPaused) return; // gated — no socket to verify, don't arm the reload watchdog
    this.armWatchdog();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // A resume fires several wake events back-to-back (visibilitychange,
      // focus, pageshow). If one of them (or the 1s retry) already has a
      // connect in flight, let it finish — churning it restarts the handshake.
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
      this.forceReconnect();
      return;
    }
    if (this.verifyTimer != null) return; // one probe round at a time
    this.verifyPings = 0;
    this.sendVerifyPing();
  }

  /** One probe of the verify round: ping, and demand ANY inbound traffic within
   *  VERIFY_TIMEOUT_MS. First miss retries (a just-woken radio can stall a pong
   *  past the deadline on a perfectly live socket); second miss ⇒ zombie ⇒
   *  reconnect. Tearing down a live socket here is expensive — the fresh
   *  handshake can outlast the reload watchdog. */
  private sendVerifyPing(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.forceReconnect(); return; }
    this.verifyPending = true;
    this.verifyPings++;
    this.pingAt = Date.now();
    try { this.ws.send(wire({ t: "ping" })); } catch { this.forceReconnect(); return; }
    this.verifyTimer = window.setTimeout(() => {
      this.verifyTimer = null;
      if (!this.verifyPending) return;
      this.verifyPending = false;
      if (this.verifyPings < VERIFY_MAX_PINGS) this.sendVerifyPing();
      else this.forceReconnect();
    }, VERIFY_TIMEOUT_MS);
  }

  /**
   * Time ONE round trip, for display (`netpulse.ts`).
   *
   * Deliberately separate from both the heartbeat and the wake-time verify
   * round, and deliberately toothless: a probe that times out resolves `null`
   * and does nothing else. It never reconnects, never marks the socket a
   * zombie, never touches `awaitingPong`. The bar exists to REPORT the link, and
   * a readout that could tear down a socket would be changing the thing it
   * claims to be measuring — a slow-but-working path would start dropping under
   * observation, which is the one failure mode a diagnostic must not have.
   *
   * One probe at a time; a second call while one is outstanding resolves `null`
   * rather than queueing, because the caller samples on a clock and a backlog of
   * probes would draw the same round trip twice.
   */
  probe(timeoutMs: number): Promise<number | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    if (this.probeResolve) return Promise.resolve(null);
    try { this.ws.send(wire({ t: "ping" })); } catch { return Promise.resolve(null); }
    const at = Date.now();
    return new Promise<number | null>((resolve) => {
      this.probeResolve = (ms) => resolve(ms);
      this.probeTimer = window.setTimeout(() => this.settleProbe(null), timeoutMs);
      this.probeAt = at;
    });
  }

  /** Land the outstanding probe, once, from either the pong or the timeout. */
  private settleProbe(ms: number | null): void {
    if (this.probeTimer != null) { window.clearTimeout(this.probeTimer); this.probeTimer = null; }
    const fn = this.probeResolve;
    this.probeResolve = null;
    if (fn) fn(ms);
  }

  /**
   * Last resort: if no live socket exists RELOAD_AFTER_MS from now, reload the
   * whole page — the automated version of the browser-reload users fall back
   * to when the app comes back frozen. Guarded to visible pages, skipped while
   * offline (a reload can't help), and rate-limited against reload loops.
   * Cleared the moment a socket opens.
   */
  private armWatchdog(): void {
    // Re-arm on every call: the deadline is RELOAD_AFTER_MS after the LATEST
    // wake, not the oldest. A hide/show inside the window would otherwise
    // inherit a nearly-expired fuse and hard-reload seconds after coming back,
    // while its reconnect was still in flight.
    this.clearWatchdog();
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      void this.maybeForceReload();
    }, RELOAD_AFTER_MS);
  }

  /**
   * The watchdog's reload, gated on the HOST ACTUALLY BEING REACHABLE.
   *
   * A reload only helps for the failure this watchdog exists for: a live host
   * behind a zombie socket / wedged page. When the host is NOT reachable, the
   * reload is the worst thing that can happen — over plain HTTP there is no
   * service worker, so the navigation lands on the browser's own
   * ERR_CONNECTION_TIMED_OUT page and the whole app is GONE: no queue UI, no
   * compose box, no way back until the tunnel returns. Text typed at that
   * moment is stranded in localStorage that nothing can read.
   *
   * `navigator.onLine` does not answer this. A phone on 5G is "online" while
   * the Tailscale path to the host is dead, which is exactly the case that was
   * reloading people into the error page. So probe `/api/health` first and only
   * reload when it answers.
   */
  private async maybeForceReload(): Promise<void> {
    if (this.status === "open") return;
    // Something on screen holds work that exists ONLY in this tab's memory —
    // today the annotator, mid-markup. Reloading there destroys exactly what
    // the user is in the middle of making, to fix a socket they can fix by
    // waiting. Defer and re-arm: the watchdog fires again once the work is
    // committed (the marked image is parked in the send queue on send).
    if (reloadGuard?.()) { this.armWatchdog(); return; }
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!(await this.hostReachable())) return; // a reload would land on the browser's error page
    // No service worker ⇒ no cached app shell ⇒ a reload that misses is fatal
    // to the whole app, not a slow paint. One probe only proves the link was up
    // a moment ago, and a flapping tunnel answers one request and drops the
    // next — so demand a second answer before betting the session on it.
    if (!this.hasShellCache() && !(await this.hostReachable())) return;
    // The probe took a moment — the socket may have come back meanwhile.
    if (this.ws?.readyState === WebSocket.OPEN) return;
    // Second probe, and only where a bad reload is UNRECOVERABLE: with no
    // service worker controlling the page (plain http over Tailscale is not a
    // secure context, so there is none) the navigation has no cached shell to
    // fall back on. A tunnel that dies in the gap between "health said yes" and
    // "the browser asks for the document" leaves ERR_CONNECTION_TIMED_OUT where
    // the app used to be — no queue, no compose box, nothing but the browser's
    // reload button. Two hits in a row don't make that impossible; they make it
    // a genuinely momentary flap rather than a link that answered once.
    const controlled = typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;
    if (!controlled) {
      if (!(await this.hostReachable())) return;
      if (this.ws?.readyState === WebSocket.OPEN) return;
    }
    try {
      const last = Number(sessionStorage.getItem(LS.lastForcedReload) || 0);
      if (Date.now() - last < RELOAD_MIN_GAP_MS) return;
      sessionStorage.setItem(LS.lastForcedReload, String(Date.now()));
    } catch { /* storage unavailable — still reload, just without the loop guard */ }
    // Written through synchronously by `noteReload` — a debounced write would not
    // survive the navigation it is describing, and "how often does the watchdog
    // nuke the page?" is one of the numbers worth having.
    noteReload();
    location.reload();
  }

  /** Does a service worker control this page? Then a reload paints from cache
   *  even with the host unreachable, and getting the probe wrong is cheap. */
  private hasShellCache(): boolean {
    try { return !!navigator.serviceWorker?.controller; } catch { return false; }
  }

  /** Is the host answering HTTP right now? Same origin, no cache, short fuse. */
  private async hostReachable(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), REACH_TIMEOUT_MS);
      try {
        // The reachability probe behind the watchdog reload. It must not be counted
        // as activity (it runs when the socket is already suspect) and it owns its
        // own timeout, because the answer it needs is "did anything at all reply",
        // not "did the API".
        // eslint-disable-next-line no-restricted-globals -- watchdog probe
        const r = await fetch("/api/health", { cache: "no-store", signal: ctl.signal, credentials: "same-origin" });
        return r.ok;
      } finally {
        window.clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer != null) { window.clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  /** Public: drop the current socket and reconnect immediately. The in-app
   *  terminal "refresh" calls this so it recovers a dead (zombie) socket the
   *  same way a full page reload does — without reloading. Arms the watchdog,
   *  so if reconnecting goes nowhere the page hard-reloads by itself. */
  reconnect(): void {
    this.authPaused = false; // login succeeded (or a manual retry) — resume connecting
    this.armWatchdog();
    this.forceReconnect();
  }

  /** The url the socket dials. */
  get dialUrl(): string { return this.url; }

  setDialGuard(fn: ((url: string) => string) | null): void { this.dialGuard = fn; }

  /**
   * Reconnect to ANOTHER address of the same host (LAN ⇄ tailnet), live.
   *
   * Exactly a `forceReconnect` with a new url, and deliberately nothing more:
   * the frames queued here while the socket was not open stay queued and go
   * out on the new socket's `onopen`, after its `hello` — the same path every
   * reconnect already takes. Nothing already SENT is re-sent from here: a send
   * that was on the old socket is the outbox's to retry, with the SAME ackId,
   * on the status edge (`core/queue`), and the host re-acks rather than
   * re-executes a repeat. No reload, ever — a route switch is not a host switch.
   * A no-op when the url is the one in use and the socket is open or opening.
   */
  redial(url: string): void {
    if (url === this.url && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.url = url;
    this.authPaused = false; // a different route may not be gated at all
    this.redialing = true;
    this.forceReconnect();
  }

  /** Ping/pong liveness. A mobile network switch can leave the socket in a
   *  half-open state: readyState says OPEN but nothing flows, so onclose never
   *  fires and ensureConnected() trusts the lie. We ping every HEARTBEAT_MS; if
   *  the prior ping got no pong by the next tick, the socket is dead → reconnect.
   *  This auto-heals the "black terminal, refresh does nothing" zombie. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Hidden with the terminal parked (`core/term/bgFresh.ts`): no 12 s radio
      // wake-up. A dead socket is found on the way back — the wake path
      // ping-verifies before it trusts OPEN — and a catch-up that hits one is
      // given up by its own fuse.
      if (document.visibilityState === "hidden" && parksWhenHidden(bgFresh())) { this.awaitingPong = false; return; }
      if (this.awaitingPong) { this.awaitingPong = false; this.forceReconnect(); return; }
      this.awaitingPong = true;
      this.pingAt = Date.now();
      this.ws.send(wire({ t: "ping" }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) { window.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** Drop any pending timer + stale socket and open a fresh one immediately. */
  private forceReconnect(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    this.connect();
  }

  private connect(): void {
    if (this.redialing) this.redialing = false;
    else if (this.dialGuard) {
      try { this.url = this.dialGuard(this.url) || this.url; } catch { /* keep the url */ }
    }
    this.status = "connecting";
    this.emitStatus();
    let ws: WebSocket;
    try {
      // The device token as a second subprotocol, when this phone holds one
      // (`deviceToken.ts`); with none the dial is byte-identical to before.
      const protocols = wsProtocols(deviceToken());
      if (this.dial) ws = this.dial(this.url, protocols);
      else ws = protocols ? new WebSocket(this.url, protocols) : new WebSocket(this.url);
    } catch {
      // Construction can throw synchronously (e.g. mid page-restore). Without
      // this, no onclose ever fires and reconnection stops for good.
      this.status = "closed";
      this.emitStatus();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Plugin streams arrive as binary frames on this same socket (`shared/stream.ts`; never a
    // second one). An ArrayBuffer is synchronous to read, where a Blob would need a promise per
    // frame and could reorder them. Text frames are untouched by this.
    try { ws.binaryType = "arraybuffer"; } catch { /* a socket that cannot say — its binary frames are dropped below */ }

    ws.onopen = () => {
      this.status = "open";
      this.clearWatchdog();
      this.verifyPending = false;
      this.emitStatus();
      this.send({ t: "hello", protocol: PROTOCOL_VERSION });
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) this.send(m);
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      // Counted before it is parsed: a frame we cannot decode still crossed the
      // tunnel and still cost the radio. A binary frame (a plugin stream's) is
      // counted by its bytes, header included — video is most of what a live
      // desktop moves, and a ↓ meter that skipped it would be the one lie here.
      const binary = typeof ev.data !== "string";
      if (!binary) noteTraffic("down", ev.data.length);
      else noteTraffic("down", binaryBytes(ev.data));
      // Same event, the other reading: an inbound frame is the newest proof the
      // desktop is there, which is what "last connected" means (`netsync.ts`).
      // An open `readyState` is not — it survives a tunnel that has already died.
      noteHostSeen();
      // ANY inbound frame proves the socket is live — not just a pong. A wake
      // mid-stream (PTY bytes flowing) must not let a probe timeout tear the
      // connection down, and a live socket means the reload watchdog is moot.
      this.awaitingPong = false;
      this.verifyPending = false;
      if (this.verifyTimer != null) { window.clearTimeout(this.verifyTimer); this.verifyTimer = null; }
      this.clearWatchdog();
      if (binary) {
        // Never decoded as JSON and never handed to `listeners`. Anything that is not an
        // ArrayBuffer (a Blob from a socket that ignored `binaryType`) is dropped in silence,
        // like any binary frame the stream router does not recognise.
        if (ev.data instanceof ArrayBuffer) this.deliverBinary(ev.data);
        return;
      }
      // Only the DECODE is guarded here: a throw inside a listener is not a
      // malformed frame, and swallowing it as one once hid App's own bugs AND
      // starved every listener after it (`deliver` isolates each instead).
      let msg: HostMessage;
      try { msg = decode<HostMessage>(ev.data as string); } catch { return; /* malformed */ }
      if (msg.t === "pong") {
        // Only price a pong we actually asked for: `pingAt` is cleared here so
        // a second pong (the verify round can overlap the heartbeat) is not
        // measured from the wrong ping.
        if (this.pingAt) { noteRtt(Date.now() - this.pingAt); this.pingAt = 0; }
        // A pong carries no id, so the first one back after a probe went out
        // settles it even if it was really the heartbeat's. Both are round
        // trips over the same socket taken moments apart, so the reading is
        // right to within the overlap — and the alternative (a correlation id)
        // would be a wire change for a graph.
        if (this.probeResolve) this.settleProbe(Date.now() - this.probeAt);
        return; // heartbeat reply — not for listeners
      }
      // Host says this connection needs the LAN password: it's about to close
      // the socket. Stop the reconnect loop (each retry would just bounce) until
      // login() succeeds and calls reconnect(). Clear the reload watchdog so a
      // gated tab doesn't hard-reload itself.
      if (msg.t === "authRequired") { this.authPaused = true; this.clearWatchdog(); }
      this.deliver(msg);
    };
    ws.onclose = () => {
      this.status = "closed";
      // A probe outstanding over a socket that just died has its answer: none.
      this.settleProbe(null);
      this.stopHeartbeat();
      this.emitStatus();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.authPaused) return; // gated — wait for an explicit reconnect() after login
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private emitStatus(): void {
    // The permanent link strip repaints on the edge rather than on its own next
    // tick — a dot that stays green for three seconds after the socket dropped
    // is the exact wrong answer for the one screen whose job is being right
    // about this.
    // The ONE writer of "am I online" (`link.ts`): the offline clock, the
    // reconnect count, "last connected" and the strip's dot all move on this
    // call, so a status the transport knows about cannot be one a readout
    // disagrees with. Idempotent — a repeated status is a no-op.
    noteLinkStatus(this.status);
    // Surfaced as a synthetic message so the UI can react in one place.
    this.deliver({ t: "error", message: this.status, context: "__status" });
  }

  /** Every listener hears every frame, in registration order, and a throw in
   *  one is contained to it — logged loudly, never mistaken for a bad frame. */
  private deliver(msg: HostMessage): void {
    if (this.early.keep(msg, this.listeners.size)) return;
    this.fanOut(msg);
  }

  private fanOut(msg: HostMessage): void {
    for (const l of this.listeners) {
      try { l(msg); } catch (e) { console.error(`${logTag} socket listener failed on ${msg.t}`, e); }
    }
  }

  private deliverBinary(data: ArrayBuffer): void {
    for (const l of this.binaryListeners) {
      try { l(data); } catch (e) { console.error(`${logTag} binary listener failed`, e); }
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(wire(msg));
    } else {
      this.queue.push(msg);
    }
  }

  /** Write NOW or not at all: false (nothing sent, nothing queued) unless the socket is truly
   *  OPEN. `send()` RAM-queues and replays on the next open — right for a queued op, wrong for a
   *  LIVE question whose caller was already told "it may have run" (`plugin.call`). */
  trySend(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(wire(msg));
    return true;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    this.early.subscribed(queueMicrotask, (m) => this.fanOut(m));
    return () => this.listeners.delete(listener);
  }

  /** Binary frames (plugin streams). Not held for a late subscriber like `on`'s hello batch: a
   *  frame for a stream nobody has opened yet is one nobody asked for. */
  onBinary(listener: BinaryListener): () => void {
    this.binaryListeners.add(listener);
    return () => this.binaryListeners.delete(listener);
  }
}

// Singleton — one WebSocket per tab, period. App.tsx calls this from a useRef
// initializer, which React evaluates on EVERY render; before this guard each
// App render constructed (and leaked) a full HostConnection — an extra socket
// plus wake listeners whose reload watchdog could hard-reload the page even
// while the real connection was healthy.
let singleton: HostConnection | null = null;

export function makeConnection(): HostConnection {
  if (!singleton) {
    // Same-origin in the browser; the paired host in the Android shell, where
    // the page origin is the APK's own asset server (see hostUrl.ts). A
    // WebSocket handshake never goes through `fetch`, so this is the one URL the
    // transport patch there cannot cover.
    const url = wsUrl();
    if (!url) {
      // Native shell with no host paired. Unreachable — main.tsx renders the
      // setup screen instead of the app until one is. Throwing keeps it that way
      // loudly (BootGuard catches it) rather than opening a socket to the APK's
      // own asset server and retrying behind a "connecting" banner forever.
      throw new Error("no host paired — open the host setup screen");
    }
    // The demo: the same class over an in-memory socket wired to the fake
    // desktop. Still the one connection, still built only here.
    const demo = demoTransport();
    singleton = demo ? new HostConnection(url, demo.dial) : new HostConnection(url);
  }
  return singleton;
}
