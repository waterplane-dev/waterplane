/**
 * The requirements list as a setup row: is it set up in this repo, and how far
 * behind the person's prompts is it?
 *
 * The list itself is built by `scripts/requirements/update.mjs` (a cheap-model
 * extract, a stronger merge, applied as ops, left as an uncommitted diff). This
 * module never runs it and never spends a token: the row SAYS the command, and
 * the phone hands it to that repo's agent as a prompt a person reads first —
 * nothing applies itself. The format, the prompt filter and the preset text are
 * `@waterplane/shared`'s `requirements.mts`, so what this counts is what the build
 * reads.
 *
 * An in-repo extension (`packages/extensions/requirements/`): `index.mts`
 * contributes this row and its fix through `api.setupCheck`/`api.setupFix`;
 * it imports `@waterplane/shared` and node only, never a host module.
 *
 * Opt-in by construction. Not set up is NO ROW at all: the offer lives on the
 * Opt-ins region (`shared/optins.ts`, which runs this extension's `requirements`
 * fix), and a second copy of it here was the same offer twice. Once set up,
 * falling `REQ_STALE_PROMPTS` behind is a warn: the person asked for this list.
 */
import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { open as openAsync, readFile as readFileAsync, readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ComplianceCheck, RequirementsState, TranscriptPrompt } from "@waterplane/shared";
import {
  BRAND, REQ_DIR_REL, claudeConfigDirFromEnv, REQ_SKILL_REL, REQ_STALE_PROMPTS, REQ_STATE_REL,
  countRequirements, promptSeen, requirementsSkillText, transcriptDirName, transcriptPrompt,
} from "@waterplane/shared";

/**
 * The build script, resolved from this module. Two layouts reach it, at two
 * depths: the source (`packages/extensions/requirements/host/`, tsx dev) and
 * the build (`packages/host/dist/extensions/requirements/host/`, see
 * `packages/host/tsconfig.extensions.json`). The first that exists wins; with
 * neither, the source layout's path, so the row can name where it looked.
 * Pinned from both by `packages/host/test/requirementsscript.test.mjs`.
 */
export const UPDATE_SCRIPT_CANDIDATES = [
  "../../../../scripts/requirements/update.mjs",
  "../../../../../../scripts/requirements/update.mjs",
].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
export const UPDATE_SCRIPT = UPDATE_SCRIPT_CANDIDATES.find((p) => existsSync(p)) ?? UPDATE_SCRIPT_CANDIDATES[0]!;
/** How the row and the preset spell the run. `.` because the agent runs it from the repo root. */
export const UPDATE_CMD = `node ${UPDATE_SCRIPT} .`;

// ── counting prompts without re-reading gigabytes ──────────────────────────
//
// The sweep visits every repo every few hours and the app's own transcript folder
// is over a gigabyte. Transcripts are append-only JSONL, so each file is read
// once and afterwards only from the byte it had reached. A file that SHRANK was
// rewritten and is read again from the start.

interface FileScan { size: number; tail: string; prompts: TranscriptPrompt[] }
const scans = new Map<string, FileScan>();

function scanFile(path: string, session: string): TranscriptPrompt[] {
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  let s = scans.get(path);
  if (!s || size < s.size) s = { size: 0, tail: "", prompts: [] };
  if (size > s.size) {
    const buf = Buffer.alloc(size - s.size);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, s.size); } finally { closeSync(fd); }
    ingest(s, buf, size, session);
  }
  scans.set(path, s);
  return s.prompts;
}

/** The appended bytes, folded into the file's scan (shared by the sync and async readers). */
function ingest(s: FileScan, buf: Buffer, size: number, session: string): void {
  const lines = (s.tail + buf.toString("utf8")).split("\n");
  s.tail = lines.pop() ?? ""; // a line still being written
  for (const line of lines) {
    if (!line) continue;
    try { const p = transcriptPrompt(JSON.parse(line), session); if (p) s.prompts.push(p); } catch { /* torn line */ }
  }
  s.size = size;
}

/** `scanFile` off the event loop: same state, same result, `fs.promises`. Two overlapping scans of one file
 *  are harmless (the second finds `s.size` already moved, or re-reads and the size guard below drops it). */
