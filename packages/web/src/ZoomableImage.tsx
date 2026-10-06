import { useEffect, useRef, useState } from "react";
import { ImageOff, Minimize2 } from "lucide-react";
import { clamp } from "./format";

const MAX_SCALE = 6;

/** GPU max texture size, probed once. A composited layer wider than this renders
 *  BLACK on plenty of Android GPUs (and takes the rest of the page with it when
 *  the GPU process gives up) — so the zoom ceiling has to be derived from it, not
 *  hard-coded. Falls back to the conservative 4096 every GL implementation has. */
let maxTexCache = 0;
function maxTexture(): number {
  if (maxTexCache) return maxTexCache;
  maxTexCache = 4096;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const v = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof v === "number" && v > 0) maxTexCache = v;
  } catch { /* no WebGL — keep the floor */ }
  return maxTexCache;
}

/** Highest scale this image can be shown at without the backing store outgrowing
 *  a texture. Never below 2 — a viewer you can't zoom is worse than a blurry one. */
function scaleCeiling(w: number, h: number): number {
  const px = Math.max(w, h) * (window.devicePixelRatio || 1);
  if (!px) return MAX_SCALE;
  return clamp(maxTexture() / px, 2, MAX_SCALE);
}

/** Full-screen pinch/pan/double-tap zoom stage. One-finger drag pans when zoomed
 *  in; otherwise lets parent overlay catch the tap-to-close. Pointer-event based
 *  so it works on touch + trackpad without a library. At fit scale a horizontal
 *  drag follows the finger and fires onNav(±1) past a threshold (swipe between
 *  images); zoomed in, the same gesture stays a pan.
 *
 *  Two invariants keep it out of the "screen went black, back button is the only
 *  way out" state: the pan is CLAMPED so the image can never leave the stage
 *  (a black overlay with the image dragged off it looks exactly like a crash),
 *  and the scale ceiling comes from the GPU texture limit (see scaleCeiling).
 *  `will-change` is applied only during a gesture — as a permanent declaration it
 *  pins an oversized layer in GPU memory for as long as the viewer is open.
 *  Shared by the gallery viewer, the new-image swiper and the repo browser
 *  (`FilesSheet`). `onError` hands a failed load to a caller that has its own
 *  fallback to show (the browser's download button). */
