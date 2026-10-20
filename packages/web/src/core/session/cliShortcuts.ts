/**
 * claude's own shortcuts, for the key row's `Keys` list — one tap each.
 *
 * Taken from claude 2.1.304's default keybinding table (its `chat:` and `app:`
 * actions, read out of the binary), not from memory. Left out on purpose:
 * `ctrl+c` (the row's `^C`), `ctrl+d` (exits claude — one stray tap ends the
 * session), `ctrl+g`/`ctrl+e` (hand the PTY to an editor the phone has no way
 * out of), `ctrl+v` (pastes the DESKTOP's clipboard image), and the
 * `ctrl+shift+…` bindings (a plain terminal cannot send them apart from
 * `ctrl+…`). A person who remapped `~/.claude/keybindings.json` has other keys —
 * the list says so.
 *
 * Bytes come from `shared/chord.ts`, the same encoding the sticky modifiers
 * use; `seq` keys are pressed one after another with a pause, because two Esc
 * bytes in one write read as alt+esc.
 */
import { chordBytes, type ChordKey, type ChordMods } from "@waterplane/shared";

export interface CliShortcut {
  /** The CLI's spelling, drawn as the key. */
  name: string;
  /** What it does, in a few words. */
  does: string;
  /** Pressed in order, one write each. */
  seq: { m: ChordMods; key: ChordKey }[];
}

export const CLI_SHORTCUTS_VERSION = "2.1.304";

export const CLI_SHORTCUTS: readonly CliShortcut[] = [
  { name: "shift+tab", does: "next permission mode", seq: [{ m: { shift: true }, key: "tab" }] },
  { name: "ctrl+o", does: "show / hide the transcript", seq: [{ m: { ctrl: true }, key: "o" }] },
  { name: "ctrl+t", does: "show / hide the todo list", seq: [{ m: { ctrl: true }, key: "t" }] },
  // tmux reads ctrl+b as its prefix; the host doubles it (`tmuxLiteral`) so one reaches claude.
  { name: "ctrl+b", does: "send the running command to the background", seq: [{ m: { ctrl: true }, key: "b" }] },
  { name: "ctrl+r", does: "search earlier prompts", seq: [{ m: { ctrl: true }, key: "r" }] },
  { name: "ctrl+s", does: "stash the prompt being typed", seq: [{ m: { ctrl: true }, key: "s" }] },
  { name: "ctrl+_", does: "undo in the prompt", seq: [{ m: { ctrl: true }, key: "_" }] },
  { name: "ctrl+l", does: "clear the prompt", seq: [{ m: { ctrl: true }, key: "l" }] },
  { name: "ctrl+j", does: "new line in the prompt", seq: [{ m: { ctrl: true }, key: "j" }] },
  { name: "alt+p", does: "model picker", seq: [{ m: { alt: true }, key: "p" }] },
  { name: "alt+t", does: "thinking on / off", seq: [{ m: { alt: true }, key: "t" }] },
  { name: "alt+o", does: "fast mode on / off", seq: [{ m: { alt: true }, key: "o" }] },
  { name: "esc esc", does: "jump back to an earlier prompt — from an empty prompt while idle; mid-turn the first Esc stops the turn", seq: [{ m: {}, key: "esc" }, { m: {}, key: "esc" }] },
];

/** The writes for a shortcut, in order — null if any step has no bytes. */
export function shortcutWrites(s: CliShortcut): string[] | null {
  const out: string[] = [];
  for (const step of s.seq) {
    const r = chordBytes(step.m, step.key);
    if (!("bytes" in r)) return null;
    out.push(r.bytes);
  }
  return out;
}
