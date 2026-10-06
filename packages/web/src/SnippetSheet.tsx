import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Quote, RotateCcw, Trash2, X } from "lucide-react";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { SyncMark } from "./SyncMark";
import { LS } from "./storage";
import { seqId } from "./format";
import { ConfirmButton } from "./Confirm";
import { Empty } from "./Empty";

/** A saved reusable text snippet the compose box can append. */
export interface Snippet { id: string; title: string; text: string }

interface Props {
  snippets: Snippet[];
  onSave: (next: Snippet[]) => void; // persists the whole list (add/edit/delete/reorder)
  onClose: () => void;
  /** The same editor drives the fan-out presets — only the wording differs. */
  heading?: string;
  hint?: ReactNode;
  emptyText?: string;
  textPlaceholder?: string;
  /** Shown as a "defaults" button when the list ships with a built-in set. */
  onReset?: () => void;
  trackId?: string;
}

/** First non-empty line, as a fallback title for a snippet with none. */
function autoTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 40 ? line.slice(0, 40) + "…" : line || "untitled";
}

/**
 * List editor: add / edit / delete / reorder saved texts. Used for the compose
 * snippets and (with different wording) the fan-out presets — ONE implementation,
 * because the drag/reorder/edit behaviour is the fiddly part and two copies would
 * drift.
 * Reorder is drag-handle (touch-friendly, elementFromPoint) plus up/down arrows.
 */
export function SnippetSheet({
  snippets, onSave, onClose,
  heading = "Snippets",
  hint,
  emptyText = "No snippets yet. Tap “new” to add one.",
  textPlaceholder = "Snippet text…",
  onReset,
  trackId = "action:snippet.save",
}: Props) {
  const [editing, setEditing] = useState<Snippet | null>(null); // the row being edited (or a fresh draft)
  const [dragId, setDragId] = useState<string | null>(null);

  function move(id: string, dir: -1 | 1) {
    const i = snippets.findIndex((s) => s.id === id), j = i + dir;
    if (i === -1 || j < 0 || j >= snippets.length) return;
    const next = [...snippets];
    [next[i], next[j]] = [next[j], next[i]];
    onSave(next);
  }
  function remove(id: string) { onSave(snippets.filter((s) => s.id !== id)); }
  function upsert(s: Snippet) {
    const text = s.text.trim();
    if (!text) { setEditing(null); return; }
    const title = s.title.trim() || autoTitle(text);
    const clean = { ...s, title, text };
    onSave(snippets.some((x) => x.id === s.id)
      ? snippets.map((x) => (x.id === s.id ? clean : x))
      : [...snippets, clean]);
    setEditing(null);
  }

  /** Live drag-reorder: drop the dragged row into the slot under the pointer. */
  function dragOver(e: React.PointerEvent) {
    if (!dragId) return;
    const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-snid]");
    const overId = row?.getAttribute("data-snid");
    if (!overId || overId === dragId) return;
    const from = snippets.findIndex((s) => s.id === dragId), to = snippets.findIndex((s) => s.id === overId);
    if (from === -1 || to === -1) return;
    const next = [...snippets];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onSave(next);
  }

  // Back — the gesture as much as the arrow — closes this step, not the sheet.
  useBackStep(editing !== null, () => setEditing(null));
  if (editing)
    return <SnippetEditor draft={editing} textPlaceholder={textPlaceholder} trackId={trackId}
      onCancel={() => setEditing(null)} onSave={upsert} />;

  return (
    <div className="sheet">
      <SheetHead title={<>{heading}</>} onClose={onClose}>
        {onReset && (
          // Two taps: this throws away every edit to the shipped list.
          <ConfirmButton className="key" title="restore the shipped list"
            confirmTitle="tap again to throw away every edit and restore the shipped list"
            confirm={<><RotateCcw size={16} /> sure?</>}
            onConfirm={onReset}><RotateCcw size={16} /> defaults</ConfirmButton>
        )}
        <button className="key" onClick={() => setEditing({ id: seqId("sn"), title: "", text: "" })}><Plus size={16} /> new</button>
      </SheetHead>
      {/* Prompt templates and the header row are authored content: they follow
          the user across devices, so "is this anywhere but here?" is a question
          about them too. */}
      <SyncMark keys={[LS.snippets, LS.headerCmds]} thing="these templates" />
      <div className="form-hint">
        {hint ?? <>Tap the <Quote size={12} /> button by the compose box to pick a snippet and append it.</>}
        {" "}Drag the <GripVertical size={12} /> handle (or the arrows) to reorder.
      </div>
      <div
        className="list"
        style={{ touchAction: dragId ? "none" : undefined }}
        onPointerMove={dragOver}
        onPointerUp={() => setDragId(null)}
        onPointerCancel={() => setDragId(null)}
      >
        {snippets.map((s, i, arr) => (
          <div key={s.id} data-snid={s.id} className={`row ${dragId === s.id ? "dragging" : ""}`}>
            <button
              className="key drag-handle"
              title="drag to reorder"
              style={{ touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => { e.preventDefault(); setDragId(s.id); }}
            ><GripVertical size={16} /></button>
            <button className="row-title snippet-title" title={s.text} onClick={() => setEditing(s)}>
              {s.title || autoTitle(s.text)}
            </button>
            <button className="key" title="move up" disabled={i === 0} onClick={() => move(s.id, -1)}><ArrowUp size={16} /></button>
            <button className="key" title="move down" disabled={i === arr.length - 1} onClick={() => move(s.id, 1)}><ArrowDown size={16} /></button>
            <button className="key" title="edit" onClick={() => setEditing(s)}><Pencil size={16} /></button>
            <button className="key danger" title="delete" onClick={() => remove(s.id)}><Trash2 size={16} /></button>
          </div>
        ))}
        <Empty empty={snippets.length === 0}>{emptyText}</Empty>
      </div>
    </div>
  );
}

/** Add/edit form for a single entry. */
function SnippetEditor({ draft, onCancel, onSave, textPlaceholder, trackId }: {
  draft: Snippet;
  onCancel: () => void;
  onSave: (s: Snippet) => void;
  textPlaceholder: string;
  trackId: string;
}) {
  const [title, setTitle] = useState(draft.title);
  const [text, setText] = useState(draft.text);
  const textRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="sheet">
      <SheetHead title={<>{draft.title || draft.text ? "Edit" : "New"}</>} onClose={onCancel} />
      <div className="form">
        <input className="search" placeholder="Title (optional — first line is used otherwise)"
          value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="search" ref={textRef} rows={10} placeholder={textPlaceholder} autoFocus
          value={text} onChange={(e) => setText(e.target.value)} style={{ resize: "vertical", fontFamily: "inherit" }} />
      </div>
      <div className="sheet-actions">
        <button className="key" onClick={onCancel}><X size={16} /> cancel</button>
        <span className="spacer" />
        <button className="send" disabled={!text.trim()} onClick={() => { track(trackId); onSave({ ...draft, title, text }); }}>Save</button>
      </div>
    </div>
  );
}
