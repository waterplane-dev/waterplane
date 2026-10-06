import { useEffect, useRef, useState } from "react";

/**
 * "Stay true for `ms` after `active` goes false."
 *
 * Every transient status strip in the session view — the queue bar, the upload
 * row — is a SIBLING of the terminal in one flex column, so mounting or
 * unmounting one changes the terminal's height, which refits the xterm grid,
 * which SIGWINCHes the PTY, which makes the claude TUI clear and repaint the
 * WHOLE screen. That is why the flicker is never confined to the strip that
 * caused it. A send that queues, delivers and acks is two of those repaints; a
 * retrying upload or a reconnect draining a queue is one per attempt.
 *
 * Lingering coalesces a burst into a single mount. It does not make the strips
 * free — a real state change still costs one repaint — but it stops the same
 * strip from flapping while the app is busy, which is exactly when it flaps.
 */
export function useLinger(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) { wasActive.current = true; setOn(false); return; }
    if (!wasActive.current) return;
    wasActive.current = false;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [active, ms]);
  return on;
}
