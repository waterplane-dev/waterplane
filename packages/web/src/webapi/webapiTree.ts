import { SLOW_OP_TIMEOUT_MS } from "@waterplane/shared";
import type { ArchiveListing } from "@waterplane/shared";
import { nfetch, jget } from "./webapiFetch";
import type { TreeListing, TreeFile, TreeWriteResult } from "./webapiTypes";

/** The conversation archive and the worktree tree. One slice of `api` (see api.ts). */
export const treeApi = {
  /**
   * Every conversation the CLI ever wrote for this repo, newest first — the
   * uncapped route back to a closed session. `q` filters on the first prompt,
   * which costs the host a title sweep, so it is a deliberate search and not a
   * per-keystroke one.
   */
  archive: (repoId: string, opts: { offset?: number; limit?: number; q?: string } = {}) => {
    const s = new URLSearchParams();
    if (opts.offset) s.set("offset", String(opts.offset));
    if (opts.limit) s.set("limit", String(opts.limit));
    if (opts.q) s.set("q", opts.q);
    return jget<ArchiveListing>(`/api/repos/${repoId}/archive?${s}`, SLOW_OP_TIMEOUT_MS);
  },
  /** Delete one archived conversation's log. The only way to lose a
   *  conversation in this app — the caller confirms first. */
  archiveDelete: async (repoId: string, id: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await nfetch(`/api/repos/${repoId}/archive?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.json() as Promise<{ ok: boolean; error?: string }>;
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
