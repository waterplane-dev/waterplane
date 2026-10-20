/**
 * The keys the CLI tells a person to press, and the bytes each one is.
 *
 * claude's footer and pickers name their own shortcuts — `(shift+tab to
 * cycle)`, `s to use this session only`, `Tab to toggle`. A phone has no
 * shift, no ctrl and (outside CLI mode) no bare letter key, so the host reads
 * those hints off the screen (`host/keyhints.ts`) and the phone offers each as
 * one tap on the key row. This file is the half both ends must agree on: which
 * key names count and what is written to the PTY for them.
 *
 * Only keys the fixed row does NOT already have: Esc, Tab, Return and the
 * arrows are always there, so a hint naming one of them adds no chip.
 */

/** One hint as the CLI drew it: the key (normalised, lower case) and its
 *  verb in the CLI's own words (`cycle`, `use this session only`). */
export interface KeyHint {
  key: string;
  verb: string;
}

/** Most chips a row carries — past three the row stops being a key row. */
export const KEY_HINT_MAX = 3;

/**
 * The bytes for a hinted key, or null for a key that is not one this list
 * knows. `shift+tab` → CSI Z, `ctrl+<letter>` → its control byte, a bare
 * lower-case letter or digit → itself. `ctrl+c` (the row's `^C`) and
 * `ctrl+g` (opens an editor) are refused.
 */
export function keyHintBytes(key: string): string | null {
  if (key === "shift+tab") return "\x1b[Z";
  // Already on the fixed row as `^C`.
  if (key === "ctrl+c") return null;
  // `ctrl+g to edit in Vim`: hands the PTY to an editor the phone has no way
  // back out of except CLI mode and `:q!` — not a one-tap key.
  if (key === "ctrl+g") return null;
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  if (/^[a-z0-9]$/.test(key)) return key;
  return null;
}

/** The chip's key label: `⇧Tab`, `^O`, `s`. */
export function keyHintLabel(key: string): string {
  if (key === "shift+tab") return "⇧Tab";
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  if (ctrl) return `^${ctrl[1].toUpperCase()}`;
  return key;
}

/** Same hints, same order — the host publishes only on a change. */
export function sameKeyHints(a: readonly KeyHint[] | undefined, b: readonly KeyHint[] | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((h, i) => h.key === y[i].key && h.verb === y[i].verb);
}
