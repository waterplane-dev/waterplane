/**
 * Saved compose snippets — seeded from this device's copy (`LS.snippets`,
 * synced), written only by `actions.ts`: the sheet's save, and a copy adopted
 * from another device (`bootSnippetSync`).
 *
 * The pick-a-snippet popover and the insert into the compose box are not
 * here: they are the compose bar's (`core/compose`'s `appendSnippet`), which
 * reads the list through `useSnippets()`.
 */
import { createStore, useStore } from "../../sdk";
import { loadSnippets } from "../../localState";
import type { Snippet } from "../../SnippetSheet";

export const snippets = createStore<Snippet[]>(loadSnippets());

export function useSnippets(): Snippet[] {
  return useStore(snippets);
}
