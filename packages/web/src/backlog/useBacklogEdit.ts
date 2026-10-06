/**
 * The inline editor's fields, and the two verbs that open and save it. A save
 * sends CHANGED fields only — an unchanged headline sent back would stamp
 * `hand` on a title the person merely looked at.
 */
import { useState } from "react";
import type { BacklogItem, ItemCategory } from "@waterplane/shared";
import type { BacklogProps } from "./backlogTypes";

export function useBacklogEdit(p: BacklogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editRepo, setEditRepo] = useState("");
  const [editTarget, setEditTarget] = useState("");
  /**
   * The machine's title, offered for editing — and **only where it is still the
   * machine's**.
   *
   * Pre-filled from `headline` when nobody has typed one (`headlineBy !==
   * "hand"`), because that is what a person is actually doing here: taking a
   * suggestion over, or correcting it. Saving is what makes it theirs — the
   * host stamps `hand` and no pass writes it again — and the hint under the
   * field says exactly that, because it is the one consequence of this save
   * that cannot be undone by another pass.
   */
  const [editHeadline, setEditHeadline] = useState("");
  const [editCategory, setEditCategory] = useState<ItemCategory | "">("");

  function beginEdit(it: BacklogItem) {
    setEditingId(it.id);
    setEditText(it.text);
    setEditLabel(it.label ?? "");
    setEditRepo(it.repoDir);
    setEditTarget(it.targetSessionId ?? "");
    // **Opened on whatever is stored, whoever wrote it.** The field is called
    // *Suggested title* because a suggestion is what is usually in it, but an
    // editor that opened EMPTY over a title already on the row would show a
    // person their own words missing — the `seedSheetDraft` failure, one form
    // along. What the author changes is the HINT under the field, not what is
    // in it.
    setEditHeadline(it.headline ?? "");
    setEditCategory(it.category ?? "");
  }
  function saveEdit(it: BacklogItem) {
    const trimmed = editText.trim();
    if (!trimmed) return;
    const patch: { text?: string; label?: string; repoDir?: string; targetSessionId?: string; headline?: string; category?: ItemCategory | "" } = {};
    if (trimmed !== it.text) patch.text = trimmed;
    if ((editLabel || undefined) !== it.label) patch.label = editLabel;
    // **Changed fields only**, and `""` is a VALUE here rather than an absence:
    // it clears the field and its author, which is what makes a row nameable
    // again. Sending an unchanged headline back would stamp `hand` on a title
    // the person merely looked at — and `hand` is the one author no pass may
    // overwrite, so a no-op save would quietly freeze a suggestion for ever.
    const headline = editHeadline.trim();
    if (headline !== (it.headline ?? "")) patch.headline = headline;
    if (editCategory !== (it.category ?? "")) patch.category = editCategory;
    if (it.status !== "running") {
      if (editRepo && editRepo !== it.repoDir) patch.repoDir = editRepo;
      // Empty string clears the target back to the repo default (host reads "").
      if ((editTarget || "") !== (it.targetSessionId ?? "")) patch.targetSessionId = editTarget;
    }
    if (Object.keys(patch).length > 0) p.verbs.onUpdate(it.id, patch);
    setEditingId(null);
  }
  return {
    editingId,
    setEditingId,
    editText,
    setEditText,
    editLabel,
    setEditLabel,
    editRepo,
    setEditRepo,
    editTarget,
    setEditTarget,
    editHeadline,
    setEditHeadline,
    editCategory,
    setEditCategory,
    beginEdit,
    saveEdit,
  };
}
