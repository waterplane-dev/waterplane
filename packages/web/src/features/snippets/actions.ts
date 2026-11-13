/**
 * Every writer of the snippet list.
 */
import { LS, lsSetJson } from "../../storage";
import { onSettingsChange } from "../../settings";
import type { Snippet } from "../../SnippetSheet";
import { missingStarters } from "../../snippetPicks";
import { readSnippetView, snippets } from "./store";

export function saveSnippets(next: Snippet[]): void {
  snippets.set({ list: next, starter: false });
  lsSetJson(LS.snippets, next);
}

/**
 * The READ half of sync (`settings.ts`): the list is held in a store seeded at
 * load, so a copy adopted from another device would otherwise sit in
 * localStorage until the next reload.
 */
export function bootSnippetSync(): () => void {
  return onSettingsChange(() => snippets.set(readSnippetView()), [LS.snippets]);
}

/** "Add the starter snippets": APPENDS the ones whose text the list lacks; never replaces. */
export function addStarters(current: Snippet[]): void {
  saveSnippets([...current, ...missingStarters(current)]);
}
