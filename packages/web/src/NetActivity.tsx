import { useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { NET_STALL_MS } from "@waterplane/shared";
import { useLink } from "./link";

/**
 * The one place that always answers "is my tap doing anything?".
 *
 * Every HTTP call in `api.ts` registers with the link store's ops ledger; this
 * renders the fact. It subscribes for `ops` ALONE — the store keeps a section's
 * identity while that section has not changed, so this strip, which is mounted
 * on every screen, does not repaint because a ping came back or a byte was
 * counted.
 * Three stages, because the useful answer changes with how long the wait is:
 *
 *  - under `SHOW_MS` — nothing. On a good link every request is over in tens of
 *    milliseconds and a bar that flashes on each one is worse than no bar.
 *  - past `SHOW_MS` — a thin indeterminate bar. Costs no vertical space and is
 *    enough to turn "the button is broken" into "it's working on it".
 *  - past `WORDS_MS` — the bar grows a chip naming what is in flight and how
 *    long it has been, because at that point the question has become "is this
 *    stuck?", and a spinner with no elapsed count cannot answer it.
 *  - past `STALL_MS` — the chip says so plainly. A phone on 5G is "online"
 *    while the Tailscale path is dead, so `navigator.onLine` is not the thing
 *    to show; the seconds are.
 *
 * The stages only ever go FORWARD while work is in flight, and the strip
 * lingers past the last one. Both rules exist because the readout is a function
 * of the OLDEST request: when it finishes and a younger one is still running,
 * the age collapses back under the thresholds, so the chip and then the bar
 * vanished and came back — a blink per request, worst exactly during a send
 * burst or a reconnect, when the app fires request after request. Nothing about
 * the link changed at those moments, so neither should the strip.
 */
const SHOW_MS = 400;
const WORDS_MS = 2000;
/** One number with the stall record (`shared/netstall.ts`), so "the chip said
 *  stalled" and "a stall was recorded" are the same moment. */
const STALL_MS = NET_STALL_MS;
/** How long the strip stays up after the last request settles, so back-to-back
 *  calls read as one wait instead of a stutter. */
const LINGER_MS = 400;

export function NetActivity() {
  const ops = useLink((s) => s.ops);
  // Re-render on a timer only while something is actually in flight — the
  // elapsed counter has to tick, but an idle app must not repaint every second.
  const [, setTick] = useState(0);
  // Stage latches, cleared only when the strip goes away for good.
  const shownRef = useRef(false);
  const wordsRef = useRef(false);
  // Set while the strip is being held open past the last settled request.
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    if (!ops.length) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [ops.length]);
  // Nothing in flight: hold the strip for LINGER_MS, then drop it and reset the
  // stages, so the NEXT wait starts from "nothing" again.
  useEffect(() => {
    if (ops.length) { setLingering(false); return; }
    if (!shownRef.current) return;
    setLingering(true);
    const t = window.setTimeout(() => {
      shownRef.current = false;
      wordsRef.current = false;
      setLingering(false);
    }, LINGER_MS);
    return () => window.clearTimeout(t);
  }, [ops.length]);

  // The OLDEST in-flight request is the one worth reporting: it is the one the
  // user is waiting on, and a burst of quick calls behind it must not reset the
  // elapsed count back to zero.
  const oldest = ops.length ? ops.reduce((a, b) => (a.started <= b.started ? a : b)) : null;
  const age = oldest ? Date.now() - oldest.started : 0;
  if (oldest && age >= SHOW_MS) shownRef.current = true;
  if (oldest && age >= WORDS_MS) wordsRef.current = true;
  if (!shownRef.current) return null;
  if (!oldest && !lingering) return null;

  const secs = Math.floor(age / 1000);
  const stalled = !!oldest && age >= STALL_MS;
  return (
    <div className={`net-activity${stalled ? " stalled" : ""}`} role="status" aria-live="polite">
      <div className="net-bar"><span /></div>
      {wordsRef.current && oldest && (
        <div className="net-chip">
          {stalled ? <TriangleAlert size={12} /> : <Loader2 size={12} className="spin" />}
          <span>
            {oldest.label}
            {ops.length > 1 ? ` +${ops.length - 1}` : ""} · {secs}s
            {stalled ? " — the connection may be down" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
