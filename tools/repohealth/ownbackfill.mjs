/**
 * Reading a repo's OWN readings back over older commits — on request only.
 *
 * `update` takes the repo's own readings (`own.mjs`) at HEAD and nowhere else,
 * so a reading's history starts the day it is declared and a tile needs a
 * second day before it can draw a curve. `own-backfill` is the person's tap
 * that fills in the days already in the series instead of waiting for new
 * ones (R-metrics-065).
 *
 * ── Which rows ─────────────────────────────────────────────────────────────
 *
 * The plot draws one row per DAY (`perDay`: the day's last commit), so the
 * candidates are those day rows, newest first, that carry no measured `own`
 * (none at all, or `notRun` — measured while the commands were unapproved).
 * Reading back twenty commits of one afternoon would add no point to any
 * chart. HEAD is never one: its reading is `update`'s, taken in the checkout.
 * A row this has filled carries `own.backfilled`, so a second run moves on to
 * older days and never re-runs one it already read (idempotent). A reading
 * that failed there stays failed, with its reason: asking again would run the
 * same command on the same tree.
 *
 * `--retry` (`retry: true`) picks the OTHER rows: older day rows that already
 * have an `own` but with at least one reading that FAILED to run (`exited …`,
 * `did not finish`, `could not start`, `printed more than` — never "not
 * declared", "HEAD-only" or "not run — …", which were left out on purpose).
 * Each is re-measured and MERGED: a key that now has a number takes it, a key
 * that had one and fails now keeps the old number, the rest take the new
 * entry; `own.retried` marks the day so later taps reach untried days first.
 *
 * ── What the scratch copy gets ─────────────────────────────────────────────
 *
 * A fresh checkout has no `node_modules` and no build, so a command that needs
 * either fails there for a reason that is the scratch's, not the commit's. The
 * declaration's `scratch` (`own.mjs`) says what to add: `linkNodeModules`
 * (a real directory of symlinks to the checkout's; a workspace package is
 * linked to the SCRATCH's own copy, never today's) and a `prepare` argv, run
 * once per commit before its readings. Both come from the approved working-
 * tree file (the approval covers them), only here, never at HEAD. A prepare
 * that fails is `own.prepare`, one sentence; the readings run anyway and keep
 * their own reasons. Removal unlinks the links first and never follows them.
 *
 * ── What runs, and where ───────────────────────────────────────────────────
 *
 * Each commit is checked out into ONE scratch detached worktree under the OS
 * tmpdir (hooks off, so no post-checkout hook of the repo's runs), cleaned
 * between commits, and removed in a `finally`. A kill leaves no finally, so
 * the daemon removes it right after a kill, and every run starts by removing
 * any scratch worktree of ours a previous run left behind (`sweepScratch`) and
 * pruning git's record of it — same prefix, same tmpdir, nothing else.
 *
 * The declaration is THAT commit's (`measureOwn` reads it out of the commit),
 * and a reading runs there only when its argv is the one this desktop approved
 * — the working tree's file, which is what the host's approval hashed. A
 * changed command at an old commit is a command nobody approved: ABSENT, with
 * that reason. So is a reading the repo marks `"backfill": false` (machine
 * state, true only of today's desktop), a reading HEAD declares that the
 * commit did not, and every failure `runReading` already words. Never 0.
 *
 * ── Budgets ────────────────────────────────────────────────────────────────
 *
 * OWN_MAX and OWN_TIMEOUT_MS hold per commit as they do at HEAD; the whole run
 * has `budgetMs` on top. A commit whose readings the budget cut is DISCARDED
 * (not written — a timeout the budget caused is not the reading's failure) and
 * the run stops; the next tap carries on from there. Each finished commit is
 * written at once (atomic rewrite), so a killed run keeps what it read.
 *
 * Only the `own` field of a row is ever written. Every other field is the row
 * as it was, re-serialised by `stringifyRow` exactly as `replaceRow` does.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { OWN_FILE, OWN_TIMEOUT_MS, execArgv, measureOwn, parseDeclaration, readingEnv } from "./own.mjs";
import { stringifyRow } from "./series.mjs";
import { BRAND } from "@waterplane/shared";

/** Commits read back when the caller names no number. */
export const OWN_BACKFILL_DEFAULT = 20;
/** The most one run reads back, whatever was asked. */
export const OWN_BACKFILL_MAX = 60;
/** The whole run's wall clock when the caller names none — under the daemon's 180 s cap. */
export const OWN_BACKFILL_BUDGET_MS = 150_000;
/** Every scratch worktree's directory name starts with this; `sweepScratch` removes only these. */
export const SCRATCH_PREFIX = `${BRAND.slug}-own-backfill-`;

