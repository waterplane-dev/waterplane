/**
 * A frame a person shortens with a grip under it: drag up to cut it, down to
 * bring it back, a tap on a shortened frame shows all of it again, arrow keys
 * step it. One number per device under `key`, read and written here.
 *
 * Four frames use it: the session chrome (`ChromeGrip.tsx`), the reader's rows
 * under its status strip (`transcript/TvTop.tsx`), the reader's outline
 * (`transcript/TvOutline.tsx`, the one that can also GROW: `drawer`) and the
 * launcher's top (`LauncherChrome.tsx`).
 * What a cap DOES to the frame is the
 * caller's CSS, the chrome clips and the list scrolls; the maths is
 * `chromeCap.ts`.
 *
 * `cut` is the measured fact, separate from `capped`: an old drag can outlive
 * the content it cut (six agents down to two), and a grip that then said
 * "shortened" would be describing nothing.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { lsDel, lsGet, lsSet } from "../../storage";
import { CHROME_STEP_PX, chromeCapAfter, chromeCapOf, drawerHeightAfter } from "./chromeCap.ts";
import { track } from "../../usage";

const TAP_SLOP_PX = 6;

export function useDragCap({ key, off = false, floorPx = 0, drawer, showAllEvent, capEvent }: {
  key: string;
  /** Draw the frame whole for now, without forgetting the cap. */
  off?: boolean;
  /** The least the frame may shrink to. */
  floorPx?: number;
  /** A frame with a usual height below its content's, which a drag may also
   *  grow: that usual height and the most it may take, measured at the drag. */
  drawer?: () => { restPx: number; ceilPx: number };
  showAllEvent: string;
  capEvent: string;
}) {
  const [cap, setCap] = useState<number | null>(() => chromeCapOf(lsGet(key)));
  const [cut, setCut] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  // The live value while a drag is under way, so `up` stores what was drawn.
  const live = useRef(cap);
  useEffect(() => { live.current = cap; }, [cap]);
  const capped = !off && cap != null;
  // Every render, on purpose: the content's height is the caller's, and a
  // boolean that did not change costs no second render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = frame.current;
    setCut(capped && el != null && el.scrollHeight > el.clientHeight + 1);
  });

  const save = (v: number | null) => { if (v == null) lsDel(key); else lsSet(key, String(v)); };
  const natural = () => frame.current?.scrollHeight ?? 0;
  const shown = () => frame.current?.getBoundingClientRect().height ?? 0;
  const after = (startH: number, dy: number) => {
    const d = drawer?.();
    return d ? drawerHeightAfter(startH, dy, natural(), floorPx, d.restPx, d.ceilPx) : chromeCapAfter(startH, dy, natural(), floorPx);
  };
  const set = (v: number | null) => { live.current = v; setCap(v); };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || off) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = shown();
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < TAP_SLOP_PX) return;
      moved = true;
      set(after(startH, dy));
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (!moved) {
        // A tap: the way back from any cap is one touch, never a precise drag.
        if (live.current != null) { track(showAllEvent); set(null); save(null); }
        return;
      }
      track(live.current == null ? showAllEvent : capEvent);
      save(live.current);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dir || off) return;
    e.preventDefault();
    const v = after(shown(), dir * CHROME_STEP_PX * (e.shiftKey ? 4 : 1));
    set(v);
    save(v);
  };

  return { frame, cap, capped, cut, grip: { onPointerDown, onKeyDown } };
}
