/**
 * The raw-key row under the terminal: the keys the CLI names on screen
 * (`SessionInfo.keyHints`), the sticky modifiers (`useChord`), Esc / Tab / the
 * arrows / ^C / Return, the `Keys` list of claude's shortcuts (`KeysPop.tsx`,
 * drawn over the grid by `TermArea`) and the CLI-mode toggle. Every key goes
 * through the compose core's `sendInput` (raw, undurable) — no new send path.
 *
 * Lifted out of `TermArea.tsx` unchanged in behaviour; the caller decides
 * whether the row is drawn (not for a pending session, not in the reader).
 */
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Keyboard, Terminal as TerminalIcon } from "lucide-react";
import { keyHintBytes, keyHintLabel, type ChordKey, type SessionInfo } from "@waterplane/shared";
import type { ComposeApi } from "../compose/useCompose";
import type { ChordMod, ModState } from "../compose/chordState.ts";
import { keepFocus } from "../compose/ComposeBar";
import { Button } from "../../kit/Button";
import { interruptWho, runsClaudeTui, type BackendList } from "../../backendCaps";

const ICON = 16;

/** Actively blur the compose box so a tap can't re-summon the on-screen keyboard.
 * preventDefault keeps the tapped button from taking focus; the blur dismisses
 * (and keeps dismissed) the keyboard for TUI-navigation keys. */
const blurCompose = (e: ReactPointerEvent) => {
  e.preventDefault();
  (document.activeElement as HTMLElement | null)?.blur();
};

// `nav` keys (arrows) are TUI navigation used while NOT typing. They must not
// hold compose focus — on Android a still-focused (but keyboard-dismissed)
// textarea re-summons the on-screen keyboard on any focus-preserving tap. So
// arrows blur the compose box instead; the rest keep focus for mid-typing use.
// `title` is what a long press explains (`hints.ts` falls back to it) and the name a screen
// reader says: four of these are bare glyphs, which explained nothing.
// `key` is the name a held modifier combines with (`useChord`, `shared/chord.ts`).
// No `key` (^C): it IS a chord already, sent as is, and a held modifier waits for the next key.
const specialKeys = (who: string): { label: ReactNode; title: string; data: string; key?: ChordKey; nav?: boolean }[] => [
  { label: "Esc", title: `Esc — close a menu or interrupt ${who}`, data: "\x1b", key: "esc" }, { label: "Tab", title: "Tab — complete", data: "\t", key: "tab" },
  { label: <ArrowUp size={ICON} />, title: "up — move the selection in a box", data: "\x1b[A", key: "up", nav: true },
  { label: <ArrowDown size={ICON} />, title: "down — move the selection in a box", data: "\x1b[B", key: "down", nav: true },
  { label: <ArrowLeft size={ICON} />, title: "left", data: "\x1b[D", key: "left", nav: true }, { label: <ArrowRight size={ICON} />, title: "right", data: "\x1b[C", key: "right", nav: true },
  { label: "^C", title: "Ctrl-C — cancel", data: "\x03" }, { label: <CornerDownLeft size={ICON} />, title: "Return — confirm the selection", data: "\r", key: "enter" },
];

/** The sticky modifier keys, in the CLI's order (`ctrl+alt+shift`). */
const MOD_KEYS: { mod: ChordMod; label: string }[] = [
  { mod: "ctrl", label: "Ctrl" }, { mod: "alt", label: "Alt" }, { mod: "shift", label: "Shift" },
];
const MOD_WORD: Record<ModState, string> = { off: "", once: "next", lock: "lock" };
const modTitle = (label: string, s: ModState) =>
  s === "off" ? `${label} — tap, then a key (on this row or typed): it goes with ${label}. Tap twice to lock.`
  : s === "once" ? `${label} is held for the next key. Tap again to lock it, a third time to let go.`
  : `${label} is locked for every key until you tap it again.`;

