/**
 * Which network the phone is on — the page's half of the Android `ShellNet`
 * plugin (`packages/app`, `ShellNetPlugin.java`).
 *
 * Two directions, like `shellLink.ts`:
 *
 *  - **Out**: `current()` and `requestLocation()`, both resolving to a
 *    `NetState` (`shared/lanroute.ts` is the contract). The Wi-Fi name needs
 *    the location permission, so `ssid` is `null` without it — never a guess.
 *  - **In**: `window.shellNetChanged(state)`, which the shell calls with a
 *    JS OBJECT (not a JSON string), debounced and only on a change. It is
 *    re-dispatched as `SHELL_NET_EVENT` so a listener needs no import from here.
 *
 * Inert in a browser: no plugin ⇒ every read resolves `null` and the global is
 * defined but never called. Reached off the Capacitor global, never an npm
 * import, for the reason `hostUrl.ts` gives.
 */
import { defineShellGlobal, nativePlugin } from "./shellBridge.ts";
import type { NetPermission, NetState, NetTransport } from "@waterplane/shared";

/**
 * **The prominent disclosure shown BEFORE Android's location prompt** (a Google
 * Play requirement, and the honest order anyway): what is read, why, where it
 * goes, and what skipping costs — in the app's own words, then the system
 * dialog. `HostSetup` raises it through `askConfirm` (never `window.confirm`)
 * and calls `requestLocation` only on `continueLabel`. Pinned by
 * `lanRoute.test.mjs`, because each of the four facts is a promise.
 */
export const LOCATION_DISCLOSURE = {
  title: "Location, for the Wi-Fi name",
  lines: [
    "What: Android shows an app the name of the Wi-Fi network it is on only with the location permission. " +
      "That name is all this is used for — not where you are.",
    "Why: to switch to the desktop's home address automatically when you are on the Wi-Fi names you saved for it.",
    "The name is compared on this phone, with the names saved here, and is never sent anywhere — not to the desktop, not to anyone.",
    "Skip, and nothing else changes: LAN switching stays manual — the app keeps reaching the desktop over its Tailscale address and never moves to the home address on its own.",
  ],
  continueLabel: "Continue",
  skipLabel: "Skip",
} as const;

/** What the form says after a skip — the cost, stated, not a dead button. */
export const LOCATION_SKIPPED_TEXT =
  "Skipped — the Wi-Fi name is not read, so LAN switching stays manual (the Tailscale address, always). Tap allow location to be asked again.";

/** The shell said the network changed. `detail` is the new `NetState`. */
export const SHELL_NET_EVENT = "app:shell-net";

interface NetPlugin {
  current(): Promise<unknown>;
  requestLocation(): Promise<unknown>;
}

function plugin(): NetPlugin | null {
  const p = nativePlugin<NetPlugin>("Net");
  return p && typeof p.current === "function" ? p : null;
}

const TRANSPORTS: readonly NetTransport[] = ["wifi", "cellular", "other", "none"];
const PERMISSIONS: readonly NetPermission[] = ["granted", "denied", "prompt"];

/** A `NetState` off the bridge, or null for anything that is not one. An
 *  older or newer shell's shape degrades to "not reported", never to a guess. */
export function parseNetState(v: unknown): NetState | null {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const transport = TRANSPORTS.includes(o.transport as NetTransport) ? (o.transport as NetTransport) : null;
  const permission = PERMISSIONS.includes(o.permission as NetPermission) ? (o.permission as NetPermission) : null;
  if (!transport || !permission) return null;
  const ssid = typeof o.ssid === "string" && o.ssid.trim() ? o.ssid : null;
  return { transport, ssid, permission };
}

/** Ask the shell now. `null` = no plugin, or it did not answer. */
export async function currentNet(): Promise<NetState | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const s = parseNetState(await p.current());
    return s;
  } catch { return null; }
}

function dispatch(s: NetState): void {
  try { window.dispatchEvent(new CustomEvent(SHELL_NET_EVENT, { detail: s })); } catch { /* no DOM */ }
}

/** Listen for network changes. Returns an unsubscribe. */
export function onShellNet(fn: (s: NetState) => void): () => void {
  const h = (e: Event) => {
    const s = parseNetState((e as CustomEvent).detail);
    if (s) fn(s);
  };
  window.addEventListener(SHELL_NET_EVENT, h);
  return () => window.removeEventListener(SHELL_NET_EVENT, h);
}

/**
 * Define `window.shellNetChanged`. Idempotent; safe in a browser. Returns
 * true so a shell that retries on a falsy answer stops.
 */
export function installShellNet(): void {
  defineShellGlobal("NetChanged", (state: unknown): boolean => {
    const s = parseNetState(state);
    if (!s) return true;
    dispatch(s);
    return true;
  });
}
