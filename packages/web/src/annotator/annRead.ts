/**
 * The words inside a highlight, box or circle: typed by hand, or read ON THE PHONE by an enabled
 * text-in-marks extension (`annAutoRead.ts`, R-images-015). Still never the desktop or a cloud
 * model (2026-10-18, R-images-012) — with no such extension, nothing reads a mark and the agent
 * reads the picture itself. Typed words always win: once the person types or drops a mark's
 * words (`readBy: "hand"`), no reader touches them again.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); `ImageAnnotator.tsx` composes it.
 */

import type { AnnCtx, Shape } from "./annTypes";

export function readActions(c: AnnCtx) {
  const { setShapes, readTextRef, editRead, setEditRead, readDraft, setReadDraft, readInputRef } = c;

  /** Set fields on one mark by its id. Never by index — see `Shape.id`. */
  function patchShape(id: number, patch: Partial<Shape>) {
    setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  /** Supply (or correct) a mark's words by hand. */
  function startEditRead(s: Shape) {
    setEditRead(s.id);
    setReadDraft(s.read ?? "");
    requestAnimationFrame(() => readInputRef.current?.focus());
  }
  function commitRead() {
    const id = editRead;
    const t = readDraft.trim();
    setEditRead(null);
    setReadDraft("");
    readInputRef.current?.blur();
    if (id == null) return;
    if (t) readTextRef.current.set(id, t);
    else readTextRef.current.delete(id);
    patchShape(id, { read: t || undefined, readErr: t ? undefined : "no words on this mark", readBy: "hand", reading: false });
  }

  /** Keep the band, drop the sentence — words beside the point are noise in the prompt. */
  function dropRead(s: Shape) {
    readTextRef.current.delete(s.id);
    patchShape(s.id, { read: undefined, readErr: "words dropped", readBy: "hand", reading: false });
  }

  return { patchShape, startEditRead, commitRead, dropRead };
}