async function scanFileAsync(path: string, session: string): Promise<TranscriptPrompt[]> {
  let size: number;
  try { size = (await statAsync(path)).size; } catch { return []; }
  let s = scans.get(path);
  if (!s || size < s.size) s = { size: 0, tail: "", prompts: [] };
  if (size > s.size) {
    const from = s.size;
    const buf = Buffer.alloc(size - from);
    const fh = await openAsync(path, "r");
    try { await fh.read(buf, 0, buf.length, from); } finally { await fh.close(); }
    const cur = scans.get(path);
    if (cur && cur !== s && cur.size > from) return cur.prompts; // a concurrent scan got there first
    ingest(s, buf, size, session);
  }
  scans.set(path, s);
  return s.prompts;
}

/** The person's prompts in this directory's transcripts after `since` (ISO), deduped as the build dedupes. */
export function promptsSince(worktree: string, since: string | null | undefined): number | null {
  const dir = join(claudeConfigDirFromEnv(process.env, homedir()), "projects", transcriptDirName(worktree));
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const seen = new Set<string>();
  let n = 0;
  for (const f of files) {
    const path = join(dir, f);
    // A file untouched since the mark cannot hold a newer prompt.
    if (since) { try { if (statSync(path).mtime.toISOString() <= since) continue; } catch { continue; } }
    for (const p of scanFile(path, f.replace(/\.jsonl$/, ""))) {
      if (since && p.ts <= since) continue;
      if (!promptSeen(seen, p)) n++;
    }
  }
  return n;
}

