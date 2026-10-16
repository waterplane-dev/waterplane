/**
 * CTRL/CMD+RETURN PRESSES THE DIALOG'S BLUE BUTTON — with a physical keyboard.
 *
 * Every in-app dialog (`askConfirm`, `askText`, the launcher's pickers, a hint
 * card) marks its next action as the one `.send` button. The compose box
 * already answers Cmd/Ctrl+Return with Send (`useCompose.ts`); a dialog asked
 * WHILE the caret sits in that box — a picture pasted onto a busy annotator —
 * left the same keys sending the message underneath instead of answering.
 *
 * So the listener runs in the CAPTURE phase on `window`, ahead of React's root
 * listener: with a dialog up, the keys are the dialog's, and the press is
 * consumed. With none up it does nothing and the compose box keeps them.
 * Sheets are not dialogs: a full screen can hold several `.send` buttons and
 * the first in DOM order is not reliably "the next action". A sheet that IS
 * one question with one verb (the launch ask's "Start …") opts in with
 * `data-primary-key` on its root — and keeps exactly one `.send` while it does.
 */

import { registerShortcut } from "../../shortcuts.ts";

/** Topmost open dialog (or opted-in sheet), innermost-last in DOM order. */
const DIALOGS = ".bl-modal-backdrop, [role=dialog][aria-modal=true], [data-primary-key]";

/** The slice of a keydown the decision reads (fakeable in a node test). */
export interface PrimaryKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/** Is this press Ctrl/Cmd+Return and nothing else? Pure. */
export function isPrimaryPress(e: PrimaryKey): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !e.isComposing;
}

/** The dialog's blue button, or null with no dialog (or one without a primary). */
export function primaryButton(doc: Pick<Document, "querySelectorAll">): HTMLButtonElement | null {
  const open = doc.querySelectorAll(DIALOGS);
  const top = open[open.length - 1];
  return top?.querySelector<HTMLButtonElement>("button.send:not(:disabled)") ?? null;
}

/** The button's own words for the shortcut card: `press “Delete”`. */
export function primaryWhat(label: string | null | undefined): string {
  const t = (label ?? "").replace(/\s+/g, " ").trim();
  return t && t.length <= 24 ? `press “${t}”` : "press the dialog's button";
}

/** Install once (`main.tsx`); returns the uninstall. Also the line on the
 *  shortcut card (`shortcuts.ts`), live exactly when the listener would act. */
export function installPrimaryKey(win: Window = window): () => void {
  const offRow = registerShortcut({
    id: "primaryKey",
    mods: ["ctrl", "meta"],
    key: "Enter",
    what: () => primaryWhat(primaryButton(win.document)?.textContent),
    when: () => primaryButton(win.document) != null,
  });
  const onKey = (e: KeyboardEvent) => {
    if (!isPrimaryPress(e)) return;
    const btn = primaryButton(win.document);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    btn.click();
  };
  win.addEventListener("keydown", onKey, true);
  return () => { offRow(); win.removeEventListener("keydown", onKey, true); };
}
