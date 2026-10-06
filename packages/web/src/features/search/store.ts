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

export interface SearchState { scope: string | null; results: SessionSearchResult[] | null; loading: boolean }

export const search = createStore<SearchState>({ scope: null, results: null, loading: false });