export function ZoomableImage({ src, alt, onNav, onError }: { src: string; alt: string; onNav?: (dir: 1 | -1) => void; onError?: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const [gesture, setGesture] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;
  // Live pointer set + gesture snapshots (refs so handlers stay stable).
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  // Pinch snapshot: finger distance, midpoint and the transform, all at gesture start.
  const pinch = useRef<{ dist: number; mx: number; my: number; s: number; x: number; y: number } | null>(null);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTap = useRef(0);
  // Src that failed to load (host unreachable, file gone, thumbnail evicted).
  // Stored as the SRC, not a boolean, so the flag can't survive into the next
  // image and so a re-render can't re-mount the same failing <img> in a loop:
  // an unloadable src is simply never rendered as an <img> again. Without this
  // the full-screen viewer is a black stage with nothing on it — which is the
  // exact "the app crashed" symptom the zoom invariants below also guard.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Reset when the source changes (viewer reused for the next image).
  useEffect(() => { setT({ s: 1, x: 0, y: 0 }); }, [src]);

  /** Clamp a transform so the image always covers / stays inside the stage.
   *  Layout size (offsetWidth) is pre-transform, which is what the maths needs. */
  function fit(next: { s: number; x: number; y: number }, freeX = false) {
    const img = imgRef.current;
    const stage = stageRef.current;
    let s = Number.isFinite(next.s) ? clamp(next.s, 1, MAX_SCALE) : 1;
    if (img && img.offsetWidth) s = Math.min(s, scaleCeiling(img.offsetWidth, img.offsetHeight));
    let x = Number.isFinite(next.x) ? next.x : 0;
    let y = Number.isFinite(next.y) ? next.y : 0;
    if (img && stage) {
      // Slack = how far the scaled image overhangs the stage, halved (centred).
      const sx = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2);
      const sy = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2);
      if (!freeX) x = clamp(x, -sx, sx);
      y = clamp(y, -sy, sy);
    }
    return { s, x, y };
  }

  const two = () => {
    const p = [...ptrs.current.values()];
    return p.length >= 2 ? p : null;
  };

  function startPinch() {
    const p = two();
    if (!p) return;
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    const box = stageRef.current?.getBoundingClientRect();
    const cx = box ? box.left + box.width / 2 : 0;
    const cy = box ? box.top + box.height / 2 : 0;
    pinch.current = {
      dist: d || 1, // two fingers reported at the same point would divide by zero
      mx: (p[0].x + p[1].x) / 2 - cx,
      my: (p[0].y + p[1].y) / 2 - cy,
      s: tRef.current.s,
      x: tRef.current.x,
      y: tRef.current.y,
    };
    pan.current = null;
  }

  function down(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setGesture(true);
    if (ptrs.current.size >= 2) {
      startPinch();
    } else {
      // Double-tap toggles between fit and 2.5×.
      const now = e.timeStamp;
      if (now - lastTap.current < 300) {
        setT((c) => fit(c.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }));
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
      pan.current = { x: e.clientX, y: e.clientY, tx: tRef.current.x, ty: tRef.current.y };
    }
  }

  function move(e: React.PointerEvent) {
    const p = ptrs.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const pair = two();
    if (pair && pinch.current) {
      e.stopPropagation();
      const g = pinch.current;
      const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      const box = stageRef.current?.getBoundingClientRect();
      const mx = (pair[0].x + pair[1].x) / 2 - (box ? box.left + box.width / 2 : 0);
      const my = (pair[0].y + pair[1].y) / 2 - (box ? box.top + box.height / 2 : 0);
      const s = clamp((g.s * d) / g.dist, 1, MAX_SCALE);
      // Keep the point under the fingers put: with transform `translate then
      // scale`, a stage point f maps through x' = f - (f - x) * s'/s. The moving
      // midpoint carries the two-finger pan for free.
      setT(fit({ s, x: mx - (g.mx - g.x) * (s / g.s), y: my - (g.my - g.y) * (s / g.s) }));
    } else if (pan.current && tRef.current.s > 1) {
      e.stopPropagation();
      const g = pan.current;
      setT((c) => fit({ s: c.s, x: g.tx + (e.clientX - g.x), y: g.ty + (e.clientY - g.y) }));
    } else if (pan.current && onNav) {
      // Fit scale: horizontal follow only, so the swipe reads as image nav.
      const g = pan.current;
      setT((c) => ({ ...c, x: g.tx + (e.clientX - g.x) }));
    }
  }

  function up(e: React.PointerEvent) {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (ptrs.current.size === 1) {
      // Second finger lifted mid-pinch: hand the survivor a fresh pan anchor
      // instead of leaving it inert until it too is lifted.
      const [only] = [...ptrs.current.values()];
      pan.current = { x: only.x, y: only.y, tx: tRef.current.x, ty: tRef.current.y };
    }
    if (ptrs.current.size === 0) {
      setGesture(false);
      if (pan.current && tRef.current.s <= 1 && onNav && e.type !== "pointercancel") {
        const dx = e.clientX - pan.current.x;
        const dy = e.clientY - pan.current.y;
        // Deliberate horizontal swipe (not a tap, not a vertical scroll attempt).
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onNav(dx < 0 ? 1 : -1);
      }
      // Snap back anything the free-x swipe or a stale gesture left off-centre.
      setT((c) => (c.s <= 1 ? { s: 1, x: 0, y: 0 } : fit(c)));
      pan.current = null;
    }
  }

  const zoomed = t.s > 1.01;
  return (
    <div
      ref={stageRef}
      className="zoom-stage"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {failedSrc === src ? (
        <div className="img-missing">
          <ImageOff size={22} />
          <span className="img-missing-name">{alt}</span>
          <span>couldn’t load this image — the host may be unreachable</span>
        </div>
      ) : (
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setT((c) => fit(c))}
        onError={() => { setFailedSrc(src); onError?.(); }}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          willChange: gesture ? "transform" : "auto",
        }}
      />
      )}
      {zoomed && (
        // Visible way back to fit — double-tap alone is undiscoverable, and a
        // stuck zoom used to leave the browser Back button as the only exit.
        <button
          className="zoom-reset"
          aria-label="reset zoom"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setT({ s: 1, x: 0, y: 0 }); }}
        >
          <Minimize2 size={16} /> {t.s.toFixed(1)}×
        </button>
      )}
    </div>
  );
}
