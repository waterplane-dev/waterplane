/**
 * How the active host is reached right now — its LAN address or the tailnet —
 * with the one sentence saying why. ONE writer: `lanLink.ts` (the APK's LAN
 * route, or the browser's `welcome.clientKind`). Read by the route chips: the
 * connection strip, the health sheet, and `features/hosts` (launcher door,
 * switcher sheet). A root module rather than feature state because the strip
 * and the sheet are not features and may not import one.
 */
import { createStore, useStore } from "./sdk";

/** How the active host is reached: its LAN address or the tailnet. */
export interface HostRouteView { route: "lan" | "tailnet"; sentence: string }

/** `null` until the route is known; the chips draw nothing until then. */
export const hostRoute = createStore<HostRouteView | null>(null);

export function setHostRoute(r: HostRouteView | null): void {
  hostRoute.set(r);
}

export function useHostRoute(): HostRouteView | null {
  return useStore(hostRoute);
}

/** Opens the form where the route's settings change (the active host's LAN
 *  address, Wi-Fi names, "switch to LAN automatically") — registered by
 *  `features/hosts` at boot in the shell only, where that form exists. `null`
 *  ⇒ the readout draws no button: there is nowhere to send the tap. */
export const hostRouteEditor = createStore<(() => void) | null>(null);

export function useHostRouteEditor(): (() => void) | null {
  return useStore(hostRouteEditor);
}
