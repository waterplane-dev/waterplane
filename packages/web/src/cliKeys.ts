/**
 * CLI mode — the compose box as a KEY PIPE instead of a composer.
 *
 * The normal send path is deliberately heavy: text is queued (`outbox.ts`),
 * carried on an ackId, typed host-side by `deliver.ts`, echo-checked on the
 * rendered screen and submitted with a verified Return. That is what makes a
 * prompt survive a dead tunnel — and it is exactly wrong when what you want is
 * to *drive the TUI*: pick a file in `/resume`, walk a `/config` menu, answer a
 * free-text box, type `y`. There the keystroke IS the interaction, the CLI
 * echoes it itself, and a queued-and-confirmed delivery of the letter "y" is
 * both slower and less correct than sending the byte.
 *
 * So CLI mode routes every keystroke straight to `session.input`, raw and
 * undurable — the same path the Esc/Tab/arrow row already uses, and undurable
 * for the same reason (see `sendInput`): a keystroke aimed at what is on screen
 * right now is meaningless when replayed onto a screen that has moved on.
 *
 * The phone is why this file exists rather than a `keydown` handler. Android
 * soft keyboards do not emit usable `keydown` for letters (keyCode 229, or
 * nothing at all) — only `input` events on a focused editable. So the box keeps
 * a PAD of spaces and every input event is DIFFED against it: text appended is
 * text typed, characters missing are backspaces. `decodePipe` is that diff, and
 * it is pure so the rule can be read (and reasoned about) without a DOM.
 */

/**
 * What the pipe box holds when nothing has been typed.
 *
 * Spaces, not zero-width characters: a soft keyboard treats the invisible ones
 * as part of the word it is composing and hands back autocorrect suggestions
 * built on them. Padded rather than empty because Backspace in an EMPTY field
 * is the one keystroke Android may not report at all — there has to be
 * something to delete for the deletion to be observable.
 */
export const PIPE_PAD = "        "; // 8 spaces

/** Bytes for a paste/typing diff. `\n` becomes `\r`: the CLI's composer submits
 *  on Return, and a newline that arrives as `\n` is not a submit. */
function asBytes(s: string): string {
  return s.replace(/\r?\n/g, "\r");
}

/**
 * Turn "the box was `prev`, now it is `next`" into the bytes the PTY should get.
 *
 * Compares on the common prefix, so it covers all three shapes an IME produces:
 * appended text (typed or pasted), a shorter string (backspaces), and a
 * rewritten tail (autocorrect replacing a word) — the last one as "delete what
 * changed, then type the replacement", which is what a real keyboard would have
 * sent anyway.
 *
 * `prev` is the value the box was last KNOWN to hold, not `PIPE_PAD`: the
 * caller resets the DOM synchronously, and two events landing before a render
 * would otherwise both be measured against the pad and double-count deletes.
 */
export function decodePipe(prev: string, next: string): string {
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  const deletes = prev.length - i;
  return "\x7f".repeat(deletes) + asBytes(next.slice(i));
}

/** A hardware-keyboard keystroke, if it is one the diff can't carry. */
export interface CliKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Keys that produce no text, so an `input` diff never sees them. */
const NAMED: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
};

/**
 * Bytes for a key that the text diff cannot express, or `null` to let the diff
 * handle it (every printable character, and Backspace — which shortens the pad
 * and is therefore already covered).
 *
 * Returning bytes here means the caller must `preventDefault()`: Enter would
 * otherwise also insert a newline into the pad and be sent twice.
 */
export function keyToBytes(e: CliKeyEvent): string | null {
  if (e.metaKey) return null; // ⌘-shortcuts belong to the browser
  if (e.ctrlKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) {
    return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
  }
  const named = NAMED[e.key];
  if (!named) return null;
  // Alt+Return is "newline, don't submit" in the claude composer.
  if (e.key === "Enter" && e.altKey) return "\x1b\r";
  return named;
}
