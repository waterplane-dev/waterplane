/**
 * The tmux substrate of `SessionManager` (S2 of the split in
 * docs/notes/host-architecture.md): which tmux server and session name a
 * session lives under, how its backend is spawned inside tmux, how a
 * pane that outlived the daemon is re-attached, the tmux.conf, the `live/`
 * records that let a restart find its sessions again, the boot-time reclaim of
 * records whose pane is provably gone, and the boot-time sweep of the
 * per-session stores those records protect.
 *
 * Stateless: every function that needs the manager takes `core` first. The
 * facade re-exports `tmuxEnvPrefix`, `sweepSessionStores` and `staleLiveIds` from here. The
 * tmux server and session-name constants live in `knobs.ts`, beside the other env-derived knobs so every slice may import them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { SessionInfo } from "@waterplane/shared";
import { cleanSessionBudget, logTag, sessionBudgetVerdict } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { spawnFailure } from "../ptycap.js";
import { ptyEnv } from "../ptyenv.js";
import { inCopyModeSync } from "../tmuxscroll.js";
import { knownBackend, resolveBackend, type BackendDescriptor } from "../backends/index.js";
import type { LiveMeta, SessionCore } from "./core.js";
import { ORPHAN_MAX_AGE_MS, ORPHAN_SWEEP_DELAY_MS, STALE_LIVE_MIN_AGE_MS, STORE_FILE_RE, TMUX_SERVER, TMUX_SOCKET_DEFAULT, TMUX_SOCKET_ID, tmuxName } from "./knobs.js";
import { tmuxRefusal } from "../tmuxreq.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

/**
 * The `env(1)` prefix that carries a backend's `spawnEnv` into the tmux PANE.
 *
 * A tmux pane does NOT inherit the environment of the client that asked for it —
 * only of the client that happened to START the server, plus whatever
 * `update-environment` names. Our server outlives the daemon, so the common case
 * is a pane built from some earlier session's environment, and a variable merged
 * into the client's env is simply lost. For `OPENCODE_DISABLE_AUTOUPDATE` that
 * loss is not cosmetic: it is the difference between a composer and an update
 * modal whose focused button is `Confirm` (`backends/opencode.ts`).
 *
 * Exported for `packages/host/test/tmuxenv.test.mjs`: the thing that broke is a
 * property of the ARGV, and an argv is pinnable without a tmux server.
 *
 * Empty in, empty out. Claude declares `DISABLE_AUTOUPDATER=1`
 * (`backends/claude.ts`), for the same reason: a server that already exists
 * would drop it from the client's env.
 */
export function tmuxEnvPrefix(spawnEnv: Readonly<Record<string, string>>, unset: readonly string[] = []): string[] {
  const pairs = Object.entries(spawnEnv);
  if (!pairs.length && !unset.length) return [];
  // Absolute, not a bare `env`: the pane's PATH is the server's, which is not
  // necessarily the daemon's. `--` would need tmux to pass it through, and
  // nothing here starts with a dash, so it buys nothing. `-u NAME` (BSD and GNU
  // env alike) removes a variable the server's environment would hand down.
  return ["/usr/bin/env", ...unset.flatMap((n) => ["-u", n]), ...pairs.map(([k, v]) => `${k}=${v}`)];
}

/**
 * The names a launch's `dropEnv` (`LaunchPlan.dropEnv`) removes: exact names,
 * and `*SUFFIX` patterns matched against the daemon's own variable names —
 * which is what the tmux server's environment was built from. A name the
 * launch itself sets (`keep`) stays. Sorted, deduped, only valid names.
 */
export function droppedEnvNames(patterns: readonly string[] | undefined, names: readonly string[] = Object.keys(process.env), keep: Readonly<Record<string, string>> = {}): string[] {
  if (!patterns?.length) return [];
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.startsWith("*")) { const suffix = p.slice(1); for (const n of names) if (n.endsWith(suffix) && n.length > suffix.length) out.add(n); }
    else out.add(p);
  }
  return [...out].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !Object.hasOwn(keep, n)).sort();
}

