import { useEffect, useState } from "react";
import { dismissToast, onToast } from "./toast";

/**
 * The toast, mounted once beside `App` (see `toast.ts`). Renders nothing when
 * there is nothing to say, so it costs an empty subscription and no DOM.
 *
 * It is a BUTTON, not a `div`: the clock is now scaled to the length of the
 * sentence and reaches twelve seconds for a long one, so there has to be a way
 * to put it down early — a toast sits over the screen it is explaining. The tap
 * only takes it off screen; the row it wrote into the message log stays.
 *
 * A tap ANYWHERE puts it down too. Reported: a cost notice covering most of the
 * screen was "annoying and must be dismissable by tapping somewhere" — aiming
 * at the toast itself is one more thing to get right on a phone. The outside
 * tap is not swallowed: it dismisses AND does what it was aimed at, because a
 * toast is a sentence, never a wall in front of Send.
 *
 * `aria-live="polite"` because a sentence that is only ever painted is one a
 * screen reader never hears.
 */
/** Past this, the toast says where its words can be read again. */
const LONG_CHARS = 120;

export function ToastLayer() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => onToast(setMsg), []);
  useEffect(() => {
    if (!msg) return;
    // Capture phase, so a handler that stops propagation cannot keep it up.
    const down = () => dismissToast();
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [msg]);
  if (!msg) return null;
  return (
    <button className="toast" role="status" aria-live="polite" title="dismiss" onClick={dismissToast}>
      {msg}
      {/* Only under a sentence long enough to need saying where it went —
          "copied" does not need a footnote. */}
      {msg.length > LONG_CHARS && (
        <span style={{ display: "block", marginTop: 6, fontSize: "0.85em", color: "var(--muted)" }}>
          tap anywhere to close · the full text stays under the bell
        </span>
      )}
    </button>
  );
}
