/**
 * **A fork's look, on the phone** — the host's `<config dir>/theme.json`, as
 * `GET /api/theme` serves it (`host/themeoverlay.ts`; the rules are
 * `@waterplane/shared`'s `themeoverlay.ts`, run here again over whatever arrived).
 *
 * Three things, all optional, none of them present = today's app unchanged
 * (no style element, no stored key, `BRAND.name` everywhere):
 *
 *  - colour tokens → one `<style id="theme-overlay">` after `styles.css`,
 *  - the terminal palette → `termTheme.ts` (and `--term-bg`, so the frame
 *    round the grid stays the grid's colour),
 *  - the display name → `appName()`: the window title, the logo's label, the
 *    wordmark, the crash screen.
 *
 * **No flash**: the last answer is cached (`LS.themeOverlay`, cleaned, and the
 * derived CSS as `LS.themeOverlayCss`). `index.html`'s inline script injects
 * that CSS before the bundle parses — the same trick, and the same reason, as
 * the theme attribute — and `applyCachedThemeOverlay()` takes it over at boot.
 * `refreshThemeOverlay(bgJson)` then asks the host once; a failed read keeps the
 * cache (the tunnel being down says nothing about the fork's colours).
 */
import { BRAND, cleanThemeOverlay, themeOverlayCss, themeOverlayEmpty, type ThemeOverlay } from "@waterplane/shared";
import { LS, lsDel, lsJson, lsSet } from "./storage.ts";

const STYLE_ID = "theme-overlay";
let current: ThemeOverlay = {};
let titleRepo: string | null = null;
const listeners = new Set<() => void>();

/** The overlay in force (cleaned; `{}` when there is none). */
export const themeOverlay = (): ThemeOverlay => current;

/** What the running UI calls itself: the fork's `displayName`, else the brand's. */
export const appName = (): string => current.displayName ?? BRAND.name;

/** Fires after the overlay changed (not on a no-op re-apply). */
export function onThemeOverlay(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The window title, `<repo> — <name>` — kept here so a name change re-titles it. */
export function setDocTitle(repo: string | null | undefined): void {
  titleRepo = repo || null;
  try { document.title = titleRepo ? `${titleRepo} — ${appName()}` : appName(); } catch { /* no document */ }
}

function paint(css: string): void {
  try {
    let el = document.getElementById(STYLE_ID);
    if (!css) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  } catch { /* pre-DOM */ }
}

/**
 * Adopt an overlay (anything — it is cleaned first). Returns whether it
 * changed what is on screen. `persist` writes the cache, or clears it when the
 * overlay is empty, so an absent file leaves no key behind.
 */
export function setThemeOverlay(raw: unknown, persist = true): boolean {
  const { overlay } = cleanThemeOverlay(raw);
  const empty = themeOverlayEmpty(overlay);
  const next = empty ? {} : overlay;
  const css = themeOverlayCss(next);
  paint(css);
  if (persist) {
    if (empty) { lsDel(LS.themeOverlay); lsDel(LS.themeOverlayCss); }
    else {
      lsSet(LS.themeOverlay, JSON.stringify(next));
      if (css) lsSet(LS.themeOverlayCss, css); else lsDel(LS.themeOverlayCss);
    }
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  current = next;
  setDocTitle(titleRepo);
  for (const fn of listeners) { try { fn(); } catch { /* one listener must not stop the rest */ } }
  return true;
}

/** Boot, before the theme is applied: the cached overlay, no network. */
export function applyCachedThemeOverlay(): void {
  const cached = lsJson<unknown>(LS.themeOverlay, undefined);
  if (cached === undefined) { paint(""); return; } // a stale inline-injected sheet with no record behind it goes too
  setThemeOverlay(cached, false);
}

/**
 * Boot, after the host routing is in place: ask the host once. The fetcher is
 * `api.ts`'s `bgJson`, passed in so this module (which the crash screen
 * imports) stays clear of the API layer. A null (offline, an older host with no
 * route) keeps whatever is cached.
 */
export async function refreshThemeOverlay(get: (url: string) => Promise<unknown>): Promise<void> {
  try {
    const r = await get("/api/theme");
    if (r && typeof r === "object" && "overlay" in r) setThemeOverlay((r as { overlay: unknown }).overlay);
  } catch { /* keep the cache */ }
}
