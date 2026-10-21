/**
 * The toolbar configuration's pure half — no React, no DOM, no icons — so
 * `logic.test.mjs` runs it under `node --test`. Each takes the id lists and
 * returns the next one; `actions.ts` saves it.
 */

/**
 * Menu entries that do NOT shut the burger's menu behind them. Everything else
 * opens a sheet or fires once, so a tap is a choice and the menu goes — but
 * these mutate IN PLACE and are meant to be hit twice: `limit` cycles
 * inherit → on → off and the star toggles. Closing under the finger would mean
 * re-opening the menu to finish what one tap started. (A plugin's switches in
 * the `plugins` entry never call `dismiss` at all, for the same reason; its
 * actions do.)
 */
export const MENU_KEEP_OPEN: ReadonlySet<string> = new Set(["limit", "star", "followup", "bookmark"]);

/** Does a tap on this menu entry shut the menu? */
export function closesMenu(id?: string): boolean {
  return !(id && MENU_KEEP_OPEN.has(id));
}

/** `id` in or out of `list`, appended when added. */
export function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The order with `id` swapped one step in `dir`; null at an end. */
export function movedBy(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id), j = i + dir;
  if (i === -1 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** The order with `dragId` dropped into `overId`'s slot; null when nothing moves. */
export function draggedOnto(ids: readonly string[], dragId: string, overId: string | null | undefined): string[] | null {
  if (!overId || overId === dragId) return null;
  const from = ids.indexOf(dragId), to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}
