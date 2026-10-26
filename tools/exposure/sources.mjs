// The exposure watch's I/O, and only that: spawn npm / gh / git / apksigner, GET or POST public
// registries. Every function RETURNS `{ok:true, data}` or `{ok:false, why, unreachable}` and never
// throws; `unreachable` is true only when the network or the credentials failed (so the reading is
// unknown), never for "this does not apply". Timeouts: 15 s per fetch (45 s for a registry packument), 120 s per spawned process.
// What the payloads MEAN is tools/exposure/parse.mjs; what to do about it is core.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FETCH_MS = 15_000;
const SPAWN_MS = 120_000;

const ok = (data, extra = {}) => ({ ok: true, data, ...extra });
const fail = (why, unreachable = false) => ({ ok: false, why: String(why).replace(/\s+/g, " ").trim().slice(0, 240), unreachable });
const msg = (e) => (e && e.message) || String(e);

/** Run a process; `{ok, status, stdout, stderr}` in `data`, or a failure when it could not start / timed out. */
export function run(cmd, args, { cwd, input, timeout = SPAWN_MS, env } = {}) {
  try {
    const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, env: env ?? process.env });
    if (r.error) return fail(`${cmd}: ${msg(r.error)}`);
    return ok({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  } catch (e) {
    return fail(`${cmd}: ${msg(e)}`);
  }
}

/** Read a text file; failure when absent. */
export function readText(path) {
  try { return ok(readFileSync(path, "utf8")); } catch (e) { return fail(`${path}: ${msg(e)}`); }
}

/** Read and parse a JSON file. */
export function readJson(path) {
  const t = readText(path);
  if (!t.ok) return t;
  try { return ok(JSON.parse(t.data)); } catch (e) { return fail(`${path}: not JSON (${msg(e)})`); }
}

/** Tracked files of a git repo (paths relative to dir). Not a git repo: failure, `unreachable:false`. */
export function gitFiles(dir) {
  const r = run("git", ["-C", dir, "ls-files"], { timeout: 30_000 });
  if (!r.ok) return r;
  if (r.data.status !== 0) return fail(`not a git repo: ${r.data.stderr.trim()}`);
  return ok(r.data.stdout.split("\n").filter(Boolean));
}

