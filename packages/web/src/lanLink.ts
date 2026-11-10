/**
 * The LAN route at run time: wires `lanRoute.ts`'s ladder to the socket, the
 * transports, the shell's network events and the route chip.
 *
 * - **Triggers**: start, `shellNetChanged` (`shellNet.ts`), every socket
 *   REOPEN (a `welcome` this module did not cause), and a LAN failure — which
 *   falls back to the tailnet at once and is retried only on the NEXT trigger.
 * - **A verified LAN is the only way onto the LAN.** The route moves with
 *   `setRouteBase` (the transports read it per call) and `conn.redial` (the
 *   socket, with its queue intact). A socket that drops while on the LAN does
 *   not reconnect there by itself: the dial guard sends the reconnect to the
 *   tailnet, and its `welcome` re-runs the ladder — so the MAC is checked
 *   before every LAN connect, not once per install.
 * - **The token** (`deviceToken.ts`) is minted over the tailnet, and a 401 or
 *   an `authRequired` while carrying it drops it, falls back, and re-mints ONCE
 *   per page. A dial that held it back (`tokenWithheld`) drops nothing.
 * - **The identity** is read over the tailnet and re-read when a tailnet
 *   `welcome` names another `hostId`. Only on a protected route: it is the
 *   secret the LAN proof rests on.
 * - **The pin** is learned from a `welcome` whose socket DIALLED a protected
 *   address (`learnPins`), never a plain one, and `routePinsChanged` is the one
 *   way a change reaches the route, the socket and the background link. Before
 *   the shell's first reading a name proves nothing, so the learn, the identity
 *   and the LAN check all wait for one (`whenNetRead`).
 * - **A phone with no tailnet** has nothing to fall to, so what the ladder says
 *   as "using the tailnet" is said as what is true (`routeView`), and a pinned
 *   address that will not open says why and offers pairing by code (`sayStuck`).
 *   It also holds the read ticket `abs()` needs (`renewTicket`).
 *
 * In a browser there is no LAN switching (the page is served BY one address):
 * the chip only says which kind of peer the host saw, from `welcome.clientKind`.
 */
import { PLAIN_ROUTE_TOAST } from "@waterplane/shared";
import { showToast } from "./toast";
import type { DeviceTokenResponse, HostMessage, LanIdentityResponse, LanVerifyResponse } from "@waterplane/shared";
import { bgFetch, bgJson } from "./api";
import { deviceToken, dropDeviceToken, onBearerRejected, pickDeviceName, setDeviceToken } from "./deviceToken";
import { setHostRoute, type HostRouteView } from "./hostRoute";
import { activeHost, browserKV, listHosts, realHosts, setHostPins } from "./hosts";
import { baseOfDial, invalidateSavedHostBase, isNativeShell, netOwedNow, plainBaseNow, plainHostRoute, readTicketLeft, routeBase, savedBasePinned, savedHostBase, setReadTicket, setRouteBase, tokenWithheld, whenNetRead, wsUrl } from "./hostUrl";
import { isDemo } from "./demo/mode";
import { deviceModel, deviceName } from "./deviceInfo";
import { createLanRouter, fallbackGone, lanDialOf, lanDropOnSave, lanOnlyBase, lanOnlySentence, lanProbeAnswered, newNonce, parseLanIdentity, pinSyncPlan, refusalFits, troubleSentence, verifyLanAnswer, welcomePinPlan, type LanIdentity, type LanRouter, type LanVerdict, type RouteTrouble, type TokenState } from "./lanRoute";
import { hasShellTls, shellTls, shellTlsPins, shellTlsRefusal } from "./sdk/shellTls";
import { resyncShellLink } from "./shellLink";
import { currentNet, onShellNet } from "./shellNet";
import { LS, lsDel, lsJson, lsSetJson } from "./storage";
import type { LanTest } from "./hostTestWords";

/** What this needs of `HostConnection` — structural, like `link.ts`'s source. */
export interface LanConn {
  on(fn: (msg: HostMessage) => void): () => void;
  redial(url: string): void;
  reconnect(): void;
  setDialGuard(fn: ((url: string) => string) | null): void;
  readonly dialUrl: string;
  readonly tokenHeld: boolean;
}

