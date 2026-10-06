/**
 * What the requirements sheet reads: the area files as items, and how far behind the list is —
 * computed the way the setup row computes it (`requirements.mts`), so the sheet and the row cannot
 * say two different numbers. Reads only; it never runs the build and never spends a token.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginRepoScope } from "@waterplane/shared";
import { REQ_DIR_REL, REQ_STALE_PROMPTS, REQ_STATE_REL, claudeConfigDirFromEnv, parseRequirementsArea, transcriptDirName } from "@waterplane/shared";
import type { ReqCommit, ReqItem, ReqList, ReqSummary } from "../shared/methods.mjs";
import { UPDATE_SCRIPT, commitsSinceAsync, isSetUp, promptsSinceAsync, readState, readStateAsync } from "./requirements.mjs";

const execFileP = promisify(execFile);

/** Every area file, in name order. A README is the index, never an area. */
export function readItems(scope: PluginRepoScope): { items: ReqItem[]; areas: string[] } {
  const names = (scope.listDir(REQ_DIR_REL) ?? [])
    .filter((e) => !e.dir && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name).sort();
  const items: ReqItem[] = [];
  const areas: string[] = [];
  for (const n of names) {
    const area = n.replace(/\.md$/, "");
    areas.push(area);
    items.push(...parseRequirementsArea(area, scope.readFile(`${REQ_DIR_REL}/${n}`, 2_000_000) ?? ""));
  }
  return { items, areas };
}

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The subject and date of each sha an item names, in ONE `git log --no-walk` (async, 5 s fuse). A sha
 * this repo does not know is ABSENT (the sheet says so); any failure is `{}`, never a partial guess.
 */
export async function commitFacts(worktree: string, shas: readonly string[]): Promise<Record<string, ReqCommit>> {
  const uniq = [...new Set(shas.filter((s) => SHA.test(s)))].slice(0, 400);
  if (!uniq.length) return {};
  let out: string;
  try {
    out = (await execFileP("git", ["-C", worktree, "log", "--no-walk", "--ignore-missing", "--format=%H%x09%cs%x09%s", ...uniq],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4_000_000 })).stdout;
  } catch { return {}; }
  const lines = out.split("\n").filter(Boolean).map((l) => l.split("\t"));
  const res: Record<string, ReqCommit> = {};
  for (const sha of uniq) {
    const hit = lines.find((l) => l[0]!.startsWith(sha));
    if (hit) res[sha] = { sha: hit[0]!, date: hit[1] ?? "", subject: hit.slice(2).join("\t") };
  }
  return res;
}

/** The launcher chip's answer: area files only, no transcript scan (it is asked once per repo on mount). */
export function summaryOf(scope: PluginRepoScope): ReqSummary {
  const setUp = isSetUp(scope.worktree);
  const built = !!readState(scope.worktree)?.lastRun;
  const { items } = readItems(scope);
  return { setUp, built, requested: items.filter((i) => i.status === "requested").length, total: items.length };
}

/** Everything the list reads that can change, as one string: the area files, the state file, every
 *  transcript's size+mtime (an append moves the file, not the directory) and HEAD. Stats only — no reads. */
async function signature(scope: PluginRepoScope): Promise<string> {
  const wt = scope.worktree;
  const st = async (p: string) => { try { const s = await statAsync(p); return `${s.size}:${s.mtimeMs}`; } catch { return "-"; } };
  const names = (scope.listDir(REQ_DIR_REL) ?? []).filter((e) => !e.dir && e.name.endsWith(".md") && e.name !== "README.md").map((e) => e.name).sort();
  const tdir = join(claudeConfigDirFromEnv(process.env, homedir()), "projects", transcriptDirName(wt));
  let tfiles: string[] = [];
  try { tfiles = (await readdirAsync(tdir)).filter((f) => f.endsWith(".jsonl")).sort(); } catch { /* none */ }
  const head = await execFileP("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).then((r) => r.stdout.trim(), () => "?");
  const parts = await Promise.all([
    ...names.map(async (n) => `${n}=${await st(join(wt, REQ_DIR_REL, n))}`),
    st(join(wt, REQ_STATE_REL)),
    ...tfiles.map(async (f) => `${f}=${await st(join(tdir, f))}`),
  ]);
  return `${head}|${parts.join("|")}`;
}

const cache = new Map<string, { sig: string; list: Promise<ReqList> }>();

/** The sheet's list, off the event loop and memoised on what it reads (`signature`): a repeat with nothing
 *  changed costs a few stats and one `rev-parse`. `setUp`/`scriptFound` are cheap and always fresh. */
export async function listOf(scope: PluginRepoScope): Promise<ReqList> {
  const wt = scope.worktree;
  const sig = await signature(scope);
  let hit = cache.get(wt);
  if (!hit || hit.sig !== sig) {
    const list = compute(scope);
    hit = { sig, list };
    cache.set(wt, hit);
    list.catch(() => { if (cache.get(wt) === hit) cache.delete(wt); });
  }
  const list = await hit.list;
  return { ...list, setUp: isSetUp(wt), scriptFound: existsSync(UPDATE_SCRIPT) };
}

async function compute(scope: PluginRepoScope): Promise<ReqList> {
  const wt = scope.worktree;
  const state = await readStateAsync(wt);
  const built = !!state?.lastRun;
  const { items, areas } = readItems(scope);
  const [promptsBehind, commitsBehind, commits] = await Promise.all([
    promptsSinceAsync(wt, built ? state?.promptsThrough : null),
    commitsSinceAsync(wt, built ? state?.commitsThrough : null),
    commitFacts(wt, items.flatMap((i) => i.shipped)),
  ]);
  return {
    repoName: scope.name,
    setUp: isSetUp(wt),
    scriptFound: existsSync(UPDATE_SCRIPT),
    lastRun: state?.lastRun ?? null,
    lastCostUsd: typeof state?.lastCostUsd === "number" ? state.lastCostUsd : null,
    promptsBehind, commitsBehind,
    stalePrompts: REQ_STALE_PROMPTS,
    items, areas, commits,
  };
}
