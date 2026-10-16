/**
 * Keys and typed words → `DesktopInput` events. Pure (`keys.test.mjs`).
 *
 * The sticky modifiers ⌘ ⌥ ⌃ ⇧ apply to the NEXT key and then clear, the way a phone keyboard's
 * shift does, so ⌘ then `s` is one ⌘S and nothing stays held by accident. Typed text goes as
 * `text` events of at most `TEXT_MAX` characters (code points, never a split surrogate pair), and a
 * line break is a `Return` key of its own — the helper types text with a unicode string, which
 * carries no Return.
 */
import { NAMED_KEYS, TEXT_MAX, type DesktopInput, type Modifier } from "../shared/wire.mts";

export const MOD_ORDER: readonly Modifier[] = ["cmd", "alt", "ctrl", "shift"];
export const MOD_GLYPH: Record<Modifier, string> = { cmd: "⌘", alt: "⌥", ctrl: "⌃", shift: "⇧" };
export const MOD_NAME: Record<Modifier, string> = { cmd: "Command", alt: "Option", ctrl: "Control", shift: "Shift" };

/** A stored typing draft (`state.ts`, an older build may have written it) → the composer's one-box
 *  list. A string is kept as it is, words never trimmed away; anything else is an empty box. */
export function cleanDraft(v: unknown): string[] {
  return [typeof v === "string" ? v : ""];
}

/** Toggle one modifier in the held set (kept in `MOD_ORDER`). */
export function toggleMod(held: readonly Modifier[], m: Modifier): Modifier[] {
  const on = held.includes(m) ? held.filter((x) => x !== m) : [...held, m];
  return MOD_ORDER.filter((x) => on.includes(x));
}

/** One key with whatever is held — and the held set after it (empty: they apply once). */
export function pressKey(held: readonly Modifier[], key: string): { ev: DesktopInput; held: Modifier[] } {
  return { ev: { k: "key", key, mods: MOD_ORDER.filter((m) => held.includes(m)) }, held: [] };
}

/** Typed words → events: text chunks of at most `max` code points, a `Return` key per line break.
 *  With modifiers held and exactly one character typed, it is that KEY with them (⌘ + s). */
export function textEvents(s: string, held: readonly Modifier[] = [], max = TEXT_MAX): DesktopInput[] {
  const chars = [...s.replace(/\r\n?/g, "\n")];
  if (held.length && chars.length === 1 && chars[0] !== "\n") return [pressKey(held, chars[0]!).ev];
  const out: DesktopInput[] = [];
  let run: string[] = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += max) out.push({ k: "text", s: run.slice(i, i + max).join("") });
    run = [];
  };
  for (const c of chars) {
    if (c === "\n") { flush(); out.push({ k: "key", key: "Return", mods: [] }); }
    else run.push(c);
  }
  flush();
  return out;
}

/** The key row, in the terminal key row's order and words, plus Backspace (a desktop has no
 *  composer to correct in). `^C` is Control-C, exactly what the label says. */
export interface RowKey { id: string; label: string; title: string; key: string; mods?: Modifier[] }
export const ROW_KEYS: readonly RowKey[] = [
  { id: "esc", label: "Esc", title: "Esc", key: "Escape" },
  { id: "tab", label: "Tab", title: "Tab", key: "Tab" },
  { id: "up", label: "up", title: "up arrow", key: "ArrowUp" },
  { id: "down", label: "down", title: "down arrow", key: "ArrowDown" },
  { id: "left", label: "left", title: "left arrow", key: "ArrowLeft" },
  { id: "right", label: "right", title: "right arrow", key: "ArrowRight" },
  { id: "ctrlc", label: "^C", title: "Control-C", key: "c", mods: ["ctrl"] },
  { id: "bksp", label: "bksp", title: "Backspace — delete the character before the cursor", key: "Backspace" },
  { id: "ret", label: "ret", title: "Return", key: "Return" },
];

/** A row key pressed with what is held; its own modifiers (^C's Control) are added. */
export function rowKeyEvent(held: readonly Modifier[], k: RowKey): DesktopInput {
  const mods = MOD_ORDER.filter((m) => held.includes(m) || (k.mods ?? []).includes(m));
  return { k: "key", key: k.key, mods };
}

/** The parts of a `KeyboardEvent` a hardware keyboard's press is read from. */
export interface KeyPress { key: string; code: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; isComposing?: boolean }

/** A hardware keyboard's key → one event for the desktop, or null when it is not one to send
 *  (a modifier alone, a dead key mid-compose, a key the helper has no name for). A character with
 *  no ⌘ ⌥ ⌃ goes as TEXT (the browser already applied Shift and the layout); with one it is that
 *  KEY with them, read off `code` so ⌥S is S and not the layout's ß. The sticky row's `held`
 *  modifiers are added, as for any other key. */
export function keyboardEvent(e: KeyPress, held: readonly Modifier[] = []): DesktopInput | null {
  if (e.isComposing) return null;
  const on = (m: Modifier) => held.includes(m) || (m === "cmd" ? e.metaKey : m === "alt" ? e.altKey : m === "ctrl" ? e.ctrlKey : e.shiftKey);
  const mods = MOD_ORDER.filter(on);
  const chord = mods.some((m) => m !== "shift");
  const key = e.key === "Enter" ? "Return" : e.key;
  if ((NAMED_KEYS as readonly string[]).includes(key)) return { k: "key", key, mods };
  if ([...key].length !== 1) return null;
  if (!chord) return { k: "text", s: key };
  const fromCode = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(e.code)?.[1];
  return { k: "key", key: fromCode ?? key.toLowerCase(), mods };
}
