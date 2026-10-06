/**
 * Every writer of the snippet list.
 */
import { LS, lsSetJson } from "../../storage";
import { loadSnippets } from "../../localState";
import { onSettingsChange } from "../../settings";
import type { Snippet } from "../../SnippetSheet";
import { snippets } from "./store";

export function saveSnippets(next: Snippet[]): void {
  snippets.set(next);
  lsSetJson(LS.snippets, next);
}

/**
 * The READ half of sync (`settings.ts`): the list is held in a store seeded at
 * load, so a copy adopted from another device would otherwise sit in
 * localStorage until the next reload.
 */
export function bootSnippetSync(): () => void {
  return onSettingsChange(() => snippets.set(loadSnippets()), [LS.snippets]);
}
