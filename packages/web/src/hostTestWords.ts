/**
 * What a "test" button under one of a desktop's addresses says (pure; `HostSetup.tsx`). Each address has its own button and its
 * own sentence: the tailnet one names the folder the daemon serves, the Wi-Fi one says whether that desktop PROVED it is the one
 * (`lanLink.ts testLanAddress`, the HMAC check the route itself uses) — after a DHCP shuffle another device can own the old address.
 */
import { normalizeHostBase } from "@waterplane/shared";

/** One LAN test. `proven`: true = the desktop answered the identity check, false = something answered and failed it, null = not checked (no identity on this phone for this desktop). */
export type LanTest = { s: "ok"; ms: number; proven: boolean | null } | { s: "bad"; aborted: boolean };

export const ms = (n: number): string => `${Math.max(1, Math.round(n))} ms`;

export function tailnetOkWords(took: number, root: string): string {
  return `Reached in ${ms(took)}: the desktop serving ${root}.`;
}

export function lanTestWords(t: LanTest): { tone: "ok" | "warn" | "dead"; text: string } {
  if (t.s === "bad") {
    return { tone: "dead", text: t.aborted
      ? "No answer within 4 s. The desktop's Wi-Fi address may have changed, or this phone is not on that Wi-Fi."
      : "Could not reach that address. Check that this phone is on the same Wi-Fi as the desktop." };
  }
  if (t.proven === true) return { tone: "ok", text: `Reached in ${ms(t.ms)}: this desktop proved who it is.` };
  if (t.proven === false) return { tone: "dead", text: `Something answered in ${ms(t.ms)}, but it is not this desktop. The address may now belong to another device.` };
  return { tone: "warn", text: `A desktop answered in ${ms(t.ms)}. Which one is checked when the app switches to it; switch to this desktop to check it now.` };
}

/** The host part of an address, or null. */
function hostOf(s: string): string | null {
  const b = normalizeHostBase(s);
  if (!b) return null;
  try { return new URL(b).hostname; } catch { return null; }
}

/** The address the desktop reports NOW, when its HOST differs from the typed one and the typed one has not proved itself.
 *  The host, not the whole address: a typed `https://` or port on the same IP is `lanHttpsFix`'s, not a stale address. */
export function staleLanOffer(lanBase: string | null, test: LanTest | null, reported: readonly string[]): string | null {
  if (!lanBase || (test?.s === "ok" && test.proven === true)) return null;
  const typed = hostOf(lanBase);
  const other = reported.find((ip) => hostOf(ip) !== typed);
  return other ?? null;
}

/**
 * A Wi-Fi address typed as `https://` to a bare IP, or null. The app adds TLS by itself, and only to the plain
 * form (`tlsBaseOf`): it dials `https://<ip>:<the desktop's TLS port>` with the pin checked. Typed as https, the
 * address is dialled as written (the plain port never speaks TLS) and is never matched to the pin. The offer is the
 * bare IP. A name is left alone: an https name may be a front door with a real certificate.
 */
export function lanHttpsFix(lanBase: string | null): string | null {
  if (!lanBase?.startsWith("https:")) return null;
  const h = hostOf(lanBase);
  return h && /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null;
}

export interface LanTlsFacts {
  lanBase: string | null;
  /** Inside the Android shell (`isNativeShell`). A browser cannot pin, and never says so here. */
  shell: boolean;
  /** This shell enforces TLS pins (`hasShellTls`): an APK from before the encrypted link does not. */
  enforcing: boolean;
  tls?: { port: number; spki: string };
  tlsOff?: boolean;
}

/**
 * Whether the Wi-Fi link to this desktop is encrypted, as one line under the address, or null for nothing to say.
 * The key is learned with no step of the person's: a `welcome` over a protected (tailnet) connection carries it
 * (`welcomePinPlan`). `tlsOff` says nothing here: the row's own shield says plain HTTP was chosen.
 */
