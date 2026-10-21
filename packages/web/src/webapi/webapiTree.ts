import { SLOW_OP_TIMEOUT_MS, timedFetch, TRANSCRIPT_TIMEOUT_MS } from "@waterplane/shared";
import type { ArchiveListing, Bookmark, TranscriptDoc, TranscriptToolDetail } from "@waterplane/shared";
import { nfetch, jget } from "./webapiFetch";
import { readJsonFused } from "./webapiBody";
import type { TreeListing, TreeFile, TreeWriteResult } from "./webapiTypes";

/** The conversation archive and the worktree tree. One slice of `api` (see api.ts). */
export const treeApi = {
  /**
   * Every conversation the CLI ever wrote for this repo, newest first — the
   * uncapped route back to a closed session. `q` filters on the first prompt,
   * which costs the host a title sweep, so it is a deliberate search and not a
   * per-keystroke one.
   */
  archive: (repoId: string, opts: { offset?: number; limit?: number; q?: string; bookmarked?: boolean } = {}) => {
    const s = new URLSearchParams();
    if (opts.offset) s.set("offset", String(opts.offset));
    if (opts.limit) s.set("limit", String(opts.limit));
    if (opts.q) s.set("q", opts.q);
    // Only this repo's bookmarks (R-conversations-007). An older host ignores
    // it and answers without `bookmarked` — the caller must not call that
    // listing "bookmarks".
    if (opts.bookmarked) s.set("bookmarked", "1");
    return jget<ArchiveListing>(`/api/repos/${repoId}/archive?${s}`, SLOW_OP_TIMEOUT_MS);
  },
  /** Delete one archived conversation's log. The only way to lose a
   *  conversation in this app — the caller confirms first. */
  archiveDelete: async (repoId: string, id: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await nfetch(`/api/repos/${repoId}/archive?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.json() as Promise<{ ok: boolean; error?: string }>;
  },
  /**
   * Bookmark one conversation, or update its note / remembered tab name. A
   * field left out keeps what it had; one sent empty clears it. `nfetch`: a
   * tap, worth a line in the activity bar. Not queued — a bookmark set an hour
   * late is harmless but a receipt that lies about it is not, so offline is an
   * error the caller words.
   */
  bookmarkSet: async (repoId: string, convId: string, fields: { note?: string; name?: string } = {}): Promise<{ ok: boolean; bookmark?: Bookmark; error?: string }> => {
    const r = await nfetch(`/api/repos/${repoId}/archive/bookmark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: convId, ...fields }),
    });
    return r.json() as Promise<{ ok: boolean; bookmark?: Bookmark; error?: string }>;
  },
  /** Drop one conversation's bookmark (and its note). */
  bookmarkRemove: async (repoId: string, convId: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await nfetch(`/api/repos/${repoId}/archive/bookmark?id=${encodeURIComponent(convId)}`, { method: "DELETE" });
    return r.json() as Promise<{ ok: boolean; error?: string }>;
  },
  /**
   * One ARCHIVED conversation as the reader's document, read off its log —
   * no session, no CLI spawned. Same contract as `sessionsApi.transcript`:
   * `since` → 204 (null) when unchanged, a raw `timedFetch` so a poll does not
   * blink the activity bar, and a stall fuse on the body.
   */
  archivedTranscript: async (repoId: string, convId: string, since?: number, detail: "lite" | "full" = "lite"): Promise<TranscriptDoc | null> => {
    const q = new URLSearchParams({ conv: convId });
    if (since) q.set("since", String(since));
    if (detail === "full") q.set("detail", "full");
    const r = await timedFetch(`/api/repos/${repoId}/archive/transcript?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`${r.status} transcript`);
    return readJsonFused<TranscriptDoc>(r, TRANSCRIPT_TIMEOUT_MS);
  },
  /** The tool inputs/results a `lite` archived document withheld, for one turn. */
  archivedToolDetails: async (repoId: string, convId: string, turnId: string): Promise<Record<string, TranscriptToolDetail>> => {
    const q = new URLSearchParams({ conv: convId, turn: turnId });
    const r = await timedFetch(`/api/repos/${repoId}/archive/transcript/tools?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (!r.ok) throw new Error(`${r.status} tool details`);
    const d = await readJsonFused<{ tools?: Record<string, TranscriptToolDetail> }>(r, TRANSCRIPT_TIMEOUT_MS);
    return d.tools ?? {};
  },
  /** One directory of the worktree, or (with `q`) a recursive name search. */
  tree: (repoId: string, path = "", q?: string) => {
    const s = new URLSearchParams();
    if (path) s.set("path", path);
    if (q) s.set("q", q);
    return jget<TreeListing>(`/api/repos/${repoId}/tree?${s}`);
  },
  /** Read one file for the viewer/editor. Carries the `sha` a save must echo. */
  treeFile: (repoId: string, path: string) =>
    jget<TreeFile>(`/api/repos/${repoId}/tree/file?path=${encodeURIComponent(path)}`),
  /**
   * Save a file back over the exact bytes we read (`baseSha`). A 409 answer is
   * the host refusing a stale write — not an error to swallow: it means an
   * agent edited the file while it was open here, and the caller must re-read
   * before it can save. Deliberately NOT routed through the send queue: a write
   * replayed an hour later carries a base the file left behind long ago.
   */
  treeWrite: async (repoId: string, path: string, body: string, baseSha: string): Promise<TreeWriteResult> => {
    const r = await nfetch(`/api/repos/${repoId}/tree/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, body, baseSha }),
    }, SLOW_OP_TIMEOUT_MS);
    return r.json() as Promise<TreeWriteResult>;
  },
};
