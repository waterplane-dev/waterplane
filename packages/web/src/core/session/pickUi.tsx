/**
 * What the terminal and the reader share for "pick lines": the long-press
 * menu, the pick bar under the picks, and their verbs. The two hooks
 * (`useTermPick.tsx`, `useReaderPick.tsx`) differ only in what a "line" is —
 * a grid row there, a paragraph or list item here.
 *
 * Both are abortable without choosing anything: the menu has its own cancel,
 * closes on a tap anywhere else and on Back; the bar's last button leaves pick
 * mode, and so does Back.
 */
import { useEffect, useRef } from "react";
import { Copy, ListChecks, MessageSquareReply, Quote, TextSelect, X } from "lucide-react";
import { useBackStep } from "../../backStep";
import { openDecisions, quoteIntoCompose } from "../../features/clipboard";
import { showToast } from "../../toast";

const ICON = 16;
/** How long a still finger is a long-press, not a tap. Under Android's own
 *  long-press (~500 ms), so the choices appear with the native selection. */
export const LONG_PRESS_MS = 450;

export interface MenuAt { x: number; y: number }

const plural = (n: number) => `${n} line${n > 1 ? "s" : ""}`;

/** Quote, copy or answer the picked text; true when pick mode should end. */
export function quotePicked(lines: readonly string[]): boolean {
  if (!quoteIntoCompose(lines.join("\n"))) return false;
  showToast(`quoted ${plural(lines.length)} into compose`);
  return true;
}
export async function copyPicked(lines: readonly string[]): Promise<void> {
  try { await navigator.clipboard.writeText(lines.join("\n")); showToast(`copied ${plural(lines.length)}`); }
  catch { showToast("clipboard unavailable (needs https) — quote puts the lines in compose instead"); }
}

export function PickMenu({ at, onPick, onCancel }: { at: MenuAt; onPick: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useBackStep(true, onCancel);
  // A tap anywhere else is "never mind". Bound on the NEXT press, so the
  // finger that opened the menu lifting off does not close it again.
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onCancel(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onCancel]);
  return (
    <div ref={ref} className="tpick-menu" style={{
      left: Math.max(8, Math.min(at.x - 110, window.innerWidth - 236)),
      top: at.y + 220 > window.innerHeight ? Math.max(8, at.y - 220) : at.y + 28,
    }}>
      <button className="key" onClick={onPick}><ListChecks size={ICON} /> pick lines</button>
      <button className="key" onClick={() => { onCancel(); void openDecisions(); }}><MessageSquareReply size={ICON} /> answer list</button>
      <button className="key" onClick={onCancel}><TextSelect size={ICON} /> select text</button>
      <button className="key" onClick={() => { window.getSelection()?.removeAllRanges(); onCancel(); }}><X size={ICON} /> cancel</button>
    </div>
  );
}

export function PickBar({ count, off, hint, lines, onStop }: {
  count: number; off: number; hint: string; lines: () => string[]; onStop: () => void;
}) {
  useBackStep(true, onStop);
  return (
    <div className="tpick-bar">
      <span className="tpick-count">
        {count ? <>{count} picked{off ? <>, {off} out of view</> : null}</> : hint}
      </span>
      {count > 0 && <>
        <button className="key" onClick={() => { if (quotePicked(lines())) onStop(); }}><Quote size={ICON} /> quote</button>
        <button className="key" onClick={() => void copyPicked(lines())}><Copy size={ICON} /> copy</button>
        <button className="key" onClick={() => { const l = lines(); onStop(); void openDecisions(l); }}><MessageSquareReply size={ICON} /> answer</button>
      </>}
      <button className="key" onClick={onStop}><X size={ICON} /> {count ? "cancel" : "done"}</button>
    </div>
  );
}

/** A finger held still on `el` for `LONG_PRESS_MS` — moved past 8 px, a
 *  second finger or lifting it cancels. Native selection is not prevented. */
export function bindLongPress(el: HTMLElement, fire: (x: number, y: number, target: EventTarget | null) => void): () => void {
  let timer: number | undefined, x0 = 0, y0 = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const start = (e: TouchEvent) => {
    cancel();
    if (e.touches.length !== 1) return;
    const t = e.touches[0], target = e.target;
    x0 = t.clientX; y0 = t.clientY;
    timer = window.setTimeout(() => { timer = undefined; fire(x0, y0, target); }, LONG_PRESS_MS);
  };
  const move = (e: TouchEvent) => {
    if (timer === undefined || e.touches.length !== 1) return;
    if (Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 8) cancel();
  };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", cancel, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    cancel();
    el.removeEventListener("touchstart", start);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", cancel);
    el.removeEventListener("touchcancel", cancel);
  };
}
