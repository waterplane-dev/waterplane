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
import type { Snippet } from "../../SnippetSheet";
import { loadSnippetView } from "../../localState";
import type { SnippetView } from "../../snippetPicks";

/** What this device shows RIGHT NOW: its saved list, or the starters while no list exists at all (`logic.snippetView`). Reads storage; writes nothing. */
export const readSnippetView = (): SnippetView => loadSnippetView();

export const snippets = createStore<SnippetView>(readSnippetView());

export function useSnippetView(): SnippetView {
  return useStore(snippets);
}

export function useSnippets(): Snippet[] {
  return useStore(snippets).list;
}
