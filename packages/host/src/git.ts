/** Git review operations for a worktree: status, diff, stage, commit, pull, push. */
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { contained, containedReal, realResolve } from "./paths.js";
import { spawn } from "node:child_process";
import type { GitPushState } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";
import { PushProgress } from "./pushprogress.js";


export interface GitFile {
  path: string;
  /** Two-char porcelain code, e.g. " M", "A ", "??", "R ". */
  code: string;
  staged: boolean;
  /** Renamed-from path, when code starts with R. */
  from?: string;
}
export interface GitStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  clean: boolean;
}

async function git(wt: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return pexec("git", args, { cwd: wt, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Count the files with uncommitted changes in a worktree — staged, unstaged and
 * untracked alike, one line per path, respecting .gitignore. 0 on any error.
 *
 * It counted only untracked files once (`ls-files --others`), and the badge it
 * feeds opens the git view, which lists EVERY changed file: 4 on the badge, 33
 * in the sheet the tap opened. A count on a control is the cut it opens.
 *
 * `--untracked-files=all` is not optional here: porcelain collapses a wholly
 * untracked directory to one `?? src/` line, so a fresh directory of ten files
 * would count as one.
 */
export async function countChangedFiles(wt: string): Promise<{ changed: number; ahead?: number; behind?: number; hasOrigin?: boolean }> {
  // Beside the status, not inside its try: a repo with no `origin` is a fact
  // worth drawing even when the status failed. Unknown (git itself broke) =
  // absent, never a made-up "no remote".
  const origin = hasOriginRemote(wt);
  const counts = await countStatus(wt);
  const hasOrigin = await origin;
  return hasOrigin === undefined ? counts : { ...counts, hasOrigin };
}

/** `git config --get` exits 1 for a key that is not set and something else when
 *  git itself failed — only the first is "no origin". */
async function hasOriginRemote(wt: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await pexec("git", ["config", "--get", "remote.origin.url"], { cwd: wt, timeout: 10_000 });
    return stdout.trim() !== "";
  } catch (e) {
    return (e as { code?: unknown }).code === 1 ? false : undefined;
  }
}

async function countStatus(wt: string): Promise<{ changed: number; ahead?: number; behind?: number }> {
  try {
    // `--branch` adds the `## main...origin/main [ahead 2, behind 1]` header, so
    // the launcher's in/out counts cost no second git call. No upstream (no
    // `...` in the header) = nothing to compare against: ahead/behind ABSENT,
    // never a made-up 0.
    const { stdout } = await git(wt, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
    const lines = stdout.split("\n").filter((l) => l.trim());
    const head = lines[0]?.startsWith("## ") ? lines.shift()! : "";
    if (!head.includes("...")) return { changed: lines.length };
    return {
      changed: lines.length,
      ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
    };
  } catch {
    return { changed: 0 };
  }
}

export type ChangedCount = Awaited<ReturnType<typeof countChangedFiles>>;

/** Last answer per worktree, and the run in flight — `changedCountsWithin`'s memory. */
const changedCache = new Map<string, ChangedCount>();
const changedInflight = new Map<string, Promise<ChangedCount>>();
/** `git status` runs at once. 38 at a time over WSL's 9P bridge to `/mnt/c` took 55-400 s for the
 *  slowest (everything thrashing one link); a few at a time finishes the set sooner, and on a
 *  local disk four is no limit worth noticing. */
const CHANGED_PARALLEL = 4;
let changedRunning = 0;
const changedQueue: (() => void)[] = [];

/** When each cached count was taken, and how long its `git status` ran. */
const changedTaken = new Map<string, { at: number; tookMs: number }>();
/**
 * A count stays fresh for this many times as long as it took to make, up to the cap. On a local
 * disk a status takes milliseconds, so every listing still re-asks; over 9P one takes up to a
 * minute, and re-asking all of them on every listing kept 4 `git status` grinding the bridge
 * permanently — which slowed every other file read the host made, its event loop's among them.
 */
const CHANGED_FRESH_FACTOR = 10;
const CHANGED_FRESH_CAP_MS = 5 * 60_000;

function changedFresh(wt: string, now = Date.now()): boolean {
  const t = changedTaken.get(wt);
  return !!t && changedCache.has(wt) && now - t.at < Math.min(CHANGED_FRESH_CAP_MS, t.tookMs * CHANGED_FRESH_FACTOR);
}

function refreshChanged(wt: string): Promise<ChangedCount> {
  let p = changedInflight.get(wt);
  if (p) return p;
  if (changedFresh(wt)) return Promise.resolve(changedCache.get(wt)!);
  p = (async () => {
    if (changedRunning >= CHANGED_PARALLEL) await new Promise<void>((r) => changedQueue.push(r));
    changedRunning++;
    try {
      const began = Date.now();
      const c = await countChangedFiles(wt);
      changedCache.set(wt, c);
      changedTaken.set(wt, { at: Date.now(), tookMs: Date.now() - began });
      return c;
    } finally {
      changedRunning--;
      changedQueue.shift()?.();
      changedInflight.delete(wt);
    }
  })();
  changedInflight.set(wt, p);
  return p;
}

/**
 * The launcher's per-worktree git counts, answered within `budgetMs`: each worktree's `git status`
 * is (re)started unless its last count is still fresh (`changedFresh`), and whatever has not finished by the deadline is answered from the last run —
 * or not at all (absent from the map) the first time, while the run carries on and caches for the
 * next listing. On a local disk every run beats the budget and this is exactly the old "await them
 * all"; on a slow one (WSL reading `/mnt/c`: a repo's status can take a minute) the listing no
 * longer waits for the slowest repo on the machine.
 */
export async function changedCountsWithin(
  wts: readonly string[], budgetMs: number, refreshBudgetMs: number = budgetMs,
): Promise<Map<string, ChangedCount>> {
  // Every worktree already answered once: only a short wait for fresher counts (the cached ones
  // stand in for any still running). Some never have: the full budget, so a first listing has them.
  const wait = wts.every((wt) => changedCache.has(wt)) ? refreshBudgetMs : budgetMs;
  const runs = wts.map((wt) => refreshChanged(wt).catch(() => undefined));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(runs),
    new Promise<void>((r) => { timer = setTimeout(r, wait); }),
  ]);
  clearTimeout(timer);
  const out = new Map<string, ChangedCount>();
  for (const wt of wts) { const c = changedCache.get(wt); if (c) out.set(wt, c); }
  return out;
}

/**
 * The last `n` commit subjects, newest first — the cheapest fact there is about
 * what this repo has been doing lately.
 *
 * `[]` on ANY error, and that covers more than a broken git: a worktree with no
 * commits at all, a fresh `git init`, a detached checkout, a directory that
 * stopped being a repo between one call and the next. Every one of those is
 * honestly "nobody has anything to tell you about recent work here", and the
 * callers are advisory readers that must keep working on the words alone.
 *
 * Two caps, both on the COUNT and the length and never on a subject's meaning:
 * `n` rows (bounded, so a caller cannot ask for the whole history by passing a
 * large number) and 200 chars each, because these go into a prompt whose budget
 * belongs to the backlog items rather than to somebody's essay of a commit
 * message. `%s` is the subject line only — the body never comes.
 */
export async function gitRecentSubjects(wt: string, n = 10): Promise<string[]> {
  const want = Math.max(1, Math.min(Math.floor(n) || 0, 100));
  try {
    const { stdout } = await git(wt, ["log", `-${want}`, "--format=%s"]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, want)
      .map((l) => l.slice(0, 200));
  } catch {
    return [];
  }
}

/** Ensure a path stays inside the worktree (file may not exist, e.g. deleted). */
const pathInTree = (wt: string, rel: string): string | null => contained(wt, rel);

export async function gitStatus(wt: string): Promise<GitStatus> {
  const { stdout } = await git(wt, ["status", "--porcelain=v1", "--branch"]);
  const lines = stdout.split("\n");
  const status: GitStatus = { branch: "(unknown)", ahead: 0, behind: 0, files: [], clean: true };

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const m = /^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(head);
      if (m) {
        status.branch = m[1] === "HEAD (no branch)" ? "(detached)" : m[1];
        status.upstream = m[2];
        const tail = m[3] ?? "";
        status.ahead = Number(/ahead (\d+)/.exec(tail)?.[1] ?? 0);
        status.behind = Number(/behind (\d+)/.exec(tail)?.[1] ?? 0);
      }
      continue;
    }
    const code = line.slice(0, 2);
    let path = line.slice(3);
    let from: string | undefined;
    if (code[0] === "R" && path.includes(" -> ")) {
      [from, path] = path.split(" -> ");
    }
    status.files.push({ path, code, staged: code[0] !== " " && code[0] !== "?", from });
  }
  status.clean = status.files.length === 0;
  return status;
}

