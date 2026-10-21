/**
 * Bookmarks on conversations (R-conversations-007) as DRAWN: the glyph, the
 * one-line note editor, and the open session's own toggle (a ☰ line / header
 * pin, `toolbar.ts`'s `bookmark`). The words and the cut are `bookmarkFacts.ts`.
 *
 * A bookmark goes over HTTP to the archive's route (`api.bookmarkSet`), never
 * through the send queue: it is not words for a session, and a receipt saying
 * "bookmarked" while the press waits for a tunnel would be a claim nobody
 * checked. So with the link down a tap SAYS it needs the desktop — never a
 * dimmed button (`Unavailable.tsx`'s rule).
 */
import { useState, type ReactNode } from "react";
import { Bookmark, BookmarkCheck, Check, Pencil, X } from "lucide-react";
import type { Bookmark as BookmarkT, RepoTarget, SessionInfo } from "@waterplane/shared";
import { BOOKMARK_NOTE_CAP } from "@waterplane/shared";
import { api } from "../../api";
import { showToast } from "../../toast";
import { tabLabel } from "../../sessionTabs";
import { Button } from "../../kit/Button";
import { ConfirmButton } from "../../Confirm";
import { bookmarkReceipt } from "./bookmarkFacts";

/** The two verbs, as every surface words them — never "keep". */
export const BOOKMARK_SET = "bookmark";
export const BOOKMARK_ON = "bookmarked";

/** Outline when off, the checked glyph when on — one icon per meaning. */
export const BookmarkIcon = ({ on, size }: { on: boolean; size: number }): ReactNode =>
  on ? <BookmarkCheck size={size} fill="currentColor" /> : <Bookmark size={size} />;

/**
 * One line, at most `BOOKMARK_NOTE_CAP`, seeded ONCE from the note it edits —
 * a later push of the same bookmark never writes over what is being typed
 * (CLAUDE.md: never overwrite typed words). Enter saves, Escape or × leaves.
 */
export function BookmarkNoteEdit({ initial, onSave, onCancel }: {
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [v, setV] = useState(initial);
  return (
    <span className="bm-edit">
      <input className="search grow" value={v} maxLength={BOOKMARK_NOTE_CAP} autoFocus
        placeholder="a note — why you will want it again" aria-label="bookmark note"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(v); else if (e.key === "Escape") onCancel(); }} />
      <button className="row-act" title="save the note" onClick={() => onSave(v)}><Check size={16} /></button>
      <button className="row-act" title="leave the note as it was" onClick={onCancel}><X size={16} /></button>
    </span>
  );
}

/** Set (or update) and remove, with the receipt as a toast either way. */
export async function setBookmark(repoId: string, convId: string, fields: { note?: string; name?: string }): Promise<BookmarkT | null> {
  const r = await api.bookmarkSet(repoId, convId, fields).catch(() => ({ ok: false, error: "the desktop did not answer", bookmark: undefined }));
  if (!r.ok || !r.bookmark) { showToast(bookmarkReceipt(true, r.error ?? "?")); return null; }
  return r.bookmark;
}
export async function removeBookmark(repoId: string, convId: string): Promise<boolean> {
  const r = await api.bookmarkRemove(repoId, convId).catch(() => ({ ok: false, error: "the desktop did not answer" }));
  showToast(bookmarkReceipt(false, r.ok ? undefined : r.error ?? "?"));
  return r.ok;
}

/** Why the open session cannot be bookmarked right now, as a sentence; null = it can. */
export function sessionBookmarkBlock(active: SessionInfo, repo: RepoTarget | null, online: boolean): string | null {
  if (!online) return "Bookmarking needs the desktop — the link is down.";
  if (!active.claudeSessionId) return "Nothing to bookmark yet — this session has no conversation until its first turn.";
  if (!repo) return "Bookmarking needs this session's repo, and it is not in the list.";
  return null;
}

/**
 * The open session's bookmark: a ☰ line (labelled, with the note under it and
 * its editor) or a header pin (`compact`: the glyph alone, a tap toggles). The
 * name it remembers is the tab's (`tabLabel`), so the archive row still has
 * one after the closed-row shortlist forgets it.
 */
export function SessionBookmark({ active, repo, online, compact, dismiss }: {
  active: SessionInfo;
  repo: RepoTarget | null;
  online: boolean;
  compact: boolean;
  dismiss: () => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const b = active.bookmark;
  const on = !!b;
  const block = sessionBookmarkBlock(active, repo, online);
  const title = block ?? (on ? `${BOOKMARK_ON}${b?.note ? ` — ${b.note}` : ""} · tap to remove` : "bookmark this conversation — the archive finds it again after it is closed");
  const set = async (fields: { note?: string; name?: string }) => {
    if (block) { showToast(block); return; }
    const got = await setBookmark(repo!.id, active.claudeSessionId!, fields);
    if (got) showToast(on ? "bookmark note saved" : bookmarkReceipt(true));
  };
  const remove = () => { if (block) { showToast(block); return; } void removeBookmark(repo!.id, active.claudeSessionId!); };
  // Removing a bookmark that carries a note deletes words somebody typed, so
  // that one tap is armed (`ConfirmButton`, disarms itself); without a note a
  // tap is a plain toggle.
  const toggle = on && b?.note
    ? (
      <ConfirmButton key="bookmark" className="key bm-btn on" title={title}
        confirmTitle="tap again to remove the bookmark and its note"
        confirm={<><BookmarkIcon on size={16} />{!compact && " remove, with its note?"}</>}
        onConfirm={() => { dismiss(); remove(); }}>
        <BookmarkIcon on size={16} />{!compact && ` ${BOOKMARK_ON}`}
      </ConfirmButton>
    )
    : (
      <Button key="bookmark" className={`bm-btn${on ? " on" : ""}`} data-hint="session.bookmark" aria-pressed={on} title={title}
        onClick={() => { dismiss(); if (on) remove(); else void set({ name: tabLabel(active, repo?.repoName ?? "") }); }}>
        <BookmarkIcon on={on} size={16} />{!compact && ` ${on ? BOOKMARK_ON : BOOKMARK_SET}`}
      </Button>
    );
  if (compact || !on) return toggle;
  return (
    <>
      {toggle}
      {editing
        ? <BookmarkNoteEdit initial={b?.note ?? ""} onCancel={() => setEditing(false)}
            onSave={(note) => { setEditing(false); void set({ note }); }} />
        : (
          <Button key="bookmark-note" className="bm-note" title="edit the bookmark's one-line note"
            onClick={() => { if (block) showToast(block); else setEditing(true); }}>
            <Pencil size={16} /> {b?.note ? b.note : "add a note"}
          </Button>
        )}
    </>
  );
}
