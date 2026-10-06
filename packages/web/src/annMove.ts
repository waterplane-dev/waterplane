/**
 * Moving or reshaping a mark that is already on the picture — the part of the
 * annotator where a finger dragging a SMALL mark covers the very thing it is
 * placing. The proven answer for that is not a floating knob to re-aim (an
 * offset cursor or a text-selection lollipop just relocates the occlusion
 * problem onto a new piece of UI); it is RELATIVE drag: the finger touches
 * anywhere, and the selected mark follows by the delta, the way a trackpad or
 * Procreate's Transform does. The finger is then never on the mark, so nothing
 * needs to be offset, positioned or clamped to the screen.
 *
 * `moveGrab` is the whole priority decision for a pointer-down in move mode,
 * pinned so the order cannot drift between callers:
 *
 *  1. **A visible end dot wins** — the finger IS on the reshape handle, which
 *     is the finer gesture. Suppressed on a SMALL mark: its dots would sit
 *     under one fingertip anyway, so they are not drawn and not grabbable
 *     (`smallOnScreen`) — a direct drag on a small mark always means MOVE.
 *  2. **Picking a mark (any mark, including the one already selected) wins
 *     over a relative drag** — the finger is somewhere real, so that is what
 *     moves, whole.
 *  3. **A relative drag** — nothing under the finger, but something is
 *     selected: the drag moves that mark's WHOLE geometry, or one end of it,
 *     by whichever the mode chip currently names (`target`).
 *  4. **Nothing** — no selection, nothing hit; a tap on empty space is not a
 *     gesture yet (see `TAP_SLOP_PX` below).
 *
 * `settleMove` reuses `annClip.ts` UNCHANGED for what a move commits to — the
 * one new rule is the CALLER's: a move that would leave nothing on the picture
 * is REFUSED, never a delete. A drag has no undo of its own, so pushing a mark
 * fully off-image on a slip must snap back and say so, not disappear.
 *
 * Pure and node-tested (`annMove.test.mjs`) for the same reason `annClip.ts` is.
 */
import type { Mark } from "./annNote";
import { clipMark } from "./annClip.ts";

/** Below this on-screen span (CSS px), a mark's own end dots would sit under
 *  one fingertip — Material's/Apple's ~44-48pt minimum touch target — so they
 *  are hidden rather than drawn too small to hit reliably. */
export const SMALL_PX = 48;

/** A relative drag that moved less than this (CSS px) was a tap, not a drag —
 *  the deselect-on-empty-tap gesture, not a move of zero pixels. */
export const TAP_SLOP_PX = 8;

/** Is this mark's own bounding diagonal, at the current zoom, smaller than a
 *  fingertip? Text has no end dots at all, so it is never "small" in this
 *  sense — there is nothing to hide. */
export function smallOnScreen(m: Pick<Mark, "x0" | "y0" | "x1" | "y1" | "tool">, k: number): boolean {
  if (m.tool === "text") return false;
  return Math.hypot(m.x1 - m.x0, m.y1 - m.y0) * k < SMALL_PX;
}

export type MoveGrab =
  | { kind: "handle"; i: number; h: 0 | 1 }
  | { kind: "pick"; i: number }
  | { kind: "relative"; i: number; h: 0 | 1 | null }
  | { kind: "none" };

/** The move-mode pointer-down decision, in one place so its priority order is
 *  pinned rather than reconstructed at each call site. */
export function moveGrab(input: {
  /** Currently-selected mark, or none. */
  sel: number | null;
  /** Whether that mark's dots are too small to grab (see `smallOnScreen`). */
  small: boolean;
  /** Which end dot of the selection the finger landed on, if any — already
   *  gated on `!small` by the caller (a hidden dot cannot be hit). */
  handleHit: 0 | 1 | null;
  /** Topmost mark under the finger, if any (any mark, not just `sel`). */
  pickHit: number | null;
  /** The mode chip's current target — which end a relative drag reshapes,
   *  or `null` for the whole mark. */
  target: 0 | 1 | null;
}): MoveGrab {
  const { sel, small, handleHit, pickHit, target } = input;
  if (sel != null && !small && handleHit != null) return { kind: "handle", i: sel, h: handleHit };
  if (pickHit != null) return { kind: "pick", i: pickHit };
  if (sel != null) return { kind: "relative", i: sel, h: target };
  return { kind: "none" };
}

/** What a move commits to: `annClip`'s existing rules, unchanged — a box
 *  clips at the edge, a segment clips along its line, an ellipse is kept whole
 *  or not at all, a label clamps on. The one new decision is here: `null`
 *  (nothing left on the picture) REFUSES rather than deletes, and the caller
 *  is left holding `base` — right where the mark was before this drag. */
export function settleMove<T extends Mark>(live: T, base: T, w: number, h: number): { mark: T; refused: boolean } {
  const clipped = clipMark(live, w, h);
  return clipped ? { mark: clipped, refused: false } : { mark: base, refused: true };
}
