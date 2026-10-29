import { FETCH_TIMEOUT_MS, SLOW_OP_TIMEOUT_MS, type ChangeBrief, type GitExplainState, type GitLog, type GitPushState, type GitStatus, type PrActionResult, type PrListDoc } from "@waterplane/shared";
import { jget, jpost, jpostOk, nfetch } from "./webapiFetch";
import { readBodyFused } from "./webapiBody";

async function gitSide(url: string, path: string, side: "old" | "new", staged: boolean, ms = SLOW_OP_TIMEOUT_MS): Promise<Response | null> {
  const q = new URLSearchParams({ path, side });
  if (staged) q.set("staged", "1");
  const r = await nfetch(`${url}?${q}`, undefined, ms);
  if (r.status === 404) return null;
  if (r.ok) return r;
  const body = await r.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error || `the desktop answered ${r.status}`);
}

/** A media side's body may take a while on a thin link; what it may not do is
 *  stop arriving. This long without a single byte is a dead transfer. */
const BLOB_STALL_MS = 20000;

/** Git review (status, diff, stage, commit, pull, push). One slice of `api` (see api.ts). */
export const gitApi = {
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
  gitBlob: async (
    repoId: string, path: string, side: "old" | "new", staged: boolean,
    onProgress?: (got: number, total: number) => void,
  ): Promise<Blob | null> => {
    // Headers take the generic fuse (the host answers in milliseconds); the
    // body, megabytes of gif, takes a stall fuse (webapiBody.ts).
    const r = await gitSide(`/api/repos/${repoId}/git/blob`, path, side, staged, FETCH_TIMEOUT_MS);
    if (!r) return null;
    return readBodyFused(r, BLOB_STALL_MS, onProgress);
  },
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
  /**
   * Explain what a push would send and a pull would bring, under the ticked
   * foci (host `changebrief.ts`). POST: it spends. A host with the job (`explainjob.ts`)
   * answers at once with its STATE; an older one holds it and answers the brief (its fuse).
   */
  gitExplain: (repoId: string, foci: readonly string[], note: string) =>
    jpost<ChangeBrief | GitExplainState>(`/api/repos/${repoId}/git/explain`, { foci, note, background: true }, 330_000),
  /** The brief running or last finished in this repo (host `explainjob.ts`); null = none yet. */
  gitExplainState: (repoId: string) =>
    jget<{ explain: GitExplainState | null }>(`/api/repos/${repoId}/git/explain`).then((r) => r.explain),
  /** The branch against its upstream — incoming, outgoing, the shared history (host `gitlog.ts`). */
  gitLog: (repoId: string) => jget<GitLog>(`/api/repos/${repoId}/git/log`),
  /** One commit's message and file stat. */
  gitShow: (repoId: string, sha: string) =>
    jget<{ body: string }>(`/api/repos/${repoId}/git/show?${new URLSearchParams({ sha })}`).then((r) => r.body),
  /** `git fetch` of the upstream's remote — refs only, never the branch or the tree. */
  gitFetch: (repoId: string) =>
    jpost<{ ok: boolean; error?: string }>(`/api/repos/${repoId}/git/fetch`, {}, SLOW_OP_TIMEOUT_MS),
  /** Fetch, then fast-forward (or replay local commits when both sides moved). Lands whole or changes nothing; a refusal is the host's sentence. */
  gitPull: (repoId: string) =>
    jpost<{ ok: boolean; output?: string; error?: string }>(`/api/repos/${repoId}/git/pull`, {}, SLOW_OP_TIMEOUT_MS),
  /** Start (or join) the desktop's push JOB — its pre-push hook runs for minutes, never one held request — then ask after it (`null` = none since the desktop started). */
  gitPush: (repoId: string) => jpostOk<GitPushState>(`/api/repos/${repoId}/git/push`, { background: true }),
  gitPushState: (repoId: string) => jget<{ push: GitPushState | null }>(`/api/repos/${repoId}/git/push`).then((r) => r.push),
  /** The PR card (PR mode only): the lease keeps the host polling `gh`; the rest are one tap each. A refusal comes back as `{ok:false,error}`. */
  prLease: (repoId: string, holder: string) => jpost<PrListDoc>(`/api/repos/${repoId}/git/prs/lease`, { holder }),
  prMerge: (repoId: string, number: number, method?: string) => jpost<PrActionResult>(`/api/repos/${repoId}/git/prs/merge`, { number, method }, SLOW_OP_TIMEOUT_MS),
  prAutoMerge: (repoId: string, number: number, on: boolean) => jpost<PrActionResult>(`/api/repos/${repoId}/git/prs/automerge`, { number, on }),
  prClose: (repoId: string, number: number) => jpost<PrActionResult>(`/api/repos/${repoId}/git/prs/close`, { number }),
  prLog: (repoId: string, number: number, check?: string) => jpost<PrActionResult>(`/api/repos/${repoId}/git/prs/log`, { number, check }, SLOW_OP_TIMEOUT_MS),
};
