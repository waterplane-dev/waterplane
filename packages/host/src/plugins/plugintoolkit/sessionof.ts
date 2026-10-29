/**
 * `api.sessionOf` (plugin API 2.4): which live waterplane session spawned a requesting process —
 * so an approval card can name the tab instead of a bare pid (docs/notes/plugins.md,
 * "Which session asked").
 *
 * Everything the requester hands us is a CLAIM (same uid), so the ladder believes the cheapest
 * thing only where the desktop's own reading agrees, and stops at the first rung that names
 * exactly ONE session:
 *   1. `pane`       — the reported `TMUX_PANE` is a pane on OUR server and the pid's ppid walk
 *                     reaches that pane's pid (a pane id alone is unique per tmux SERVER only);
 *                     a walk that reaches a DIFFERENT pane of ours wins, as `pid`.
 *   2. `pid`        — no usable pane, the walk alone reaches one of our panes' pids.
 *   3. `scratchpad` — a path segment of the cwd equals exactly one live session's conversation id
 *                     (`/private/tmp/claude-501/<slug>/<uuid>/scratchpad/…`).
 *   4. `cwd`        — the realpath'd cwd is under exactly one live session's directory.
 * Every probe failure (tmux down, `ps` failing, a realpath throwing) drops to the next rung or
 * to null — never to a wrong session. `matchSessionOf` is pure over injected probes.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import type { PluginSessionMatch, PluginSessionQuery } from "@waterplane/shared";

export type SessionOfHow = PluginSessionMatch["how"];

/** One of our tmux panes (`sessions/haltall.ts`'s `OurPane`). */
export interface SessionOfPane { paneId: string; sessionId: string; panePid: number }
/** A live session, as far as the ladder needs it. */
export interface SessionOfCandidate { id: string; cwd: string; claudeSessionId?: string }

export interface SessionOfProbes {
  /** Our panes; null = the listing failed (rungs 1–2 are then skipped). */
  panes: SessionOfPane[] | null;
  /** A process's parent, or null when unknown. */
  ppid(pid: number): number | null;
  /** `realpathSync`, or null when the path cannot be resolved. */
  realpath(path: string): string | null;
}

/** The ppid walk's hop limit (pane pid → shell → claude → Bash wrapper → tool → … is ~5 deep). */
export const SESSIONOF_MAX_HOPS = 12;
/** A prompt handed to a plugin is cut here. */
export const SESSIONOF_PROMPT_MAX = 200;

/**
 * The pane whose pid `pid` strictly descends from, walking 1 … `SESSIONOF_MAX_HOPS` parents. A claimed pid that IS
 * a pane's pid is no match: the pane's own process (the shell or the CLI the pane runs, readable by `ps`) is never
 * the requester — a real one is at least the child the agent's tool started, one hop below.
 */
export function walkToPane(pid: number | null | undefined, panes: SessionOfPane[], ppid: SessionOfProbes["ppid"]): SessionOfPane | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || panes.length === 0) return null;
  const byPid = new Map(panes.map((p) => [p.panePid, p]));
  if (byPid.has(pid)) return null;
  let cur = pid;
  for (let hop = 0; hop <= SESSIONOF_MAX_HOPS; hop++) {
    const hit = byPid.get(cur);
    if (hit) return hit;
    if (hop === SESSIONOF_MAX_HOPS) break;
    let next: number | null;
    try { next = ppid(cur); } catch { return null; }
    if (next == null || !Number.isInteger(next) || next <= 1 || next === cur) return null;
    cur = next;
  }
  return null;
}

const under = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

/** The ladder. Returns the session id and the rung that named it, or null. */
export function matchSessionOf(q: PluginSessionQuery, live: SessionOfCandidate[], probes: SessionOfProbes): { id: string; how: SessionOfHow } | null {
  const ids = new Set(live.map((s) => s.id));
  const panes = (probes.panes ?? []).filter((p) => ids.has(p.sessionId));
  const walked = walkToPane(q.pid, panes, probes.ppid);
  // 1. the reported pane, confirmed by the walk; a walk to another pane of ours beats the claim.
  const pane = typeof q.tmuxPane === "string" ? panes.find((p) => p.paneId === q.tmuxPane) : undefined;
  if (pane && walked) return walked.paneId === pane.paneId ? { id: pane.sessionId, how: "pane" } : { id: walked.sessionId, how: "pid" };
  // 2. the walk alone.
  if (walked) return { id: walked.sessionId, how: "pid" };
  const cwd = typeof q.cwd === "string" && q.cwd.startsWith("/") ? q.cwd : null;
  if (!cwd) return null;
  // 3. a scratchpad (or any path) naming exactly one live conversation id.
  const segs = new Set(cwd.split("/").filter(Boolean));
  const byConv = live.filter((s) => s.claudeSessionId && segs.has(s.claudeSessionId));
  if (byConv.length === 1) return { id: byConv[0].id, how: "scratchpad" };
  if (byConv.length > 1) return null;
  // 4. the cwd under exactly one session's directory (both realpath'd; an unresolvable one counts as itself).
  const real = probes.realpath(cwd) ?? cwd;
  const hits = live.filter((s) => s.cwd && under(real, probes.realpath(s.cwd) ?? s.cwd));
  return hits.length === 1 ? { id: hits[0].id, how: "cwd" } : null;
}

/** A prompt as a plugin may see it: ≤ `SESSIONOF_PROMPT_MAX` chars, absent when empty. */
export function capPrompt(text: string | undefined): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  return text.length > SESSIONOF_PROMPT_MAX ? text.slice(0, SESSIONOF_PROMPT_MAX - 1) + "…" : text;
}

/** `ps -axo pid=,ppid=` → pid → ppid; empty on failure. */
export function parsePpidTable(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

let ppidMemo: { at: number; map: Map<number, number> } | null = null;
const PPID_MEMO_MS = 2000;

function readPpidTable(fresh: boolean): Promise<Map<number, number> | null> {
  if (!fresh && ppidMemo && Date.now() - ppidMemo.at < PPID_MEMO_MS) return Promise.resolve(ppidMemo.map);
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const map = parsePpidTable(String(stdout));
      ppidMemo = { at: Date.now(), map };
      resolve(map);
    });
  });
}

/**
 * The live probes: our panes (handed in — the facade's `ourPanes()`), ONE `ps` table (memoised
 * 2 s, re-read fresh when the asked pid is not in it — a requester younger than the memo), and
 * `realpathSync`.
 */
export async function liveSessionOfProbes(pid: number | null | undefined, panes: () => Promise<SessionOfPane[] | null>): Promise<SessionOfProbes> {
  const [paneRows, table0] = await Promise.all([panes().catch(() => null), readPpidTable(false)]);
  let table = table0;
  if (typeof pid === "number" && table && !table.has(pid)) table = await readPpidTable(true);
  return {
    panes: paneRows,
    ppid: (p) => table?.get(p) ?? null,
    realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
  };
}
