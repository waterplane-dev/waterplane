/**
 * Bookmarks on conversations (R-conversations-007) — the pure half of what the
 * phone draws: an archive row's two lines, the "Bookmarks (n)" control and the
 * cut it opens, and an in-place patch after a set/remove. No React, node-tested
 * (`bookmarkFacts.test.mjs`).
 *
 * A bookmark is "I will want to look at this again": not the star (waiting on
 * it), not the follow-up flag (a reading list), and not the close sheet's per-
 * row keep (do not close). Never worded as "keep".
 */
import type { ArchivedConversation, ArchiveListing, Bookmark } from "@waterplane/shared";

/**
 * An archive row's title and the line under it. The tab name is the title when
 * there is one — it is what the person called the session while it was open —
 * with the first prompt beneath; one line alone when they say the same thing or
 * only one is known. `null` title = nothing typed and nothing named.
 */
export function archiveRowLines(row: Pick<ArchivedConversation, "title" | "name" | "bookmark">): { title: string | null; sub: string | null } {
  const name = (row.name || row.bookmark?.name || "").trim();
  const prompt = (row.title || "").trim();
  if (name && prompt && name.toLowerCase() !== prompt.toLowerCase()) return { title: name, sub: prompt };
  return { title: name || prompt || null, sub: null };
}

/**
 * What the "Bookmarks" control may say, read off ONE listing: the host's
 * `bookmarked=1` answer, whose `total` is both the number on the control and
 * the length of the cut it opens — never a second count of the same thing.
 *
 * - `loading` — not read yet: the control is drawn without a number.
 * - `old-host` — the desktop answered WITHOUT `bookmarked`, i.e. it ignored the
 *   filter: its rows are every conversation, so they must not be called
 *   bookmarks; the control says the desktop needs an update.
 * - `count` — `n` bookmarked conversations (matching the search, if any).
 */
export type BookmarkCount = { kind: "loading" } | { kind: "old-host" } | { kind: "count"; n: number };

export function bookmarkCount(listing: ArchiveListing | null | undefined): BookmarkCount {
  if (!listing) return { kind: "loading" };
  if (listing.bookmarked !== true) return { kind: "old-host" };
  return { kind: "count", n: listing.total };
}

/** The control's words: `Bookmarks (n)`, `Bookmarks` before the read. */
export function bookmarkChipText(c: BookmarkCount): string {
  return c.kind === "count" ? `Bookmarks (${c.n})` : "Bookmarks";
}

/**
 * The filtered view's own sentence: what it shows of how many, so it never
 * passes for the whole archive. `all` = conversations on disk (`scanned`).
 */
export function bookmarkCutText(c: BookmarkCount, all: number | null): string {
  if (c.kind === "old-host") return "This desktop's host is too old to filter bookmarks — update it to see them here.";
  if (c.kind === "loading") return "Reading the bookmarks…";
  const of = all != null ? `${c.n} of ${all}` : `${c.n}`;
  return `Showing bookmarked conversations only — ${of}.`;
}

/** A row with its bookmark replaced (`undefined` = removed). */
export function withBookmark<T extends { id: string; bookmark?: Bookmark }>(rows: readonly T[], id: string, b: Bookmark | undefined): T[] {
  return rows.map((r) => {
    if (r.id !== id) return r;
    if (b) return { ...r, bookmark: b };
    const { bookmark: _gone, ...rest } = r;
    return rest as T;
  });
}

/** The receipt after a toggle — one sentence, naming where it is found again. */
export function bookmarkReceipt(on: boolean, err?: string): string {
  if (err) return on ? `bookmark not set: ${err}` : `bookmark not removed: ${err}`;
  return on ? "bookmarked — Archive › Bookmarks finds it after it is closed" : "bookmark removed";
}
