/**
 * Which contributed session views (the live desktop) have a TAB in the session
 * header, beside `[Claude | Shell]`.
 *
 * None by default: a view is opened from the ☰ menu (`ToolbarMenu`'s view
 * lines), and that open is what puts its tab up — the same rule the Shell tab
 * follows (it appears once the burger's "companion shell" made one, never as a
 * standing offer). The tab's × takes it down again. A tab drawn on every
 * session for a view the person had never asked for cost the title most of its
 * row (the owner's ask, 2026-10-09).
 *
 * Keyed by `ContributedEntry.key` (`<manifest id>:<view id>`), persisted per
 * host (`LS.headerViews`). One writer: the two functions here.
 */
import { createStore, useStore } from "../../sdk/store.ts";
import { LS, lsJson, lsSetJson } from "../../storage";

const read = (): readonly string[] => {
  const v = lsJson<unknown>(LS.headerViews, []);
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
};

const store = createStore<readonly string[]>(read());

function write(next: readonly string[]): void {
  store.set(next);
  lsSetJson(LS.headerViews, next);
}

/** Give a view its header tab (an open from the ☰ menu). */
export function pinHeaderView(key: string): void {
  const cur = store.get();
  if (!cur.includes(key)) write([...cur, key]);
}

/** Take a view's header tab down (its ×). */
export function unpinHeaderView(key: string): void {
  const cur = store.get();
  if (cur.includes(key)) write(cur.filter((k) => k !== key));
}

export function useHeaderViews(): readonly string[] {
  return useStore(store);
}