export function lanTlsLine(f: LanTlsFacts): { tone: "ok" | "warn"; text: string } | null {
  if (!f.shell || !f.lanBase || f.lanBase.startsWith("https:") || f.tlsOff) return null;
  if (!f.enforcing) return { tone: "warn", text: "This app version cannot encrypt the Wi-Fi link. The newest APK can: install it from Apps." };
  if (!f.tls) return { tone: "warn", text: "Not encrypted yet: this phone learns the desktop's key by itself the next time it connects to it over Tailscale." };
  return { tone: "ok", text: `Encrypted on port ${f.tls.port}: the desktop's key ${f.tls.spki.slice(0, 16)}… is pinned on this phone.` };
}

// ── Which address is in use (the Edit screen's top panel and its two cards) ───────────

/** What the top panel of the Edit screen is told: the route store (`hostRoute.ts`) and the socket, for the desktop in use. */
export interface RouteNowFacts {
  /** This row is the desktop in use. Only that one has a route; every other row is not dialled at all. */
  active: boolean;
  /** `null` until the route has been decided. */
  route: { route: "lan" | "tailnet"; sentence: string } | null;
  status: "connecting" | "open" | "closed";
  /** "3m" — how long since the desktop was last heard; null when never. */
  lastSeenAgo: string | null;
  /** The address the socket is dialling now (`hostBase()`). */
  dial: string | null;
  /** The saved tailnet address: the dial is shown only when it differs (the field below already shows this one). */
  saved?: string | null;
}

export interface RouteNowWords {
  /** Which way: null = none (another desktop is in use, or not decided yet). */
  via: "lan" | "tailnet" | null;
  head: string;
  state: string;
  /** The address being dialled, on its own line; null when nothing is. */
  dial: string | null;
  tone: "ok" | "warn" | "dead" | null;
  why: string | null;
}

/** The top panel: WHICH address this phone is on now, whether it answers, and why that one. */
export function routeNowWords(f: RouteNowFacts): RouteNowWords {
  if (!f.active) {
    return { via: null, head: "Not in use", state: "This phone is on another desktop. Switch to this one from the list to connect to it.", dial: null, tone: null, why: null };
  }
  const secs = !!f.lastSeenAgo && /^\d+s$/.test(f.lastSeenAgo);
  const heard = !f.lastSeenAgo ? "" : secs ? (f.status === "closed" ? "dropped seconds ago" : "last heard seconds ago") : `last heard ${f.lastSeenAgo} ago`;
  const state = f.status === "open" ? "connected"
    : f.status === "connecting" ? `connecting…${heard ? ` ${heard}` : ""}`
      : `not connected${heard ? ` — ${heard}` : ""}`;
  const tone = f.status === "open" ? "ok" : f.status === "connecting" ? "warn" : "dead";
  const dial = f.dial && f.dial !== f.saved ? f.dial : null;
  if (!f.route) return { via: null, head: "Not yet decided: Wi-Fi or tailnet", state, dial, tone, why: "This phone has not yet chosen between the Wi-Fi address and the tailnet." };
  const head = f.route.route === "lan" ? "In use: home Wi-Fi address" : "In use: tailnet address";
  return { via: f.route.route, head, state, dial, tone, why: f.route.sentence };
}

/** The tag on one address card. `null`: no tag (a row not in use has no route to report on its tailnet card). */
export function routeCardTag(card: "lan" | "tailnet", f: {
  active: boolean; route: "lan" | "tailnet" | null; hasLan: boolean; auto: boolean; ssids: number;
}): { text: string; inUse: boolean } | null {
  if (card === "tailnet") {
    if (!f.active || !f.route) return null;
    return f.route === "tailnet" ? { text: "in use", inUse: true } : { text: "fallback", inUse: false };
  }
  if (!f.hasLan) return null;
  if (f.active && f.route === "lan") return { text: "in use", inUse: true };
  if (!f.auto) return { text: "off", inUse: false };
  if (f.ssids === 0) return { text: "waiting for a Wi-Fi name", inUse: false };
  return { text: "standby", inUse: false };
}
