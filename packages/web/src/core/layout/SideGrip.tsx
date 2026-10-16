/**
 * The wide sidebar's right edge, as a handle: drag it, or focus it and press
 * ←/→ (Shift for bigger steps); a double-click puts back the default.
 *
 * The width is ONE CSS variable on `<html>`, `--ws-side-w`, which styles.css
 * clamps against the viewport (`--ws-side`). A drag writes the variable every
 * move (the terminal refits on its own 150 ms debounce, so a drag is one
 * SIGWINCH at its end, not one per frame) and stores the width once, on
 * release. Lives INSIDE `aside.ws-side`, so `#root`'s children — Workspace's
 * DOM contract — are unchanged.
 */
import { useEffect, useRef } from "react";
import { LS, lsNum, lsSet, lsDel } from "../../storage";
import { SIDE_DEFAULT_PX, SIDE_STEP_PX, clampSide } from "./sideWidth.ts";

const VAR = "--ws-side-w";

function apply(w: number): number {
  const v = clampSide(w, window.innerWidth);
  document.documentElement.style.setProperty(VAR, `${v}px`);
  return v;
}

export function SideGrip() {
  const width = useRef(SIDE_DEFAULT_PX);
  const el = useRef<HTMLDivElement>(null);
  const sync = (v: number) => {
    width.current = v;
    el.current?.setAttribute("aria-valuenow", String(v));
  };

  useEffect(() => {
    sync(apply(lsNum(LS.wideSideW, SIDE_DEFAULT_PX)));
    return () => { document.documentElement.style.removeProperty(VAR); };
  }, []);

  const save = (v: number) => {
    if (v === SIDE_DEFAULT_PX) lsDel(LS.wideSideW);
    else lsSet(LS.wideSideW, String(v));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width.current;
    document.documentElement.classList.add("ws-resizing");
    const move = (ev: PointerEvent) => sync(apply(startW + ev.clientX - startX));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("ws-resizing");
      save(width.current);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const v = apply(width.current + dir * SIDE_STEP_PX * (e.shiftKey ? 5 : 1));
    sync(v);
    save(v);
  };

  const reset = () => { const v = apply(SIDE_DEFAULT_PX); sync(v); save(v); };

  return (
    <div
      ref={el}
      className="ws-side-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width: drag, or arrow keys; double-click resets"
      title="Drag to resize · double-click for the default width"
      aria-valuenow={SIDE_DEFAULT_PX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
    />
  );
}
