/**
 * What runs UNDER a session: the agents and background shells `checkAgents`
 * publishes and keeps polling (`agents.ts`, `shells.ts`). Cut out of `turn.ts`
 * by subject; stateless like it — every fact lives on the `Session`.
 */
import { realpathSync } from "node:fs";
import type { SessionAgent, SessionShell, SourceSession } from "@waterplane/shared";
import { shellBucket } from "@waterplane/shared";
import { agentsChanged, readAgents, readCliRecord, readRunningAgents } from "../agents.js";
import { derive } from "../backends/derive.js";
import { liveSourceFor } from "../livesources.js";
import { readPsTableAsync, readShellList, shellsEnabled } from "../shells.js";
import type { Session, SessionCore } from "./core.js";
import { AGENT_POLL_MS, tmuxName } from "./knobs.js";

/**
 * The `SourceSession` `agents.list()` is handed — the SAME one every other slot gets (review R7):
 * the live channel's own when one is attached (`sidechannel.ts`'s `sourceSession`), else built the
 * same way, `cwd` REALPATHED (`/var` -> `/private/var`), so a plugin keying its agent list by cwd sees
 * one string on every call. `backendSessionId` absent rather than `undefined`. Exported for the test.
 */
export function agentsSourceSession(s: Pick<Session, "spawnedAt"> & { info: Pick<Session["info"], "id" | "cwd" | "backendSessionId"> }): SourceSession {
  const live = liveSourceFor(s.info.id)?.session;
  if (live) return live;
  let cwd = s.info.cwd;
  try { cwd = realpathSync(cwd); } catch { /* the record's own path */ }
  return { id: s.info.id, cwd, spawnedAt: s.spawnedAt, ...(s.info.backendSessionId ? { backendSessionId: s.info.backendSessionId } : {}) };
}

/**
 * Publish which agents are running UNDER this session, and keep polling while
 * any are.
 *
 * The turn flag answers for the MAIN loop only. A background agent survives
 * its Stop hook by design — the CLI prints "Waiting for 2 background agents
 * to finish" and hands the composer back — so a session with two reviewers in
 * flight published `turnActive: false, idle: true` and the reader, which has
 * no terminal to check that against, said "idle — nothing running" for six
 * minutes of real work. `agents.ts` reads the fact off the CLI's own logs.
 *
 * Polled rather than evented because there is no event: the parent's log is
 * not written while a background agent runs, and no hook fires for an agent.
 * The poll is a `readdir` plus a `stat` per agent, armed ONLY while agents
 * exist, so a desktop full of quiet sessions pays for nothing. Elapsed is
 * counted on the phone off `startedAt`, so a broadcast happens on a CHANGE
 * (an agent appearing, finishing, or moving to a different tool) and not once
 * a tick per attached client.
 */
