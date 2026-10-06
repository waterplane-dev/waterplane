/**
 * How big the text and the icons are, as a decision the user makes once.
 *
 * **Why this can be a setting at all.** Two facts about this codebase, neither
 * of them an accident: every font size in the app is a `font-size: Npx` in ONE
 * stylesheet, and every icon is a lucide `<svg>` that renders its `size` prop as
 * a `width`/`height` ATTRIBUTE with a `lucide` class on it. So a multiplier on
 * the root reaches all 298 of the first through `calc()`, and all fourteen
 * distinct sizes of the second through one attribute-selector rule each. No
 * component had to learn about this, and none can forget it.
 *
 * **Per device, like the theme, and for the theme's reason** (`shared/settings.
 * ts` argues it at length): a phone held at arm's length and a 27-inch display
 * want different numbers from the same pair of eyes. Syncing it would make the
 * desktop's answer the phone's problem. What travels is the person; what does
 * not travel is how far away the screen is.
 *
 * **Two knobs, not one.** A single "UI scale" sounds tidier and answers the
 * wrong question: the two are wanted independently. Text too small to read is an
 * ability; icons too small to hit are a thumb — and this app's own rule about
 * tap targets is a separate complaint from its rule about legibility. Somebody
 * who wants big text and compact chrome is not confused.
 *
 * The multipliers are written to `<html>` as custom properties and nowhere else,
 * which is what makes them one repaint rather than a re-render. `index.html`
 * sets them inline BEFORE this module is parsed, for `theme.ts`'s reason: a
 * bundle is fetched, and a size applied when React mounts is a frame of the
 * wrong layout on every cold start.
 */
import { LS, lsGet, lsSet } from "./storage";
import { ICON_MAX, ICON_MIN, TERM_ZOOM_MAX, TERM_ZOOM_MIN, TEXT_MAX, TEXT_MIN, clampScale, readerScale, termFontPx } from "./uiScaleSteps";

export { ICON_STEPS, TEXT_STEPS, TERM_ZOOM_STEPS, nextReaderZoom, nextTermZoom, readerScale, termFontPx } from "./uiScaleSteps";

export const textScale = (): number => clampScale(lsGet(LS.textScale), TEXT_MIN, TEXT_MAX);
export const iconScale = (): number => clampScale(lsGet(LS.iconScale), ICON_MIN, ICON_MAX);
/**
 * The terminal's zoom, on top of the text size — see `uiScaleSteps.ts` for why
 * it is a second knob. Clamped on the way out like the other two, for the same
 * reason: this one can make the console unreadable, and the control that undoes
 * it is drawn at a size the text knob owns.
 */
export const termZoom = (): number => clampScale(lsGet(LS.termZoom), TERM_ZOOM_MIN, TERM_ZOOM_MAX);
/** What xterm is told right now. The one number the readout and the canvas
 *  both quote. */
export const termPx = (): number => termFontPx(textScale(), termZoom());
/**
 * The reader's zoom, the same ladder over the other surface. A SECOND stored
 * value rather than the console's, because the two are different documents in
 * different units — a terminal is a grid whose size is a fact the host is told
 * about, a transcript is a page that reflows — and a phone that wants the CLI
 * dense wants the conversation comfortable as often as the reverse.
 */
export const readerZoom = (): number => clampScale(lsGet(LS.readerZoom), TERM_ZOOM_MIN, TERM_ZOOM_MAX);
/**
 * The scrollback sheet's zoom — a THIRD stored value, and the reader's
 * arithmetic.
 *
 * Its arithmetic is the reader's because the sheet is HTML: every size in it is
 * already `calc(Npx * var(--ui-font))`, so it re-sizes by overriding that one
 * property on the body, exactly as the transcript does. Its VALUE is its own
 * because the console's zoom resizes the live grid (the host is told the new
 * cols/rows) and reading history must not reshape the session that wrote it —
 * and because what is on screen here is fixed-width lines a terminal already
 * wrapped at its own width, so the size that stops them wrapping again is not
 * the size that makes prose comfortable.
 */
export const scrollbackZoom = (): number => clampScale(lsGet(LS.scrollZoom), TERM_ZOOM_MIN, TERM_ZOOM_MAX);
/** The git review sheet's zoom — the scrollback's arithmetic, its own value. */
export const gitZoom = (): number => clampScale(lsGet(LS.gitZoom), TERM_ZOOM_MIN, TERM_ZOOM_MAX);
/** The multiplier the scrollback body overrides `--ui-font` with. */
export const scrollbackFont = (): number => readerScale(textScale(), scrollbackZoom());

/** Fired when either changes, so the terminal can re-measure — it is a canvas
 *  and a custom property means nothing to it. */
export const UI_SCALE_EVENT = "app:uiscale";

function apply(): void {
  const root = document.documentElement;
  root.style.setProperty("--ui-font", String(textScale()));
  root.style.setProperty("--ui-icon", String(iconScale()));
  try { window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT)); } catch { /* no DOM */ }
}

export function setTextScale(v: number): void {
  lsSet(LS.textScale, String(v));
  apply();
}

export function setIconScale(v: number): void {
  lsSet(LS.iconScale, String(v));
  apply();
}

/** Zoom the console. Rides the same event as the other two — it is not a custom
 *  property (a canvas cannot inherit one), so the terminal is subscribed. */
export function setTermZoom(v: number): void {
  lsSet(LS.termZoom, String(v));
  apply();
}

/** Zoom the reader. Unlike the console's this one IS a custom property, written
 *  on the reader's own subtree by `App` — the event is fired anyway so anything
 *  else reading a size re-measures. */
export function setReaderZoom(v: number): void {
  lsSet(LS.readerZoom, String(v));
  apply();
}

/** Zoom the scrollback sheet. A custom property like the reader's, written on
 *  the sheet's own body; the event is fired for the same reason. */
export function setScrollbackZoom(v: number): void {
  lsSet(LS.scrollZoom, String(v));
  apply();
}

/** Zoom the git review sheet's list and diff. */
export function setGitZoom(v: number): void {
  lsSet(LS.gitZoom, String(v));
  apply();
}

/** Re-assert both from storage. Called once at boot, after `index.html`'s inline
 *  pass, so a value this module clamps differently to that script wins. */
export function installUiScale(): void {
  apply();
}

/** Subscribe to size changes. Returns the unsubscribe. */
export function onUiScale(fn: () => void): () => void {
  window.addEventListener(UI_SCALE_EVENT, fn);
  return () => window.removeEventListener(UI_SCALE_EVENT, fn);
}
