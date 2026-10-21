import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, Pencil, Send, Trash2, X } from "lucide-react";
import { ConfirmButton } from "./Confirm";
import { Markdown, type FileRefCtx } from "./Markdown";
import { DictateButton, PromptComposer } from "./PromptComposer";
import { LS, lsJson, lsSetJson } from "./storage";
import { track } from "./usage";
import {
  lineSpanText, nextSel, orderRemarks, relocate, remarksAt, remarksBlock, sliceLines,
  type Remark, type Sel,
} from "./fileRemarks";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

/**
 * Review mode of the file viewer: mark lines, say what should change, send
 * every remark on the file to the chat as one message.
 *
 * The image annotator's round trip for a file somebody is READING — a README
 * that does not say what it should. Rules in `fileRemarks.ts`; the ones that
 * live here are about the words:
 *
 *  - **Remarks and the comment being written are kept on the phone**, per repo
 *    and path (`LS.fileRemarks`, kept by the hard reset): closing the file, the
 *    sheet or the app halfway down a long README loses nothing.
 *  - **A remark follows its lines** when the file changed since (`relocate`),
 *    and says so when it cannot find them — never re-pointed at whatever now
 *    sits on those line numbers.
 *  - **Typed words are never discarded on one tap**: cancelling a written
 *    comment and deleting a remark both ask once (`ConfirmButton`).
 *  - **The rendered view picks BLOCKS, the source view picks LINES**, and both
 *    name source lines, because that is what the agent can open.
 */

interface Stored {
  remarks: Remark[];
  /** The comment being written, and what it is about. */
  draft?: { from: number; to: number; text: string; editId?: string };
}

const storeKey = (repoId: string, path: string) => `${repoId}\n${path}`;

function readStored(repoId: string, path: string): Stored {
  const all = lsJson<Record<string, Stored>>(LS.fileRemarks, {});
  const s = all[storeKey(repoId, path)];
  return s && Array.isArray(s.remarks) ? s : { remarks: [] };
}

function writeStored(repoId: string, path: string, s: Stored): void {
  const all = lsJson<Record<string, Stored>>(LS.fileRemarks, {});
  const k = storeKey(repoId, path);
  if (!s.remarks.length && !s.draft?.text.trim()) delete all[k];
  else all[k] = s;
  lsSetJson(LS.fileRemarks, all);
}