export const NOT_DECLARED = "not declared at this commit";
export const NOT_APPROVED = "not run — the command at this commit is not the one this desktop approved";
export const HEAD_ONLY = "not read back — the repo marks this reading HEAD-only (\"backfill\": false)";
const BUDGET_CUT = "budget";

/** A count from the command line, clamped: absent or junk is the default, never 0. */
export function clampCommits(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return OWN_BACKFILL_DEFAULT;
  return Math.min(OWN_BACKFILL_MAX, Math.floor(n));
}

/** A budget from the command line, clamped to 1 s – 10 min. */
export function clampBudget(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return OWN_BACKFILL_BUDGET_MS;
  return Math.min(600_000, Math.max(1_000, Math.floor(n)));
}

/** A row with no MEASURED own readings: none at all, or the unapproved `notRun` shape. */
export const lacksOwn = (r) => !r?.own || typeof r.own !== "object" || !!r.own.notRun;

/**
 * The rows to read back: day rows (as `perDay` hands them, oldest first),
 * newest first, without measured own readings, HEAD's excluded, at most `n`.
 * `left` is how many such rows there are in all, so a reply can say what one
 * more tap would still find.
 */
export function backfillTargets(dayRows, headSha, n) {
  const all = dayRows.filter((r) => r && typeof r.sha === "string" && r.sha !== headSha && lacksOwn(r)).reverse();
  return { picked: all.slice(0, n), left: all.length };
}

/** A reading's reason that is a RUN failure — the command ran (or tried to) and did not give a number. Not "not declared", "HEAD-only" or "not run — …". */
const RUN_FAILURE = /^(exited |did not finish|could not start|printed more than)/;

/** Did this stored reading fail to run (as opposed to being left out on purpose)? */
export const failedOwnReading = (r) =>
  !!r && typeof r === "object" && typeof r.value !== "number" && typeof r.reason === "string" && RUN_FAILURE.test(r.reason);

/** A day row whose stored own readings include at least one failed run — what `--retry` re-reads. */
export const retryableDay = (row) =>
  !!row?.own && typeof row.own === "object" && !row.own.notRun && Array.isArray(row.own.readings) && row.own.readings.some(failedOwnReading);

/**
 * Rows to RE-read: day rows (oldest first, as `perDay` gives them) with a
 * failed reading, HEAD's excluded. Newest first, but a day already retried
 * (`own.retried`) goes after the ones never retried, so a day that keeps
 * failing cannot hold the cap against older days. `left` = never-retried days.
 */
export function retryTargets(dayRows, headSha, n) {
  const all = dayRows.filter((r) => r && typeof r.sha === "string" && r.sha !== headSha && retryableDay(r)).reverse();
  const ordered = [...all.filter((r) => !r.own.retried), ...all.filter((r) => r.own.retried)];
  return { picked: ordered.slice(0, n), left: all.filter((r) => !r.own.retried).length };
}

/**
 * The stored own of a retried day: a key that now has a number takes it; a key
 * that had a number and fails now keeps the old one; a key that failed before and
 * is only cut by the budget keeps the old failure; the rest take the new entry (a standing
 * "not run": not approved, HEAD-only … replaces the old failure, or the day never left the retry set). Keys only the old entry had are kept. Pure.
 */
