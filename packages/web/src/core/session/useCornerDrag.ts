/**
 * The terminal corner group's drag handle (`ScreenCorner` in `TermArea.tsx`).
 *
 * The group floats over the top-right of the output, and the line it sits on
 * is sometimes the line you need to read. A grip at its left end moves the
 * whole group anywhere on the session screen — over the header, the compose
 * box, wherever it is least in the way; a double-tap puts it back.
 *
 * It is drawn as a child of `.screen`, not of the terminal box: `.term-area`
 * clips (on purpose) and paints below the compose box, so a child of it can
 * never leave it. What stays in the terminal box is an empty ANCHOR
 * (`.term-zoom-anchor`) that CSS moves for typing room and the connection
 * banner, and that the box's own height rule hides; the group is drawn from
 * where that anchor is. What a dropped place means: `cornerPlace.ts`.
 *
 * It is absolutely placed, never a size or a flow change: the group exists so
 * it does not refit the PTY, and moving it must not either.
 *
 * Pushing PAST the right edge folds the group instead (the owner's ask): the
 * group is anchored right, so it cannot travel further, and every button's
 * width of overshoot takes one column off — a grid that wraps into rows, down
 * to one column (fully vertical) when the finger reaches the far edge.
 * Dragging back left unfolds it the same way. The fold is part of the one
 * virtual position the drag tracks, so out and back is the same gesture.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { LS, lsJson, lsSetJson } from "../../storage";
import { foldCols, foldExcess } from "./cornerFold";
import { drawnAt, EDGE, HOME, isFree, keepIn, placeFor, readPlace, type Box, type Home, type Place } from "./cornerPlace";

/** Assumed button pitch before one has been measured. */
const STEP_FALLBACK = 40;
/** How close to the screen's right edge a finger can drag. */
const FINGER = 16;
/** Never fold faster than one column per this many px. */
const MIN_STEP = 12;
/** Movement under this many px is a tap, not a drag. */
const SLOP = 4;
/** Two taps this close together put the group back. Counted by hand: a
 *  `dblclick` is not reliably synthesised from touch once pointerdown is
 *  prevented. */
const DOUBLE_MS = 350;

interface Frame { screen: Box; box: Box; home: Home | null }
/** Under the finger: the group's right edge and top as asked for, unclamped. */
interface Drag extends Home { cols?: number }

/** `.screen` inside its padding: the always-on strips and the safe areas are in
 *  that padding, and a group parked under one of them could not be reached. */
function inner(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  return { left: r.left + px(cs.paddingLeft), top: r.top + px(cs.paddingTop), right: r.right - px(cs.paddingRight), bottom: r.bottom - px(cs.paddingBottom) };
}

function measure(anchor: HTMLElement, screenEl: HTMLElement): Frame | null {
  // The positioned box the anchor is in; none while it is not displayed, when only its absence matters.
  const wrap = anchor.offsetParent ?? anchor.parentElement;
  if (!wrap) return null;
  const screen = inner(screenEl);
  // No rects = `display: none`: the terminal is too short to carry the group.
  const a = anchor.getClientRects()[0];
  const home = a ? { right: a.right, top: a.top } : null;
  // Typing room floats two header buttons over the top corner, above this
  // group: its ceiling is then the home corner, which CSS puts under them.
  const typing = document.documentElement.dataset.typing === "1";
  return { screen: home && typing ? { ...screen, top: Math.max(screen.top, home.top) } : screen, box: wrap.getBoundingClientRect(), home };
}

/** `covered`: something is over the whole terminal box (the storm), so a group
 *  that lives in it is not drawn. `onTap(true)` after a double-tap has put the
 *  group back, `onTap(false)` for a lone tap. */
