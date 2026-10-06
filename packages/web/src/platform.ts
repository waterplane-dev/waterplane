/**
 * What kind of shell this page is running in — the two checks the install
 * affordances read. Browser-only, called at render; lifted out of `App.tsx`.
 */

/** Already running as an installed app (home-screen / standalone window)? */
export function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches
      || (navigator as any).standalone === true;
  } catch { return false; }
}
/** iOS has no beforeinstallprompt — installing is Share → Add to Home Screen,
 *  so the app has to SAY that rather than offer a button that can't exist. */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return iOS && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