export interface CloseCheck {
  isRepo: boolean;
  branch: string;
  /** Uncommitted changes in the working tree (staged or unstaged or untracked). */
  dirty: boolean;
  /** Commits on this branch not yet reachable from the main branch. */
  unmerged: number;
  /** Branch this worktree is on IS the main branch. */
  isMain: boolean;
  /** Name of the resolved main branch (main/master), or "" if none found. */
  mainBranch: string;
}

/** Pre-close safety check: is there uncommitted or un-merged-to-main work here? */
export async function gitCloseCheck(wt: string): Promise<CloseCheck> {
  const out: CloseCheck = { isRepo: false, branch: "", dirty: false, unmerged: 0, isMain: false, mainBranch: "" };
  let branch = "";
  try {
    const { stdout } = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = stdout.trim();
  } catch {
    return out; // not a git worktree
  }
  out.isRepo = true;
  out.branch = branch;

  // Dirty = any porcelain output.
  try {
    const { stdout } = await git(wt, ["status", "--porcelain"]);
    out.dirty = stdout.trim().length > 0;
  } catch { /* leave dirty=false */ }

  // Resolve the main branch (prefer main, then master).
  for (const cand of ["main", "master"]) {
    try {
      await git(wt, ["rev-parse", "--verify", "--quiet", cand]);
      out.mainBranch = cand;
      break;
    } catch { /* try next */ }
  }
  out.isMain = !!out.mainBranch && branch === out.mainBranch;

  // Count commits on HEAD not reachable from main.
  if (out.mainBranch && !out.isMain) {
    try {
      const { stdout } = await git(wt, ["rev-list", "--count", `${out.mainBranch}..HEAD`]);
      out.unmerged = Number(stdout.trim()) || 0;
    } catch { /* leave 0 */ }
  }
  return out;
}

