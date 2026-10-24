/**
 * Where an `auto` toolbar goes for this picture (`autoPlace`, annLayout.ts).
 *
 * Measures the BODY (bar + picture — the same box whichever side the bar is
 * on, so the choice cannot feed back into its own input) against the canvas's
 * own size, which the canvas box carries 1:1 (no CSS scaling) and which a crop
 * changes too. Null until both are known; the CSS media fallback stands then.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { autoPlace } from "../annLayout";

export function useAutoPlace(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"left" | "top" | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const canvas = canvasRef.current;
    if (!body || !canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = body.getBoundingClientRect();
      setSide(autoPlace({ w: r.width, h: r.height }, canvas.width ? { w: canvas.width, h: canvas.height } : null));
    });
    ro.observe(body);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef]);
  return { bodyRef, side };
}
