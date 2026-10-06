/**
 * Whether the phone talks to a host over its LAN address or over the tailnet.
 *
 * Three gates, ANDed, and all three must be FRESH evidence rather than a
 * remembered one:
 *
 * 1. the phone is on Wi-Fi and the network's name is one of `host.lan.ssids`;
 * 2. the LAN address answered `/api/health` within `LAN_PROBE_TIMEOUT_MS`;
 * 3. the answer proved it is THIS desktop (`/api/lan/verify` HMAC checked).
 *
 * Anything missing, unknown or failed ⇒ `tailnet`, the route that always works.
 * A LAN failure newer than the last good probe also ⇒ `tailnet`, until the next
 * trigger re-probes. Each verdict carries the one sentence the UI says about
 * it; a number the input does not carry (probe time) is left out of the
 * sentence, never guessed.
 *
 * The `NetState` below is also the contract of the Android `ShellNet` plugin:
 * `ShellNet.current()` resolves to one, `window.shellNetChanged(json)`
 * delivers one on every change.
 */

import type { SavedHost } from "./hosts.js";

export type NetTransport = "wifi" | "cellular" | "other" | "none";
/** Android's location permission, which is what reading the SSID needs. */
export type NetPermission = "granted" | "denied" | "prompt";

/** What the native shell knows about the phone's current network. */
export interface NetState {
  transport: NetTransport;
  /** Wi-Fi name, `null` when unreadable (not Wi-Fi, or permission missing). */
  ssid: string | null;
  permission: NetPermission;
}

/** How long the LAN `/api/health` probe may take before the LAN is not used. */
export const LAN_PROBE_TIMEOUT_MS = 1500;

export interface LanProbe {
  ok: boolean;
  /** Round trip in ms, when measured. */
  ms?: number;
  /** When it finished (epoch ms) — compared only against `lastFailure.at`. */
  at: number;
}

export interface LanFailure {
  at: number;
  /** What went wrong, in words (shown after "LAN failed:"). */
  reason?: string;
}

export interface LanRouteInput {
  host: Pick<SavedHost, "lan">;
  /** `null` = no native shell / not reported (the browser PWA). */
  net: NetState | null;
  /** `null` = not probed yet on this trigger. */
  probe: LanProbe | null;
  /** `null` = not verified yet; `false` = verification failed. */
  macVerified: boolean | null;
  lastFailure?: LanFailure | null;
}

export type LanRoute = "lan" | "tailnet";

export type LanRouteReason =
  | "no-lan"
  | "auto-off"
  | "no-net"
  | "not-wifi"
  | "no-permission"
  | "no-ssid"
  | "ssid-mismatch"
  | "failed-recently"
  | "probe-pending"
  | "probe-failed"
  | "probe-slow"
  | "mac-pending"
  | "mac-failed"
  | "lan-ok";

export interface LanRouteDecision {
  route: LanRoute;
  reason: LanRouteReason;
  /** One sentence: why this route. */
  sentence: string;
  /** What the caller should do next to move toward LAN, if anything. */
  next: "probe" | "verify" | null;
}

function tail(reason: LanRouteReason, sentence: string, next: LanRouteDecision["next"] = null): LanRouteDecision {
  return { route: "tailnet", reason, sentence, next };
}

/** Is `ssid` one of this host's saved networks? Exact match — SSIDs are
 *  case-sensitive and `"Home"` is not `"home"`. */
export function ssidMatches(host: Pick<SavedHost, "lan">, ssid: string | null): boolean {
  return !!ssid && !!host.lan && host.lan.ssids.includes(ssid);
}

export function decideLanRoute(input: LanRouteInput): LanRouteDecision {
  const { host, net, probe, macVerified, lastFailure } = input;
  const lan = host.lan;
  if (!lan) return tail("no-lan", "Using the tailnet: no LAN address saved for this desktop.");
  if (!lan.auto) return tail("auto-off", "Using the tailnet: switching to LAN automatically is off.");
  if (!net) return tail("no-net", "Using the tailnet: this phone did not report which network it is on.");
  if (net.transport !== "wifi") {
    const what = net.transport === "cellular" ? "on mobile data" : net.transport === "none" ? "offline" : "not on Wi-Fi";
    return tail("not-wifi", `Using the tailnet: the phone is ${what}.`);
  }
  if (net.permission !== "granted") {
    return tail("no-permission", "Using the tailnet: reading the Wi-Fi name needs the location permission.");
  }
  if (!net.ssid) return tail("no-ssid", "Using the tailnet: the Wi-Fi name could not be read.");
  if (!ssidMatches(host, net.ssid)) {
    return tail("ssid-mismatch", `Using the tailnet: "${net.ssid}" is not one of this desktop's saved networks.`);
  }
  if (lastFailure && (!probe || probe.at <= lastFailure.at)) {
    const why = lastFailure.reason ? ` (${lastFailure.reason})` : "";
    return tail("failed-recently", `Using the tailnet: the LAN connection failed${why}; it is tried again on the next network change or reconnect.`, "probe");
  }
  if (!probe) return tail("probe-pending", `Using the tailnet while ${lan.base} is checked.`, "probe");
  if (!probe.ok) return tail("probe-failed", `Using the tailnet: ${lan.base} did not answer on "${net.ssid}".`);
  if (probe.ms != null && probe.ms > LAN_PROBE_TIMEOUT_MS) {
    return tail("probe-slow", `Using the tailnet: ${lan.base} took ${Math.round(probe.ms)} ms, over the ${LAN_PROBE_TIMEOUT_MS} ms limit.`);
  }
  if (macVerified === null) return tail("mac-pending", `Using the tailnet while ${lan.base} proves it is this desktop.`, "verify");
  if (!macVerified) {
    return tail("mac-failed", `Using the tailnet: whatever answers at ${lan.base} could not prove it is this desktop.`);
  }
  const took = probe.ms != null ? ` in ${Math.round(probe.ms)} ms` : "";
  return {
    route: "lan",
    reason: "lan-ok",
    sentence: `Using LAN: on "${net.ssid}", ${lan.base} answered${took} and proved it is this desktop.`,
    next: null,
  };
}

/** The route chip's word. */
export function lanRouteLabel(route: LanRoute): string {
  return route === "lan" ? "LAN" : "tailnet";
}

/** `GET /api/lan/identity` → (loopback/Tailscale only). The HMAC key is the
 *  UTF-8 bytes of `secret` as written (a base64url string), NOT its decoding. */
export interface LanIdentityResponse { hostId: string; secret: string; hostName: string }
/** `POST /api/lan/verify {nonce}` → `mac` = hex HMAC-SHA256(key = utf8(secret),
 *  msg = hostId + "\n" + nonce). */
export interface LanVerifyResponse { hostId: string; mac: string }
/** What `lanMacMessage` signs — one definition for both ends. */
export function lanMacMessage(hostId: string, nonce: string): string {
  return `${hostId}\n${nonce}`;
}