/**
 * Delete the per-session files of sessions that no longer exist.
 *
 * `<STATE_DIR>/history/` and `<STATE_DIR>/summaries/` are written per session
 * and, until this existed, only ever unwritten by `remove()` — the one exit a
 * session usually does NOT take. A session that exits at a usage limit, or whose
 * tmux was killed at the desk, or that was open across a `--continue` bounce,
 * leaves its file behind for good. It is a tidiness leak measured in megabytes
 * rather than a performance problem (3.2 MB here), which is why the fix is one
 * pass at boot and nothing more: no recursion, no directory removal, no
 * bookkeeping file that could itself go stale.
 *
 * Pure fs on purpose — dirs in, ids in, files gone — so the rules above can be
 * pinned against a fixture without a `SessionManager`, a PTY or a tmux server.
 */
export function sweepSessionStores(
  dirs: string[],
  /**
   * Every id that must survive — or NULL when the caller could not determine
   * that. Null is not "nothing is alive": it is "the question is unanswerable
   * this boot", and the only safe response to an unanswerable question in a
   * function that deletes files is to delete nothing. Kept here rather than at
   * the call site so the rule travels with the destructive code and can be
   * pinned by a test.
   */
  alive: ReadonlySet<string> | null,
  now = Date.now(),
  maxAgeMs = ORPHAN_MAX_AGE_MS,
): { deleted: number; kept: number; skipped: boolean } {
  if (!alive) return { deleted: 0, kept: 0, skipped: true };
  let deleted = 0, kept = 0;
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }   // store never created — nothing to sweep
    for (const name of names) {
      const m = STORE_FILE_RE.exec(name);
      if (!m || alive.has(m[1])) { kept++; continue; }
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }         // vanished under us — fine, that was the goal
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) { kept++; continue; }
      try { rmSync(p, { force: true }); deleted++; } catch { kept++; }
    }
  }
  return { deleted, kept, skipped: false };
}

/** What `staleLiveIds` needs to know about one `live/` record: when it was last
 *  written, and which tmux server its pane was started on (absent = unstamped). */
export interface LiveRecordFacts { mtimeMs: number; tmuxSocket?: string }

/**
 * The `live/` records whose tmux session is PROVABLY gone — the ids the boot
 * reclaim deletes.
 *
 * A record is how a restart finds a pane again, and until this existed it was
 * only ever deleted while the daemon watched the session end (`kill`, `remove`,
 * the exit path). A pane that ended while the daemon was down — a reboot, a
 * crash, a `tmux kill-session` at the desk — left its record behind for good,
 * and `aliveSessionIds` reads every record as a session, so the orphan sweep
 * could never reclaim that session's history and summary either. Measured on
 * this desktop: 162 of 277 records with no tmux session, the oldest seven weeks
 * old.
 *
 * "Provably" is every condition below, and each one keeps on doubt:
 * - `tmuxNames` is a SUCCESSFUL `tmux ls` of this host's server. Null is "the
 *   question could not be asked" (no server, a socket error, a timeout) and
 *   reclaims nothing — the same rule `sweepSessionStores` holds for its alive
 *   set, and for the same reason: this function's answer gets deleted.
 * - the id is a bare `<id>` (the store-file rule); anything else is refused.
 * - the id is not held by this host (`keep`: the session map, the parked set).
 * - the record was written on THIS server (`tmuxSocket` equal to `server.socket`),
 *   or is unstamped and this host runs on the default socket
 *   (`TMUX_SOCKET_DEFAULT` says why that is the only reading of an unstamped
 *   record that is safe). A listing of one server says nothing about another.
 * - the record has gone unwritten for longer than `minAgeMs` — a spawn whose
 *   record is on disk while its `new-session` is still in flight.
 * - facts were read at all; a record that could not be stat'ed or parsed is kept.
 *
 * Pure — ids, a listing and facts in, ids out — so every one of those rules is
 * pinned without a tmux server (`packages/host/test/sweepstores.test.mjs`).
 */
export function staleLiveIds(
  liveIds: Iterable<string>,
  tmuxNames: ReadonlySet<string> | null,
  now: number,
  facts: ReadonlyMap<string, LiveRecordFacts>,
  minAgeMs: number,
  server: { socket: string; isDefault: boolean } = { socket: TMUX_SOCKET_ID, isDefault: TMUX_SOCKET_DEFAULT },
  keep: ReadonlySet<string> = new Set(),
): string[] {
  if (!tmuxNames) return [];
  const out: string[] = [];
  for (const id of liveIds) {
    if (!STORE_FILE_RE.test(`${id}.json`)) continue;
    if (keep.has(id) || tmuxNames.has(tmuxName(id))) continue;
    const f = facts.get(id);
    if (!f || !Number.isFinite(f.mtimeMs) || now - f.mtimeMs <= minAgeMs) continue;
    if (f.tmuxSocket ? f.tmuxSocket !== server.socket : !server.isDefault) continue;
    out.push(id);
  }
  return out;
}

