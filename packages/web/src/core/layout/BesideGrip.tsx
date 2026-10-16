/**
 * A right-hand column's LEFT edge, as a handle: the annotator beside the
 * session (`Workspace.tsx`'s beside mode) and the side panel a sheet opens in
 * (`.ws-panel`, e.g. the live desktop). Drag it, or focus it and press ←/→
 * (Shift for bigger steps); a double-click puts back the default.
 *
 * `SideGrip`'s shape, mirrored: one CSS variable on `<html>` (`--ws-beside-w`
 * / `--ws-panel-w`), which styles.css clamps so the session keeps a readable
 * width and the column its floor; written every move, stored once on release.
 * The terminal refits on its own debounce (beside); the panel overlays it.
 */
import { useEffect, useRef } from "react";
import { LS, lsDel, lsNum, lsSet } from "../../storage";

const GRIPS = {
  beside: { VAR: "--ws-beside-w", key: LS.wideBesideW, cls: "ws-beside-grip", label: "Annotator width" },
  panel: { VAR: "--ws-panel-w", key: LS.widePanelW, cls: "ws-panel-grip", label: "Panel width" },
} as const;
const MIN = 440;
/** What the session keeps, at least, beside the sidebar. */
const SESSION_MIN = 360;
const STEP = 24;

function sideWidth(): number {
  return document.querySelector("#root > .ws-side")?.getBoundingClientRect().width ?? 320;
}
function clampBeside(w: number): number {
  const max = Math.max(MIN, window.innerWidth - sideWidth() - SESSION_MIN);
  return Math.round(Math.min(max, Math.max(MIN, w)));
}
function current(el: HTMLElement | null): number {
  return el?.parentElement?.getBoundingClientRect().width ?? MIN;
}

export function BesideGrip({ of = "beside" }: { of?: keyof typeof GRIPS }) {
  const el = useRef<HTMLDivElement>(null);
  const { VAR, key, cls, label } = GRIPS[of];
  const apply = (w: number): number => {
    const v = clampBeside(w);
    document.documentElement.style.setProperty(VAR, `${v}px`);
    return v;
  };

  useEffect(() => {
    const saved = lsNum(key, 0);
    if (saved) apply(saved);
    return () => { document.documentElement.style.removeProperty(VAR); };
  }, [of]); // eslint-disable-line react-hooks/exhaustive-deps -- `key`, `VAR` and `apply` all derive from `of` via the module-constant `GRIPS`

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = current(grip);
    let w = startW;
    document.documentElement.classList.add("ws-resizing");
    const move = (ev: PointerEvent) => { w = apply(startW - (ev.clientX - startX)); };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("ws-resizing");
      lsSet(key, String(w));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    lsSet(key, String(apply(current(el.current) + dir * STEP * (e.shiftKey ? 5 : 1))));
  };

  const reset = () => {
    document.documentElement.style.removeProperty(VAR);
    lsDel(key);
  };

  return (
    <div ref={el} className={cls} role="separator" aria-orientation="vertical"
      aria-label={`${label}: drag, or arrow keys; double-click resets`}
      title="Drag to resize · double-click for the default width"
      tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} onDoubleClick={reset} />
  );
}
