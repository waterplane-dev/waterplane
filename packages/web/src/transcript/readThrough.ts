/**
 * How far down the reader has actually READ: the newest turn whose END has been
 * on screen. A turn whose bottom edge sits at or above the viewport's bottom has
 * been scrolled through — it is on screen now or was passed on the way down —
 * so its stamp is the watermark, and every turn before it is read with it.
 *
 * This replaces "read only once parked at the very bottom": reading a long
 * session a turn at a time never touched the bottom, so every turn already
 * scrolled past was still counted new the next time the session opened.
 *
 * Pure (rects in, a stamp out) so the edge can be tested without a DOM.
 * `slack` absorbs sub-pixel rounding and a foot row still sliding in.
 */
export interface TurnEdge { ts: number; bottom: number }

export function readThrough(turns: readonly TurnEdge[], viewBottom: number, slack = 8): number {
  let m = 0;
  for (const t of turns) if (t.ts > m && t.bottom <= viewBottom + slack) m = t.ts;
  return m;
}
