/**
 * The repo-health engine's raw step results folded into one `HealthDoc` — PURE apart from
 * `gitOnPath` / `gitCandidates` / `isShallow`, which stat the filesystem and spawn nothing, and
 * `pickGit`, which runs only the probe it is handed.
 *
 * The engine states, this reads: every number comes off the engine's own JSON through the shared
 * parsers the phone uses (`parseRepoHealthStatus`, `parseRepoHealthPlot`, `classifyExit`, …), and
 * every failure is the engine's own sentence or one of ours — never a number. Mirrors the host's
 * `packages/host/src/repohealth.ts` (`readStatus`, `readPlot`, `runRefresh`), minus narrate/html.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  classifyExit, parseRepoHealthMeasure, parseRepoHealthPlot, parseRepoHealthProgress,
  parseRepoHealthStatus, parseUpdateSummary, secondsToMs,
} from "@waterplane/shared";
import type { RepoHealthOutcome } from "@waterplane/shared";
import type { HealthDoc } from "../protocol.js";

/** What one engine step left behind. `code: null` = it never exited on its own. */
export interface HealthStepResult { stdout: string; stderr: string; code: number | null; timedOut?: boolean; cancelled?: boolean }
/** The last `update`, with when it ended and how long it took. */
export interface HealthUpdateResult extends HealthStepResult { at: number; ms: number }

export interface HealthFoldInput {
  folder: string;
  /** null = status was not read (nothing to fold: the doc is null). */
  status: HealthStepResult | null;
  /** null = plot was not read (status failed, or there was no series to draw). */
  plot: HealthStepResult | null;
  /** The last `update` this window, or null when none ran. */
  update: HealthUpdateResult | null;
  shallow: boolean | null;
  readAt: number;
  stepMs: number;
  seriesFile: string;
  /** Where the series came from (`healthsource.ts`); absent = our own, whole repo, no scopes. */
  source?: { kind: "own" | "repo"; scope: string | null; scopes: string[]; repoFile: string | null };
  /** `seriestail.ts`'s sentence when a torn last row was dropped; absent/null otherwise. */
  tailNote?: string | null;
}

export const NO_GIT_WHY =
  "git is not on this extension host's PATH, so the folder's history cannot be read. Install git, or set the git.path setting.";
export const NOT_READ_WHY = "This folder's repo health has not been read yet.";

const secs = (ms: number): number => Math.round(ms / 1000);

/** `head` and `behind` off the status line — host `headAndBehind`, re-implemented (not exported there). */
export function headAndBehind(stdout: string): { head: { sha: string; ts: number } | null; behind: number | null } {
  let raw: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch { /* not the line, keep looking */ }
  }
  if (!raw) return { head: null, behind: null };
  const h = raw.head as Record<string, unknown> | null | undefined;
  const sha = h && typeof h === "object" ? h.sha : null;
  const ts = h && typeof h === "object" ? h.ts : null;
  const head = typeof sha === "string" && sha.length > 0 && typeof ts === "number" && Number.isFinite(ts) && ts > 0
    ? { sha, ts: secondsToMs(ts) }
    : null;
  const b = raw.behind;
  const behind = typeof b === "number" && Number.isInteger(b) && b >= 0 ? b : null;
  return { head, behind };
}

/** A clean step's stderr minus its progress lines — host `warningsIn`. */
function warningsIn(stderr: string): string[] {
  return stderr.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0 && parseRepoHealthProgress(l) === null);
}

/** How the last `update` ended, as the phone's `RepoHealthOutcome`. */
export function outcomeOf(u: HealthUpdateResult, stepMs: number): RepoHealthOutcome {
  const base = { at: u.at, ms: u.ms, step: "update" as const, added: null, warnings: [] as string[] };
  if (u.timedOut) {
    return { ...base, ok: false, refused: null, error: `update ran past ${secs(stepMs)}s and was stopped; rows measured so far were kept — refresh again to continue.` };
  }
  if (u.cancelled) {
    return { ...base, ok: false, refused: null, error: "update was stopped before it finished; rows measured so far were kept — refresh again to continue." };
  }
  const v = classifyExit(u.code, u.stderr);
  if (v.refused || v.error) return { ...base, ok: false, refused: v.refused, error: v.error };
  return { ...base, ok: true, refused: null, error: null, added: parseUpdateSummary(u.stdout).added, warnings: warningsIn(u.stderr) };
}