/** Short HEAD sha, or null. */
export function gitHead(dir) {
  const r = run("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { timeout: 15_000 });
  return r.ok && r.data.status === 0 ? r.data.stdout.trim() : null;
}

/** `git remote get-url origin` -> "owner/repo" for github.com remotes, else null. */
export function gitOriginSlug(dir) {
  const r = run("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 15_000 });
  if (!r.ok || r.data.status !== 0) return null;
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(r.data.stdout.trim())?.[1] ?? null;
}

/** ISO commit date of the commit that last introduced `"version": "<v>"` in a file; fallback: the file's last commit. */
export function gitVersionDate(dir, file, version) {
  const a = run("git", ["-C", dir, "log", "-1", "--format=%cI", `-S"version": "${version}"`, "--", file], { timeout: 30_000 });
  if (a.ok && a.data.status === 0 && a.data.stdout.trim()) return ok(a.data.stdout.trim());
  const b = run("git", ["-C", dir, "log", "-1", "--format=%cI", "--", file], { timeout: 30_000 });
  return b.ok && b.data.status === 0 && b.data.stdout.trim() ? ok(b.data.stdout.trim()) : fail("no commit date for the manifest");
}

// ---- HTTP ---------------------------------------------------------------------------------------

/** One fetch with the 15 s timeout. 404 is `ok` with `data:null, status:404`; other non-2xx is a failure (5xx/429 = unreachable). */
async function http(url, opts = {}, retry = true) {
  const { method = "GET", headers, body, ms = FETCH_MS } = opts;
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(ms) });
    if (res.status === 404) return ok(null, { status: 404 });
    if (!res.ok) return fail(`${method} ${url} -> HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 401);
    return ok(await res.json(), { status: res.status });
  } catch (e) {
    if (retry) return http(url, opts, false); // one retry: a busy registry times out now and then
    return fail(`${method} ${url}: ${msg(e)}`, true);
  }
}

/**
 * GET a URL following redirects (15 s, one retry) and report the FINAL status without reading JSON.
 * `{ok:true, status, finalUrl}` means we got an answer (any status); `ok:false` = network error, unreachable.
 */
export async function httpStatus(url, retry = true) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) });
    await res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status, finalUrl: res.url || url };
  } catch (e) {
    if (retry) return httpStatus(url, false);
    return fail(`GET ${url}: ${msg(e)}`, true);
  }
}

/** RDAP record of a domain via the rdap.org bootstrap; it answers 403 to a request without a user-agent (Node's fetch sends none). */
export const rdapDomain = (name) =>
  http(`https://rdap.org/domain/${encodeURIComponent(name)}`, { headers: { accept: "application/rdap+json", "user-agent": "exposure-watch" } });

/** Abbreviated packument of an npm package; a package the registry does not know is `ok` with data null. */
export const registryDoc = (name) =>
  // 45 s, not 15: the big packuments (typescript-eslint: ~10 MB) need ~6 s alone and far more at 16 in flight
  http(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, ms: 45_000 });

/** OSV querybatch (POST) and one vulnerability record. */
export const osvBatch = (body) =>
  http("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const osvVuln = (id) => http(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);

/** endoflife.date cycles of a product; an unknown product is `ok` with null. */
export const eolCycles = (product) => http(`https://endoflife.date/api/${encodeURIComponent(product)}.json`);

/**
 * OpenSSF Scorecard's public reading of a PUBLIC GitHub repo (no credential). Resolves to
 * `{ score, reason, date }` of its Branch-Protection check; score -1 = inconclusive. A repo Scorecard has not
 * scored (404) or without that check is `ok` with null.
 */
export async function scorecardBranch(slug) {
  const r = await http(`https://api.securityscorecards.dev/projects/github.com/${slug}`);
  if (!r.ok || !r.data) return r;
  const c = Array.isArray(r.data.checks) ? r.data.checks.find((x) => x?.name === "Branch-Protection") : null;
  if (!c || typeof c.score !== "number") return ok(null, { status: r.status });
  return ok({ score: c.score, reason: String(c.reason ?? ""), date: r.data.date ?? null }, { status: r.status });
}

/** Marketplace extension query by `publisher.name`. */
export const marketplaceQuery = (extId) =>
  http("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json;api-version=3.0-preview.1" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: extId }], pageNumber: 1, pageSize: 1 }], flags: 914 }),
  });

