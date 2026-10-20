/**
 * The key row's `Keys` list: claude's own shortcuts (`cliShortcuts.ts`), one
 * tap each, over the bottom of the grid — an overlay with its own scroll, so
 * the PTY is never resized to make room (a resize repaints the whole screen).
 * A tap sends through `sendInput`, the row's own raw path, closes the list and
 * says what went.
 */
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { CLI_SHORTCUTS, CLI_SHORTCUTS_VERSION, shortcutWrites } from "./cliShortcuts";
import { keepFocus } from "../compose/ComposeBar";

const ICON = 16;

/** Between the two Esc of `esc esc` — one write would read as alt+esc. */
const SEQ_GAP_MS = 150;

export function KeysPop({ sendInput, onClose }: { sendInput: (data: string) => void; onClose: () => void }): ReactNode {
  // Escape closes the list (a hardware keyboard); capture, so the terminal
  // does not also get it as a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  function press(i: number) {
    const s = CLI_SHORTCUTS[i];
    const writes = shortcutWrites(s);
    if (!writes) { showToast(`${s.name} has no terminal bytes. Nothing was sent.`); return; }
    track("action:keys.send");
    writes.forEach((w, k) => (k === 0 ? sendInput(w) : window.setTimeout(() => sendInput(w), k * SEQ_GAP_MS)));
    onClose();
    showToast(`sent ${s.name} — ${s.does}`);
  }
  return (
    <div className="keys-pop" role="dialog" aria-label="claude's shortcuts">
      <div className="keys-pop-head">
        <span className="muted">claude {CLI_SHORTCUTS_VERSION}'s default keys — a remapped keybindings.json has others</span>
        <button className="key" onPointerDown={keepFocus} onClick={onClose} title="close the list" aria-label="close the list"><X size={ICON} /></button>
      </div>
      <div className="keys-pop-list">
        {CLI_SHORTCUTS.map((s, i) => (
          <button key={s.name} className="keys-pop-row" onPointerDown={keepFocus} onClick={() => press(i)}
            title={`${s.name} — ${s.does}`}>
            <span className="keys-pop-key">{s.name}</span>
            <span className="keys-pop-does">{s.does}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
