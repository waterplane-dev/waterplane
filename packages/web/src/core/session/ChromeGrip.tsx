/**
 * The session chrome (header + status line) as a frame a person can shorten:
 * drag the grip under it up to hide its bottom rows, down to bring them back;
 * a tap on a shortened frame shows all of it again. Arrow keys step it.
 *
 * The cap is one number per device (`chromeCap.ts`, `LS.sessChromeH`) and it
 * CLIPS — the rows are still rendered, so nothing about the header's own logic
 * knows a cap exists. `off` lifts it without forgetting it: the burger's menu
 * hangs inside the header, typing room floats two of its buttons over the
 * output, and the peek is a request to SEE the chrome — none of those may be
 * cut by an old drag.
 *
 * The terminal under it refits on its own debounce, so a drag is one SIGWINCH
 * at its end (`SideGrip.tsx`'s reasoning), not one per frame.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsDown } from "lucide-react";
import { LS, lsDel, lsGet, lsSet } from "../../storage";
import { CHROME_STEP_PX, chromeCapAfter, chromeCapOf } from "./chromeCap.ts";
import { track } from "../../usage";

const TAP_SLOP_PX = 6;

function save(v: number | null): void {
  if (v == null) lsDel(LS.sessChromeH);
  else lsSet(LS.sessChromeH, String(v));
}

export function ChromeFrame({ off, hidden, children }: {
  /** Draw the chrome whole for now (menu open, typing room, the peek). */
  off: boolean;
  /** No grip at all (typing room / full screen: the chrome is gone anyway). */
  hidden: boolean;
  children: ReactNode;
}): ReactNode {
  const [cap, setCap] = useState<number | null>(() => chromeCapOf(lsGet(LS.sessChromeH)));
  const frame = useRef<HTMLDivElement>(null);
  // The live value while a drag is under way, so `up` stores what was drawn.
  const live = useRef(cap);
  useEffect(() => { live.current = cap; }, [cap]);
  const capped = !off && cap != null;

  const natural = () => frame.current?.scrollHeight ?? 0;
  const shown = () => frame.current?.getBoundingClientRect().height ?? 0;
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
      set(chromeCapAfter(startH, dy, natural()));
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (!moved) {
        // A tap: the way back from any cap is one touch, never a precise drag.
        if (live.current != null) { track("action:chrome.showAll"); set(null); save(null); }
        return;
      }
      track(live.current == null ? "action:chrome.showAll" : "action:chrome.cap");
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
    const v = chromeCapAfter(shown(), dir * CHROME_STEP_PX * (e.shiftKey ? 4 : 1), natural());
    set(v);
    save(v);
  };

  return (
    <>
      <div ref={frame} className={`sess-chrome${capped ? " capped" : ""}`}
        style={capped ? { maxHeight: `${cap}px` } : undefined}>
        {children}
      </div>
      {!hidden && (
        <div className={`sess-chrome-grip${capped ? " capped" : ""}`}
          role="separator" aria-orientation="horizontal" tabIndex={0}
          aria-label={capped
            ? "header shortened — tap to show all of it, or drag down for more"
            : "drag up to hide the bottom of the header"}
          title={capped
            ? "header shortened — tap to show all of it, or drag down for more"
            : "drag up to hide the bottom of the header — the status line goes first"}
          onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
          {capped && <ChevronsDown size={12} aria-hidden="true" />}
        </div>
      )}
    </>
  );
}
