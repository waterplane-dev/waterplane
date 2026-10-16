/**
 * Ctrl/⌘+Return in the compose box sends (`useCompose.ts`'s `onComposeKey`) —
 * its line on the shortcut card (`shortcuts.ts`). Live while the caret is in
 * the compose box (`data-compose`, not the CLI pipe) with words in it, and no
 * dialog is up to take the same keys first (`primaryKey.ts`).
 */
import { registerShortcut } from "../../shortcuts.ts";
import { primaryButton } from "../layout/primaryKey.ts";

/** The focus slice the predicate reads (fakeable in a node test). */
export interface ComposeFocus {
  matches(sel: string): boolean;
  value?: string;
}

/** Would Ctrl/⌘+Return send right now? Pure over the focused element. */
export function composeSendLive(el: ComposeFocus | null | undefined, dialogUp: boolean): boolean {
  if (dialogUp || !el) return false;
  if (!el.matches("textarea[data-compose]:not(.pipe)")) return false;
  return (el.value ?? "").trim() !== "";
}

/** Install once (`main.tsx`); returns the removal. */
export function registerComposeShortcut(doc: Document = document): () => void {
  return registerShortcut({
    id: "composeSend",
    mods: ["ctrl", "meta"],
    key: "Enter",
    what: () => "send",
    when: () => composeSendLive(doc.activeElement as HTMLTextAreaElement | null, primaryButton(doc) != null),
  });
}
