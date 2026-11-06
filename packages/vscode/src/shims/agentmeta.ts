/**
 * `agents.ts`'s `readMeta`, as the extension bundles it.
 *
 * `ctxlog/ctxagents.ts` (bundled verbatim: the subagents' spend, roster and running total) imports
 * `readMeta` from `../agents.js` for an agent's label, and the log listing, which is the host's own
 * `agentlogs.ts` re-exported below. The real module also imports `./proc.js` → `node:child_process`, and an extension that says "nothing spawned" must not
 * ship a process launcher it never uses. `esbuild.mjs` redirects that import here.
 *
 * Same contract as the host's: an unreadable, oversized or malformed meta file is `{}` — a lost
 * label, never a lost agent. Cached on size + mtime because it is asked once per agent per poll.
 */
import { readFileSync, statSync } from "node:fs";

export { agentLogId, agentLogs } from "../../../host/src/agentlogs.js";

export interface MetaFile { agentType?: string; description?: string; model?: string }

/** A meta file is a few hundred bytes; past this it is not one, and nothing is read. */
const META_MAX = 64 * 1024;
const CACHE_MAX = 256;
const cache = new Map<string, { key: string; meta: MetaFile }>();

export function readMeta(path: string): MetaFile {
  let st;
  try { st = statSync(path); } catch { return {}; }
  if (!st.isFile() || st.size > META_MAX) return {};
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.meta;
  let meta: MetaFile = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as MetaFile;
  } catch { meta = {}; }
  cache.set(path, { key, meta });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return meta;
}
