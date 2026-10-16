/**
 * The key row under the live desktop: the terminal key row's look (`.keys` / `.key`, the same
 * order — Esc, Tab, the arrows, ^C, Return) plus Backspace, the sticky ⌘ ⌥ ⌃ ⇧ and the way into
 * typing. The terminal's own row (`core/session/TermArea.tsx` `SPECIAL_KEYS`) is not exported and
 * types PTY bytes, so this row is built from the same pieces rather than borrowed.
 *
 * A held modifier is drawn lit and SAYS what it does in its title; it applies to the next key (or
 * one typed character) and clears.
 */
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Keyboard } from "lucide-react";
import type { Modifier } from "../shared/wire.mts";
import { MOD_GLYPH, MOD_NAME, MOD_ORDER, ROW_KEYS } from "./keys.ts";
import type { DesktopController } from "./controller.ts";

const ICON = 16;
const GLYPH: Record<string, ReactNode> = {
  up: <ArrowUp size={ICON} />, down: <ArrowDown size={ICON} />, left: <ArrowLeft size={ICON} />, right: <ArrowRight size={ICON} />,
  ret: <CornerDownLeft size={ICON} />, bksp: <Delete size={ICON} />,
};
const ROW = { touchAction: "pan-x", flex: "0 0 auto" } as const;

export function KeyRow({ ctl, held, typing, onType }: { ctl: DesktopController; held: readonly Modifier[]; typing: boolean; onType(): void }) {
  return (
    <div className="keys" style={ROW}>
      <button className={`key${typing ? " active" : ""}`} title={typing ? "close the typing box (what you wrote stays)" : "type words on the desktop"}
        aria-label="type" onClick={onType}><Keyboard size={ICON} /> type</button>
      {MOD_ORDER.map((m) => {
        const on = held.includes(m);
        return (
          <button key={m} className={`key${on ? " active" : ""}`} aria-pressed={on}
            title={on ? `${MOD_NAME[m]} is held for the next key — tap to let go` : `${MOD_NAME[m]} — held for the next key, then released`}
            onClick={() => ctl.toggleMod(m)}>{MOD_GLYPH[m]}</button>
        );
      })}
      {ROW_KEYS.map((k) => (
        <button key={k.id} className="key" title={k.title} aria-label={k.title} onClick={() => ctl.pressRowKey(k)}>{GLYPH[k.id] ?? k.label}</button>
      ))}
    </div>
  );
}
