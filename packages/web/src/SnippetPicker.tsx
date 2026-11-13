/**
 * The snippet popover, ONE copy for the compose bar and the sheets' own button
 * (`PromptComposer.tsx`). At the src root because both import it (a feature is not importable from there).
 * A tap on a snippet inserts it at once — one snippet stays ONE tap, the common case. The circle
 * at the row's end ticks it instead (its tap-order number shows there); once anything is ticked,
 * a tap anywhere on a row ticks or unticks, and `Insert n` — above the list — hands the ticked
 * ones over in tap order. Closing drops the ticks. The list shows the most recently inserted first
 * (this phone's own order, `LS.snippetRecent`; the synced list itself is never rewritten). What the caller does with them is its own APPEND (never an overwrite).
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Circle, Pencil, X } from "lucide-react";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { Empty } from "./Empty";
import { byRecent, insertLabel, noteRecent, tickedSnippets, toggleTick, type SnippetLike } from "./snippetPicks";
import { LS, lsJson, lsSetJson } from "./storage";

export function SnippetPicker({ list, starter, onInsert, onClose, onManage, keepFocus, emptyText }: {
  list: SnippetLike[];
  starter: boolean;
  onInsert: (picked: SnippetLike[]) => void;
  onClose: () => void;
  onManage?: () => void;
  /** The compose bar keeps the box focused through a tap (the keyboard stays up). */
  keepFocus?: (e: ReactPointerEvent) => void;
  emptyText: string;
}) {
  // Read once per open: the rows must not jump under a finger while the picker is up.
  const [recent] = useState<string[]>(() => { const v = lsJson<unknown>(LS.snippetRecent, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; });
  const shown = byRecent(list, recent);
  const insert = (picked: SnippetLike[]) => { lsSetJson(LS.snippetRecent, noteRecent(recent, picked.map((p) => p.id))); onInsert(picked); };
  const [order, setOrder] = useState<string[]>([]);
  const picked = tickedSnippets(list, order);
  return (
    <div className="snippet-pop">
      <div className="snippet-pop-head">
        <span>Snippets</span>
        {onManage && <Button onPointerDown={keepFocus} onClick={onManage} title="Manage snippets"><Pencil size={14} /> manage</Button>}
        <Button onPointerDown={keepFocus} onClick={onClose} title="Close"><X size={14} /></Button>
      </div>
      {/* ONE fixed-height slot holds the hint or the Insert button, so the rows never move under a
          finger on the first tick (screen-review 2026-11-12). */}
      {list.length > 0 && (
        <div className="snippet-pop-act">
          {picked.length > 0
            ? <Button variant="primary" onPointerDown={keepFocus} onClick={() => insert(picked)}
                title="Add the ticked snippets to the draft, in the order you tapped them">{insertLabel(picked.length)}</Button>
            : <Hint className="snippet-pop-note">{starter
                ? "Starter snippets: tap one to insert, circles combine; edit in manage."
                : "Tap one to insert it, or the circles to combine several."}</Hint>}
        </div>
      )}
      <div className="snippet-pop-list">
        {list.length === 0 && <Empty>{emptyText}</Empty>}
        {shown.map((s) => {
          const n = order.indexOf(s.id) + 1;
          const tick = () => setOrder((o) => toggleTick(o, s.id));
          return (
            <div key={s.id} className={`snippet-pop-row${n ? " on" : ""}`}>
              <button type="button" className="snippet-pop-item" onPointerDown={keepFocus} title={s.text}
                onClick={() => (order.length ? tick() : insert([s]))}>
                <span className="snippet-pop-title">{s.title}</span>
                <span className="snippet-pop-preview">{s.text.replace(/\s+/g, " ").trim()}</span>
              </button>
              <button type="button" className="snippet-pop-tick" aria-pressed={n > 0} onPointerDown={keepFocus} onClick={tick}
                aria-label={n ? `Ticked ${n} — tap to untick ${s.title}` : `Tick ${s.title} to combine it with others`}>
                {n ? <span className="snippet-pop-n">{n}</span> : <Circle size={20} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
