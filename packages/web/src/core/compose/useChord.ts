/**
 * Sticky modifiers — Ctrl / Alt / Shift on the key row, combined with the next
 * key (`shared/chord.ts` is the one encoding).
 *
 * A phone keyboard has no Ctrl, and claude binds most of what it does to one
 * (`ctrl+o` transcript, `ctrl+t` todos, `meta+p` model…). So a modifier is a
 * key you TAP, the way a terminal app's extra-keys row does it: one tap arms it
 * for the next key, a second tap locks it, a third lets go. The next key is
 * either one on the row (`Tab`, an arrow) or a letter typed on the on-screen
 * keyboard — while a modifier is armed the compose box is a key pipe for that
 * one key (`useCompose` widens `cliMode` by `armed`), so the letter never lands
 * in the draft, and the draft is kept exactly as CLI mode keeps it.
 *
 * The modifiers live in a REF as well as state: two input events can land
 * before a render, and the second must already see a one-shot modifier gone.
 */
import { useRef, useState } from "react";
import { chordBytes, chordName, hasMods, type ChordKey } from "@waterplane/shared";
import { ALL_OFF, afterKey, held, nextModState, typedKey, type ChordMod, type ModStates } from "./chordState.ts";
import { showToast } from "../../toast";
import { track } from "../../usage";

export type { ChordMod, ModState, ModStates } from "./chordState.ts";

export interface ChordApi {
  mods: ModStates;
  /** Some modifier is held — the next key goes with it. */
  armed: boolean;
  /** What is held, in the CLI's spelling (`ctrl+alt`), for the words around it. */
  heldName: string;
  tapMod(m: ChordMod): void;
  clear(): void;
  /** A key from the row: with modifiers held, the chord; else `plain`. */
  sendKey(key: ChordKey, plain: string): void;
  /** Bytes from the pipe: a one-shot modifier applies to the first character, a locked one to all. */
  sendTyped(bytes: string): void;
}

export function useChord(sendInput: (data: string) => void): ChordApi {
  const [mods, setModsState] = useState<ModStates>(ALL_OFF);
  const ref = useRef<ModStates>(ALL_OFF);
  const setMods = (s: ModStates) => { ref.current = s; setModsState(s); };

  function sendKey(key: ChordKey, plain: string) {
    const m = held(ref.current);
    if (!hasMods(m)) { sendInput(plain); return; }
    const r = chordBytes(m, key);
    if ("refused" in r) showToast(`${r.refused}. Nothing was sent.`);
    else { track("action:chord.send"); sendInput(r.bytes); }
    setMods(afterKey(ref.current));
  }

  const heldName = chordName(held(mods), "").replace(/\+$/, "");
  return {
    mods,
    armed: hasMods(held(mods)),
    heldName,
    tapMod(m) { setMods({ ...ref.current, [m]: nextModState(ref.current[m]) }); },
    clear() { setMods(ALL_OFF); },
    sendKey,
    sendTyped(bytes) {
      if (!bytes) return;
      if (!hasMods(held(ref.current))) { sendInput(bytes); return; }
      // Code points, not UTF-16 units: an emoji's first half is not a key.
      // A one-shot modifier takes the first; a LOCKED one takes every key it
      // is still held for (a pasted or autocorrected burst included).
      const chars = Array.from(bytes);
      let i = 0;
      while (i < chars.length && hasMods(held(ref.current))) { sendKey(typedKey(chars[i]), chars[i]); i++; }
      if (i < chars.length) sendInput(chars.slice(i).join(""));
    },
  };
}
