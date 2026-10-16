/**
 * THE HOLD — when the shortcut card comes up, and when it goes. Pure, node-tested
 * (`shortcutHold.test.mjs`); `ShortcutCard.tsx` feeds it real events and a timer.
 *
 * A modifier pressed ALONE arms it; held `HOLD_MS` with nothing else pressed,
 * the card shows. Any other key, the modifier's release, a blur or the page
 * going hidden ends it at once. A quick Ctrl+C never shows anything: the C
 * lands before the timer, and once another key has been pressed the hold is
 * SPENT until every key is up — so keeping Ctrl down after a copy does not
 * bring the card up halfway through the next chord.
 *
 * The card never consumes a key: a listed key pressed while it is up hides it
 * and runs the chord as it always would.
 */
import type { HeldMod } from "./shortcuts.ts";

/** Long enough that Ctrl+C / Ctrl+V never flash it, short enough to feel asked. */
export const HOLD_MS = 500;

export type HoldState =
  | { phase: "idle" }
  | { phase: "armed"; mod: HeldMod }
  | { phase: "shown"; mod: HeldMod }
  | { phase: "spent" };

export const IDLE: HoldState = { phase: "idle" };

/** The slice of a key event the machine reads (fakeable in a node test). */
export interface HoldKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export type HoldEvent =
  | { type: "down"; e: HoldKey }
  | { type: "up"; e: HoldKey }
  | { type: "timer"; mod: HeldMod }
  | { type: "blur" };

/** Which modifier this key IS, or null for any other key. */
export function modOfKey(key: string): HeldMod | null {
  if (key === "Control") return "ctrl";
  if (key === "Meta" || key === "OS") return "meta";
  if (key === "Alt") return "alt";
  return null;
}

/** The modifier flags this press carries besides its own key's. */
function othersHeld(e: HoldKey, mod: HeldMod): boolean {
  return e.shiftKey
    || (mod !== "ctrl" && e.ctrlKey)
    || (mod !== "meta" && e.metaKey)
    || (mod !== "alt" && e.altKey);
}

/** One step. Same state back (by identity) when nothing changes. */
export function holdStep(s: HoldState, ev: HoldEvent): HoldState {
  switch (ev.type) {
    case "blur":
      return s.phase === "idle" ? s : IDLE;
    case "timer":
      return s.phase === "armed" && s.mod === ev.mod ? { phase: "shown", mod: ev.mod } : s;
    case "up": {
      // Any modifier coming up ends the hold. A plain key coming up while still
      // spent keeps it spent: the modifier is still down.
      if (modOfKey(ev.e.key)) return s.phase === "idle" ? s : IDLE;
      if (s.phase === "spent" && !ev.e.ctrlKey && !ev.e.metaKey && !ev.e.altKey) return IDLE;
      return s;
    }
    case "down": {
      const mod = modOfKey(ev.e.key);
      if (ev.e.isComposing) return s.phase === "idle" ? s : { phase: "spent" };
      if (!mod) return s.phase === "idle" ? s : { phase: "spent" };
      // The same modifier auto-repeating: the hold goes on.
      if ((s.phase === "armed" || s.phase === "shown") && s.mod === mod) return s;
      if (s.phase === "idle" && !ev.e.repeat && !othersHeld(ev.e, mod)) return { phase: "armed", mod };
      // A second modifier joined, or it started under another one: not a hold.
      return s.phase === "idle" ? s : { phase: "spent" };
    }
  }
}

// ── Is there a physical keyboard? ───────────────────────────────────────────

/** The slice of a keydown the detection reads. */
export interface SeenKey {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
}

/**
 * Did this keydown come from a hardware key? A soft keyboard sends keyCode 229
 * ("composition in progress") for letters, or no keydown at all; a hardware
 * key sends its real code. Only a printable key or a modifier counts — some
 * soft keyboards send a real Backspace or Enter.
 */
export function isHardwareKey(e: SeenKey): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  return e.key.length === 1 || modOfKey(e.key) != null;
}

/** A fine pointer (a mouse or trackpad) OR a hardware key seen this session. */
export function hasKeyboard(pointerFine: boolean, hardwareSeen: boolean): boolean {
  return pointerFine || hardwareSeen;
}
