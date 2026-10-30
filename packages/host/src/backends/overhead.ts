/**
 * What Claude Code's own prompt costs a model's window, MEASURED — the input of
 * the first request of the newest conversation that ran it, off the CLI's log.
 *
 * Feeds `BackendModels.overheadTok` for the claude-on-another-runner backends
 * (`claude-local`, `claude-endpoint`), which `@waterplane/shared`'s
 * `windowAdviceText` turns into the picker's sentence. Absent beats borrowed:
 * a model no conversation was found for has NO entry, never a neighbour's.
 *
 * Cheap on purpose, because it runs with every catalogue read: the newest
 * `MAX_DIRS` project directories by mtime (a new conversation file bumps its
 * directory), their top-level `*.jsonl` newest first, at most `MAX_FILES` of
 * them, and only the first `HEAD_BYTES` of each — the first assistant row is
 * near the top. Subagent logs (`subagents/`) are never read: their first
 * request is a different prompt. Any failure reads as "not found".
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "../claudeconfig.js";
import { isAnchor, usageRecordOf } from "../ctxlog/usagerecord.js";

const MAX_DIRS = 40;
const MAX_FILES = 300;
const HEAD_BYTES = 256 * 1024;

/**
 * The first request of one conversation log's head: which model answered it
 * and how many input tokens it carried (fresh + cache read + cache write — the
 * whole prompt, however it was billed). The record's rules are
 * `usagerecord.ts`'s: a `<synthetic>` usage-wall row and an output-only reply
 * carried nothing and are passed over, never read as the answer — the anchor is
 * the first request that carried context. Null when the head holds no such row
 * with a model. A torn last line is skipped, never guessed. Pure.
 */
export function firstRequestOf(head: string): { model: string; tok: number } | null {
  for (const line of head.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let row: { isSidechain?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.isSidechain === true) continue;
    const rec = usageRecordOf(row);
    if (!rec || !isAnchor(rec) || !rec.model) continue;
    return { model: rec.model, tok: rec.carried };
  }
  return null;
}

async function head(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * For each wanted model id, the first-request input of the NEWEST conversation
 * that ran it. Ids never found are left out. Never throws.
 */
export async function measuredOverhead(wanted: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const want = new Set(wanted);
  if (!want.size) return out;
  try {
    const root = join(claudeConfigDir(), "projects");
    const dirs = await Promise.all((await readdir(root)).map(async (d) => {
      try { const s = await stat(join(root, d)); return s.isDirectory() ? { p: join(root, d), m: s.mtimeMs } : null; } catch { return null; }
    }));
    const newestDirs = dirs.filter((d): d is { p: string; m: number } => !!d).sort((a, b) => b.m - a.m).slice(0, MAX_DIRS);
    const files: Array<{ p: string; m: number }> = [];
    for (const d of newestDirs) {
      let names: string[];
      try { names = await readdir(d.p); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        try { const s = await stat(join(d.p, n)); if (s.isFile()) files.push({ p: join(d.p, n), m: s.mtimeMs }); } catch { /* gone */ }
      }
    }
    files.sort((a, b) => b.m - a.m);
    for (const f of files.slice(0, MAX_FILES)) {
      let first: { model: string; tok: number } | null = null;
      try { first = firstRequestOf(await head(f.p)); } catch { continue; }
      if (first && want.has(first.model) && !(first.model in out)) {
        out[first.model] = first.tok;
        if (Object.keys(out).length === want.size) break;
      }
    }
  } catch { /* no log directory: nothing measured */ }
  return out;
}