/**
 * `rediscover()`'s reclaim, given the listing it already holds: read each
 * record's mtime and stamp, ask `staleLiveIds`, delete what it names, say so in
 * one log line. Returns the ids deleted. A record is read with a plain parse rather than `loadLive`,
 * whose guard renames a corrupt file aside — a side effect that would take the
 * record out of `aliveSessionIds` without anyone having decided it was dead.
 */
export function reclaimStaleLive(core: SessionCore, tmuxNames: ReadonlySet<string>, now = Date.now()): string[] {
  let files: string[];
  try { files = readdirSync(liveDir(core)); } catch { return []; }   // no store, or unreadable: nothing to judge
  const ids: string[] = [];
  const facts = new Map<string, LiveRecordFacts>();
  for (const f of files) {
    const m = STORE_FILE_RE.exec(f);
    if (!m) continue;
    const id = m[1];
    ids.push(id);
    try {
      const p = livePath(core, id);
      const st = statSync(p);
      if (!st.isFile()) continue;
      const rec = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const sock = (rec as LiveMeta).tmuxSocket;
      facts.set(id, { mtimeMs: st.mtimeMs, ...(typeof sock === "string" && sock ? { tmuxSocket: sock } : {}) });
    } catch { /* unreadable or unparseable ⇒ no facts ⇒ kept */ }
  }
  const keep = new Set<string>([...core.sessions.keys(), ...parkState(core).map.keys()]);
  const stale = staleLiveIds(ids, tmuxNames, now, facts, STALE_LIVE_MIN_AGE_MS, undefined, keep);
  for (const id of stale) deleteLive(core, id);
  if (stale.length) console.log(`${logTag} swept ${stale.length} stale live record(s) — no tmux session left for them, kept ${ids.length - stale.length}`);
  return stale;
}

// ── tmux substrate: spawn / re-attach / discover ────────────────────

/** What the binary must be spawned WITH: the descriptor's `spawnEnv`, then this launch's (`LaunchPlan.env`) over it. */
export function backendPaneEnv(backend: Pick<BackendDescriptor, "spawnEnv">, launchEnv?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...backend.spawnEnv, ...launchEnv };
}

/** A pane in an already-running tmux server takes the SERVER's environment, so a
 *  `CLAUDE_CONFIG_DIR` this daemon was started with rides the pane's `env(1)` prefix
 *  too, UNCHANGED (the CLI reads it as a replacement for `~/.claude`). A backend's or
 *  launch's own value wins; unset adds nothing. */
export function cliConfigEnv(paneEnv: Readonly<Record<string, string>>): Record<string, string> {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? { CLAUDE_CONFIG_DIR: dir, ...paneEnv } : { ...paneEnv };
}

/**
 * Spawn the backend's binary inside tmux (survives a restart) — the only way a
 * session runs; a missing tmux refuses in words (`tmuxreq.ts`).
 *
 * The binary and the environment both come from the DESCRIPTOR. `spawnEnv` is
 * merged over the PTY env rather than beside it because for at least one
 * backend it is a safety requirement and not a preference
 * (`backends/opencode.ts`: without `OPENCODE_DISABLE_AUTOUPDATE=1` the CLI
 * opens an update modal whose focused button is `Confirm`, and this app's
 * delivery model would press it).
 *
 * **The tmux client's environment is NOT the pane's, so `spawnEnv` also
 * rides on the command line.** This used to say that `new-session` builds the
 * pane's environment from the client's, which is true only for the spawn that
 * STARTS the server. The `-L <server>` server outlives the daemon and is normally
 * started by whichever session got there first — so in the ordinary case tmux
 * builds the new pane's environment from the SERVER's global environment plus
 * `update-environment`, which `ensureTmuxConf` does not set. The variable was
 * therefore dropped on exactly the path that matters, and the real binary
 * launched unguarded: measured with `tmux 3.6b`, a pane spawned into a
 * pre-existing server read `MISSING`.
 *
 * `env(1)` in front of the pane command rather than `new-session -e`, for two
 * reasons. `-e` needs tmux ≥ 3.2, and this app does not choose the tmux on the
 * machine it runs on. And `-e` puts the value in the tmux SESSION's
 * environment, where it is inherited by every later pane in that session and
 * readable from `show-environment` — a wider blast radius than the fact
 * deserves, when what is needed is one variable in the environment of one
 * process. tmux `exec`s the pane argv directly (verified: an argument
 * containing spaces and quotes — claude's `--settings <json>` — survives
 * byte-for-byte through the prefix), so this adds no shell and no quoting.
 *
 * A backend with an EMPTY `spawnEnv` gets no prefix at all.
 */