export function KeyRow({ active, backends, compose, keysOpen, setKeysOpen }: {
  active: Pick<SessionInfo, "keyHints" | "backend">;
  /** Which backend the session runs decides whose shortcut list the Keys button offers. */
  backends: BackendList;
  compose: Pick<ComposeApi, "chord" | "tapChordMod" | "cliMode" | "sendInput" | "toggleCliMode">;
  keysOpen: boolean;
  setKeysOpen(f: (open: boolean) => boolean): void;
}): ReactNode {
  const { cliMode, sendInput, toggleCliMode } = compose;
  // A tapped one-shot hint (a picker's `s`, a ctrl key) usually closes what
  // named it, but the host re-reads only on its quiet tick — a second tap in
  // that window would type the letter into the composer. So a tapped chip
  // hides until the hints the host sends change. shift+tab cycles: it stays.
  const hintKey = JSON.stringify(active.keyHints ?? []);
  const [spentHints, setSpentHints] = useState<{ of: string; keys: string[] }>({ of: "", keys: [] });
  const spent = spentHints.of === hintKey ? spentHints.keys : [];
  return (
    <div className="keys">
      {/* The arrows normally BLUR the box (a focused-but-dismissed textarea
          re-summons the keyboard on any focus-preserving tap). In CLI mode the
          box IS the keyboard — dismissing it to press an arrow would mean
          re-opening it for the next letter. */}
      {/* The keys the CLI names on screen right now that this row lacks —
          `(shift+tab to cycle)`, a picker's `s for this session only`
          (`SessionInfo.keyHints`, read by the host). First, because they are
          what the screen is asking for; gone when the hint is. Raw, like
          the rest of the row. */}
      {(active.keyHints ?? []).map((h) => {
        const bytes = keyHintBytes(h.key);
        if (!bytes || spent.includes(h.key)) return null;
        const title = `${h.key} — ${h.verb} (the CLI names this key on screen now)`;
        return (
          <Button key={`hint:${h.key}`} className="key-hint" title={title} aria-label={title}
            onPointerDown={keepFocus} onClick={() => {
              // A chip is a whole key already: held modifiers let go rather
              // than waiting to land on whatever is pressed next.
              compose.chord.clear();
              sendInput(bytes);
              if (h.key !== "shift+tab") setSpentHints({ of: hintKey, keys: [...spent, h.key] });
            }}>
            {keyHintLabel(h.key)} <span className="key-hint-verb">{h.verb}</span>
          </Button>
        );
      })}
      {specialKeys(interruptWho(backends, active.backend)).map((k, i) => (
        <Button key={i} title={k.title} aria-label={k.title}
          onPointerDown={k.nav && !cliMode ? blurCompose : keepFocus}
          onClick={() => (k.key ? compose.chord.sendKey(k.key, k.data) : sendInput(k.data))}>{k.label}</Button>
      ))}
      {/* Sticky modifiers: held for the next key — one of these, or a
          letter typed on the keyboard, which the compose box then pipes
          (`useChord`). Worded while held, so a held key is never a guess —
          on a second line, so the word never widens the key and moves the
          row under the finger. After the fixed keys: Esc … ^C stay on the
          first screen of a 390 px phone. */}
      {MOD_KEYS.map(({ mod, label }) => {
        const st = compose.chord.mods[mod];
        return (
          <Button key={mod} className={`mod-key${st !== "off" ? " active" : ""}`} title={modTitle(label, st)} aria-label={modTitle(label, st)}
            aria-pressed={st !== "off"} onPointerDown={keepFocus} onClick={() => compose.tapChordMod(mod)}>
            <span>{label}</span>{st !== "off" && <span className="mod-state">{MOD_WORD[st]}</span>}
          </Button>
        );
      })}
      {/* claude's own list, only where the session runs claude's TUI (a cap test, `runsClaudeTui`):
          offered in a Copilot or shell session it would type claude's keys at another program. */}
      {runsClaudeTui(backends, active.backend) && (
      <Button className={keysOpen ? "active" : undefined} onPointerDown={keepFocus} onClick={() => setKeysOpen((o) => !o)}
        aria-expanded={keysOpen} title="claude's own shortcuts (ctrl+o transcript, ctrl+t todos, alt+p model…) — one tap each"
        aria-label="claude's shortcuts"><Keyboard size={ICON} /> Keys</Button>
      )}
      {/* Lives at the END of this row on purpose: the row IS raw input, and
          CLI mode is the same thing with the alphabet added. */}
      <Button
        className={`cli-key ${cliMode ? "active" : ""}`}
        data-hint="compose.cli"
        onPointerDown={keepFocus}
        onClick={toggleCliMode}
        title={cliMode
          ? "CLI mode is on — every key you type goes straight to the session. Tap to go back to composing (queued, confirmed sends)."
          : "CLI mode — type directly at the CLI instead of composing a message: keystrokes go through as you type, nothing is queued or echo-checked."}
      ><TerminalIcon size={ICON} /> CLI</Button>
    </div>
  );
}
