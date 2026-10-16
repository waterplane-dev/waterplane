/**
 * A reader verb (`cmd`, the toolbar's outline/find/refresh) and an outline jump
 * (`jumpTo`) are props that OUTLIVE the reader they were fired at: both live in
 * `useTermFeed`, and the reader unmounts under every sheet and every switch to
 * the terminal. Its effects run on mount — on purpose, `openReader` fires its
 * outline before the reader exists — so without a record of what was already
 * done, every remount did it again: back from any sheet, the find bar
 * re-opened or the view was yanked to the turn the outline jumped to minutes ago.
 *
 * Spent by IDENTITY, not by `key`: each fire is a new object, while the keys
 * restart at 1 after `attach` clears `readerCmd`, so a key seen in one session
 * is a fresh tap in the next.
 */
/** Module-wide, because the reader's own state dies on every remount and the props do not. */
export const READER_SPENT = new WeakSet<object>();

export function takeVerb(v: object | null | undefined, spent: WeakSet<object> = READER_SPENT): boolean {
  if (!v || spent.has(v)) return false;
  spent.add(v);
  return true;
}
