/**
 * Where the corner group (`useCornerDrag.ts`) is drawn, as pure geometry in
 * client coordinates. No imports, so node --test can load it.
 *
 * Two kinds of place, because the two want different things of a layout that
 * moves (keyboard up, header folded, full screen):
 *
 *  - BOXED: dropped wholly over the terminal or the reader. An offset from the
 *    group's home corner, kept inside that box, hidden with it.
 *  - FREE: dropped anywhere else on the session screen. A gap to the screen's
 *    right edge and to whichever of its top and bottom was nearer, so a group
 *    parked by the compose box rides up with it when the keyboard opens.
 *
 * A place is never overwritten by a clamp: the clamp is redone on every layout,
 * so a narrow moment does not move the group for good.
 */
export interface Box { left: number; top: number; right: number; bottom: number }
/** The home corner: the group's right edge and top with no offset. */
export interface Home { right: number; top: number }
export interface Size { width: number; height: number }
/** `cols` absent = unfolded (one row). */
export interface Boxed { x: number; y: number; cols?: number }
export interface Free { free: true; right: number; edge: "top" | "bottom"; gap: number; cols?: number }
export type Place = Boxed | Free;

export const HOME: Boxed = { x: 0, y: 0 };
/** Gap kept to the right edge — the CSS home's own `right: 8px`, so a drag (or
 *  a fold) never parks the group flush against the screen edge. */
export const EDGE = 8;

export const isFree = (p: Place): p is Free => "free" in p;

/** What storage held, or home. An older build's `{x, y}` reads as boxed. */
export function readPlace(v: unknown): Place {
  if (!v || typeof v !== "object") return HOME;
  const o = v as Record<string, unknown>;
  const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const cols = Number.isInteger(o.cols) && (o.cols as number) >= 1 ? { cols: o.cols as number } : {};
  if (o.free === true) {
    return fin(o.right) && fin(o.gap) && (o.edge === "top" || o.edge === "bottom")
      ? { free: true, right: o.right, edge: o.edge, gap: o.gap, ...cols } : HOME;
  }
  return fin(o.x) && fin(o.y) ? { x: o.x, y: o.y, ...cols } : HOME;
}

/** The group's right edge and top, kept inside `box`. Too big for it, its left
 *  top corner wins: that is where the grip is, and a group whose grip is off
 *  the screen cannot be dragged back. */
export function keepIn(at: Home, size: Size, box: Box): Home {
  const right = Math.max(Math.min(at.right, box.right - EDGE), box.left + size.width);
  const top = Math.max(Math.min(at.top, box.bottom - size.height), box.top);
  return { right: Math.round(right), top: Math.round(top) };
}

/** Where a place is drawn right now. */
export function drawnAt(p: Place, size: Size, home: Home, box: Box, screen: Box): Home {
  if (!isFree(p)) return keepIn({ right: home.right + p.x, top: home.top + p.y }, size, box);
  const top = p.edge === "top" ? screen.top + p.gap : screen.bottom - p.gap - size.height;
  return keepIn({ right: screen.right - p.right, top }, size, screen);
}

/** The place a group dropped at `at` is remembered as. */
export function placeFor(at: Home, size: Size, home: Home, box: Box | null, screen: Box, cols?: number): Place {
  const fold = cols ? { cols } : {};
  const bottom = at.top + size.height;
  // No box: it is too short to carry the group (`useCornerDrag.ts`), so nothing is dropped INTO it.
  if (box && at.right - size.width >= box.left && at.right <= box.right && at.top >= box.top && bottom <= box.bottom) {
    return { x: at.right - home.right, y: at.top - home.top, ...fold };
  }
  const above = at.top - screen.top, below = screen.bottom - bottom;
  return { free: true, right: screen.right - at.right, edge: above <= below ? "top" : "bottom", gap: Math.min(above, below), ...fold };
}