export function mergeRetried(old, fresh) {
  const oldBy = new Map((old?.readings ?? []).map((r) => [r.key, r]));
  const seen = new Set();
  const readings = (fresh.readings ?? []).map((r) => {
    seen.add(r.key);
    const o = oldBy.get(r.key);
    if (typeof r.value === "number" || !o) return r;
    // No new number: the old number stays, and so does an old FAILED run when the fresh entry is
    // only the budget cut — nothing ran, and the next retry should still try it. Any other "not run"
    // (not approved, HEAD-only, …) is the standing state: it replaces the failure, so the day
    // leaves the retry set instead of costing a checkout and a prepare on every tap.
    return typeof o.value === "number" || (failedOwnReading(o) && r.reason === BUDGET_CUT) ? o : r;
  });
  for (const o of old?.readings ?? []) if (!seen.has(o.key)) readings.push(o);
  return { ...fresh, readings, backfilled: true, retried: true };
}

/**
 * The series text with `own` replaced on the LAST line for each sha in
 * `ownBySha` (a Map). Every other line, and every other field of those lines,
 * is left as it was. Pure.
 */
export function spliceOwn(text, ownBySha) {
  const lines = text.split("\n");
  const todo = new Map(ownBySha);
  for (let i = lines.length - 1; i >= 0 && todo.size; i--) {
    if (!lines[i].trim()) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!todo.has(row?.sha)) continue;
    lines[i] = stringifyRow({ ...row, own: todo.get(row.sha) });
    todo.delete(row.sha);
  }
  return lines.join("\n");
}

function writeOwn(seriesPath, ownBySha) {
  const text = readFileSync(seriesPath, "utf8");
  const tmp = `${seriesPath}.tmp-${process.pid}`;
  writeFileSync(tmp, spliceOwn(text, ownBySha), "utf8");
  renameSync(tmp, seriesPath);
}

/** The approved argv per key — the WORKING TREE's declaration, which is what
 *  the host's approval hashed (`repohealthapproval.ts`). Null: none readable. */
export function approvedRuns(text) {
  if (typeof text !== "string") return null;
  const d = parseDeclaration(text);
  if (d.refused || d.none) return null;
  const out = new Map();
  for (const r of d.readings) if (Array.isArray(r.run)) out.set(r.key, JSON.stringify(r.run));
  return out;
}

/** The scratch needs (`linkNodeModules`, `prepare`) of the WORKING TREE's declaration — the one the host approved; an older commit's file never supplies them. Null: none. */
export function approvedScratch(text) {
  if (typeof text !== "string") return null;
  const d = parseDeclaration(text);
  return d.refused || d.none || !d.scratch ? null : d.scratch;
}

/** Keys a declaration marks `"backfill": false` — read off the raw file, a field `parseDeclaration` ignores. */
export function headOnlyKeys(text) {
  const out = new Set();
  try {
    const doc = JSON.parse(text);
    for (const e of Array.isArray(doc?.readings) ? doc.readings : []) {
      if (e && typeof e.key === "string" && e.backfill === false) out.add(e.key);
    }
  } catch { /* nothing marked */ }
  return out;
}

/** Why a declared reading is not run at an older commit, or null: run it. */
export function backfillSkip(d, approved, headOnly) {
  if (headOnly.has(d.key)) return HEAD_ONLY;
  if (!Array.isArray(d.run) || d.invalid) return null; // `runReading` words its own refusal
  if (approved.get(d.key) !== JSON.stringify(d.run)) return NOT_APPROVED;
  return null;
}

/** HEAD's readings the commit did not declare, as absent entries — no `gate`,
 *  so the index never counts an unknown gate the commit never had. */
function notDeclared(headReadings, have) {
  return headReadings.filter((d) => !have.has(d.key)).map((d) => ({
    key: d.key, name: d.name, means: d.means, better: d.better, unit: d.unit, value: null, reason: NOT_DECLARED,
  }));
}

