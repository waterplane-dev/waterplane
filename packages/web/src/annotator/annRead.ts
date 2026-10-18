/**
 * The words on a highlighted band, typed by hand. Nothing reads them off the
 * picture (2026-10-18: no desktop or cloud call for this) — the agent reads the
 * image itself, and the band says where to look.
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

  /** Supply (or correct) a band's words by hand. */
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
    patchShape(id, { read: t || undefined, readErr: t ? undefined : "no words on this mark" });
  }

  /** Keep the band, drop the sentence — words beside the point are noise in the prompt. */
  function dropRead(s: Shape) {
    readTextRef.current.delete(s.id);
    patchShape(s.id, { read: undefined, readErr: "words dropped" });
  }

  return { patchShape, startEditRead, commitRead, dropRead };
}