export async function gitDiff(wt: string, opts: { path?: string; staged?: boolean } = {}): Promise<string> {
  const args = ["diff", "--no-color"];
  if (opts.staged) args.push("--staged");
  if (opts.path) {
    const safe = pathInTree(wt, opts.path);
    if (!safe) return "";
    args.push("--", opts.path);
  }
  try {
    const { stdout } = await git(wt, args);
    // Untracked files have no diff; show their content as an added-file diff.
    if (!stdout && opts.path && !opts.staged) {
      const body = await readTextFile(wt, opts.path);
      if (body != null) return `--- /dev/null\n+++ b/${opts.path}\n` + body.split("\n").map((l) => "+" + l).join("\n");
    }
    return stdout;
  } catch {
    return "";
  }
}

/** Cap on one side of a binary diff's bytes — a docs gif or a screen recording, not a dataset. */
const BLOB_MAX = 64 * 1024 * 1024;

/**
 * One side of a changed file's diff, as BYTES: what `git diff` prints as
 * "Binary files differ" is a picture the phone can show before and after.
 *
 * The sides follow the diff the git view opened: unstaged compares the index
 * (`old`) with the working tree (`new`); staged compares `HEAD` with the index.
 * `null` when that side has no such file — an added file has no `old`, a
 * deleted one no `new` — or the path escapes the tree, is a dotenv file, or is
 * past `BLOB_MAX`. Never a guess at another revision.
 */
