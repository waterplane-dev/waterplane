/**
 * What is newest at a repo OUTSIDE the org catalogue (a plugin installed by URL): GitHub's release
 * (else default-branch head) when the address is a github.com one, otherwise `git ls-remote` for the
 * newest version tag (else HEAD). A read. Throws in words when the remote cannot be read.
 */
import { BRAND } from "@waterplane/shared";
import type { CatalogLatest } from "@waterplane/shared";
import { ghJson, GithubError } from "./github.js";
import { realGit, resolveUrl } from "./gitops.js";
import type { Git } from "./gitops.js";

const GH = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export async function remoteLatest(url: string, git: Git = realGit): Promise<CatalogLatest> {
  const m = GH.exec(url);
  if (m) {
    const full = `${m[1]}/${m[2]}`;
    try {
      const rel = await ghJson<{ tag_name?: string }>(`/repos/${full}/releases/latest`);
      if (rel.tag_name) return { kind: "tag", ref: rel.tag_name };
    } catch (e) { if (!(e instanceof GithubError && e.status === 404)) throw e; }
    const repo = await ghJson<{ default_branch?: string }>(`/repos/${full}`);
    if (!repo.default_branch) throw new Error("the repo has no default branch");
    const head = await ghJson<{ sha?: string }>(`/repos/${full}/commits/${encodeURIComponent(repo.default_branch)}`);
    return { kind: "branch", ref: repo.default_branch, ...(head.sha ? { commit: head.sha } : {}) };
  }
  const r = await resolveUrl(git, url);
  if (r.kind === "tag") return r;
  const out = await git(["ls-remote", "--symref", "--", url, "HEAD"]);
  const ref = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out)?.[1];
  const commit = /^([0-9a-f]{40})\tHEAD$/m.exec(out)?.[1];
  if (!ref) throw new Error("the remote names no default branch");
  return { kind: "branch", ref, ...(commit ? { commit } : {}) };
}

/** True only for a github.com address under the `BRAND.githubOrg` org: the one test behind "from <org>". */
export function isOrgUrl(url: string): boolean {
  const m = GH.exec(url);
  return !!m && m[1]!.toLowerCase() === BRAND.githubOrg.toLowerCase();
}

/**
 * `owner/name` for a github.com address. Anything else is `other: host/path`, so no non-GitHub
 * address can ever read like `waterplane-dev/x`; "from the org" is judged by `isOrgUrl` / `fromOrg`.
 */
export function repoLabel(url: string): string {
  const m = GH.exec(url);
  if (m) return `${m[1]}/${m[2]}`;
  return "other: " + url.replace(/^(https|ssh):\/\//, "").replace(/^[^@/]+@/, "").replace(":", "/").replace(/\.git$/, "");
}
