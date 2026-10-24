/**
 * Fullscreen's one control on the glass: a small round handle the person can drag anywhere, so it
 * never sits on the same part of the desktop for good. A tap shows the view's controls (exit,
 * close, screenshot, fit, the key row); another tap hides them. Its place is remembered per host.
 */
import { useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { extStorage } from "@waterplane/sdk";
import { Button } from "@waterplane/kit";
import { PLUGIN_ID } from "../shared/wire.mts";
import { DRAG_SLOP, cleanSpot, spotAt, type Spot } from "./spot.ts";

const SIZE = 44;
const store = extStorage(PLUGIN_ID);

export function Handle({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const [spot, setSpot] = useState<Spot>(() => cleanSpot(store.read("handleSpot", null)));
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const place = (e: React.PointerEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return null;
    return spotAt(e.clientX - box.left, e.clientY - box.top, box.width, box.height, SIZE);
  };
  return (
    <Button className={open ? "active" : undefined} aria-pressed={open} aria-label="controls"
      title={open ? "hide the controls — drag to move this button" : "show the controls (exit, close, screenshot, keys) — drag to move this button"}
      style={{
        position: "absolute", zIndex: 3, width: SIZE, height: SIZE, minWidth: SIZE, padding: 0, borderRadius: SIZE / 2,
        left: `calc(${spot.x * 100}% - ${SIZE / 2}px)`, top: `calc(${spot.y * 100}% - ${SIZE / 2}px)`,
        display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none",
        opacity: open ? 0.95 : 0.6, boxShadow: "0 0 4px #000",
        // `.key.active`'s fill is a translucent tint: over the desktop picture it vanished. Lay it on the opaque key face.
        ...(open ? { background: "linear-gradient(var(--pick-fill), var(--pick-fill)), var(--raise)" } : null),
      }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); press.current = { x: e.clientX, y: e.clientY, moved: false }; }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p) return;
        if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
        p.moved = true;
        const s = place(e);
        if (s) setSpot(s);
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (!p) return;
        if (!p.moved) { onToggle(); return; }
        const s = place(e);
        if (s) { setSpot(s); store.write("handleSpot", s); }
      }}
      onPointerCancel={() => { press.current = null; }}>
      <Ellipsis size={20} />
    </Button>
  );
}
