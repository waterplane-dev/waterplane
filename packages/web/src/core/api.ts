/**
 * The core's half of the feature contract: ONE `CoreApi`, rebound by `App` on
 * every render, read by features through `core()`.
 *
 * A module singleton rather than a React context, for two reasons that are both
 * about where features get called from. App's socket handler is an effect with
 * `[]` deps that reads refs — it never re-subscribes, so a context value
 * captured there would be the first render's for ever. And a feature's message
 * handler, its store actions and its toolbar command are plain functions, not
 * components, with no hook to read a context through. `showToast` and `track`
 * are module functions for exactly the same reasons; this is that shape again.
 *
 * Rebinding on every render is what makes the values current: `world.sessions`
 * is this render's list, `nav.overlay` this render's sheet — the same timing
 * `overlayRef.current = overlay` already had.
 */
import type { CoreApi } from "../sdk/types.ts";

let impl: CoreApi | null = null;

export function bindCore(next: CoreApi): void {
  impl = next;
}

export function core(): CoreApi {
  // Only reachable before App's first render, which nothing that runs in a
  // feature can precede: handlers, boots and sheets are all driven BY App.
  if (!impl) throw new Error("core() before App bound it — a feature ran outside App's lifecycle");
  return impl;
}
