/**
 * A key with modifiers held, as the bytes a terminal sends for it.
 *
 * The phone's key row arms Ctrl / Alt / Shift and combines them with the next
 * key — one on the row, or a letter from the on-screen keyboard. This is the
 * one encoding of that combination, xterm's, which is what claude's TUI reads
 * (its own keybinding table names `ctrl+o`, `meta+p`, `shift+tab`, …):
 *
 * - `ctrl+<letter>` → the control byte (`ctrl+o` = 0x0f); `ctrl+[ \ ] ^ _ space`
 *   their C0 bytes; `ctrl+?` / `ctrl+backspace` DEL / BS.
 * - `alt+<anything>` → ESC, then the key's own bytes (`alt+p` = `\x1bp`) — the
 *   "meta sends escape" convention claude's `meta+` bindings rely on.
 * - `shift+<letter>` → the capital; `shift+tab` → CSI Z.
 * - modified arrows / Home / End → `CSI 1;<m><final>`, PgUp/PgDn/Delete →
 *   `CSI <n>;<m>~`, with xterm's `m = 1 + shift + 2·alt + 4·ctrl`.
 *
 * A combination a terminal has no bytes for (`ctrl+1`, `ctrl+tab`,
 * `shift+enter`) is REFUSED with a sentence, never sent as something else.
 */

export interface ChordMods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * The key the modifiers land on: one printable character as typed, or a name
 * for a key that types nothing.
 */
export type ChordKey =
  | "tab" | "enter" | "esc" | "backspace" | "delete" | "space"
  | "up" | "down" | "left" | "right" | "home" | "end" | "pgup" | "pgdn"
  | (string & {});

export type ChordResult = { bytes: string } | { refused: string };

const CURSOR_FINAL: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const TILDE_CODE: Record<string, string> = { pgup: "5", pgdn: "6", delete: "3" };
const PLAIN: Record<string, string> = {
  tab: "\t", enter: "\r", esc: "\x1b", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
  pgup: "\x1b[5~", pgdn: "\x1b[6~", delete: "\x1b[3~",
};
/** C0 bytes for the punctuation ctrl combines with. */
const CTRL_PUNCT: Record<string, string> = {
  "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f", "?": "\x7f", "@": "\x00", " ": "\x00",
};

/** `ctrl+alt+shift+o`, the CLI's own spelling, modifiers in that order. */
export function chordName(m: ChordMods, key: ChordKey): string {
  return [m.ctrl && "ctrl", m.alt && "alt", m.shift && "shift", key === " " ? "space" : key].filter(Boolean).join("+");
}

export function hasMods(m: ChordMods): boolean {
  return !!(m.ctrl || m.alt || m.shift);
}

/** The bytes for `key` with `m` held, or the sentence why there are none. */
export function chordBytes(m: ChordMods, key: ChordKey): ChordResult {
  const name = chordName(m, key);
  const no = (why: string): ChordResult => ({ refused: `${name} has no terminal bytes — ${why}` });
  if (!key) return no("no key");

  // Cursor keys carry every modifier in the xterm parameter.
  if (key in CURSOR_FINAL || key in TILDE_CODE) {
    if (!hasMods(m)) return { bytes: PLAIN[key] };
    const p = 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
    return { bytes: key in CURSOR_FINAL ? `\x1b[1;${p}${CURSOR_FINAL[key]}` : `\x1b[${TILDE_CODE[key]};${p}~` };
  }

  // Alt is a prefix over whatever the rest encodes to.
  if (m.alt) {
    const rest = chordBytes({ ctrl: m.ctrl, shift: m.shift }, key);
    return "bytes" in rest ? { bytes: `\x1b${rest.bytes}` } : no("refused" in rest ? rest.refused.replace(/^.*? — /, "") : "");
  }

  const ch = key === "space" ? " " : key;
  if (m.ctrl) {
    if (m.shift && key !== "tab") {
      // ctrl+shift+<letter> is the same control byte in a plain terminal;
      // claude binds a few (`ctrl+shift+b`) that only a kitty-protocol
      // terminal can tell apart — sending ctrl+<letter> would be a different key.
      return no("a plain terminal sends the same byte as without shift");
    }
    if (key === "tab") return no("terminals send Tab for it");
    if (key === "enter") return no("terminals send Return for it");
    if (key === "backspace") return { bytes: "\x08" };
    if (key === "esc") return no("terminals send Esc for it");
    if (ch.length === 1) {
      const lower = ch.toLowerCase();
      if (/^[a-z]$/.test(lower)) return { bytes: String.fromCharCode(lower.charCodeAt(0) - 96) };
      if (ch in CTRL_PUNCT) return { bytes: CTRL_PUNCT[ch] };
      if (ch === "-") return { bytes: "\x1f" }; // ctrl+- is how most keyboards type ctrl+_
    }
    return no("ctrl combines only with a letter or [ \\ ] ^ _ ? @ space");
  }

  if (m.shift) {
    if (key === "tab") return { bytes: "\x1b[Z" };
    if (key === "enter") return no("terminals send Return for it; Alt+Return is claude's newline");
    if (key === "space") return { bytes: " " };
    if (key in PLAIN) return { bytes: PLAIN[key] };
    if (ch.length === 1) return { bytes: ch.toUpperCase() };
    return no("unknown key");
  }

  if (key in PLAIN) return { bytes: PLAIN[key] };
  if (ch.length === 1) return { bytes: ch };
  return no("unknown key");
}
