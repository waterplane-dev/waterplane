/**
 * Every writer of the search store, and the one frame it sends.
 */
import type { SessionSearchResult, SessionSearchScope } from "@waterplane/shared";
import { core } from "../../sdk";
import { acceptsResults } from "./logic";
import { search } from "./store";

/** Open the search sheet scoped to a session (null = all sessions). The
 *  toolbar's `find` (terminal view) and the launcher menu's search call this. */
export function openSearch(sessionId: string | null, query?: string): void {
  search.set({ scope: sessionId, query: query?.trim() || undefined, results: null, loading: false, archive: null });
  core().nav.open("search");
}

/** Whether the request in flight asked for the archive — what an answer without the
 *  echo is measured against (an older host never searches it, and that is said). */
let pendingArchived = false;

/** Fire a search request over the wire; results arrive via `session.searchResults`. */
export function fireSearch(query: string, scope: SessionSearchScope, archived = false): void {
  const cur = search.get();
  // Only the all-sessions sheet offers the archive; a scoped find never asks.
  const ask = archived && !cur.scope;
  search.set({ ...cur, loading: true });
  pendingArchived = ask;
  // eslint-disable-next-line local/no-silent-send -- the sheet IS the receipt: it shows the search as loading until the answer lands and states offline itself (`online`); a search replayed on reconnect would answer a sheet that has moved on, so nothing is queued
  core().conn.send({ t: "session.search", query, scope, id: cur.scope ?? undefined, ...(ask ? { archived: true } : {}) });
}

/** `session.searchResults`: kept only when it answers the scope on screen. */
export function onSearchResults(id: string | undefined, results: SessionSearchResult[], archived?: boolean, archivedOmitted?: number): void {
  const cur = search.get();
  if (acceptsResults(id, cur.scope)) {
    search.set({ ...cur, results, loading: false, archive: { asked: pendingArchived, searched: !!archived, omitted: archivedOmitted ?? 0 } });
  }
}
