/**
 * Alt+G (⌥G on a Mac) is the corner's full-screen button from the keyboard.
 *
 * WHY THIS KEY. It has to be free in three places at once: the browser (F11 and
 * Ctrl+Shift+F-style chords, Alt+D/E/F, and Firefox's menu letters in English and
 * German are theirs), claude's own keys (Alt+W, +O, +P, +T, +M, +V and the
 * readline B/D/F/Y; Alt+Return is its newline) and this app's (Alt+N). Pressed
 * in the terminal it never reaches the CLI.
 */
import { registerShortcut } from "../../shortcuts.ts";

/** The slice of a keydown the decision reads (fakeable in a node test). */
export interface FullKey {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

/** Alt alone + G. AltGr arrives as Ctrl+Alt and is never this. A letter is
 *  believed as printed; Option on a Mac types "©", so there `code` decides.
 *  A held key's auto-repeat would flicker, so only the first press counts. */
export function isFullScreenPress(e: FullKey): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.repeat) return false;
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === "g" : e.code === "KeyG";
}

/** The chord as this keyboard prints it. */
export const fullScreenKeyLabel = (mac: boolean): string => (mac ? "⌥G" : "Alt+G");

/** What already owns the keyboard: an in-app dialog (`primaryKey.ts`'s set). */
const DIALOGS = ".bl-modal-backdrop, [role=dialog][aria-modal=true]";

export interface FullScreenKeyDeps {
  /** The session screen is on top — off it full screen refuses to apply. */
  onSessionScreen(): boolean;
  hidden(): boolean;
  toggle(): void;
}

/** Capture phase, so a focused xterm does not send the press to the CLI. The
 *  listener and the shortcut card's row read one predicate. */
export function installFullScreenKey(d: FullScreenKeyDeps, win: Window = window): () => void {
  const free = () => d.onSessionScreen() && !win.document.querySelector(DIALOGS);
  const onKey = (e: KeyboardEvent) => {
    // A repeat is swallowed, not ignored: let through, the CLI would get it.
    if (!isFullScreenPress({ ...pick(e), repeat: false }) || !free()) return;
    e.preventDefault();
    e.stopPropagation();
    if (isFullScreenPress(pick(e))) d.toggle();
  };
  win.addEventListener("keydown", onKey, true);
  const off = registerShortcut({
    id: "term.fullscreen", mods: ["alt"], key: "G",
    what: () => (d.hidden() ? "leave full screen" : "full screen"),
    when: free,
  });
  return () => { win.removeEventListener("keydown", onKey, true); off(); };
}

/** An event's fields are getters on its prototype; a spread would copy none. */
function pick(e: KeyboardEvent): FullKey {
  const { key, code, ctrlKey, metaKey, shiftKey, altKey, isComposing, repeat } = e;
  return { key, code, ctrlKey, metaKey, shiftKey, altKey, isComposing, repeat };
}
