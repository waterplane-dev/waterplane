/**
 * The score over time, on disk: `<state dir>/scorecard/history/<owner>__<name>.json` (slug lowercased)
 *   { "points": ScorePoint[], "runsAt": <ms the workflow runs were last listed>, "missing": ["<sha>", …] }
 * `missing` = commits a workflow ran on that the API had no result under (asked once, not again).
 * A file that does not parse is NEVER written over: reads see no points and say why.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScorePoint } from "../shared/wire.mjs";

export interface HistoryFile { points: ScorePoint[]; runsAt: number | null; missing: string[]; problem?: string }

export const historyFile = (stateDir: string, slug: string): string => join(stateDir, "scorecard", "history", `${slug.toLowerCase().replace(/\//g, "__")}.json`);

const isPoint = (p: unknown): p is ScorePoint => {
  const o = p as Partial<ScorePoint> | null;
  return !!o && typeof o.date === "string" && Number.isFinite(Date.parse(o.date)) && typeof o.score === "number" && Number.isFinite(o.score)
    && (o.commit === null || typeof o.commit === "string") && !!o.checks && typeof o.checks === "object";
};

export function loadHistory(file: string): HistoryFile {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { points: [], runsAt: null, missing: [] };
    return { points: [], runsAt: null, missing: [], problem: `${file} could not be read (${(e as Error).message}) — no history is shown or kept until it can.` };
  }
  let d: { points?: unknown; runsAt?: unknown; missing?: unknown } | null;
  try { d = JSON.parse(text); } catch { d = null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { points: [], runsAt: null, missing: [], problem: `${file} is not valid JSON — no history is shown or kept until it parses (fix or move it).` };
  const points = Array.isArray(d.points) ? d.points.filter(isPoint).map((p) => {
    const checks: Record<string, number> = Object.create(null);
    for (const [k, v] of Object.entries(p.checks)) if (typeof v === "number" && Number.isFinite(v)) checks[k] = v;
    return { date: p.date, commit: p.commit, score: p.score, checks };
  }) : [];
  return {
    points,
    runsAt: typeof d.runsAt === "number" && Number.isFinite(d.runsAt) ? d.runsAt : null,
    missing: Array.isArray(d.missing) ? d.missing.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Write atomically; refuses (throws) when the file on disk is not ours to overwrite. */
export function saveHistory(file: string, h: HistoryFile): void {
  if (h.problem) throw new Error(h.problem);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ points: h.points, runsAt: h.runsAt, missing: h.missing }) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
