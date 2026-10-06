/**
 * Opening a link that is NOT this app — and the two completely different things
 * that means in the two places this app runs.
 *
 * In a browser tab, `window.open(url, "_blank")` is the whole story.
 *
 * In the Android shell it is the wrong call and fails quietly: Capacitor turns
 * multiple windows off, so `_blank` either no-ops or hands the URL to the
 * phone's browser where it resolves against Capacitor's own local asset server
 * and loads nothing (the same trap `Markdown.tsx` and `routing.ts` each
 * document from their own side). What DOES work there is an ordinary main-frame
 * navigation: `MainActivity.guardNavigation` intercepts one aimed at another
 * origin, asks "open in your browser?", and starts an `ACTION_VIEW` intent —
 * the WebView itself never navigates, so the app stays exactly where it was.
 *
 * Which is why this is a function and not a `<a target="_blank">`: the correct
 * mechanism differs by shell, and getting it wrong is silent in both directions.
 */
import { isNativeShell } from "./hostUrl";

/** Only these may be handed to the platform. A `javascript:` or `intent:` URL
 *  arriving from screen-scraped terminal text is not a link, it is an injection. */
function safe(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url);
}

/**
 * Open `url` outside the app.
 *
 * Returns false when it could not be attempted at all — a refused scheme, or a
 * popup the browser blocked — so the caller can say so. Nothing here is allowed
 * to fail silently: a tap that does nothing is the failure this app keeps
 * finding in its own transports.
 */
export function openExternal(url: string): boolean {
  if (!safe(url)) return false;
  if (isNativeShell()) {
    // Handed to the shell, which confirms and opens it outside. Assigning
    // `location.href` is the ONLY form that reaches `shouldOverrideUrlLoading`
    // with `isForMainFrame()` true.
    location.href = url;
    return true;
  }
  const w = window.open(url, "_blank", "noopener,noreferrer");
  return !!w;
}