// ── The LAN route's four requests ──────────────────────────────────────
//
// Background requests on `bgFetch` (fuse, no spinner), each to an ABSOLUTE
// address: `tailnet` is the saved host base, `lan` the LAN address being
// checked. The transport patch (`hostUrl.ts`) adds the device token only to
// the host base IN FORCE, so the probe and the verify — made while the LAN is
// not yet the route — carry nothing but a nonce.

/** `GET <lan>/api/health` within `ms`; how long it took. Never throws. A gated
 *  host's 401 counts as an answer (`lanProbeAnswered`). */
async function lanProbe(lan: string, ms: number): Promise<{ ok: boolean; ms?: number; at: number }> {
  const t0 = performance.now();
  try {
    const r = await bgFetch(`${lan}/api/health`, { cache: "no-store", credentials: "omit" }, ms);
    const took = performance.now() - t0;
    return { ok: lanProbeAnswered(r.status), ms: took, at: Date.now() };
  } catch {
    return { ok: false, at: Date.now() };
  }
}

/** `POST <lan>/api/lan/verify {nonce}` → `{hostId, mac}`, or null. */
async function lanVerify(lan: string, nonce: string): Promise<LanVerifyResponse | null> {
  const j = await bgJson<LanVerifyResponse>(`${lan}/api/lan/verify`, {
    method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }),
  }, 4000);
  return j && typeof j.hostId === "string" && typeof j.mac === "string" ? j : null;
}

/** `GET <tailnet>/api/lan/identity`, or null (not served to this peer, or down). */
async function lanIdentityOver(tailnet: string): Promise<LanIdentityResponse | null> {
  return bgJson<LanIdentityResponse>(`${tailnet}/api/lan/identity`, { cache: "no-store" }, 8000);
}

/** `POST <tailnet>/api/auth/token {deviceName}`: the token, `no-password`
 *  (403 — the host has none, so it mints nothing), or `failed`. */
