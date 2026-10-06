/** Git review operations for a worktree: status, diff, stage, commit, push. */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { contained } from "./paths.js";
import { execFileP as pexec } from "./proc.js";


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
export async function countChangedFiles(wt: string): Promise<number> {
  try {
    const { stdout } = await git(wt, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return stdout.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
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
  const full = pathInTree(wt, rel);
  if (!full || isSecretFile(rel)) return null;
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

export async function readTextFile(wt: string, rel: string): Promise<string | null> {
  const full = pathInTree(wt, rel);
  if (!full) return null;
  // Never render a dotenv file into the app. The secret sheet writes these and
  // promises it won't show them back, and the file/diff viewers are the one
  // place that promise could quietly break. (This is a UI guarantee, not a
  // security boundary — a `claude` session in the repo can read anything.)
  // Committed templates are exempt: they exist to be read and hold no secrets.
  if (isSecretFile(rel)) return null;
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
    const { stdout, stderr } = await git(wt, ["checkout", safe]);
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

export async function gitPush(wt: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    // Set upstream automatically on first push of a branch.
    const { stdout, stderr } = await git(wt, ["push", "--porcelain"]).catch(async (e) => {
      if (/no upstream|set-upstream/i.test(String(e?.stderr || e))) {
        const { stdout: br } = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return git(wt, ["push", "--set-upstream", "origin", br.trim()]);
      }
      throw e;
    });
    return { ok: true, output: (stdout || stderr || "pushed").toString().trim() };
  } catch (err: any) {
    return { ok: false, error: (err?.stderr || err?.stdout || String(err)).toString().trim() };
  }
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