/** Run `fn(item)` over `items`, at most `limit` at a time; results in input order. fn must not throw (it is caught anyway). */
export async function pool(items, fn, limit = 16) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = fail(msg(e)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- npm ----------------------------------------------------------------------------------------

/** `npm audit --json --package-lock-only` in `cwd`. npm exits non-zero when it finds vulns: only non-JSON stdout is a failure. */
export function npmAudit(cwd) {
  const r = run("npm", ["audit", "--json", "--package-lock-only"], { cwd });
  if (!r.ok) return fail(r.why, true);
  try {
    const j = JSON.parse(r.data.stdout);
    if (j && j.error && !j.vulnerabilities) return fail(`npm audit: ${j.error.summary ?? j.error.code ?? "error"}`, true);
    return ok(j);
  } catch {
    return fail(`npm audit printed no JSON: ${r.data.stderr.trim().slice(0, 200)}`, true);
  }
}

/** `npm view <pkg> --json`. */
export function npmView(pkg) {
  const r = run("npm", ["view", pkg, "--json"], { timeout: 60_000 });
  if (!r.ok) return fail(r.why, true);
  try { return ok(JSON.parse(r.data.stdout)); } catch { return fail(`npm view ${pkg}: ${r.data.stderr.trim().slice(0, 200)}`, true); }
}

/** scripts/release/npm-verify.mjs <pkg> <version> --check: `{status, stdout}`; ok means the script ran, not that it passed. */
export function npmVerify(pkg, version) {
  const script = new URL("../../scripts/release/npm-verify.mjs", import.meta.url).pathname;
  const r = run(process.execPath, [script, pkg, version, "--check"], { timeout: 5 * 60_000 });
  return r.ok ? ok({ status: r.data.status, stdout: r.data.stdout + r.data.stderr }) : fail(r.why, true);
}

// ---- GitHub (gh) --------------------------------------------------------------------------------

/**
 * `gh api <path>`. 404 -> ok with data null (the thing is not there). 401 / no connection / gh missing or
 * not logged in -> unreachable. 403 (a token without the right) -> failure, NOT unreachable: that reading is
 * unreadable, not the network.
 */
export function ghApi(path) {
  // Known limit: one page only (callers ask per_page=100); a repo with more open alerts than that is
  // under-read, not paginated. Add `--paginate` here if one ever gets there.
  const r = run("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { timeout: 60_000 });
  if (!r.ok) return fail(r.why, true);
  const { status, stdout, stderr } = r.data;
  if (status === 0) {
    try { return ok(stdout.trim() ? JSON.parse(stdout) : null); } catch { return fail(`gh api ${path}: not JSON`); }
  }
  const code = /HTTP (\d{3})/.exec(stderr)?.[1];
  if (code === "404") return ok(null, { status: 404 });
  if (code === "403") return fail(`gh api ${path}: HTTP 403 ${stderr.trim().slice(0, 120)}`);
  if (code === "401" || /gh auth login|authentication/i.test(stderr) || !code) return fail(`gh api ${path}: ${stderr.trim().slice(0, 160)}`, true);
  return fail(`gh api ${path}: HTTP ${code}`, Number(code) >= 500);
}

/** `gh release view --json tagName,assets` of the latest release. */
export function ghLatestRelease(repo) {
  const r = run("gh", ["release", "view", "--repo", repo, "--json", "tagName,assets"], { timeout: 60_000 });
  if (!r.ok) return fail(r.why, true);
  if (r.data.status !== 0) return fail(`gh release view: ${r.data.stderr.trim().slice(0, 160)}`, !/not found/i.test(r.data.stderr));
  try { return ok(JSON.parse(r.data.stdout)); } catch { return fail("gh release view: not JSON"); }
}

/** Download the named assets of a release into `dir`; the files read back as Buffers by name. */
export function ghDownload(repo, tag, names, dir) {
  const args = ["release", "download", tag, "--repo", repo, "--dir", dir, "--clobber"];
  for (const n of names) args.push("--pattern", n);
  const r = run("gh", args, { timeout: 5 * 60_000 });
  if (!r.ok) return fail(r.why, true);
  if (r.data.status !== 0) return fail(`gh release download: ${r.data.stderr.trim().slice(0, 160)}`, true);
  const files = {};
  try { for (const n of readdirSync(dir)) files[n] = readFileSync(join(dir, n)); } catch (e) { return fail(msg(e)); }
  return ok(files);
}

// ---- apksigner ----------------------------------------------------------------------------------

/** Newest build-tools apksigner under $ANDROID_HOME / $ANDROID_SDK_ROOT / ~/Library/Android/sdk, or null. */
export function findApksigner() {
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk")]) {
    if (!root) continue;
    try {
      const dir = join(root, "build-tools");
      const v = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
      for (const x of v) if (existsSync(join(dir, x, "apksigner"))) return join(dir, x, "apksigner");
    } catch { /* next root */ }
  }
  return null;
}

/** `apksigner verify --print-certs <apk>` stdout. */
export function apksignerCerts(apksigner, apk) {
  const r = run(apksigner, ["verify", "--print-certs", apk], { timeout: 60_000 });
  return r.ok ? ok(r.data.stdout) : r;
}
