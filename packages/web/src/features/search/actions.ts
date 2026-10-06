/**
 * Every writer of the search store, and the one frame it sends.
 */
import type { SessionSearchResult, SessionSearchScope } from "@waterplane/shared";
import { core } from "../../sdk";
import { acceptsResults } from "./logic";
import { search } from "./store";

/** Open the search sheet scoped to a session (null = all sessions). The
 *  toolbar's `find` (terminal view) and the launcher menu's search call this. */
export function openSearch(sessionId: string | null): void {
  search.set({ scope: sessionId, results: null, loading: false });
  core().nav.open("search");
}

/** Fire a search request over the wire; results arrive via `session.searchResults`. */
export function fireSearch(query: string, scope: SessionSearchScope): void {
  const cur = search.get();
  search.set({ ...cur, loading: true });
  // eslint-disable-next-line local/no-silent-send -- the sheet IS the receipt: it shows the search as loading until the answer lands and states offline itself (`online`); a search replayed on reconnect would answer a sheet that has moved on, so nothing is queued
  core().conn.send({ t: "session.search", query, scope, id: cur.scope ?? undefined });
}

/** `session.searchResults`: kept only when it answers the scope on screen. */
export function onSearchResults(id: string | undefined, results: SessionSearchResult[]): void {
  const cur = search.get();
  if (acceptsResults(id, cur.scope)) search.set({ ...cur, results, loading: false });
}
