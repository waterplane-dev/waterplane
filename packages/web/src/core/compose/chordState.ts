/**
 * The sticky modifiers' state rules, pure (`useChord.ts` is the hook over
 * them): a tap cycles off → once → lock → off, a key drops the one-shot ones,
 * and what the pipe or a hardware key hands over is named as a chord key.
 */
import type { ChordKey, ChordMods } from "@waterplane/shared";

export type ChordMod = "ctrl" | "alt" | "shift";
/** `once` = for the next key; `lock` = until tapped off. */
export type ModState = "off" | "once" | "lock";
export type ModStates = Record<ChordMod, ModState>;

export const ALL_OFF: ModStates = { ctrl: "off", alt: "off", shift: "off" };

export const held = (s: ModStates): ChordMods => ({ ctrl: s.ctrl !== "off", alt: s.alt !== "off", shift: s.shift !== "off" });

/** The next state of one modifier key on a tap. */
export function nextModState(s: ModState): ModState {
  return s === "off" ? "once" : s === "once" ? "lock" : "off";
}

/** One-shot modifiers drop after a key; locked ones stay. */
export function afterKey(s: ModStates): ModStates {
  return { ctrl: s.ctrl === "lock" ? "lock" : "off", alt: s.alt === "lock" ? "lock" : "off", shift: s.shift === "lock" ? "lock" : "off" };
}

/** The pipe's bytes → the key the modifiers apply to (its FIRST character). */
export function typedKey(c: string): ChordKey {
  return c === "\x7f" ? "backspace" : c === "\r" ? "enter" : c === "\t" ? "tab" : c === " " ? "space" : c;
}

/** A hardware key's `e.key` → a chord key name, for the keys the text diff cannot see. */
export const NAMED_KEY: Record<string, ChordKey> = {
  Enter: "enter", Tab: "tab", Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Home: "home", End: "end", PageUp: "pgup", PageDown: "pgdn", Delete: "delete", Backspace: "backspace",
};