/** `promptsSince` off the event loop — the sheet's path. The setup row keeps the sync one (its output is pinned). */
export async function promptsSinceAsync(worktree: string, since: string | null | undefined): Promise<number | null> {
  const dir = join(claudeConfigDirFromEnv(process.env, homedir()), "projects", transcriptDirName(worktree));
  let files: string[];
  try { files = (await readdirAsync(dir)).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const seen = new Set<string>();
  let n = 0;
  for (const f of files) {
    const path = join(dir, f);
    if (since) { try { if ((await statAsync(path)).mtime.toISOString() <= since) continue; } catch { continue; } }
    for (const p of await scanFileAsync(path, f.replace(/\.jsonl$/, ""))) {
      if (since && p.ts <= since) continue;
      if (!promptSeen(seen, p)) n++;
    }
  }
  return n;
}

const GIT_MS = 5000;
const execFileP = promisify(execFile);
/** `commitsThrough` comes from the repo's committed `.state.json`: only a hex sha
 *  reaches git's argv (a `--flag` there would be read as an option), and a value
 *  that is not one answers null — never a count from the wrong anchor. */
const SHA_RE = /^[0-9a-f]{7,40}$/;
const revListArgs = (worktree: string, sha: string | null | undefined): string[] | null => {
  if (sha && !SHA_RE.test(sha)) return null;
  return ["-C", worktree, "rev-list", "--count", sha ? `${sha}..HEAD` : "HEAD"];
};

export function commitsSince(worktree: string, sha: string | null | undefined): number | null {
  const args = revListArgs(worktree, sha);
  if (!args) return null;
  try {
    const n = Number(execFileSync("git", args, { encoding: "utf8", timeout: GIT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export async function commitsSinceAsync(worktree: string, sha: string | null | undefined): Promise<number | null> {
  const args = revListArgs(worktree, sha);
  if (!args) return null;
  try {
    const n = Number((await execFileP("git", args, { encoding: "utf8", timeout: GIT_MS })).stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function readState(worktree: string): RequirementsState | null {
  try { return JSON.parse(readFileSync(join(worktree, REQ_STATE_REL), "utf8")) as RequirementsState; } catch { return null; }
}

export async function readStateAsync(worktree: string): Promise<RequirementsState | null> {
  try { return JSON.parse(await readFileAsync(join(worktree, REQ_STATE_REL), "utf8")) as RequirementsState; } catch { return null; }
}

/**
 * How long the CLI keeps transcripts (`cleanupPeriodDays`, default 30). The list
 * is built FROM them, so a prompt older than this that no run read is gone.
 */
function retentionDays(): number {
  try {
    const v = JSON.parse(readFileSync(join(claudeConfigDirFromEnv(process.env, homedir()), "settings.json"), "utf8")).cleanupPeriodDays;
    return typeof v === "number" && v > 0 ? v : 30;
  } catch { return 30; }
}

/** The row's own "is it set up" rule — the skill file or a state file. */
export const isSetUp = (worktree: string): boolean =>
  existsSync(join(worktree, REQ_SKILL_REL)) || readState(worktree) != null;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ── the row ────────────────────────────────────────────────────────────────

/** The row, or `null` where the list is not set up (the offer is an opt-in, not a row). */
export function requirementsCheck(worktree: string): ComplianceCheck | null {
  const id = "requirements";
  const label = "Requirements list";
  const skill = existsSync(join(worktree, REQ_SKILL_REL));
  const state = readState(worktree);
  if (!skill && !state) return null;
  if (!existsSync(UPDATE_SCRIPT)) {
    return { id, label, status: "warn", fix: null,
      detail: `Set up, but this host cannot find its build script at ${UPDATE_SCRIPT}.` };
  }
  const keep = retentionDays();
  const retention = keep <= 30
    ? ` The CLI deletes transcripts after ${keep} days (cleanupPeriodDays in ~/.claude/settings.json), and this list is built from them — raise it, or build at least that often.`
    : "";
  const built = !!state?.lastRun;
  const prompts = promptsSince(worktree, built ? state?.promptsThrough : null);
  const commits = commitsSince(worktree, built ? state?.commitsThrough : null);
  const since = [prompts == null ? null : plural(prompts, "prompt"), commits == null ? null : plural(commits, "commit")]
    .filter(Boolean).join(" and ");
  if (!built) {
    return { id, label, status: "warn", fix: null,
      detail: `Set up, never built${since ? ` — ${since} to read` : ""}. Build it from the repo root: ${UPDATE_CMD}${retention}` };
  }
  let items = { requested: 0, shipped: 0, superseded: 0, dropped: 0 };
  try {
    const dir = join(worktree, REQ_DIR_REL);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
      const c = countRequirements(readFileSync(join(dir, f), "utf8"));
      items = { requested: items.requested + c.requested, shipped: items.shipped + c.shipped,
        superseded: items.superseded + c.superseded, dropped: items.dropped + c.dropped };
    }
  } catch { /* no area files yet */ }
  const total = items.requested + items.shipped + items.superseded + items.dropped;
  const cost = typeof state!.lastCostUsd === "number" ? ` for $${state!.lastCostUsd.toFixed(2)}` : "";
  const head = `${plural(total, "item")} — ${items.requested} requested, ${items.shipped} shipped, ` +
    `${items.superseded + items.dropped} superseded or dropped. Built ${state!.lastRun!.slice(0, 10)}${cost}` +
    `${since ? `; ${since} since` : ""}.`;
  const behind = (prompts ?? 0) >= REQ_STALE_PROMPTS;
  return behind
    ? { id, label, status: "warn", fix: null, detail: `${head} Update it from the repo root: ${UPDATE_CMD}${retention}` }
    : { id, label, status: "pass", fix: null, detail: head + retention };
}

/**
 * The `requirements` fix: the preset and an index stub, each only when absent.
 * No model call, no `.state.json` — the first build writes that, and its
 * absence is how the row tells "set up" from "built".
 */
export function scaffoldRequirements(worktree: string): string[] {
  const wrote: string[] = [];
  const skill = join(worktree, REQ_SKILL_REL);
  if (!existsSync(skill)) {
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, requirementsSkillText(UPDATE_CMD));
    wrote.push(REQ_SKILL_REL);
  }
  const readme = join(worktree, REQ_DIR_REL, "README.md");
  if (!existsSync(readme)) {
    mkdirSync(dirname(readme), { recursive: true });
    writeFileSync(readme, `# Requirements\n\nNot built yet. ${BRAND.name}'s setup checklist says how to build it; the format is in ` +
      `\`${REQ_SKILL_REL}\`.\n`);
    wrote.push(`${REQ_DIR_REL}/README.md`);
  }
  return wrote;
}
