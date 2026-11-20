/**
 * The search sheet's state, moved out of `App.tsx` (three `useState`s and a
 * ref mirror). ONE writer: `actions.ts` — `openSearch`/`fireSearch` from a tap,
 * `onSearchResults` from the `session.searchResults` handler.
 *
 * `scope` is the session the sheet searches (null = all sessions); `results`
 * is null until an answer lands, and is cleared when a fresh request fires.
 */
import type { SessionSearchResult } from "@waterplane/shared";
import { createStore } from "../../sdk";

export interface SearchState {
  scope: string | null; /** Words the sheet opens with (the launcher filter's). */ query?: string; results: SessionSearchResult[] | null; loading: boolean;
  /** What the last answer said about the archive: `asked` = the request wanted it,
   *  `searched` = the host echoed it (absent on an older host), `omitted` = matching
   *  archived conversations past the host's cap. Null before any answer. */
  archive?: { asked: boolean; searched: boolean; omitted: number } | null;
}

export const search = createStore<SearchState>({ scope: null, results: null, loading: false, archive: null });