/** How many remarks wait on this file — the review button's count. */
export function storedRemarkCount(repoId: string, path: string): number {
  return readStored(repoId, path).remarks.length;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Props {
  repoId: string;
  path: string;
  /** The file as it reads ON DISK — what the line numbers mean. */
  body: string;
  /** Draw it formatted (markdown, not switched to source). */
  rendered: boolean;
  files?: FileRefCtx;
  onCopy: (text: string) => void;
  /** Hand the message to the chat. False = it did not go, keep everything. */
  onSend: (text: string) => boolean;
  /** Remarks were added or removed — the header's count. */
  onCount?: (n: number) => void;
}

export function FileReview({ repoId, path, body, rendered, files, onCopy, onSend, onCount }: Props) {
  const lines = useMemo(() => body.split("\n"), [body]);
  const init = useRef<Stored | null>(null);
  init.current ??= readStored(repoId, path);
  const [remarks, setRemarks] = useState<Remark[]>(() => relocate(init.current!.remarks, lines));
  const d = init.current.draft;
  const [sel, setSel] = useState<Sel | null>(d ? { from: d.from, to: d.to, open: false } : null);
  const [text, setText] = useState(d?.text ?? "");
  const [editId, setEditId] = useState<string | undefined>(d?.editId);
  const [listOpen, setListOpen] = useState(false);

  // The file moved on under an open review (a reload after an agent's edit).
  useEffect(() => { setRemarks((rs) => relocate(rs, lines)); }, [lines]);

  // Every change is written through: these are typed words.
  useEffect(() => {
    writeStored(repoId, path, {
      remarks,
      draft: sel && (text.trim() || editId) ? { from: sel.from, to: sel.to, text, editId } : undefined,
    });
    onCount?.(remarks.length);
  }, [repoId, path, remarks, sel, text, editId, onCount]);

  const ordered = useMemo(() => orderRemarks(remarks), [remarks]);
  const inSel = (a: number, b: number) => !!sel && a <= sel.to && b >= sel.from;

  const pick = (a: number, b: number) => {
    setSel((s) => nextSel(s, a, b));
  };
  const onTapSrc = (e: MouseEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-l]");
    if (!row) return;
    const n = Number(row.dataset.l);
    if (n) pick(n, n);
  };
  // Capture phase: in review mode a tap on a rendered block MARKS it — a link
  // inside it, or a code block's copy button, must not also fire.
  const onTapMd = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-l0]");
    if (!el || !e.currentTarget.contains(el)) return;
    e.preventDefault(); e.stopPropagation();
    pick(Number(el.dataset.l0), Number(el.dataset.l1));
  };

  const reset = () => { setSel(null); setText(""); setEditId(undefined); };
  const commit = () => {
    if (!sel || !text.trim()) return;
    const quote = sliceLines(lines, sel.from, sel.to);
    track(editId ? "action:files.remark.edit" : "action:files.remark");
    setRemarks((rs) => editId
      ? rs.map((r) => (r.id === editId ? { ...r, from: sel.from, to: sel.to, quote, text, moved: false } : r))
      : [...rs, { id: newId(), from: sel.from, to: sel.to, quote, text }]);
    reset();
  };
  const edit = (r: Remark) => {
    setSel({ from: r.from, to: r.to, open: false });
    setText(r.text); setEditId(r.id); setListOpen(false);
  };
  const drop = (id: string) => {
    setRemarks((rs) => rs.filter((r) => r.id !== id));
    if (editId === id) reset();
  };
  const send = () => {
    const block = remarksBlock(path, remarks);
    if (!block) return;
    track("action:files.remarks.send");
    if (!onSend(block)) return;
    // Handed over: the words are in the prompt now, which is their next copy.
    setRemarks([]); reset();
  };

  // Text-box plumbing for the one dictation chrome (`DictateButton`): it
  // reads a ref, because a recording outlives the render that started it.
  const promptsRef = useRef<string[]>([text]);
  promptsRef.current = [text];

  const editing = editId ? ordered.findIndex((r) => r.id === editId) + 1 : 0;
  const startsAt = useMemo(() => {
    const m = new Map<number, number[]>();
    ordered.forEach((r, i) => m.set(r.from, [...(m.get(r.from) ?? []), i + 1]));
    return m;
  }, [ordered]);

  const span = sel ? lineSpanText(sel.from, sel.to) : "";
  const hint = !sel
    ? `Tap a ${rendered ? "paragraph" : "line"} to mark it — then tap another to mark everything between.`
    : `${span[0].toUpperCase()}${span.slice(1)} marked${sel.open ? " — tap another to stretch the mark, or say what should change." : "."}`;

  return (
    <>
      <Hint className="rv-hint">{hint}</Hint>

      {rendered ? (
        <div className="viewer-doc-body rv-md" onClickCapture={onTapMd}>
          <Markdown src={body} q="" onCopy={onCopy} files={files} lineTag={(a, b) => {
            // The number sits on the block a remark STARTS in, as it sits on
            // its first line in the source view; the rest carry the bar.
            const starts = ordered.flatMap((r, i) => (r.from >= a && r.from <= b ? [i + 1] : []));
            const cls = [inSel(a, b) ? "rv-sel" : "", remarksAt(ordered, a, b).length ? "rv-marked" : ""].filter(Boolean).join(" ");
            return { className: cls || undefined, badge: starts.length ? starts.join(",") : undefined };
          }} />
        </div>
      ) : (
        <div className="rv-src mono" onClick={onTapSrc}>
          {lines.map((l, i) => {
            const n = i + 1;
            const marked = remarksAt(ordered, n).length > 0;
            const badge = startsAt.get(n);
            return (
              <div key={n} data-l={n} className={`rv-line${inSel(n, n) ? " rv-sel" : ""}${marked ? " rv-marked" : ""}`}>
                <span className="rv-no">{badge ? <b className="rv-badge">{badge.join(",")}</b> : n}</span>
                <span className="rv-txt">{l || " "}</span>
              </div>
            );
          })}
        </div>
      )}

      {sel ? (
        <div className="rv-compose">
          <div className="rv-compose-head">
            <MessageSquarePlus size={16} />
            <span className="grow">{editing ? `Remark ${editing} · ` : ""}{lineSpanText(sel.from, sel.to)}</span>
            {text.trim()
              ? <ConfirmButton title="cancel this remark" confirm="discard words?" onConfirm={reset}><X size={16} /></ConfirmButton>
              : <Button title="cancel" onClick={reset}><X size={16} /></Button>}
          </div>
          <PromptComposer inline rows={2} prompts={[text]} onChange={(next) => setText(next[0] ?? "")}
            placeholder="What should change here? Type or dictate." />
          <div className="sheet-actions rv-compose-acts">
            <DictateButton prompts={promptsRef} onPrompts={(next) => setText(next[0] ?? "")}
              boxKey={`remark:${repoId}:${path}`} />
            <span className="spacer" />
            {text.trim()
              ? <button className="send" onClick={commit}>{editId ? "Save remark" : "Add remark"}</button>
              : <Hint as="span" className="rv-why">Say what should change to add it.</Hint>}
          </div>
        </div>
      ) : remarks.length > 0 && (
        <div className="rv-compose">
          <div className="sheet-actions rv-compose-acts">
            <Button onClick={() => setListOpen((v) => !v)}>
              {listOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {remarks.length} remark{remarks.length === 1 ? "" : "s"}
            </Button>
            <span className="spacer" />
            <button className="send" onClick={send}>
              <Send size={16} /> Send {remarks.length === 1 ? "remark" : `${remarks.length} remarks`} to the chat
            </button>
          </div>
          {listOpen && (
            <div className="rv-list">
              {ordered.map((r, i) => (
                <div key={r.id} className="rv-item">
                  <b className="rv-badge">{i + 1}</b>
                  <div className="grow">
                    <div className="rv-item-where">{lineSpanText(r.from, r.to)}{r.moved ? " · these lines have changed since" : ""}</div>
                    <div className="rv-item-text">{r.text}</div>
                  </div>
                  <Button title="edit this remark" onClick={() => edit(r)}><Pencil size={16} /></Button>
                  <ConfirmButton title="delete this remark" confirm="delete?" onConfirm={() => drop(r.id)}><Trash2 size={16} /></ConfirmButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
