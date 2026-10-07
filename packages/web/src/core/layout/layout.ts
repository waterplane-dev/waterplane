/**
 * PHONE OR WIDE — one fact, one writer, read everywhere.
 *
 * On a window at least `WIDE_MIN_PX` wide the app is a two-pane workspace
 * (`Workspace.tsx`); below it, the phone layout, unchanged. Width ONLY:
 * pointer and hover decide affordances, never structure — a tablet with a
 * keyboard and a desktop window dragged narrow both exist. 1024 is the floor
 * where a 300px sidebar plus an 80-col terminal fit (owner decision O1,
 * docs/analysis/desktop-workspace-plan.md §1). No hysteresis: everything that
 * must survive a crossing lives outside the frame (the draft in `App`, PTY
 * bytes in `useTermFeed`, the overlay in the route).
 *
 * The `chromeMode.ts` / `link.ts` shape: ONE store, ONE writer (the media-query
 * listener `startLayout` installs), and the same value mirrored once to
 * `<html data-layout="wide"|"phone">` so CSS and the strips mounted BESIDE
 * `App` (`main.tsx`) read the same fact without a second derivation.
 *
 * The listener asks the browser (`matchMedia`) rather than reading
 * `innerWidth` on every resize: the query is the exact predicate CSS uses, so
 * a component and a stylesheet can never disagree by a scrollbar's width.
 * `layoutOf` is that predicate as a pure function, node-tested.
 */
import { createStore, useStore } from "../../sdk/store.ts";

export type Layout = "phone" | "wide";

/** The narrowest viewport, in CSS px, that gets the workspace. */
export const WIDE_MIN_PX = 1024;

/** The one media query. CSS reads `[data-layout="wide"]`, never its own copy
 *  of this number. */
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_PX}px)`;

/** The attribute on `<html>` that mirrors the store. */
export const LAYOUT_ATTR = "data-layout";

/** `(min-width: 1024px)` as a function: a fractional 1023.5 (browser zoom) is
 *  still phone, exactly as the query says. A width that is not a number is
 *  phone — the layout that works everywhere. */
export function layoutOf(width: number): Layout {
  return Number.isFinite(width) && width >= WIDE_MIN_PX ? "wide" : "phone";
}

/** Phone until the writer has asked the browser: the phone tree is the one
 *  every test and every pre-DOM path already knows. */
export const layoutStore = createStore<Layout>("phone");

/** The slice of `MediaQueryList` the writer uses (fakeable in a node test). */
export interface LayoutQuery {
  matches: boolean;
  addEventListener?(type: "change", fn: () => void): void;
  removeEventListener?(type: "change", fn: () => void): void;
  /** Safari < 14 only knows these. */
  addListener?(fn: () => void): void;
  removeListener?(fn: () => void): void;
}

/** The slice of `<html>` the mirror writes. */
export interface LayoutRoot { setAttribute(name: string, value: string): void }

/**
 * THE writer. Reads the query now and on every change, sets the store and the
 * attribute together. Returns the unsubscribe. Called once at module load in a
 * browser (below); exported so the test can drive it with fakes.
 */
export function startLayout(mq: LayoutQuery | null, root: LayoutRoot | null): () => void {
  const write = () => {
    const next: Layout = mq?.matches ? "wide" : "phone";
    layoutStore.set(next);
    try { root?.setAttribute(LAYOUT_ATTR, next); } catch { /* a document being torn down */ }
  };
  write();
  if (!mq) return () => {};
  if (mq.addEventListener) {
    mq.addEventListener("change", write);
    return () => mq.removeEventListener?.("change", write);
  }
  mq.addListener?.(write);
  return () => mq.removeListener?.(write);
}

/** `"wide"` or `"phone"`, re-rendering on a crossing. */
export function useLayout(): Layout {
  return useStore(layoutStore);
}

/** `useLayout() === "wide"`. */
export function useWide(): boolean {
  return useLayout() === "wide";
}

// Installed at import, before the first render reads the store: `Workspace`
// (imported by `App`) pulls this module in, so the attribute is on <html> by
// the time anything paints. A node test has no `window` and gets the pure half.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  let mq: LayoutQuery | null = null;
  try { mq = window.matchMedia?.(WIDE_QUERY) ?? null; } catch { mq = null; }
  startLayout(mq, document.documentElement);
}
