/**
 * A KEY TYPED AT NOTHING GOES TO THE TERMINAL — the desktop's expectation.
 *
 * On a PC the terminal is on screen and a hand is on a keyboard, so typing is
 * expected to reach the CLI without first finding the right box to click.
 * xterm already pipes its own keys (`Terminal.tsx` → `session.input`); what was
 * missing is a keystroke that landed on NO field — focus on `<body>`, or on a
 * button just clicked in the sidebar — which went nowhere at all. That key is
 * sent through the same raw pipe (`sendInput`, no new send path) and the
 * terminal then takes focus, so the rest of the word is xterm's own.
 *
 * Left alone, each for a reason:
 *   - any field (input, textarea, select, contenteditable) — its keys are its own;
 *   - the terminal itself — xterm already sent the key;
 *   - Esc and every Ctrl/Alt/Meta chord: a STRAY Esc or ^C interrupts a running
 *     turn, and a desktop hand presses Esc out of habit (Workspace.tsx says the
 *     same). Those reach the CLI only from the focused terminal, on purpose;
 *   - Tab: focus navigation stays the browser's;
 *   - Enter/Space on a button or link: that is activating it;
 *   - an already-handled key (`defaultPrevented`).
 */
import { keyToBytes } from "../../cliKeys.ts";

/** The slice of a keydown the decision reads (fakeable in a node test). */
export interface StrayKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

/** What the key landed on, already classified. */
export interface StrayTarget {
  /** input / textarea / select / contenteditable. */
  editable: boolean;
  /** Inside the xterm element. */
  inTerminal: boolean;
  /** A button, link or summary — Enter and Space activate it. */
  activatable: boolean;
}

/** Bytes to send for a key that landed on no field, or null to leave it. Pure. */
export function strayKeyBytes(e: StrayKey, t: StrayTarget): string | null {
  if (e.defaultPrevented || e.isComposing) return null;
  if (t.editable || t.inTerminal) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === "Escape" || e.key === "Tab") return null;
  if (t.activatable && (e.key === "Enter" || e.key === " ")) return null;
  if (e.key === "Backspace") return "\x7f";
  if (e.key.length === 1) return e.key;
  return keyToBytes(e);
}

/** Classify a DOM event target. */
export function strayTargetOf(el: Element | null): StrayTarget {
  const tag = el?.tagName?.toUpperCase() ?? "";
  const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(el as HTMLElement | null)?.isContentEditable;
  return {
    editable,
    inTerminal: !!el?.closest?.(".xterm"),
    activatable: !!el?.closest?.("button, a[href], summary, [role=button]"),
  };
}

/** Something is over the terminal: a side panel, a dialog, a confirm. */
export const OVER_TERMINAL = "#root > .ws-panel, [role=dialog], .bl-modal-backdrop";

/**
 * Listen on `window` while a live terminal is on screen. `blocked()` answers
 * "is something over it" at the moment of the key; `send` is the raw pipe;
 * `focus` hands the terminal the rest of the typing. The decision waits until
 * every other keydown handler has run (`escape.ts`'s reason): one that owns
 * the key has called `preventDefault()` by then. Nothing here needs the
 * default prevented — the key landed on no field, so it had none.
 */
export function startStrayKeys(win: Window, send: (bytes: string) => void, focus: () => void, blocked: () => boolean): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (strayKeyBytes(e, strayTargetOf(e.target as Element | null)) == null) return;
    win.setTimeout(() => {
      if (blocked()) return;
      const bytes = strayKeyBytes(e, strayTargetOf(e.target as Element | null));
      if (bytes == null) return;
      send(bytes);
      focus();
    }, 0);
  };
  win.addEventListener("keydown", onKey);
  return () => win.removeEventListener("keydown", onKey);
}
