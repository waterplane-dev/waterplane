import { SLOW_OP_TIMEOUT_MS, type GitStatus } from "@waterplane/shared";
import { jget, jpost, nfetch } from "./webapiFetch";

async function gitSide(url: string, path: string, side: "old" | "new", staged: boolean): Promise<Response | null> {
  const q = new URLSearchParams({ path, side });
  if (staged) q.set("staged", "1");
  const r = await nfetch(`${url}?${q}`, undefined, SLOW_OP_TIMEOUT_MS);
  if (r.status === 404) return null;
  if (r.ok) return r;
  const body = await r.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error || `the desktop answered ${r.status}`);
}

/** Git review (status, diff, stage, commit, push). One slice of `api` (see api.ts). */
export const gitApi = {
  // Git review (Tier 3)
  gitStatus: (repoId: string) => jget<GitStatus>(`/api/repos/${repoId}/git/status`),
  gitDiff: (repoId: string, path?: string, staged?: boolean) => {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    if (staged) q.set("staged", "1");
    return jget<{ diff: string }>(`/api/repos/${repoId}/git/diff?${q}`).then((d) => d.diff);
  },
  /**
   * One side of a changed file (host `gitBlob`): `old` is what the diff
   * compares against, `new` what it shows. `gitBlob` is a media file's bytes,
   * `gitText` a text file whole. `null` = that side has no such file (added /
   * deleted); any other refusal throws with the host's words.
   */
  gitBlob: async (repoId: string, path: string, side: "old" | "new", staged: boolean): Promise<Blob | null> =>
    (await gitSide(`/api/repos/${repoId}/git/blob`, path, side, staged))?.blob() ?? null,
  gitText: async (repoId: string, path: string, side: "old" | "new", staged: boolean) =>
    (await gitSide(`/api/repos/${repoId}/git/text`, path, side, staged))?.json() as Promise<{ body: string; truncated: boolean }> | null,
  gitStage: (repoId: string, path: string, unstage: boolean) =>
    jpost<{ ok: boolean; error?: string }>(`/api/repos/${repoId}/git/stage`, { path, unstage }),
  gitCommit: (repoId: string, message: string, all = true) =>
    jpost<{ ok: boolean; output?: string; error?: string }>(`/api/repos/${repoId}/git/commit`, { message, all }, SLOW_OP_TIMEOUT_MS),
  /**
   * Draft a commit message for what is waiting in this worktree (host
   * `commitmsg.ts`). POST because it SPENDS — it writes nothing.
   *
   * Exactly one of `message` / `reason` comes back, and the caller shows
   * whichever it got. `SLOW_OP_TIMEOUT_MS` because there are two model calls
   * behind it and the 20-second fuse is for a route that reads a file.
   */
  gitMessage: (repoId: string) =>
    jpost<{ message?: string; reason?: string; limited?: boolean }>(`/api/repos/${repoId}/git/message`, {}, SLOW_OP_TIMEOUT_MS),
  gitPush: (repoId: string) =>
    jpost<{ ok: boolean; output?: string; error?: string }>(`/api/repos/${repoId}/git/push`, {}, SLOW_OP_TIMEOUT_MS),
};