/** A git environment without whatever a hook exported (`GIT_DIR` would point every call at another repo). */
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function gitRun(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * The scratch name carries its run's pid (`<prefix><pid>-xxxxxx`), so a sweep
 * for one checkout never removes the LIVE scratch of a run for another
 * checkout of the same repo (the listing is repo-wide, single-flight is per
 * path). A name without a pid, or of a dead or our own process, is a leftover.
 */
export function scratchOwnerAlive(name) {
  const m = new RegExp(`^${SCRATCH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)-`).exec(name);
  if (!m) return false;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

const realTmp = () => { try { return realpathSync(tmpdir()); } catch { return tmpdir(); } };

/**
 * Remove every scratch worktree of ours this repo still lists (a SIGKILLed run's).
 * Only our own paths: never a repo-wide `git worktree prune`, which would also
 * delete git's record of a worktree this git merely cannot see (a Windows path
 * under WSL, an unmounted volume). `remove -f -f` also takes a locked one or one
 * whose folder is already gone. Returns how many.
 */
export function sweepScratch(root) {
  let listed = "";
  try { listed = gitRun(root, ["worktree", "list", "--porcelain"]); } catch { return 0; }
  const base = realTmp();
  let n = 0;
  for (const line of listed.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (!basename(p).startsWith(SCRATCH_PREFIX)) continue;
    if (!(p.startsWith(base + sep) || p.startsWith(tmpdir() + sep))) continue;
    if (scratchOwnerAlive(basename(p))) continue;
    try { gitRun(root, ["worktree", "remove", "-f", "-f", p]); } catch { /* the rm below */ }
    try { rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
    n++;
  }
  return n;
}

/**
 * Give the scratch copy a `node_modules`: a REAL directory whose entries are
 * symlinks to the checkout's own (one level into `@scope/` directories too),
 * so a removal of the scratch can only ever unlink them. An entry that is
 * itself inside the repo (a workspace package: `node_modules/@x/shared` →
 * `packages/shared`) is linked to the same path inside the scratch, so the
 * commit's own code runs, never today's. Returns null, or a sentence.
 */
export function linkNodeModules(root, dir) {
  const src = join(root, "node_modules");
  let rootReal;
  try { rootReal = realpathSync(root); } catch { return "could not link node_modules: the checkout is not readable"; }
  if (!existsSync(src)) return "could not link node_modules: the checkout has none";
  const dst = join(dir, "node_modules");
  try {
    unlinkNodeModules(dir);
    mkdirSync(dst, { recursive: true });
    const target = (from) => {
      let real;
      try { real = realpathSync(from); } catch { return from; }
      const rel = relative(rootReal, real);
      const inside = rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !isAbs(rel)
        && rel !== "node_modules" && !rel.startsWith(`node_modules${sep}`);
      return inside ? join(dir, rel) : from;
    };
    for (const name of readdirSync(src)) {
      const from = join(src, name);
      let st;
      try { st = lstatSync(from); } catch { continue; }
      if (name.startsWith("@") && st.isDirectory()) {
        mkdirSync(join(dst, name), { recursive: true });
        for (const sub of readdirSync(from)) symlinkSync(target(join(from, sub)), join(dst, name, sub));
      } else {
        symlinkSync(target(from), join(dst, name));
      }
    }
  } catch (err) {
    return `could not link node_modules: ${err.message}`;
  }
  return null;
}
const isAbs = (p) => /^([A-Za-z]:)?[\\/]/.test(p);

/**
 * Take `<dir>/node_modules` down by UNLINKING what `linkNodeModules` made —
 * never a recursive removal through it. Anything that is not a symlink or one
 * of our two levels of plain directories is left for the caller's `rm`, which
 * does not follow symlinks either; this is the belt beside that.
 */
export function unlinkNodeModules(dir) {
  const nm = join(dir, "node_modules");
  let st;
  try { st = lstatSync(nm); } catch { return; }
  if (st.isSymbolicLink()) { try { unlinkSync(nm); } catch { /* the rm */ } return; }
  if (!st.isDirectory()) return;
  for (const name of safeList(nm)) {
    const p = join(nm, name);
    let s;
    try { s = lstatSync(p); } catch { continue; }
    if (s.isSymbolicLink()) { try { unlinkSync(p); } catch { /* the rm */ } continue; }
    if (!s.isDirectory()) continue;
    for (const sub of safeList(p)) {
      try { if (lstatSync(join(p, sub)).isSymbolicLink()) unlinkSync(join(p, sub)); } catch { /* the rm */ }
    }
    try { rmdirSync(p); } catch { /* not empty: the rm decides */ }
  }
  try { rmdirSync(nm); } catch { /* not empty: the rm decides */ }
}
const safeList = (d) => { try { return readdirSync(d); } catch { return []; } };

/**
 * Run `fn(dir)` with a scratch detached worktree of `root`, removed afterwards
 * on a return or a throw. A signal is NOT caught: the run is synchronous, so a
 * JS handler would only run after the reading finished — it would turn the
 * daemon's SIGTERM into a wait for its SIGKILL. A killed run's worktree is
 * removed by the daemon right after the kill (host `repohealth.ts`
 * `sweepOwnScratch`) and by the next run's `sweepScratch`.
 */
export function withScratch(root, firstSha, fn) {
  const dir = mkdtempSync(join(realTmp(), `${SCRATCH_PREFIX}${process.pid}-`));
  const remove = () => {
    unlinkNodeModules(dir);
    try { gitRun(root, ["worktree", "remove", "-f", "-f", dir]); } catch { /* the rm below */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  try {
    gitRun(root, ["worktree", "add", "--detach", "--force", dir, firstSha]);
    return fn(dir);
  } finally {
    remove();
  }
}

/** The most a commit's `prepare` may take, within what the run has left. */
export const PREPARE_TIMEOUT_MS = 120_000;
const PREPARE_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Make the scratch copy ready for the commit's readings, from the APPROVED
 * working-tree `scratch` declaration: link `node_modules`, then run `prepare`
 * (argv, no shell, the minimal env, cwd the scratch, its group killed on a
 * timeout). Null when it all worked; else ONE sentence — never a throw. The
 * readings run regardless and keep their own reasons.
 */
export function prepareScratch(dir, root, scratch, timeoutMs, opts = {}) {
  if (scratch.linkNodeModules) {
    const why = linkNodeModules(root, dir);
    if (why) return why;
  }
  if (!scratch.prepare) return null;
  const got = execArgv(dir, scratch.prepare, {
    timeoutMs: Math.max(1, timeoutMs), env: opts.env ?? readingEnv(), spawn: opts.spawn, maxBuffer: PREPARE_MAX_OUTPUT,
  });
  return got.reason ? `prepare (${scratch.prepare.join(" ")}) ${got.reason}` : null;
}

/**
 * Read back up to `commits` day rows. Returns `{ refused }` (a sentence, the
 * engine exits 3) or the summary the subcommand prints.
 *
 * @param {object} a
 * @param {string} a.root           the measured repo
 * @param {string} a.seriesPath     its series file
 * @param {object[]} a.dayRows      `perDay` of the live rows, oldest first
 * @param {string} a.headSha        first-parent HEAD
 * @param {{ readFileAt: Function }} a.git
 */
export function runOwnBackfill({
  root, seriesPath, dayRows, headSha, git, commits = OWN_BACKFILL_DEFAULT, budgetMs = OWN_BACKFILL_BUDGET_MS,
  now = Date.now, onProgress = () => {}, readingOpts = {}, retry = false,
}) {
  const started = now();
  const headText = git.readFileAt(root, headSha, OWN_FILE);
  const head = headText === null ? null : parseDeclaration(headText);
  if (!head || head.none || head.refused || !head.readings.length) {
    return { refused: head?.refused
      ? `HEAD's ${OWN_FILE} cannot be read (${head.refused}) — there is nothing to read back until it can.`
      : `HEAD declares no readings of its own in ${OWN_FILE} — there is nothing to read back.` };
  }
  let wtText = null;
  try { wtText = readFileSync(join(root, OWN_FILE), "utf8"); } catch { /* none */ }
  const approved = approvedRuns(wtText);
  if (!approved) {
    return { refused: `${OWN_FILE} in the working tree declares no readings this desktop could have approved — nothing is read back.` };
  }
  const headOnly = headOnlyKeys(wtText);
  const scratch = approvedScratch(wtText);

  const swept = sweepScratch(root);
  // Days from before the declaration existed cost no checkout and do not count
  // against the commit cap, so the cap is applied below, not here.
  const { picked: all, left } = (retry ? retryTargets : backfillTargets)(dayRows, headSha, Infinity);
  const summary = { asked: commits, eligible: left, read: 0, values: 0, absent: 0, stopped: null, swept, left, ...(retry ? { retried: 0 } : {}) };
  if (!all.length) return summary;
  const total = Math.min(all.length, commits);

  const remaining = () => budgetMs - (now() - started);
  let cut = false;
  const opts = {
    ...readingOpts,
    get timeoutMs() { return Math.max(1, Math.min(readingOpts.timeoutMs ?? OWN_TIMEOUT_MS, remaining())); },
    skip(d) {
      if (remaining() < 1_000) { cut = true; return BUDGET_CUT; }
      return backfillSkip(d, approved, headOnly);
    },
  };
  const store = (row, own) => {
    writeOwn(seriesPath, new Map([[row.sha, own]]));
    summary.read++;
    if (retry) summary.retried++;
    if (!retry || !row.own?.retried) summary.left--;
    // A retry counts what THIS run changed: a number the old entry did not hold, and a reading
    // that is still a failed run — never the numbers carried over, never the left-out ones.
    const oldBy = new Map(retry ? (row.own?.readings ?? []).map((r) => [r.key, r]) : []);
    for (const r of own.readings ?? []) {
      if (retry) {
        if (typeof r.value === "number") { if (typeof oldBy.get(r.key)?.value !== "number") summary.values++; }
        else if (failedOwnReading(r)) summary.absent++;
      } else if (typeof r.value === "number") summary.values++;
      else summary.absent++;
    }
  };
  const undeclared = () => ({ file: OWN_FILE, readings: notDeclared(head.readings, new Set()), notDeclared: `this commit declares no readings of its own`, backfilled: true });

  withScratch(root, headSha, (dir) => {
    let checked = 0;
    for (const row of all) {
      if (remaining() < 1_000) { summary.stopped = "budget"; break; }
      if (git.readFileAt(root, row.sha, OWN_FILE) === null) {
        if (!retry) store(row, undeclared()); // a retried day keeps what it has
        continue;
      }
      if (checked >= commits) break;
      onProgress(checked, total, row);
      checked++;
      gitRun(dir, ["checkout", "--detach", "--force", "--quiet", row.sha]);
      unlinkNodeModules(dir);
      gitRun(dir, ["clean", "-ffdxq"]);
      cut = false;
      const prepareFailed = scratch ? prepareScratch(dir, root, scratch, Math.min(PREPARE_TIMEOUT_MS, remaining()), readingOpts) : null;
      const measured = measureOwn(dir, row.sha, git, opts);
      const timedOutByBudget = remaining() <= 0
        && (measured?.readings ?? []).some((r) => typeof r.reason === "string" && /^did not finish/.test(r.reason));
      // A first commit that cannot fit the whole budget is stored with what it
      // did read and the rest ABSENT with their reason — discarding it would
      // leave every later run stuck on the same commit.
      const forced = (cut || timedOutByBudget) && checked === 1 && measured !== undefined;
      if ((cut || timedOutByBudget) && !forced) { summary.stopped = "budget"; break; }
      let own;
      if (measured === undefined) {
        if (retry) continue;
        own = undeclared();
      } else if (measured.refused) {
        if (retry) continue;
        own = { ...measured, backfilled: true };
      } else {
        const have = new Set(measured.readings.map((r) => r.key));
        own = { ...measured, readings: [...measured.readings, ...notDeclared(head.readings, have)], backfilled: true };
        if (prepareFailed) own.prepare = prepareFailed;
      }
      if (retry) own = mergeRetried(row.own, own);
      store(row, own);
      if (forced) { summary.stopped = "budget"; break; }
    }
  });
  onProgress(Math.min(summary.read, total), total, null);
  return summary;
}
