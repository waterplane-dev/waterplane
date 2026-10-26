/**
 * What a person told the scorecard, on disk: `<state dir>/scorecard/accepted.json`
 *   { "accepts": { "<slug>": { "<check>": { reason, at, score } } }, "scoredAs": { "<realpath of the repo's common git dir>": "<slug>" } }
 * A file that does not parse is NEVER written over: reads see nothing, writes refuse in words naming it.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isUsableSlug } from "../shared/logic.mjs";
import { REASON_MAX, type ScoreAccept } from "../shared/wire.mjs";

export interface Stored {
  accepts: Record<string, Record<string, ScoreAccept>>;
  scoredAs: Record<string, string>;
  /** A sentence when the file exists but cannot be used; writes refuse while it is set. */
  problem?: string;
}

export const storeFile = (stateDir: string): string => join(stateDir, "scorecard", "accepted.json");

const cache = new Map<string, { sig: string; stored: Stored }>();

/** A copy a caller may mutate: per-slug records have no prototype, so a check named `__proto__` is just a key. */
function copy(s: Stored): Stored {
  const accepts: Stored["accepts"] = {};
  for (const [slug, per] of Object.entries(s.accepts)) {
    const c: Record<string, ScoreAccept> = Object.create(null);
    for (const [n, a] of Object.entries(per)) c[n] = { ...a };
    accepts[slug] = c;
  }
  return { accepts, scoredAs: { ...s.scoredAs }, ...(s.problem ? { problem: s.problem } : {}) };
}

/** Read the file, re-parsing only when its mtime / size / inode changed (the setup row asks per repo). */
export function loadStore(file: string): Stored {
  let sig: string;
  try { const st = statSync(file); sig = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`; } catch { cache.delete(file); return parse(file); }
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return copy(hit.stored);
  const stored = parse(file);
  cache.set(file, { sig, stored });
  return copy(stored);
}

function parse(file: string): Stored {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { accepts: {}, scoredAs: {} };
    return { accepts: {}, scoredAs: {}, problem: `${file} could not be read (${(e as Error).message}) — nothing is written over it.` };
  }
  let d: unknown;
  try { d = JSON.parse(text); } catch {
    return { accepts: {}, scoredAs: {}, problem: `${file} is not valid JSON — your accepts are not counted and none can be saved; nothing is written over it until it parses (fix or move it).` };
  }
  const o = d as { accepts?: unknown; scoredAs?: unknown } | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { accepts: {}, scoredAs: {}, problem: `${file} is not a JSON object — nothing is written over it until it is.` };
  const accepts: Stored["accepts"] = {};
  if (o.accepts && typeof o.accepts === "object") {
    for (const [slug, per] of Object.entries(o.accepts as Record<string, unknown>)) {
      if (!per || typeof per !== "object") continue;
      for (const [name, a] of Object.entries(per as Record<string, unknown>)) {
        const r = a as Partial<ScoreAccept> | null;
        if (!r || typeof r.reason !== "string" || !r.reason.trim()) continue;
        (accepts[slug] ??= Object.create(null) as Record<string, ScoreAccept>)[name] = { reason: r.reason.slice(0, REASON_MAX), ...(typeof r.at === "string" ? { at: r.at } : {}), ...(typeof r.score === "number" ? { score: r.score } : {}) };
      }
    }
  }
  const scoredAs: Stored["scoredAs"] = {};
  if (o.scoredAs && typeof o.scoredAs === "object") {
    for (const [k, v] of Object.entries(o.scoredAs as Record<string, unknown>)) if (typeof v === "string" && isUsableSlug(v)) scoredAs[k] = v;
  }
  return { accepts, scoredAs };
}

/** Write atomically (tmp + rename). Throws a sentence when the file on disk is not ours to overwrite. */
export function saveStore(file: string, s: Stored): void {
  if (s.problem) throw new Error(s.problem);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ accepts: s.accepts, scoredAs: s.scoredAs }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