export function useCornerDrag(covered: boolean, onTap: (wasReset: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement>(null);
  /** `.screen`, once mounted: the portal's target. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<Place>(() => readPlace(lsJson<unknown>(LS.termCornerPos, null)));
  const [live, setLive] = useState<Drag | null>(null);
  const drag = useRef<{ id: number; sx: number; sy: number; base: Home; moved: boolean; n: number; step: number } | null>(null);
  const lastTap = useRef(0);
  /** Average button pitch, measured while the group is one row. */
  const stepRef = useRef(STEP_FALLBACK);
  const cols = (live ?? place).cols;

  const layout = useCallback(() => {
    const el = ref.current, a = anchor.current;
    const f = el && a && host ? measure(a, host) : null;
    if (!el || !host || !f) return;
    const off = !live && !isFree(place) && (covered || !f.home);
    el.toggleAttribute("data-off", off);
    if (off) return;
    const size = el.getBoundingClientRect();
    const at = live ? keepIn(live, size, f.screen) : drawnAt(place, size, f.home ?? f.screen, f.box, f.screen);
    const h = host.getBoundingClientRect();
    el.style.top = `${at.top - h.top - host.clientTop}px`;
    el.style.right = `${h.right - host.clientLeft - at.right}px`;
  }, [host, place, live, covered]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useLayoutEffect(() => { setHost(anchor.current?.closest<HTMLElement>(".screen") ?? null); }, []);
  // Every render: a button that came or went, and a header above that moved the
  // terminal without resizing it, are both seen here.
  useLayoutEffect(layout);
  useEffect(() => {
    const el = ref.current, wrap = anchor.current?.closest(".term-wrap");
    if (!el || !wrap || !host) return;
    const run = () => layoutRef.current();
    const ro = new ResizeObserver(run);
    ro.observe(host); ro.observe(wrap); ro.observe(el);
    // The banner moves the anchor without resizing anything; typing room is an attribute.
    const mo = new MutationObserver(run);
    mo.observe(wrap, { childList: true });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-typing"] });
    window.addEventListener("resize", run);
    return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener("resize", run); };
  }, [host]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault(); // keeps focus in the compose box (`keepFocus`'s reason) and stops text selection
    const el = ref.current;
    if (!el || !host) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const n = el.children.length;
    const r = el.getBoundingClientRect();
    if (n > 1 && !cols) {
      // The pitch is sized to the finger's REACH, not the buttons' width: the
      // fold has to reach one column with the finger at the screen edge, and
      // a pitch of one button left it stuck at two (the grip is on the left
      // end, so the overshoot a finger can make is shorter than the row).
      const edge = inner(host).right;
      const room = edge - EDGE - r.right; // travel before the edge stops it
      const reach = edge - FINGER - e.clientX - room;
      stepRef.current = Math.max(MIN_STEP, reach / (n - 0.5));
    }
    const step = stepRef.current;
    // The drag runs on ONE virtual x: the real place plus the overshoot the
    // current fold stands for.
    const base = { right: r.right + foldExcess(n, cols ? Math.min(cols, n) : n, step), top: r.top };
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, base, moved: false, n, step };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !host) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < SLOP) return;
    d.moved = true;
    const right = d.base.right + dx, top = d.base.top + dy;
    // Right-anchored, so the right limit does not depend on the width: the
    // overshoot past it is what folds.
    const c = foldCols(d.n, right - (inner(host).right - EDGE), d.step);
    setLive({ right, top, ...(c < d.n ? { cols: c } : {}) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) { drop(); return; }
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_MS) { lastTap.current = 0; keep(HOME); onTap(true); return; }
    lastTap.current = now;
    onTap(false);
  };
  const keep = (p: Place) => { setPlace(p); lsSetJson(LS.termCornerPos, p); };
  /** What is DRAWN is what is kept: the finger may have gone past an edge. */
  const drop = () => {
    const el = ref.current, a = anchor.current;
    const f = el && a && host ? measure(a, host) : null;
    setLive(null);
    if (!el || !f) return;
    const r = el.getBoundingClientRect();
    keep(placeFor({ right: Math.round(r.right), top: Math.round(r.top) }, r, f.home ?? f.screen,
      f.home && !covered ? f.box : null, f.screen, live?.cols));
  };
  const onPointerCancel = () => { drag.current = null; setLive(null); };

  const style: CSSProperties | undefined = cols
    ? { display: "grid", gridTemplateColumns: `repeat(${cols}, auto)` } : undefined;
  return {
    ref, anchor, host, style,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