export function spawnBackend(core: SessionCore, id: string, cwd: string, cols: number, rows: number, args: string[], backend: BackendDescriptor, launchEnv?: Readonly<Record<string, string>>, dropEnv?: readonly string[]): IPty {
  // The descriptor's `spawnEnv` first, THEN this launch's own (`LaunchPlan.env`):
  // a per-launch value (claude-local's base URL) wins over a standing one, and
  // BOTH ride the tmux command line (`tmuxEnvPrefix`) and the client's env.
  const paneEnv = backendPaneEnv(backend, launchEnv);
  const env = { ...ptyEnv(), ...paneEnv };
  const BIN = backend.bin();
  // tmux is required (`tmuxreq.ts`): no binary ⇒ refuse in words naming the
  // install command. There is no other substrate to fall back to.
  const refusal = tmuxRefusal();
  if (refusal) throw new Error(refusal);
  // Rethrow a pty-table exhaustion as the sentence for it (`ptycap.ts`), here
  // rather than at each caller: `create()` is reached from the WS route, the
  // backlog, fan-out and the intent tick, and node-pty's own `posix_spawnp
  // failed` names no fact any of them could act on.
  try {
    const conf = ensureTmuxConf(core);
    // new-session -A: create running the binary, or attach if it already exists.
    const argv = ["-L", TMUX_SERVER, "-u", "-f", conf, "new-session", "-A", "-s", tmuxName(id),
      "-x", String(cols), "-y", String(rows), "-c", cwd, ...tmuxEnvPrefix(cliConfigEnv(paneEnv), droppedEnvNames(dropEnv, Object.keys(process.env), paneEnv)), BIN, ...args];
    return pty.spawn("tmux", argv, { name: "xterm-256color", cols, rows, cwd, env });
  } catch (err) {
    const why = spawnFailure(err);
    throw why === String((err as Error)?.message ?? err) ? err : new Error(why);
  }
}

/** The tmux pane's real working directory — ground truth for where claude runs,
 *  used to heal a stale/corrupted meta cwd on reattach. Null if unresolvable. */
