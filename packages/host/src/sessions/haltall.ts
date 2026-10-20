/**
 * The emergency halt's kill, a slice of `sessions/` (`halt.ts` holds the latch).
 * Its own file because it is a blocking teardown of MANY sessions, and
 * `drive.ts` is held to no new blocking spawn (`tools/hostshape.test.mjs`).
 * Reached from the facade only; `drive.kill` is handed in (a slice imports no slice).
 */
import { execFileSync } from "node:child_process";
import { haltRefusal, killTrees } from "../halt.js";
import { shellOpenRefusal, type BackendDescriptor } from "../backends/index.js";
import type { SessionCore } from "./core.js";
import { TMUX_SERVER, tmuxName } from "./knobs.js";

/**
 * Every pane on OUR tmux server whose session name is ours, as session id →
 * the pane's pid (the binary tmux exec'd, so the agent itself). Empty when the
 * server is not running or tmux fails — the halt then has the map to go on.
 * `-u`: a client with no UTF-8 locale (the launchd service has none) prints the
 * `\t` below as `_`, every line then failed the split, and nothing was forced.
 */
export function ourPanePids(): Map<string, number> {
  const out = new Map<string, number>();
  let text = "";
  try {
    text = execFileSync("tmux", ["-u", "-L", TMUX_SERVER, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return out; }
  const prefix = tmuxName("");
  for (const line of text.split("\n")) {
    const [name, pid] = line.split("\t");
    if (!name?.startsWith(prefix) || !pid) continue;
    const n = Number(pid);
    if (Number.isInteger(n) && n > 1) out.set(name.slice(prefix.length), n);
  }
  return out;
}

/**
 * `create()`'s refusal, asked BEFORE the backend's `launchArgs` (opencode's
 * starts a server there): a job never opens a shell (`shellOpenRefusal`), and
 * while halted nothing but a shell opens at all. Null = go ahead.
 */
export function openRefusal(backend: BackendDescriptor, origin: Parameters<typeof shellOpenRefusal>[1]): string | null {
  return shellOpenRefusal(backend, origin) ?? (backend.id === "shell" ? null : haltRefusal());
}

/**
 * The emergency halt's kill (`halt.ts`). Every AGENT session this host started
 * ends for good: the ones in the map — running, or exited and waiting to be
 * reopened by the resume queue — and the detached ones still running in tmux
 * with only a `live/` record. Shell sessions are not AI and are left alone.
 *
 * Order matters. Each session is marked `killed` FIRST, so a CLI that exits on
 * the SIGTERM is read by the exit path as a close, never as a limit exit to
 * resurrect. Then every pane's process tree gets SIGTERM, and SIGKILL after the
 * grace (the agent flushes its transcript in that second, so `--continue` still
 * works once the halt is lifted). Only then the ordinary teardown: `kill()` for
 * a mapped session, kill-session plus the live record for a detached one, so no
 * boot re-attaches it.
 */
/** `kill` is the facade's `drive.kill(core, id, undefined, "you")`, handed in. */
export async function haltSessions(core: SessionCore, kill: (id: string) => void): Promise<{ sessions: number; processes: number; forced: number }> {
  const panes = ourPanePids();
  const targets: string[] = [];
  for (const id of new Set([...core.sessions.keys(), ...panes.keys()])) {
    const s = core.sessions.get(id);
    const backend = s ? s.backend.id : (core.loadLive(id)?.launch?.backend ?? "claude");
    if (backend === "shell") continue;
    targets.push(id);
    if (s) { s.closeBy = "you"; s.killed = true; core.clearResurrectTimer(s); }
  }
  const tree = await killTrees(targets.flatMap((id) => panes.has(id) ? [panes.get(id)!] : []));
  for (const id of targets) {
    if (core.sessions.has(id)) { kill(id); continue; }
    try { execFileSync("tmux", ["-L", TMUX_SERVER, "kill-session", "-t", tmuxName(id)], { stdio: "ignore" }); } catch { /* already gone */ }
    core.deleteLive(id);
    const row = core.closedRow(id);
    if (row?.alive) { row.alive = false; core.publishClosed(); }
  }
  return { sessions: targets.length, ...tree };
}
