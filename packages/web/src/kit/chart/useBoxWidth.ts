import { useCallback, useRef, useState } from "react";

/**
 * The width a chart is drawn at, measured off the box that holds it.
 *
 * A CALLBACK ref, deliberately not `useRef` + `useEffect`: every chart on this
 * screen is behind data that arrives after mount (the scan, the kept usage
 * readings), so a mount-time effect runs when the box does not exist yet, bails,
 * and — with nothing in its deps that changes when the data lands — never runs
 * again. The width stays 0, `width > 0` stays false, and every chart is silently
 * absent for ever while the prose around it renders. A callback ref measures at
 * the moment the node attaches, whenever that is, and re-measures when the node
 * is swapped (charts ⇄ table) without anyone having to remember a dep.
 */
export function useBoxWidth(): [number, (el: HTMLDivElement | null) => void] {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    // The CONTENT width: `clientWidth` includes the box's padding, and a
    // chart drawn that wide overflowed every `.ctx-box` by its 24px of
    // padding — the right edge of every chart on this screen was cut off.
    const inner = () => {
      const cs = getComputedStyle(el);
      return Math.max(0, el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
    };
    setWidth(inner());
    if (typeof ResizeObserver === "undefined") return;
    ro.current = new ResizeObserver(() => setWidth(inner()));
    ro.current.observe(el);
  }, []);
  return [width, ref];
}
