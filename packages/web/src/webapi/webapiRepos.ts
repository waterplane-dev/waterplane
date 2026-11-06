import type { OnboardAnswers, OnboardConsent, OnboardJob, OnboardPlan, WorktreeLeftover } from "@waterplane/shared";
import { abs } from "../hostUrl";
import { jget, jpost, nfetch } from "./webapiFetch";

/** Creating folders, repos, worktrees and onboarding; the `<img src>` URLs. One slice of `api` (see api.ts). */
export const reposApi = {
  newFolder: (parent: string, name: string) => jpost<{ path?: string; error?: string }>("/api/folder", { parent, name }),
  /** `setup` seeds the phone-facing scaffold (gitignore, README, CLAUDE.md, inbox/outbox). */
  newRepo: (parent: string, name: string, opts: { setup?: boolean; description?: string } = {}) =>
    jpost<{ path?: string; branch?: string; files?: string[]; warning?: string; error?: string }>(
      "/api/repo",
      { parent, name, setup: opts.setup !== false, description: opts.description },
    ),
  /**
   * The name to SHOW for a repo instead of its folder's (`host/reponames.ts`), set on its primary
   * checkout; `null` puts the folder's name back. A label only. The host's refusal comes back in
   * words as `ok:false` + `error`, which is the sentence the editor shows.
   */
  setRepoDisplayName: (repoId: string, name: string | null) =>
    nfetch("/api/repodisplayname", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: repoId, name }),
    }).then(async (r) => {
      let j: { ok?: boolean; error?: string; name?: string | null } = {};
      try { j = await r.json(); } catch { /* no body */ }
      return r.ok && j.ok ? { ok: true as const, name: j.name ?? null } : { ok: false as const, error: j.error || `${r.status} /api/repodisplayname` };
    }),
  /** Folders straight under the root that rescan skipped for having no `.git` (`host/repos.ts` plainFolders). */
  plainFolders: () => jget<{ folders: { name: string; path: string }[] }>("/api/plainfolders"),
  /** `git init` in one of those folders — the host refuses any path it did not just list. */
  initPlainFolder: (path: string) => jpost<{ path?: string; branch?: string; error?: string }>("/api/plainfolders/init", { path }),
  /** `git clone` into a new folder under `parent`; the host refuses any URL but https/ssh, in words. */
  cloneRepo: (parent: string, url: string, name?: string) =>
    jpost<{ path?: string; branch?: string; warning?: string; error?: string }>("/api/clone", { parent, url, name: name || undefined }),
  /**
   * The first-app job (`host/onboardroutes.ts`, plan WP6). The plan is a read
   * and writes nothing; a refusal comes back as `ok:false` + `error` in words
   * (with a 400/409 status on the two POSTs), which is why these are `jpost`
   * and not `jpostOk`: the sentence is the answer the sheet shows.
   */
  onboardPlan: (a: OnboardAnswers) => {
    const q = new URLSearchParams({ name: a.name, path: a.path });
    if (a.description) q.set("description", a.description);
    if (a.setup === false) q.set("setup", "0");
    return jget<OnboardPlan>(`/api/onboard/plan?${q}`);
  },
  // `confirm`: the one-shot token the plan (or the stopped job's GET) carried — the host refuses a
  // start, or a resume that adds consent, without it (`host/confirmgate.ts`).
  onboardJob: () => jget<{ ok: boolean; job: OnboardJob | null; confirm?: string }>("/api/onboard"),
  onboardStart: (answers: OnboardAnswers, consent: OnboardConsent, confirm?: string) =>
    jpost<{ ok: boolean; job?: OnboardJob; error?: string; missing?: string[] }>("/api/onboard", { answers, consent, confirm }),
  onboardResume: (consent?: OnboardConsent, confirm?: string) =>
    jpost<{ ok: boolean; job?: OnboardJob; error?: string }>("/api/onboard/resume", consent ? { consent, confirm } : {}),
  newWorktree: (repoId: string, branch: string) =>
    jpost<{ path?: string; branch?: string; error?: string }>("/api/worktree", { repoId, branch }),
  /** Whether a worktree nobody is using holds anything that exists only there (`host/worktreeleftover.ts`). */
  worktreeLeftover: (repoId: string, signal?: AbortSignal) => jget<WorktreeLeftover>(`/api/repos/${repoId}/worktree/leftover`, undefined, signal),
  /** Remove it — the host re-checks and refuses, in words, on any blocker. */
  removeWorktree: (repoId: string) =>
    jpost<{ ok: boolean; error?: string; note?: string; branchDeleted?: boolean; leftover?: WorktreeLeftover }>(`/api/repos/${repoId}/worktree/remove`, {}),

  // These two are the URLs that end up as `<img src>` / `<a href>` rather than
  // as a fetch, so they are the ones the native shell's transport patch cannot
  // reach — `abs()` by hand. In the browser it returns them unchanged.
  artifactUrl: (repoId: string, relPath: string) =>
    abs(`/api/repos/${repoId}/artifact?path=${encodeURIComponent(relPath)}`),
  inboxUrl: (repoId: string, name: string) => abs(`/api/repos/${repoId}/inbox/${encodeURIComponent(name)}`),
};