export function foldHealth(i: HealthFoldInput): { doc: HealthDoc | null; why?: string } {
  if (!i.status) return { doc: null, why: NOT_READ_WHY };
  const doc: HealthDoc = {
    folder: i.folder, series: null, measure: null, head: null, behind: null, plot: null, plotError: null, index: null,
    readError: null, last: i.update ? outcomeOf(i.update, i.stepMs) : null, shallow: i.shallow,
    seriesFile: i.seriesFile, stepMs: i.stepMs, readAt: i.readAt, tailNote: i.tailNote ?? null,
    source: i.source?.kind ?? "own", scope: i.source?.scope ?? null, scopes: i.source?.scopes ?? [], repoFile: i.source?.repoFile ?? null,
  };
  const s = i.status;
  if (s.timedOut || s.cancelled) {
    doc.readError = s.timedOut
      ? `status ran past ${secs(i.stepMs)}s and was stopped — nothing was read, and nothing already written was undone.`
      : "status was stopped before it answered — nothing was read.";
    return { doc };
  }
  if (s.code !== 0) {
    const v = classifyExit(s.code, s.stderr);
    doc.readError = v.error ?? v.refused?.text ?? null;
    return { doc };
  }
  doc.measure = parseRepoHealthMeasure(s.stdout);
  doc.series = parseRepoHealthStatus(s.stdout);
  Object.assign(doc, headAndBehind(s.stdout));

  const p = i.plot;
  if (!p) return { doc };
  if (p.timedOut || p.cancelled) {
    doc.plotError = p.timedOut
      ? `The chart could not be read: plot ran past ${secs(i.stepMs)}s and was stopped. The series beside it was read on its own and is unaffected.`
      : "The chart was not read: plot was stopped before it answered. The series beside it is unaffected.";
  } else if (p.code === 2) {
    doc.plotError = "The extension's bundled engine has no `plot` subcommand — it exited 2 on it.";
  } else if (p.code !== 0) {
    if (doc.series) {
      const v = classifyExit(p.code, p.stderr);
      const said = v.error ?? v.refused?.text ?? null;
      doc.plotError = said ? `The chart could not be read: ${said}` : null;
    }
  } else {
    doc.plot = parseRepoHealthPlot(p.stdout);
  }
  return { doc };
}

const pathOf = (env: Record<string, string | undefined>): string => {
  const k = Object.keys(env).find((x) => x.toUpperCase() === "PATH");
  return (k && env[k]) || "";
};

/**
 * The directory holding an executable `git`, searched WITHOUT spawning: `extra` (VS Code's
 * `git.path` directory) first, then every PATH entry. null = none found.
 */
export function gitOnPath(env: Record<string, string | undefined>, extra?: string | null): string | null {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  const dirs = [...(extra ? [extra] : []), ...pathOf(env).split(delimiter)].filter((d) => d.length > 0);
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      try {
        if (!statSync(p).isFile()) continue;
        accessSync(p, constants.X_OK);
        return d;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Where a Mac keeps a git that is not `/usr/bin/git`'s Xcode shim: Homebrew (Apple silicon, Intel)
 *  and the Command Line Tools' own binary, which runs without Xcode's license gate. */
const MAC_GIT_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/Developer/CommandLineTools/usr/bin"];

/** The dirs `gitCandidates` tries after PATH on this platform. */
export function fallbackGitDirs(platform: string): readonly string[] {
  return platform === "darwin" ? MAC_GIT_DIRS : [];
}

/**
 * Every directory holding an executable `git`, in the order to try them: `extra` (VS Code's
 * `git.path` directory), then PATH, then `fallback` (`fallbackGitDirs`). Stats only; which one RUNS is
 * `pickGit`'s question — the first on PATH can be a shim that refuses every command.
 */
export function gitCandidates(env: Record<string, string | undefined>, extra?: string | null, fallback: readonly string[] = []): string[] {
  const dirs = [...(extra ? [extra] : []), ...pathOf(env).split(delimiter), ...fallback];
  const out: string[] = [];
  for (const d of dirs) if (d.length > 0 && !out.includes(d) && gitOnPath({ PATH: d }) === d) out.push(d);
  return out;
}

/** The first candidate whose `git --version` succeeds; when none does, the first (its refusal is the
 *  engine's sentence to quote); null when there is no git at all. */
export async function pickGit(dirs: readonly string[], runs: (dir: string) => Promise<boolean>): Promise<string | null> {
  for (const d of dirs) if (await runs(d)) return d;
  return dirs[0] ?? null;
}

/** `.git/shallow` exists; null when `.git` is a file (a linked worktree) or missing — cannot tell. */
export function isShallow(folder: string): boolean | null {
  try {
    if (!statSync(join(folder, ".git")).isDirectory()) return null;
  } catch {
    return null;
  }
  return existsSync(join(folder, ".git", "shallow"));
}
