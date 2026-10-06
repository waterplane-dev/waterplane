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
 *   per page.
 * - **The identity** is read over the tailnet and re-read when a tailnet
 *   `welcome` names another `hostId`.
 *
 * In a browser there is no LAN switching (the page is served BY one address):
 * the chip only says which kind of peer the host saw, from `welcome.clientKind`.
 */
import type { DeviceTokenResponse, HostMessage, LanIdentityResponse, LanVerifyResponse } from "@waterplane/shared";
import { bgFetch, bgJson } from "./api";
import { deviceToken, dropDeviceToken, onBearerRejected, pickDeviceName, setDeviceToken } from "./deviceToken";
import { setHostRoute } from "./hostRoute";
import { activeHost } from "./hosts";
import { isNativeShell, routeBase, savedHostBase, setRouteBase, wsUrl } from "./hostUrl";
import { isDemo } from "./demo/mode";
import { deviceModel, deviceName } from "./installLog";
import { createLanRouter, lanDropOnSave, parseLanIdentity, type LanIdentity, type LanRouter, type LanVerdict, type TokenState } from "./lanRoute";
import { currentNet, onShellNet } from "./shellNet";
import { LS, lsDel, lsJson, lsSetJson } from "./storage";

/** What this needs of `HostConnection` — structural, like `link.ts`'s source. */
export interface LanConn {
  on(fn: (msg: HostMessage) => void): () => void;
  redial(url: string): void;
  setDialGuard(fn: ((url: string) => string) | null): void;
  readonly dialUrl: string;
}

// ── The LAN route's four requests ──────────────────────────────────────
//
// Background requests on `bgFetch` (fuse, no spinner), each to an ABSOLUTE
// address: `tailnet` is the saved host base, `lan` the LAN address being
// checked. The transport patch (`hostUrl.ts`) adds the device token only to
// the host base IN FORCE, so the probe and the verify — made while the LAN is
// not yet the route — carry nothing but a nonce.

/** `GET <lan>/api/health` within `ms`; how long it took. Never throws. */
async function lanProbe(lan: string, ms: number): Promise<{ ok: boolean; ms?: number; at: number }> {
  const t0 = performance.now();
  try {
    const r = await bgFetch(`${lan}/api/health`, { cache: "no-store", credentials: "omit" }, ms);
    const took = performance.now() - t0;
    return { ok: r.ok, ms: took, at: Date.now() };
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

let router: LanRouter | null = null;
let started = false;

function storedIdentity(): LanIdentity | null {
  return parseLanIdentity(lsJson<unknown>(LS.lanIdentity, null));
}

async function ensureIdentity(): Promise<LanIdentity | null> {
  const have = storedIdentity();
  if (have) return have;
  const saved = savedHostBase();
  if (!saved) return null;
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

/**
 * The active host's LAN address, SSIDs or auto switch were just saved.
 * A LAN route the new settings no longer allow (auto off, the LAN address
 * removed or moved) is dropped to the tailnet NOW — not after the ladder's
 * next pass, which may be waiting on a probe — then the ladder runs again,
 * so a newly allowed LAN is tried without waiting for a network change.
 */
export function lanSettingsSaved(): void {
  const why = lanDropOnSave(routeBase(), activeHost()?.lan);
  if (why) dropToTailnet?.(why);
  lanRouteNow("settings");
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

  const apply = (v: LanVerdict): void => {
    setHostRoute({ route: v.route, sentence: v.sentence });
    setRouteBase(v.lanBase);
    const url = wsUrl();
    if (url && url !== conn.dialUrl) {
      ownWelcome = true;
      lanOpened = false;
      conn.redial(url);
    }
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
  });
  const r = router;

  /** Off the LAN because it failed. Deferred one tick: this runs from inside
   *  the socket's own close/message handlers, and a redial there would race
   *  the reconnect timer the close is about to arm. */
  const fail = (reason: string): void => {
    setTimeout(() => { if (routeBase() !== null) r.noteFailure(reason); }, 0);
  };

  const rejectToken = (): void => {
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
  void r.evaluate("start");
}
