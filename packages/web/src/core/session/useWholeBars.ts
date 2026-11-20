/**
 * The bars between the terminal and the compose box are drawn WHOLE or not at
 * all — one rule for the whole stack, never a fix per bar.
 *
 * The session screen is a flex column bound to the VisualViewport, so the
 * keyboard takes half of it. The terminal (`.term-area`, `min-height: 0`) gave
 * its rows first, as it should; then every other child shrank by the flex
 * default. A bar that scrolls sideways (`.keys`, `.newimg-strip`) has an
 * automatic minimum height of ZERO, so those were the ones that gave: the
 * owner's phone (2026-11-18) showed the key row and the "new N" files strip
 * squeezed into one 25 px band of clipped chips and stray borders, and the
 * compose key row still went under the keyboard because the rest did not fit.
 *
 * Now (`styles/01-frame.css`, `[data-whole-bars]`): nothing on the screen but
 * the terminal shrinks. When the compose box would run past the bottom, the
 * bottom stack's bars are taken away whole — `DROP_FIRST` in order, then the
 * rest from the one nearest the terminal down — and they come back by
 * themselves when the room does (the keyboard goes down). Then the header's
 * status line goes, whole; only when that is gone too does the header frame give, clipped from
 * its bottom the way `ChromeGrip.tsx`'s own cap clips it: the compose box and
 * its keys are the last thing on the screen to go.
 */
import { useLayoutEffect, type RefObject } from "react";

/** Dropped first, in this order: news and keys the on-screen keyboard has
 *  replaced, then the cost line. Anything else in the stack goes after these,
 *  nearest the terminal first. */
export const DROP_FIRST = [".newimg-strip", ".newimg-pill", ".keys", ".tcs"] as const;

const NOFIT = "data-nofit";
const SQUEEZED = "data-squeezed";

/** The direct children between `.term-area` and `.compose`, in flow. */
export function bottomStack(screen: HTMLElement): HTMLElement[] {
  const kids = [...screen.children] as HTMLElement[];
  const from = kids.findIndex((e) => e.classList.contains("term-area"));
  if (from < 0) return [];
  let to = kids.findIndex((e, i) => i > from && e.classList.contains("compose"));
  if (to < 0) to = kids.length;
  return kids.slice(from + 1, to).filter((e) => {
    const pos = getComputedStyle(e).position;
    return pos !== "fixed" && pos !== "absolute";
  });
}

/** Drop order: the `DROP_FIRST` bars by their rank, then the others top-down. */
export function dropOrder(bars: HTMLElement[]): HTMLElement[] {
  const rank = (e: HTMLElement) => {
    const i = DROP_FIRST.findIndex((s) => e.matches(s) || e.querySelector(`:scope > ${s}`) != null);
    return i < 0 ? DROP_FIRST.length : i;
  };
  return bars.map((e, i) => ({ e, i, r: rank(e) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
}

/** Lay the stack out again: every bar back, then take bars away until the screen fits. */
export function fitWholeBars(screen: HTMLElement): void {
  for (const e of screen.querySelectorAll(`[${NOFIT}]`)) e.removeAttribute(NOFIT);
  screen.removeAttribute(SQUEEZED);
  const bottom = () => {
    const r = screen.getBoundingClientRect();
    return r.bottom - (parseFloat(getComputedStyle(screen).paddingBottom) || 0);
  };
  const last = () => {
    const kids = ([...screen.children] as HTMLElement[]).filter((e) => {
      const cs = getComputedStyle(e);
      return cs.display !== "none" && cs.position !== "fixed" && cs.position !== "absolute";
    });
    return kids[kids.length - 1];
  };
  const over = () => {
    const l = last();
    return !!l && l.getBoundingClientRect().bottom > bottom() + 1;
  };
  if (!over()) return;
  for (const e of dropOrder(bottomStack(screen))) {
    e.setAttribute(NOFIT, "");
    if (!over()) return;
  }
  // The header's status line next, whole — the grip's cap would cut it first anyway.
  for (const e of screen.querySelectorAll<HTMLElement>(":scope > .sess-chrome > .sess-status")) {
    e.setAttribute(NOFIT, "");
    if (!over()) return;
  }
  screen.setAttribute(SQUEEZED, "");
}

/** Keep `ref`'s bottom stack whole: refit on every size change of the screen
 *  or any of its children, and when a child comes or goes. */
export function useWholeBars(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const screen = ref.current;
    if (!screen || typeof ResizeObserver === "undefined") return;
    screen.setAttribute("data-whole-bars", "");
    let raf = 0;
    const run = () => { raf = 0; fitWholeBars(screen); };
    const ask = () => { if (!raf) raf = requestAnimationFrame(run); };
    const ro = new ResizeObserver(ask);
    const watch = () => { ro.disconnect(); ro.observe(screen); for (const e of screen.children) ro.observe(e); ask(); };
    const mo = new MutationObserver(watch);
    mo.observe(screen, { childList: true });
    watch();
    fitWholeBars(screen);
    return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [ref]);
}
