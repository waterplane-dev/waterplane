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
 * at its end (`SideGrip.tsx`'s reasoning), not one per frame. The drag itself
 * is `useDragCap.ts`, shared with the reader's agent list.
 */
import type { ReactNode } from "react";
import { ChevronsDown } from "lucide-react";
import { LS } from "../../storage";
import { useDragCap } from "./useDragCap";

export function ChromeFrame({ off, hidden, children }: {
  /** Draw the chrome whole for now (menu open, typing room, the peek). */
  off: boolean;
  /** No grip at all (typing room / full screen: the chrome is gone anyway). */
  hidden: boolean;
  children: ReactNode;
}): ReactNode {
  const { frame, cap, capped, grip } = useDragCap({
    key: LS.sessChromeH, off, showAllEvent: "action:chrome.showAll", capEvent: "action:chrome.cap",
  });

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
          {...grip}>
          {capped && <ChevronsDown size={12} aria-hidden="true" />}
        </div>
      )}
    </>
  );
}
