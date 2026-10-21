/**
 * Bookmarks on conversations (R-conversations-007) — what a bookmark may say.
 * The host keeps them per repo directory, keyed by conversation id, and stamps
 * them onto archive rows, `SessionInfo.bookmark` and `ClosedSession.bookmark`;
 * both ends read one through `cleanBookmark`, so a note is clipped by one rule.
 *
 * A bookmark changes nothing about the session: it is a way BACK to a
 * conversation among thousands, not a reason to keep the session open.
 */
import type { Bookmark } from "./wire/session.js";

/** A note, and a remembered tab name, are one line of at most this. */
export const BOOKMARK_NOTE_CAP = 160;

/** One line, collapsed whitespace, clipped with an ellipsis; empty ⇒ undefined. */
export function clipBookmarkText(v: unknown, cap = BOOKMARK_NOTE_CAP): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > cap ? `${t.slice(0, cap - 1).trimEnd()}…` : t;
}

/**
 * A bookmark read off disk or the wire. A missing or non-positive `at` drops
 * the WHOLE bookmark (`null`) — a row that cannot say when it was set is not
 * one somebody set; `note`/`name` are clipped to one line and dropped empty.
 */
export function cleanBookmark(raw: unknown): Bookmark | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  const out: Bookmark = { at: r.at };
  const note = clipBookmarkText(r.note);
  const name = clipBookmarkText(r.name);
  if (note) out.note = note;
  if (name) out.name = name;
  return out;
}

/**
 * Is `id` a bare conversation id — the jsonl basename the CLI writes, and the
 * only shape the host will turn into a path (`transcriptPath`)? The same rule
 * the archive's delete has always applied: no separators, no dots, ≤128 chars.
 */
export function isConversationId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}