export function paneCwd(id: string): string | null {
  try {
    const out = execFileSync("tmux", ["-L", TMUX_SERVER, "display-message", "-p", "-t", tmuxName(id), "#{pane_current_path}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out && existsSync(out) ? out : null;
  } catch { return null; }
}

/** Whether reattach may move a record's cwd/title to the pane's. ONLY a record
 *  showing the legacy orphan-rediscover corruption (cwd missing or gone, title
 *  the id or empty) is healed: a healthy record keeps its home even when the
 *  pane has `cd`'d elsewhere — a shell's pane path is wherever the person last
 *  went, and adopting it moved the session into a fake repo named after the
 *  subfolder. Pure, so `test/paneheal.test.mjs` can pin it. */
export function healFromPane(m: Pick<LiveMeta, "id" | "cwd" | "title">, realCwd: string | null, cwdExists: boolean): { cwd: string; title: string } {
  const corrupt = !m.cwd || !cwdExists || !m.title || m.title === m.id;
  if (!corrupt || !realCwd || realCwd === m.cwd) return { cwd: m.cwd, title: m.title };
  return { cwd: realCwd, title: (m.title === m.id || !m.title) ? basename(realCwd) : m.title };
}

/** Re-attach a client to a still-alive tmux session found on boot. */
export function reattach(core: SessionCore, m: LiveMeta): void {
  if (core.sessions.has(m.id)) return;
  const cols = 80, rows = 30;
  const env = ptyEnv();
  // Self-heal legacy corruption: an old orphan-rediscover bug persisted some
  // records with cwd=<root> and title=<id>, so those sessions render ungrouped
  // under a raw hex id. Only such a record takes the tmux pane's cwd
  // (`healFromPane`) — a healthy one keeps its own, because the pane's path is
  // wherever the person last `cd`'d. Corrected values are re-persisted below
  // so the bad record is fixed on disk for good.
  const { cwd, title } = healFromPane(m, paneCwd(m.id), !!m.cwd && existsSync(m.cwd));
  if (cwd !== m.cwd || title !== m.title) {
    persistLive(core, { ...m, cwd, title });
  }
  // -d: detach any other client so THIS viewport's size wins (aggressive-resize).
  const proc = pty.spawn("tmux", ["-L", TMUX_SERVER, "-u", "attach", "-d", "-t", tmuxName(m.id)],
    { name: "xterm-256color", cols, rows, cwd, env });
  const l = m.launch ?? {};
  // Which binary this pane has been running since before the restart. It is
  // the same question `create()` asks, asked of the record instead of the
  // client — and it THROWS the same way for an id this host no longer knows
  // (a downgrade), which `rediscover()` turns into "skip a session we can't
  // attach". That is the right outcome: the pane keeps running in tmux, and
  // the alternative is adopting it as a claude session and arming every
  // claude-shaped reader against a screen none of them was written for.
  const backend = resolveBackend(l.backend);
  const info: SessionInfo = {
    id: m.id, cwd, title, remoteControl: true, running: true,
    ...core.backendField(backend),
    model: l.model, effort: l.effort, permissionMode: l.permissionMode, remoteControlled: l.remoteControlled,
    prompt: null, idle: false,
    ...(backend.caps.usageLimits ? { limit: core.newLimitState() } : {}),
    claudeSessionId: m.claudeSessionId,
    ...(m.backendSessionId ? { backendSessionId: m.backendSessionId } : {}),
    createdAt: m.createdAt,
  };
  // The cap a person set survives the restart; its verdict is re-derived on
  // the next sweep (`budgetwatch.ts`), and garbage on disk is no cap at all.
  const budget = cleanSessionBudget(m.budget);
  if (budget) info.budget = { cfg: budget, verdict: sessionBudgetVerdict(budget, null, null, Date.now()) };
  if (backend.caps.transcript === "claude-jsonl") info.lastTurnAt = core.lastTurnOf(cwd, m.claudeSessionId) ?? undefined;
  core.applyStar(info);
  core.register(m.id, proc, info, l, cols, rows, backend);
  // A pane outlives the daemon, and it can outlive it IN COPY-MODE — where it
  // reads keystrokes as pager commands and nothing claude is sent arrives. The
  // flag that makes `leaveCopyMode` fire is a BELIEF, and a fresh process
  // believes `false`, so such a pane stayed stuck until somebody happened to
  // pan it again: every delivery into it typed into a pager. Measured after
  // one ordinary restart: four panes. So it is asked, once, here — one cheap
  // tmux query per re-attached session, on a path that already runs several.
  const re = core.sessions.get(m.id);
  if (re) re.copyMode = inCopyModeSync(TMUX_SERVER, tmuxName(m.id));
  // How it was opened survives the restart for its closed row (`closedRowOf`).
  if (re && m.origin) re.origin = m.origin;
  if (re && m.origin?.companionOf) re.info.companionOf = m.origin.companionOf;
  // …and so does the budget's latch: a session already told it is over is not
  // told, or interrupted, again because the daemon restarted.
  if (re && budget && m.budgetTripped) re.budgetTripped = true;
  if (re && budget && m.budgetEscOwed) re.budgetEscOwed = true;
  // …and so does "handled": the tail still ends on that question. The stop
  // count is this process's, so only the words can match after a restart.
  if (re && typeof m.askDismissed === "string" && m.askDismissed) re.askDismissed = { text: m.askDismissed, stop: -1 };
  // The record carries the LAUNCH model — often an alias ("opus") — and the
  // hooks that read the running one back only fire on the next turn. Every
  // idle session came back from a restart wearing the alias beside siblings
  // that had since turned and wore the full id, so ask the transcript once.
  if (re) core.refreshModel(re);
}

export function tmuxConfPath(core: SessionCore): string { return join(hostStateDir(core.root), "tmux.conf"); }
export function ensureTmuxConf(core: SessionCore): string {
  const p = tmuxConfPath(core);
  // status off: no tmux bar stealing a row.
  //
  // mouse off, still: `mouse on` would also hand tmux click and drag, which on
  // a phone turns a tap on the screen into a pane selection with borders the
  // user cannot see. Off does NOT mean the pane never sees the mouse — tmux
  // forwards a program's own mouse modes to the outer terminal and its
  // reports back down to the pane, which is what `tmuxscroll.ts` routes a pan
  // on: claude ≥ 2.1 asks for the wheel and scrolls itself, and only a pane
  // that asked for nothing gets the copy-mode translation.
  // destroy-unattached off: keep the session when our client detaches (the
  // whole point). passthrough + Tc: let claude's truecolor/OSC through.
  const conf = [
    "set -g status off",
    "set -g escape-time 0",
    "set -g aggressive-resize on",
    "set -g destroy-unattached off",
    "set -g allow-passthrough on",
    "set -g history-limit 100000",
    'set -g default-terminal "tmux-256color"',
    'set -ga terminal-overrides ",*:Tc"',
    "set -g mouse off",
    "set -g focus-events on",
  ].join("\n") + "\n";
  try { mkdirSync(hostStateDir(core.root), { recursive: true }); writeFileSync(p, conf); } catch { /* non-fatal */ }
  return p;
}

function liveDir(core: SessionCore): string { return join(hostStateDir(core.root), "live"); }
export function livePath(core: SessionCore, id: string): string { return join(liveDir(core), `${id}.json`); }
let lastLiveWarnAt = 0;
export function persistLive(core: SessionCore, m: LiveMeta): void {
  // The budget is taken off the LIVE session whenever there is one: several
  // writers rebuild this record field by field (`convid.ts`), and a field they
  // do not name would otherwise be deleted by the next id adoption. Before the
  // session is registered (`create`), the record's own value stands.
  const live = core.sessions.get(m.id);
  // The server stamp is THIS process's, always: every writer is either creating
  // the session on this host's server or rewriting one this host holds, so the
  // stamp is a fact about the pane — what the boot reclaim (`staleLiveIds`)
  // checks before it believes a listing that lacks the name.
  const rec: LiveMeta = live
    ? { ...m, budget: live.info.budget?.cfg, budgetTripped: live.budgetTripped ? true : undefined, budgetEscOwed: live.budgetEscOwed ? true : undefined, askDismissed: live.askDismissed?.text, tmuxSocket: TMUX_SOCKET_ID }
    : { ...m, tmuxSocket: TMUX_SOCKET_ID };
  try { mkdirSync(liveDir(core), { recursive: true }); writeJsonAtomic(livePath(core, m.id), rec); } catch (e) {
    // Non-fatal, but not silent: a record that never lands is a session that
    // cannot be re-attached after a restart. One line per 60 s, not per call.
    const now = Date.now();
    if (now - lastLiveWarnAt > 60_000) { lastLiveWarnAt = now; console.error(`[tmux] could not persist live record ${m.id}: ${(e as Error).message}`); }
  }
}
export function loadLive(core: SessionCore, id: string): LiveMeta | null {
  // Guarded: a corrupt record is kept as `.corrupt-*` and logged, not silently dropped.
  return readJsonGuarded<LiveMeta | null>(livePath(core, id), null, (v) => typeof v === "object" && v !== null && !Array.isArray(v));
}
export function deleteLive(core: SessionCore, id: string): void { try { rmSync(livePath(core, id), { force: true }); } catch { /* non-fatal */ } }

/**
 * Every session id that still means something: the ones in the map, plus every
 * record in `live/`.
 *
 * The second half is not belt-and-braces — it is the same source
 * `rediscover()` adopts from, and asking it is what keeps a tmux session this
 * boot happened not to re-attach (server slow, `reattach` threw) out of the
 * orphan set. Deliberately not a second list maintained alongside: a store
 * that had to be kept in step would be wrong exactly when the sweep is asked.
 * What keeps `live/` itself honest is `reclaimStaleLive`, run by `rediscover()`
 * before this is asked: a record whose pane is provably gone is deleted there,
 * so its session's files become orphans here like any other.
 */
export function aliveSessionIds(core: SessionCore): Set<string> | null {
  const alive = new Set<string>(core.sessions.keys());
  try {
    for (const f of readdirSync(liveDir(core))) {
      if (f.endsWith(".json")) alive.add(f.slice(0, -".json".length));
    }
  } catch (err) {
    // ENOENT is the honest "there is no live store" — nothing was ever
    // spawned under this state dir, so the map is the whole answer and the
    // sweep may proceed.
    //
    // Anything else is the store being UNREADABLE, which is the one failure
    // the age gate cannot cover: a live tmux session idle past the gate is
    // protected by this read and by nothing else. A `null` here means "do not
    // sweep this boot" — skipping a pass costs some kilobytes until the next
    // restart, and getting it wrong costs a session its prompt history.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
  }
  return alive;
}

/** One deferred pass over the two per-session stores. See `sweepSessionStores`. */
export function armOrphanSweep(core: SessionCore): void {
  const t = setTimeout(() => {
    const base = hostStateDir(core.root);
    try {
      const r = sweepSessionStores([join(base, "history"), join(base, "summaries")], aliveSessionIds(core));
      if (r.skipped) console.warn(`${logTag} orphan sweep skipped — the live store could not be read`);
      else if (r.deleted) console.log(`${logTag} swept ${r.deleted} orphaned session file(s), kept ${r.kept}`);
    } catch (e) { console.error(`${logTag} orphan sweep failed`, e); }
  }, ORPHAN_SWEEP_DELAY_MS);
  t.unref?.();
}

/** Is a claude session still alive in tmux under this id? */
/**
 * One log line for a session whose PTY ended — the facts that tell the next
 * unexplained exit apart, written at the only moment they can be read.
 *
 * It exists because one could not be explained: on 2026-09-30 sessions died
 * and the host's `.out.log` held nothing — no code, no signal, no time — while
 * npm was reinstalling the CLI underneath them. So it records:
 * - the PTY's code and signal. Under tmux those are the tmux CLIENT's, which is
 *   why the next fact is here;
 * - whether the tmux session outlived the client. Alive ⇒ it was OUR client
 *   that died and the CLI is still running; gone ⇒ the CLI itself ended;
 * - how long ago the binary on disk last changed, so an exit that follows a
 *   reinstall says so instead of being guessed at from npm's logs.
 * Every read degrades to leaving its clause out — a log line never throws.
 */
export function exitReport(
  s: { id: string; title: string; cwd: string; createdAt: number; running?: boolean },
  exitCode: number | null | undefined, signal: number | null | undefined, bin: string, now = Date.now(),
): string {
  const parts = [`session exit · ${basename(s.cwd)} (${s.id}) · ${s.title}`,
    `code ${exitCode ?? "none"} signal ${signal || "none"}`,
    `up ${ago(now - s.createdAt)}`];
  parts.push(hasLiveTmux(s.id) ? "tmux session STILL ALIVE — the client died, not the CLI" : "tmux session gone");
  const changed = binChangedAt(bin);
  if (changed != null) parts.push(`${basename(bin)} on disk changed ${ago(now - changed)} ago`);
  return `${logTag} ${parts.join(" · ")}`;
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** mtime of the binary a bare name resolves to on PATH, through its symlink; null when unresolvable. */
function binChangedAt(bin: string): number | null {
  const dirs = bin.includes("/") ? [""] : (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { return statSync(realpathSync(dir ? join(dir, bin) : bin)).mtimeMs; } catch { /* next */ }
  }
  return null;
}

export function hasLiveTmux(id: string): boolean {
  try { execFileSync("tmux", ["-L", TMUX_SERVER, "has-session", "-t", tmuxName(id)], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// ── Parking: a live pane whose backend is not registered (yet) ────────────────
//
// `rediscover()` runs before external plugins activate (`loadAll()` is not
// awaited), so a pane running a PLUGIN's backend is found while nothing can
// say what it is. Dropping it would orphan a running CLI; adopting it as
// claude would arm claude's readers against a screen none of them was written
// for. So it is PARKED: held here, retried on every backends change, and — once
// the plugins have settled and it is still unknown — shown as a closed row that
// is still `alive`, saying in words which plugin it waits for. A later
// registration of that backend adopts it and takes the row away.

interface Parked { meta: LiveMeta; closed: boolean }
interface ParkState {
  map: Map<string, Parked>;
  /** `loadAll()` has finished: a record still unknown now gets its closed row at once. */
  settled: boolean;
  /** Which plugin declares a backend id, in words; null when none does. */
  who: (backendId: string) => string | null;
}
const PARKED = new WeakMap<SessionCore, ParkState>();

function parkState(core: SessionCore): ParkState {
  let st = PARKED.get(core);
  if (!st) { st = { map: new Map(), settled: false, who: () => null }; PARKED.set(core, st); }
  return st;
}

/** The records parked under this manager, by session id (a copy). */
export function parkedLive(core: SessionCore): ReadonlyMap<string, LiveMeta> {
  return new Map([...parkState(core).map].map(([id, p]) => [id, p.meta]));
}

/** The sentence a parked session's closed row carries. Short: closed-row text is clipped. */
export function unadoptedReason(backendId: string, plugin: string | null): string {
  return plugin
    ? `Still running on "${backendId}", which ${plugin} provides; switch that plugin on to take it back.`
    : `Still running on "${backendId}", which no installed plugin provides.`;
}

function closeParkedOne(core: SessionCore, st: ParkState, p: Parked, why?: string): void {
  const m = p.meta;
  const backendId = m.launch?.backend ?? "";
  p.closed = true;
  core.pushClosed({
    id: m.id, cwd: m.cwd, title: m.title, closedAt: Date.now(), launch: m.launch,
    ...(m.claudeSessionId ? { claudeSessionId: m.claudeSessionId } : {}),
    ...(m.backendSessionId ? { backendSessionId: m.backendSessionId } : {}),
    alive: true, unadopted: why ?? unadoptedReason(backendId, st.who(backendId)),
    ...(m.origin ? { kind: m.origin.kind } : {}),
    openedAt: m.createdAt,
  });
}

/**
 * `rediscover()`'s per-record step: re-attach when the record's backend is
 * known (absent = claude, always known), else park it. Throws what `reattach`
 * throws, as before.
 */
export function adoptOrPark(core: SessionCore, m: LiveMeta): "attached" | "parked" {
  const b = m.launch?.backend;
  if (!b || knownBackend(b)) { core.reattach(m); return "attached"; }
  const st = parkState(core);
  const p: Parked = { meta: m, closed: false };
  st.map.set(m.id, p);
  if (st.settled) closeParkedOne(core, st, p);
  return "parked";
}

/**
 * The backends changed: adopt every parked record whose backend now exists and
 * whose pane is still alive; forget one whose pane has gone. Its closed row, if
 * it had one, is taken away on adoption. Returns the ids adopted.
 */
export function retryParked(core: SessionCore): string[] {
  const st = parkState(core);
  const adopted: string[] = [];
  let rows = false;
  for (const [id, p] of [...st.map]) {
    if (!knownBackend(p.meta.launch?.backend ?? "")) continue;
    st.map.delete(id);
    if (core.sessions.has(id) || !core.hasLiveTmux(id)) continue;
    try { core.reattach(p.meta); adopted.push(id); } catch (e) {
      // Neither live nor listed would lose a running pane: it stays parked (the next backends
      // change tries again) and its closed row says what went wrong, replacing one that said
      // to switch a plugin on — that plugin IS on.
      st.map.set(id, p);
      if (p.closed) core.dropClosed(id);
      const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
      closeParkedOne(core, st, p, `Still running, but taking it back failed: ${msg}`);
      rows = true;
      continue;
    }
    if (p.closed) { core.dropClosed(id); rows = true; }
  }
  if (rows) core.publishClosed();
  return adopted;
}

/**
 * The plugins have settled (`loadAll()` finished): every record still parked
 * becomes a closed row saying which plugin it waits for, and so does any found
 * later. It stays parked — switching the plugin on still adopts it.
 */
export function settleParked(core: SessionCore, who: (backendId: string) => string | null): number {
  const st = parkState(core);
  st.who = who;
  st.settled = true;
  let n = 0;
  for (const p of st.map.values()) if (!p.closed) { closeParkedOne(core, st, p); n++; }
  return n;
}