export async function gitBlob(wt: string, rel: string, side: "old" | "new", staged: boolean): Promise<Buffer | null> {
  // Reads bytes: a symlink out of the tree is refused (`containedReal`).
  const full = containedReal(wt, rel);
  if (!full || secretAt(wt, rel, full)) return null;
  if (side === "new" && !staged) {
    try {
      const st = await stat(full);
      return st.isFile() && st.size <= BLOB_MAX ? await readFile(full) : null;
    } catch {
      return null;
    }
  }
  // `:./p` / `HEAD:./p` resolve against the cwd, which is the worktree.
  const spec = side === "old" && staged ? `HEAD:./${rel}` : `:./${rel}`;
  try {
    const { stdout } = await pexec("git", ["show", spec], { cwd: wt, maxBuffer: BLOB_MAX, encoding: "buffer" });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * The full delta of a worktree vs its main branch — committed AND uncommitted
 * tracked changes — plus a list of untracked files. Used to give an independent
 * reviewer the evidence to judge whether a backlog item was implemented.
 * Falls back to `git diff HEAD` (uncommitted only) when no main branch exists.
 */
export async function gitReviewDiff(wt: string, cap = 60_000): Promise<{ diff: string; untracked: string[]; empty: boolean }> {
  let mainBranch = "";
  for (const cand of ["main", "master"]) {
    try { await git(wt, ["rev-parse", "--verify", "--quiet", cand]); mainBranch = cand; break; } catch { /* next */ }
  }
  let diff = "";
  try {
    const { stdout } = await git(wt, ["diff", "--no-color", mainBranch || "HEAD"]);
    diff = stdout;
  } catch { /* not a repo / no HEAD */ }

  let untracked: string[] = [];
  try {
    const { stdout } = await git(wt, ["ls-files", "--others", "--exclude-standard"]);
    untracked = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { /* ignore */ }

  const empty = !diff.trim() && untracked.length === 0;
  if (diff.length > cap) diff = diff.slice(0, cap) + "\n…(diff truncated)";
  return { diff, untracked, empty };
}

/**
 * The delta a `Commit all` would record: every tracked change against HEAD,
 * plus the names of the untracked files `git add -A` would sweep in.
 *
 * Deliberately NOT `gitReviewDiff`, which diffs against main and therefore
 * carries work that is ALREADY COMMITTED on a feature branch — evidence a
 * reviewer wants and the worst possible input for a message about what is
 * about to be committed now.
 *
 * Untracked files arrive as NAMES and never as contents. The cap exists
 * because this feeds a prompt, and a new `node_modules` nobody ignored would
 * otherwise be the whole budget; a caller that needs a file's text has
 * `readTextFile`. Truncation is SAID in the text, so a reader downstream can
 * tell a small change from a clipped one.
 *
 * Every failure is an EMPTY result, never a throw: the one caller is advisory
 * and its answer with no diff is "nothing to describe", which is also the
 * honest answer for a directory that stopped being a repo.
 */
export async function gitPendingDiff(wt: string, cap = 24_000): Promise<{ diff: string; stat: string; untracked: string[]; empty: boolean }> {
  let diff = "";
  try {
    const { stdout } = await git(wt, ["diff", "--no-color", "HEAD"]);
    diff = stdout;
  } catch { /* no HEAD yet, or not a repo */ }
  let stat = "";
  try {
    const { stdout } = await git(wt, ["diff", "--stat", "--no-color", "HEAD"]);
    stat = stdout.trim();
  } catch { /* same */ }
  let untracked: string[] = [];
  try {
    const { stdout } = await git(wt, ["ls-files", "--others", "--exclude-standard"]);
    untracked = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { /* ignore */ }
  const empty = !diff.trim() && untracked.length === 0;
  if (diff.length > cap) diff = diff.slice(0, cap) + "\n…(diff truncated here — the rest of the change is not shown)";
  return { diff, stat, untracked, empty };
}

/**
 * A dotenv file that plausibly holds real values — `.env`, `.env.local`,
 * `src/.env.production`. Committed templates (`.env.example` and friends) are
 * not: they're meant to be read. Doesn't match `.envrc`, `env.ts`, `a.env`.
 */
export function isSecretFile(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  if (!/(^|\/)\.env(\.|$)/i.test(p)) return false;
  return !/\.(example|sample|template|dist|defaults?)$/i.test(p);
}

/**
 * Is the file at `full` (inside worktree `wt`) a dotenv file, by the name asked
 * for OR by where it really is? A committed in-repo link `docs/x.txt -> ../.env`
 * passes containment and the name check on the requested path; the resolved
 * target's name gives it away. `full` need not be resolved — it is here.
 */
export function secretAt(wt: string, rel: string, full: string): boolean {
  return isSecretFile(rel) || isSecretFile(relative(realResolve(wt), realResolve(full)));
}

export async function readTextFile(wt: string, rel: string): Promise<string | null> {
  const full = containedReal(wt, rel);
  if (!full) return null;
  // Never render a dotenv file into the app. The secret sheet writes these and
  // promises it won't show them back, and the file/diff viewers are the one
  // place that promise could quietly break. (This is a UI guarantee, not a
  // security boundary — a `claude` session in the repo can read anything.)
  // Committed templates are exempt: they exist to be read and hold no secrets.
  if (secretAt(wt, rel, full)) return null;
  try {
    const buf = await readFile(full);
    if (buf.length > 1024 * 1024) return buf.subarray(0, 1024 * 1024).toString("utf8") + "\n…(truncated)";
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export async function gitStage(wt: string, path: string, unstage: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!pathInTree(wt, path)) return { ok: false, error: "path escapes tree" };
  try {
    if (unstage) await git(wt, ["restore", "--staged", "--", path]).catch(() => git(wt, ["reset", "HEAD", "--", path]));
    else await git(wt, ["add", "--", path]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function gitCommit(wt: string, message: string, all: boolean): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!message.trim()) return { ok: false, error: "empty message" };
  try {
    if (all) await git(wt, ["add", "-A"]);
    const { stdout } = await git(wt, ["commit", "-m", message, "--no-gpg-sign"]);
    return { ok: true, output: stdout.trim() };
  } catch (err: any) {
    return { ok: false, error: (err?.stdout || err?.stderr || String(err)).toString().trim() };
  }
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  /** Checked out in a DIFFERENT worktree — git won't let us switch to it here. */
  inUseElsewhere: boolean;
}

/** Reject branch names that could be read as flags or break the ref grammar. */
function safeBranch(name: string): string | null {
  const n = name.trim();
  if (!n || n.startsWith("-") || /[\s~^:?*\[\\]|\.\.|@\{|^\/|\/$|\/\/|\.lock$/.test(n)) return null;
  return n;
}

const errText = (err: any): string => (err?.stderr || err?.stdout || String(err)).toString().trim();

/** branch name → worktree path for every branch currently checked out somewhere. */
async function worktreeBranchMap(wt: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { stdout } = await git(wt, ["worktree", "list", "--porcelain"]);
    let path = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) {
        const b = line.slice("branch ".length).replace("refs/heads/", "").trim();
        if (b && path) map.set(b, resolve(path));
      }
    }
  } catch { /* single worktree / not a repo */ }
  return map;
}

/** Local branches with current + upstream + cross-worktree usage flags. */
export async function gitBranches(wt: string): Promise<GitBranch[]> {
  try {
    const self = resolve(wt);
    const inUse = await worktreeBranchMap(wt);
    const { stdout } = await git(wt, [
      "for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)", "refs/heads",
    ]);
    const out: GitBranch[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, upstream, head] = line.split("\t");
      const path = inUse.get(name);
      out.push({
        name,
        current: head === "*",
        upstream: upstream || undefined,
        inUseElsewhere: !!path && path !== self,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Switch the worktree to an existing branch. */
export async function gitCheckout(wt: string, branch: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const safe = safeBranch(branch);
  if (!safe) return { ok: false, error: "invalid branch name" };
  try {
    const { stdout, stderr } = await git(wt, ["checkout", safe, "--"]);
    return { ok: true, output: (stderr || stdout || "switched").toString().trim() };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** Create a branch (defaults to switching to it), optionally from a start point. */
export async function gitCreateBranch(
  wt: string,
  name: string,
  opts: { from?: string; checkout?: boolean } = {},
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const safe = safeBranch(name);
  if (!safe) return { ok: false, error: "invalid branch name" };
  const from = opts.from ? safeBranch(opts.from) : null;
  if (opts.from && !from) return { ok: false, error: "invalid start point" };
  const args = opts.checkout === false ? ["branch", safe] : ["checkout", "-b", safe];
  if (from) args.push(from);
  try {
    const { stdout, stderr } = await git(wt, args);
    return { ok: true, output: (stderr || stdout || "created").toString().trim() };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** Delete a local branch. `force` uses -D (drops the unmerged-commits guard). */
export async function gitDeleteBranch(wt: string, name: string, force = false): Promise<{ ok: boolean; output?: string; error?: string }> {
  const safe = safeBranch(name);
  if (!safe) return { ok: false, error: "invalid branch name" };
  try {
    const { stdout, stderr } = await git(wt, ["branch", force ? "-D" : "-d", safe]);
    return { ok: true, output: (stdout || stderr || "deleted").toString().trim() };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/**
 * `git push` with its output streamed to `onData` as it comes — the pre-push
 * hook is the local CI and prints for tens of minutes, and the phone follows it
 * (`pushprogress.ts`). Resolves and rejects like `execFile`: `{ stdout, stderr }`,
 * or an error carrying both.
 */
function gitStreamed(wt: string, args: string[], onData?: (stream: "out" | "err", chunk: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
    const out = { out: "", err: "" };
    for (const k of ["out", "err"] as const) {
      const s = k === "out" ? child.stdout : child.stderr;
      s.setEncoding("utf8");
      s.on("data", (d: string) => {
        // Same ceiling `git()` gives execFile; past it the oldest half goes —
        // `pushFailureText` reads the tail and the `FAILED:` line, both late.
        out[k] = (out[k] + d).length > STREAM_MAX ? (out[k] + d).slice(-STREAM_MAX / 2) : out[k] + d;
        onData?.(k, d);
      });
    }
    child.on("error", (e) => reject(Object.assign(e, { stdout: out.out, stderr: out.err })));
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout: out.out, stderr: out.err });
      else reject(Object.assign(new Error(`git ${args[0]} exited ${code ?? signal}`), { stdout: out.out, stderr: out.err }));
    });
  });
}
const STREAM_MAX = 16 * 1024 * 1024;

export async function gitPush(wt: string, onData?: (stream: "out" | "err", chunk: string) => void): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (pulling.has(wt)) return { ok: false, error: "A pull is running in this worktree — push once it has ended." };
  try {
    // Set upstream automatically on first push of a branch.
    const { stdout, stderr } = await gitStreamed(wt, ["push", "--porcelain"], onData).catch(async (e) => {
      if (/no upstream|set-upstream/i.test(String(e?.stderr || e))) {
        const { stdout: br } = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return gitStreamed(wt, ["push", "--set-upstream", "origin", br.trim()], onData);
      }
      throw e;
    });
    return { ok: true, output: (stdout || stderr || "pushed").toString().trim() };
  } catch (err: any) {
    return { ok: false, error: pushFailureText(String(err?.stdout ?? ""), String(err?.stderr ?? "") || String(err)) };
  }
}

/**
 * One push job per worktree. The pre-push hook is the local CI — build,
 * audit, lint, unit, then the whole e2e suite, tens of minutes — and the
 * phone's request fuse is three. Held open across it, the phone said the push
 * failed at 3:00 while the desktop carried on with nobody left to hear how it
 * ended. So the push is started here and asked after: a second start while
 * one runs joins it, and the last result stays until the next push.
 */
const pushes = new Map<string, GitPushJob>();

interface GitPushJob {
  running: boolean;
  startedAt: number;
  result?: { ok: boolean; output?: string; error?: string; finishedAt: number };
  progress: PushProgress;
  done: Promise<{ ok: boolean; output?: string; error?: string }>;
}

/** Start a push in `wt`, or join the one already running there. */
export function startPush(wt: string): GitPushJob {
  const live = pushes.get(wt);
  if (live?.running) return live;
  const job: GitPushJob = { running: true, startedAt: Date.now(), progress: new PushProgress(), done: null as never };
  job.done = gitPush(wt, (k, d) => job.progress.feed(k, d)).then((r) => {
    job.running = false;
    job.result = { ...r, finishedAt: Date.now() };
    return r;
  });
  pushes.set(wt, job);
  return job;
}

/** The push running or last run in `wt`, or null when there has been none since the host started. */
export function pushState(wt: string): GitPushState | null {
  const job = pushes.get(wt);
  return job ? { running: job.running, startedAt: job.startedAt, result: job.result, progress: job.progress.snapshot() } : null;
}

/** Worktrees with a pull in flight — a second tap joins nothing, it is refused in words. */
const pulling = new Set<string>();

/** The git job running in `wt` right now, for the repo listing's busy chip. */
export function gitRunningIn(wt: string): "push" | "pull" | undefined {
  if (pushes.get(wt)?.running) return "push";
  return pulling.has(wt) ? "pull" : undefined;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Bring the upstream's commits into this branch: fetch, then fast-forward, or
 * — when both sides moved — replay the local commits on top.
 *
 * Every path either lands whole or changes nothing. A fast-forward over a
 * dirty tree is git's own call (it refuses to overwrite an edited file). The
 * diverged case rebases only a tree with no tracked edits, and never with
 * `--autostash`: several sessions edit one working tree at once, and a stash
 * would lift their half-written files out from under them. A rebase that
 * stops on a conflict is aborted, so the branch is back where it was.
 *
 * Refused while a push runs here: the pre-push hook is building and testing
 * this very tree, and moving HEAD under it would test one thing and push another.
 */
export async function gitPull(wt: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (pushes.get(wt)?.running) return { ok: false, error: "A push is running in this worktree — pull once it has ended." };
  if (pulling.has(wt)) return { ok: false, error: "A pull is already running in this worktree." };
  pulling.add(wt);
  try {
    let up: string;
    try {
      up = (await git(wt, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).stdout.trim();
    } catch {
      return { ok: false, error: "This branch has no upstream to pull from. Push it once to set one." };
    }
    try {
      await pexec("git", ["fetch", "--no-tags"], { cwd: wt, timeout: 120_000, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      return { ok: false, error: `The fetch from ${up} failed — nothing was changed.\n\n${errText(err)}` };
    }
    const [ahead, behind] = (await git(wt, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).stdout.trim().split(/\s+/).map(Number);
    const toPush = ahead ? ` ${plural(ahead, "local commit")} still to push.` : "";
    if (!behind) return { ok: true, output: `Already up to date with ${up}.${toPush}` };
    if (!ahead) {
      try {
        await git(wt, ["merge", "--ff-only", "@{u}"]);
      } catch (err) {
        return { ok: false, error: `Could not fast-forward to ${up} — nothing was changed.\n\n${errText(err)}` };
      }
      return { ok: true, output: `Pulled ${plural(behind, "commit")} from ${up}.` };
    }
    const dirty = (await git(wt, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
    if (dirty) {
      return { ok: false, error: `Both sides moved — ${plural(ahead, "local commit")}, ${plural(behind, "commit")} on ${up} — and the working tree has uncommitted edits. Commit them, then pull again. Nothing was changed.` };
    }
    try {
      await git(wt, ["rebase", "@{u}"]);
    } catch (err) {
      await git(wt, ["rebase", "--abort"]).catch(() => undefined);
      return { ok: false, error: `Replaying ${plural(ahead, "local commit")} on top of ${up} hit a conflict, so it was undone — nothing was changed. Resolve it in a session on the desktop.\n\n${errText(err)}` };
    }
    return { ok: true, output: `Pulled ${plural(behind, "commit")} from ${up} and replayed your ${plural(ahead, "local commit")} on top.${toPush}` };
  } finally {
    pulling.delete(wt);
  }
}

/**
 * What a refused push says on the phone. A pre-push hook (the local CI) prints
 * its steps to git's STDOUT, so stderr alone held only node's warnings and
 * git's closing "failed to push" — the step that failed was in the half that
 * was dropped. Both halves, colour codes and node's MODULE_TYPELESS noise out,
 * the hook's `FAILED: <step>` line first, then the last lines that explain it.
 *
 * A hook that PASSED and a remote that then refused is the other case: `--porcelain`
 * writes the refusal (`!\t<ref>\t[rejected] (fetch first)`) to stdout, and 20k of e2e
 * chatter on stderr pushed it out of the tail — the phone showed host warnings and
 * "failed to push" after a green 24-minute check, with the reason nowhere on screen.
 */
export function pushFailureText(stdout: string, stderr: string, tail = 40): string {
  const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .filter((l) => !/^\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\]|^Reparsing as ES module|^To eliminate this warning|^\(Use `node --trace-warnings/.test(l));
  const lines = [...clean(stdout), ...clean(stderr)].filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  const failed = lines.find((l) => /^FAILED: /.test(l));
  const body = lines.slice(-tail).join("\n").trim();
  if (failed) return `The pre-push check stopped it — ${failed.replace(/^FAILED: /, "")}\n\n${body}`;
  const rejected = lines.map((l) => /^!\t(\S+)\t(.*)$/.exec(l)).find(Boolean);
  if (rejected) {
    const ref = rejected[1].split(":").pop()!.replace(/^refs\/heads\//, "");
    const why = rejected[2].trim();
    const passed = lines.some((l) => /^local CI passed\b/.test(l)) ? "The pre-push check passed, but the" : "The";
    const moved = /fetch first|non-fast-forward/.test(why)
      ? ` — ${ref} moved on the remote while this ran. Pull, then push again.`
      : ` — ${why}`;
    return `${passed} remote refused ${ref}${moved}\n\n${rejected[0]}\n${body}`;
  }
  return body;
}

// ── Peer jobs (peers/serve.ts): find a clone by its remote, run a job in a detached worktree ──

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** The URL of `remote` (default origin) in the repo at `dir`, or null — a repo with none identifies nothing. */
export async function gitRemoteUrl(dir: string, remote = "origin"): Promise<string | null> {
  try {
    // The configured URL as written — `remote get-url` would apply `insteadOf` rewrites, and two
    // machines would then key the same repo differently.
    const { stdout } = await pexec("git", ["config", "--get", `remote.${remote}.url`], { cwd: dir, timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** `git fetch origin <branch>` — never touches the working tree. A failure is git's own stderr. */
export async function gitFetchBranch(dir: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!branch || branch.startsWith("-") || /[\s~^:?*[\\]|\.\./.test(branch)) return { ok: false, error: "invalid branch name" };
  try {
    await pexec("git", ["fetch", "--no-tags", "origin", branch], { cwd: dir, timeout: 120_000, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** The full sha of a commit-ish that exists in `dir`, or null. */
export async function gitResolveCommit(dir: string, rev: string): Promise<string | null> {
  if (!rev || rev.startsWith("-")) return null;
  try {
    const { stdout } = await pexec("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: dir, timeout: 10_000 });
    return /^[0-9a-f]{40,64}$/.test(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/** `git worktree add --detach <path> <sha>` from the clone at `dir`. The clone's own tree is untouched. */
export async function gitWorktreeAddDetached(dir: string, path: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await pexec("git", ["worktree", "add", "--detach", path, sha], { cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** `git worktree remove --force` (then prune). Only ever called for a worktree this host made. */
export async function gitWorktreeRemove(dir: string, path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await pexec("git", ["worktree", "remove", "--force", path], { cwd: dir, timeout: 60_000 });
    return { ok: true };
  } catch (err) {
    await pexec("git", ["worktree", "prune"], { cwd: dir, timeout: 30_000 }).catch(() => undefined);
    return { ok: false, error: errText(err) };
  }
}