export function checkAgents(core: SessionCore, s: Session): void {
  if (s.agentTimer) { clearTimeout(s.agentTimer); s.agentTimer = null; }
  // Any call supersedes a still-pending `ps` read from an earlier one: that one
  // must not publish an older picture over this one, nor arm a second timer.
  const gen = (agentGen.get(s) ?? 0) + 1;
  agentGen.set(s, gen);
  if (!s.info.running) {
    if (s.info.agents || s.info.shells || s.info.shellList) {
      s.info.agents = undefined; s.info.shells = undefined; s.info.shellList = undefined; s.shellsFp = undefined;
      core.emit("updated", s.info);
    }
    return;
  }
  // What is running under a session is read off the CLI's OWN logs
  // (`subagents/agent-*.jsonl`). A backend that writes none has no such file
  // to read, so the list stays ABSENT — which is what "this app cannot tell
  // you" looks like, as against an empty list, which would claim nothing is
  // running.
  // claude keeps its own reader and its own error rule (a throw reads as "none running");
  // another backend asks its `agents` providers, and no answer keeps the list ABSENT.
  let rows: SessionAgent[] = [];
  if (derive(s.backend).keepsClaudeLog) {
    try { rows = readRunningAgents(s.info.cwd, s.info.claudeSessionId); } catch { rows = []; }
  } else {
    let read: SessionAgent[] | null = null;
    try { read = readAgents(s.backend, agentsSourceSession(s)); } catch { read = null; }
    if (read === null) return;
    rows = read;
  }
  // Background SHELLS are the same fact by another route (a `run_in_background`
  // Bash or a Monitor outlives its turn too), and no log records them — the
  // CLI's own session record does (`agents.ts`'s `readCliRecord`).
  let record: { status: string; pid: number } | null = null;
  try { record = readCliRecord(s.info.id, tmuxName(s.info.id), s.info.claudeSessionId); } catch { record = null; }
  const cli = record?.status ?? null;
  const shells = cli === "shell" ? true : undefined;
  // The RICH list, read only while the CLI's own record says there is
  // something under it worth asking about — a `busy` main loop still gets
  // asked, for the same edge `shells` itself is asked through: the Stop hook
  // can land before the record catches up to `shell`.
  if (record && (cli === "shell" || cli === "busy") && shellsEnabled()) {
    // The process table is read ASYNC: this runs per shell/busy session every
    // `AGENT_POLL_MS`, on the one loop that pumps every PTY, and the blocking
    // `ps` it replaced cost ~50 ms a time. The rest of the tick is unchanged
    // and picks up when the table is in (`publishAgents`).
    const pid = record.pid;
    void readPsTableAsync()
      .then((psRows) => readShellList(pid, s.info.cwd, s.info.claudeSessionId, cli, Date.now(), psRows))
      .catch((): SessionShell[] | undefined => undefined)
      .then((shellList) => {
        if (agentGen.get(s) !== gen) return;               // a newer tick owns the result and the timer
        if (!s.info.running) { checkAgents(core, s); return; } // ended meanwhile: the early branch retires the fields
        publishAgents(core, s, rows, shells, cli, shellList);
      });
    return;
  }
  publishAgents(core, s, rows, shells, cli, undefined);
}

/** Per-session generation of the latest `checkAgents` call — see there. */
const agentGen = new WeakMap<Session, number>();

/** The second half of `checkAgents`: compare, broadcast on a change, re-arm. */
function publishAgents(
  core: SessionCore, s: Session, rows: SessionAgent[], shells: true | undefined, cli: string | null,
  shellList: SessionShell[] | undefined,
): void {
  const shellsFp = shellsFingerprint(shellList, Date.now());
  const changed = agentsChanged(s.info.agents, rows) || shells !== s.info.shells || shellsFp !== s.shellsFp;
  if (changed) {
    s.info.agents = rows.length ? rows : undefined;
    s.info.shells = shells;
    s.info.shellList = shellList;
    s.shellsFp = shellsFp;
    core.emit("updated", s.info);
  }
  // Keep polling while something runs underneath — and while the CLI still
  // says `busy` after our turn flag dropped: the Stop hook can land before the
  // CLI rewrites its record to `shell`, and reading once at that edge would
  // miss every shell the turn left behind. And while a TURN runs: a turn that
  // starts with nothing under it and then fans out to N agents was read once at
  // its start and never again, so the phone's parallel-agent count missed every
  // agent launched mid-turn. The poll is a readdir per busy session plus the
  // shared, memoised `ps`.
  if (!rows.length && !shells && !(shellList && shellList.length) && cli !== "busy" && !s.turnActive) return;
  s.agentTimer = setTimeout(() => { s.agentTimer = null; checkAgents(core, s); }, AGENT_POLL_MS);
  s.agentTimer.unref?.();
}

/**
 * `pid:bucket:workers:fg` per row, joined — the STATE a person would see,
 * never a raw timestamp. Keying on `cpuMovedAt` directly (the old key) meant
 * a genuinely WORKING shell rebroadcast on nearly every poll: its CPU is, by
 * definition, moving, so `cpuMovedAt` ticks to `now` almost every time this
 * function is asked, and "only broadcast on a change a person would see" was
 * defeated for the one bucket that polls most often. `shellBucket` only
 * changes when the shell actually crosses working/waiting/quiet/unknown —
 * that IS a change worth a broadcast — and `workers`/`foreground` cover the
 * two other facts a person's view of the row depends on.
 */
function shellsFingerprint(list: SessionShell[] | undefined, now: number): string {
  if (!list) return "";
  return list.map((sh) => `${sh.pid}:${shellBucket(sh, now)}:${sh.workers}:${sh.foreground ? "fg" : "bg"}`).join("|");
}