async function mintDeviceTokenOver(tailnet: string, deviceName: string): Promise<{ token: string } | "no-password" | "failed"> {
  try {
    const r = await bgFetch(`${tailnet}/api/auth/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName }),
    }, 8000);
    if (r.status === 403) return "no-password";
    if (!r.ok) return "failed";
    const j = (await r.json()) as Partial<DeviceTokenResponse>;
    return typeof j.token === "string" && j.token ? { token: j.token } : "failed";
  } catch { return "failed"; }
}

/**
 * The Edit screen's "test" under the Wi-Fi address (`HostSetup.tsx`): the probe the route makes, then — for the desktop in use,
 * the only one whose identity this phone holds — the same HMAC check, so the answer says whether THIS desktop is there.
 */
export async function testLanAddress(lan: string, hostId: string): Promise<LanTest> {
  const t0 = performance.now();
  try {
    const r = await bgFetch(`${lan}/api/health`, { cache: "no-store", credentials: "omit" }, 4000);
    const took = performance.now() - t0;
    if (!lanProbeAnswered(r.status)) return { s: "bad", aborted: false };
    const id = activeHost()?.id === hostId ? storedIdentity() : null;
    if (!id) return { s: "ok", ms: took, proven: null };
    const nonce = newNonce();
    return { s: "ok", ms: took, proven: await verifyLanAnswer(id, nonce, await lanVerify(lan, nonce)) };
  } catch (e) {
    return { s: "bad", aborted: (e as Error)?.name === "AbortError" || performance.now() - t0 >= 3900 };
  }
}

let router: LanRouter | null = null;
let started = false;

function storedIdentity(): LanIdentity | null {
  return parseLanIdentity(lsJson<unknown>(LS.lanIdentity, null));
}

async function ensureIdentity(): Promise<LanIdentity | null> {
  const have = storedIdentity();
  if (have) return have;
  const saved = savedHostBase();
  // The secret behind the LAN proof: over a plain route it is the relay's to read.
  if (!saved || netOwedNow() || plainBaseNow(saved)) return null;
  const got = parseLanIdentity(await lanIdentityOver(saved));
  if (got) lsSetJson(LS.lanIdentity, got);
  return got;
}

async function ensureToken(): Promise<TokenState> {
  if (deviceToken()) return "ok";
  const saved = savedHostBase();
  if (!saved) return "failed";
  const r = await mintDeviceTokenOver(saved, pickDeviceName(deviceName(), deviceModel()));
  if (typeof r === "string") return r;
  setDeviceToken(r.token);
  return deviceToken() ? "ok" : "failed";
}

/** The shell's pins brought in line with the rows (`pinSyncPlan`). Each failure is left for the next
 *  boot: a pin that did not land is a refused dial and a fall to the tailnet, never a plain one. */
export async function syncShellPins(): Promise<void> {
  if (!hasShellTls()) return;
  const plan = pinSyncPlan(realHosts(listHosts()), await shellTlsPins());
  for (const pin of plan.set) { try { await shellTls.setPin(pin); } catch { /* next boot */ } }
  for (const id of plan.remove) { try { await shellTls.removePin(id); } catch { /* next boot */ } }
}

const TICKET_RENEW_MS = 10 * 60_000;
const TICKET_RETRY_MS = 5 * 60_000;
let ticketTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hold a read ticket while the saved route is a pinned LAN address, and only then: on a tailnet base
 * `abs()` needs none, and the desktop honours one only over TLS. Renewed quietly before it runs out;
 * a frozen page's timer is late, so every `welcome` asks too.
 */
async function renewTicket(): Promise<void> {
  const base = savedHostBase();
  if (!base || !savedBasePinned()) { setReadTicket(null); return; }
  if (readTicketLeft(base, Date.now()) > TICKET_RENEW_MS) return;
  const got = await bgJson<{ ticket?: unknown; exp?: unknown }>("/api/auth/read-ticket", { method: "POST" }, 8000);
  const fresh = got && typeof got.ticket === "string" && typeof got.exp === "number" ? { wt: got.ticket, exp: got.exp } : null;
  if (fresh) setReadTicket({ base, ...fresh });
  if (ticketTimer) clearTimeout(ticketTimer);
  const wait = fresh ? Math.max(TICKET_RETRY_MS, fresh.exp - Date.now() - TICKET_RENEW_MS) : TICKET_RETRY_MS;
  ticketTimer = setTimeout(() => { void renewTicket(); }, wait);
}

/** Browser: the chip says what the host saw, and never moves anything. */
function browserRoute(msg: Extract<HostMessage, { t: "welcome" }>): void {
  const served = typeof location !== "undefined" && location.hostname.endsWith(".ts.net");
  if (msg.clientKind === "lan") {
    setHostRoute({ route: "lan", sentence: "This browser reaches the desktop over the LAN." });
  } else if (msg.clientKind === "tailscale" || (msg.clientKind === "loopback" && served)) {
    setHostRoute({ route: "tailnet", sentence: "This browser reaches the desktop over the tailnet." });
  } else {
    setHostRoute(null);
  }
}

/** Re-run the ladder now (e.g. after the LAN settings of the host changed). */
export function lanRouteNow(trigger = "settings"): void {
  void router?.evaluate(trigger);
}

/** The LAN route's tailnet fallback, applied now (set by `startLanRoute`). */
let dropToTailnet: ((sentence: string) => void) | null = null;
/** Redial if the socket's url is no longer the route in force (set by `startLanRoute`). */
let repoint: (() => void) | null = null;

/** The active host's LAN settings with the address the route would actually be on. */
function lanInForce(): { base: string; auto: boolean } | null | undefined {
  const row = activeHost();
  if (!row?.lan) return row?.lan;
  return { base: lanDialOf(row, row.lan.base, hasShellTls())?.base ?? "", auto: row.lan.auto };
}

/**
 * The active host's LAN address, SSIDs or auto switch were just saved.
 * A LAN route the new settings no longer allow (auto off, the LAN address
 * removed or moved) is dropped to the tailnet NOW — not after the ladder's
 * next pass, which may be waiting on a probe — then the ladder runs again,
 * so a newly allowed LAN is tried without waiting for a network change.
 */
export function lanSettingsSaved(): void {
  const why = lanDropOnSave(routeBase(), lanInForce());
  if (why) dropToTailnet?.(why);
  lanRouteNow("settings");
}

/**
 * A row's `tls` or `tlsOff` just changed. The saved address may have with it, so it is read again and
 * the socket moved through `conn.redial` as any route change is. The background link is told, on any
 * row: it dials these addresses with the page dead.
 */
export function routePinsChanged(): void {
  invalidateSavedHostBase();
  const why = lanDropOnSave(routeBase(), lanInForce());
  if (why) dropToTailnet?.(why);
  repoint?.();
  void resyncShellLink();
  void renewTicket();
  lanRouteNow("pins");
}

export function startLanRoute(conn: LanConn): void {
  if (started) return;
  started = true;

  // The demo has no LAN to find and no route to report: the probes dial
  // absolute LAN addresses, which is exactly what may never leave the device.
  if (isDemo()) return;

  if (!isNativeShell()) {
    conn.on((msg) => { if (msg.t === "welcome") browserRoute(msg); });
    return;
  }

  /** Welcomes still owed to a redial THIS module made: not a trigger. */
  let ownWelcome = false;
  /** The LAN socket reached `open` since its redial. */
  let lanOpened = false;
  let reminted = false;
  /** Dials of a pinned saved address that did not open, since the last that did. */
  let savedMisses = 0;
  /** When a socket last opened on it: a refusal older than that is history. */
  let savedOpenAt = 0;
  /** The last trouble toasted: a dial that keeps failing says it once. */
  let told: RouteTrouble | null = null;

  /** A row with no tailnet address is not "using the tailnet", whatever failed. */
  const routeView = (v: LanVerdict): HostRouteView => {
    const row = activeHost();
    const trouble = v.trouble ? { trouble: v.trouble } : {};
    if (v.route === "lan" || !row || !lanOnlyBase(row.base)) return { route: v.route, sentence: v.sentence, ...trouble };
    return { route: "lan", sentence: v.trouble ? v.sentence : lanOnlySentence(savedHostBase() ?? row.base), ...trouble };
  };

  const sayTrouble = (trouble: RouteTrouble | undefined, sentence: string): void => {
    if (trouble && trouble !== told) showToast(sentence);
    told = trouble ?? null;
  };

  const moveSocket = (): void => {
    const url = wsUrl();
    if (url && url !== conn.dialUrl) {
      ownWelcome = true;
      lanOpened = false;
      conn.redial(url);
    }
  };
  repoint = moveSocket;

  const apply = (v: LanVerdict): void => {
    const wasPlain = plainHostRoute();
    setHostRoute(routeView(v));
    setRouteBase(v.lanBase);
    sayTrouble(v.trouble, v.sentence);
    if (!wasPlain && plainHostRoute()) showToast(PLAIN_ROUTE_TOAST);
    moveSocket();
  };

  /** A pinned saved address will not open: the ladder never runs for it, so this says why. Off
   *  Wi-Fi a LAN address cannot answer, and that is no reason to pair again. */
  const sayStuck = async (): Promise<void> => {
    const base = savedHostBase();
    const net = await currentNet();
    if (!base || (net && net.transport !== "wifi")) return;
    const trouble: RouteTrouble = refusalFits(await shellTlsRefusal(), base, savedOpenAt) ? "keyChanged" : "noAnswer";
    const sentence = troubleSentence(trouble, base, false);
    setHostRoute({ route: "lan", sentence, trouble });
    sayTrouble(trouble, sentence);
  };

  const noteSavedLink = (status: string): void => {
    if (routeBase() !== null || !savedBasePinned()) return;
    if (status === "open") { savedMisses = 0; savedOpenAt = Date.now(); return; }
    // Two in a row: the first close may be the one socket that had opened.
    if (status === "closed" && ++savedMisses >= 2) void sayStuck();
  };

  const pinsFrom = async (msg: Extract<HostMessage, { t: "welcome" }>, base: string | null): Promise<void> => {
    const row = activeHost(), kv = browserKV();
    if (!row || !kv) return;
    const plan = welcomePinPlan(row, msg, !!base && !plainBaseNow(base));
    if (!plan || !setHostPins(kv, row.id, plan).ok || !plan.tls) return;
    // A replaced pin also forgets what the WebView let in (`clearSslPreferences`, in the plugin),
    // and resolves after that, so the redial below cannot race it.
    if (hasShellTls()) {
      try { await shellTls.setPin({ hostId: row.id, spki: plan.tls.spki }); } catch { /* `syncShellPins`, next boot */ }
    }
    routePinsChanged();
  };

  /** What this welcome may teach, judged on the url its socket dialled, read before any wait. */
  const learnPins = (msg: Extract<HostMessage, { t: "welcome" }>): void => {
    const base = baseOfDial(conn.dialUrl);
    whenNetRead(() => { void pinsFrom(msg, base); });
  };

  dropToTailnet = (sentence) => apply({ route: "tailnet", sentence, lanBase: null });
  router = createLanRouter({
    host: () => activeHost(),
    net: () => currentNet(),
    ensureToken,
    ensureIdentity,
    probe: (lan, ms) => lanProbe(lan, ms),
    verify: (lan, nonce) => lanVerify(lan, nonce),
    apply,
    now: () => Date.now(),
    dial: (lan) => { const row = activeHost(); return row ? lanDialOf(row, lan, hasShellTls()) : null; },
    refused: async (lan, since) => refusalFits(await shellTlsRefusal(), lan, since),
    noFallback: (net) => { const row = activeHost(); return !!row && fallbackGone(row, net); },
  });
  const r = router;

  /** Off the LAN because it failed. Deferred one tick: this runs from inside
   *  the socket's own close/message handlers, and a redial there would race
   *  the reconnect timer the close is about to arm. */
  const fail = (reason: string): void => {
    setTimeout(() => { if (routeBase() !== null) r.noteFailure(reason); }, 0);
  };

  const rejectToken = (): void => {
    // A plain address cannot refuse a token it must never see: a reply carried here from before
    // the network moved is no reason to forget it. A withheld dial never gets this far.
    if (tokenWithheld()) return;
    dropDeviceToken();
    if (routeBase() !== null) fail("the desktop refused this phone's token");
    if (!reminted) { reminted = true; void ensureToken(); }
  };
  onBearerRejected(() => rejectToken());

  // A reconnect that is not a redial never goes back to the LAN on its own:
  // tailnet first, and the ladder runs again on that socket's welcome.
  conn.setDialGuard((url) => {
    if (routeBase() === null) return url;
    setRouteBase(null);
    setHostRoute({ route: "tailnet", sentence: "Using the tailnet while reconnecting; the LAN is checked again once connected." });
    return wsUrl() ?? url;
  });

  conn.on((msg) => {
    if (msg.t === "error" && msg.context === "__status") {
      noteSavedLink(msg.message);
      if (routeBase() === null) return;
      if (msg.message === "open") { lanOpened = true; return; }
      if (msg.message === "closed") {
        const visible = typeof document === "undefined" || document.visibilityState === "visible";
        // A phone going to sleep closes its socket on purpose — not a failure;
        // the dial guard moves the reconnect to the tailnet either way.
        if (!lanOpened) fail("the socket did not open");
        else if (visible) fail("the connection dropped");
      }
      return;
    }
    if (msg.t === "authRequired") {
      if (routeBase() !== null || deviceToken()) rejectToken();
      return;
    }
    if (msg.t !== "welcome") return;
    learnPins(msg);
    void renewTicket();
    const id = storedIdentity();
    if (msg.hostId && id && id.hostId !== msg.hostId) {
      lsDel(LS.lanIdentity);
      // On the LAN that is a different desktop than the one that proved itself.
      if (routeBase() !== null) { fail("a different desktop answered on the LAN"); return; }
    }
    if (ownWelcome) { ownWelcome = false; return; }
    void r.evaluate("reopen");
  });

  onShellNet(() => { void r.evaluate("net"); });
  void syncShellPins();
  void renewTicket();
  void r.evaluate("start");
  // The first reading came late: a socket dialled before it left the token behind, and the check
  // above ran without it. Neither waits for the next network change, which may never come.
  if (netOwedNow()) whenNetRead(() => {
    if (conn.tokenHeld && !tokenWithheld(baseOfDial(conn.dialUrl))) { ownWelcome = true; conn.reconnect(); }
    void r.evaluate("net");
  });
}
