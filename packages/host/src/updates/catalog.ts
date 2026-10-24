/**
 * The plugin catalogue: the `BRAND.githubOrg` repos that carry the `PLUGIN_TOPIC` topic, each read
 * at its newest release (or its default branch when it has none) — a read, never an install.
 *
 * Calls per check: one org list, then per matching repo the latest release (+ the branch head when
 * untagged), the manifest and `package.json` — about four a repo against 60 an hour on a first read, one (two when untagged) while a repo's release is unchanged since the cached check, three repos at a time. A repo the
 * manager cannot install gets its refusals in WORDS in `problems`; a transport failure (offline,
 * rate limit, 5xx) throws instead, so the caller keeps its previous catalogue — never a wrong row.
 */
import { BRAND, PLUGIN_TOPIC, manifestProblems, pluginMaturity } from "@waterplane/shared";
import type { CatalogEntry, CatalogLatest, InstalledPlugin } from "@waterplane/shared";
import { GithubError, ghJson, ghRaw } from "./github.js";
import type { InstalledWithUrl } from "./installrecord.js";
import { isOrgUrl } from "./remote.js";

interface OrgRepo {
  name: string; full_name: string; html_url: string; description: string | null;
  topics?: string[]; private?: boolean; visibility?: string; default_branch?: string;
}

/** A catalogue row before it is joined with what is installed; `id` is the manifest's, when readable. */
export type RawCatalogEntry = Omit<CatalogEntry, "installed" | "fromOrg"> & { id?: string };

const isPublic = (r: OrgRepo): boolean => r.private !== true && (r.visibility === undefined || r.visibility === "public");

async function tryJson<T>(path: string): Promise<T | null> {
  try { return await ghJson<T>(path); } catch (e) { if (e instanceof GithubError && e.status === 404) return null; throw e; }
}

/** The clone address is derived from the org + repo NAME, never taken from GitHub's `html_url`. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
export const orgRepoUrl = (fullName: string): string => `https://github.com/${fullName}.git`;

async function readRepo(r: OrgRepo, prev?: RawCatalogEntry): Promise<RawCatalogEntry> {
  const problems: string[] = [];
  let latest: CatalogLatest | null = null;
  const rel = await tryJson<{ tag_name?: string; body?: string | null }>(`/repos/${r.full_name}/releases/latest`);
  if (rel?.tag_name) {
    latest = { kind: "tag", ref: rel.tag_name, ...(rel.body ? { notes: rel.body } : {}) };
  } else if (r.default_branch) {
    const head = await tryJson<{ sha?: string }>(`/repos/${r.full_name}/commits/${encodeURIComponent(r.default_branch)}`);
    if (head?.sha) latest = { kind: "branch", ref: r.default_branch, commit: head.sha };
  }
  // The same release (or branch head) as the cached check: the manifest and package.json are not read again.
  if (prev && latest && prev.latest && prev.latest.kind === latest.kind && prev.latest.ref === latest.ref && prev.latest.commit === latest.commit && !prev.problems.some((p) => p.startsWith("no "))) {
    return { ...prev, url: orgRepoUrl(r.full_name), latest: { ...latest }, ...(prev.description === "" && r.description ? { description: r.description } : {}) };
  }
  let id: string | undefined;
  let name = r.name, description = r.description ?? "";
  let maturity = pluginMaturity(null).level;
  if (!latest) {
    problems.push("the repo has no release and no readable default branch");
  } else {
    const ref = latest.ref;
    const mtext = await ghRaw(r.full_name, ref, BRAND.pluginManifest);
    if (mtext === null) {
      problems.push(`no ${BRAND.pluginManifest} at ${ref}`);
    } else {
      let m: unknown = null;
      try { m = JSON.parse(mtext); } catch { problems.push(`${BRAND.pluginManifest} at ${ref} is not valid JSON`); }
      if (m) {
        problems.push(...manifestProblems(m));
        const o = m as Record<string, unknown>;
        if (typeof o.id === "string") id = o.id;
        if (typeof o.name === "string" && o.name.trim()) name = o.name;
        if (typeof o.description === "string" && o.description) description = o.description;
        maturity = pluginMaturity(o).level;
      }
    }
    const ptext = await ghRaw(r.full_name, ref, "package.json");
    if (ptext !== null) {
      try {
        const deps = (JSON.parse(ptext) as { dependencies?: unknown }).dependencies;
        const names = deps && typeof deps === "object" ? Object.keys(deps) : [];
        if (names.length) problems.push(`it has dependencies (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}); only plugins without dependencies can be installed`);
      } catch { problems.push("package.json is not valid JSON"); }
    }
  }
  return { repo: r.full_name, url: orgRepoUrl(r.full_name), name, description, maturity, latest, problems, ...(id ? { id } : {}) };
}

/** Read the org. Throws `GithubError` on any transport or rate-limit failure. */
export async function fetchCatalog(org: string = BRAND.githubOrg, prev: readonly RawCatalogEntry[] = []): Promise<RawCatalogEntry[]> {
  const repos = await ghJson<OrgRepo[]>(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=public`);
  if (!Array.isArray(repos)) throw new GithubError("GitHub sent a repo list this host does not understand", null);
  const mine = repos.filter((x) => isPublic(x) && Array.isArray(x.topics) && x.topics.includes(PLUGIN_TOPIC)
    && typeof x.full_name === "string" && x.full_name.startsWith(`${org}/`) && SAFE_NAME.test(x.full_name.slice(org.length + 1)));
  // A small pool: the sequential walk was ~4 calls a repo one after the other; three at a time keeps the
  // check short without a burst against the 60-an-hour allowance.
  const out: RawCatalogEntry[] = new Array(mine.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < mine.length; i = next++) out[i] = await readRepo(mine[i]!, prev.find((p) => p.repo === mine[i]!.full_name)); };
  await Promise.all(Array.from({ length: Math.min(3, mine.length) }, worker));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const repoSlug = (url: string): string => url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

/** Join with what is installed: by manifest id, else by the install record's URL. Cheap and pure — redone on every read. */
export function joinInstalled(raw: readonly RawCatalogEntry[], installed: readonly InstalledWithUrl[]): CatalogEntry[] {
  return raw.map(({ id, ...e }) => {
    const hit = installed.find((i) => (id !== undefined && i.id === id)) ?? installed.find((i) => i.url && repoSlug(i.url) === e.repo.toLowerCase());
    const problems = [...e.problems];
    let inst: InstalledPlugin | null = null;
    if (hit) {
      const { url: _u, ...rest } = hit;
      inst = rest;
      if (hit.source === "manager" && hit.url && repoSlug(hit.url) !== e.repo.toLowerCase()) {
        problems.push(`the id "${hit.id}" is already installed from ${repoSlug(hit.url)}`);
      }
    }
    return { ...e, problems, installed: inst, fromOrg: isOrgUrl(e.url) };
  });
}
