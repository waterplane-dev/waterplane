/**
 * Which conversation a session is in, and which model it is running — read off
 * the CLI's own store, never assumed from the launch flags (package S3 of the
 * split, docs/notes/host-architecture.md). Claude's id is found in its project
 * dir; another backend's by its store reader, only when exactly one candidate answers.
 *
 * Stateless: every per-session timer lives on the `Session` record, so these
 * are functions taking `core` first.
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCliVersion } from "@waterplane/shared";
import { DEFAULT_BACKEND, storeReaderFor, type BackendDescriptor } from "../backends/index.js";
import { realResolve } from "../paths.js";
import { claudeProjectDir } from "../transcript.js";
import type { Session, SessionCore } from "./core.js";
import { CLAUDE_ID_POLL_MAX, CLAUDE_ID_POLL_MS } from "./knobs.js";

/**
 * The `backend` field as it goes on the wire — **absent means claude**.
 *
 * Spread into a `SessionInfo` rather than assigned, so a claude session's
 * document is BYTE-IDENTICAL to the one this daemon published before backends
 * existed. An old phone reading a new host must see exactly today's session, and
 * a `backend: "claude"` it has never heard of is not exactly today's session.
 */
export function backendField(b: BackendDescriptor): { backend?: string } {
  return b.id === DEFAULT_BACKEND.id ? {} : { backend: b.id };
}

/**
 * The model the CLI is CURRENTLY using, read from its transcript's last real
 * assistant message. This is the only reliable source: `/model` (native TUI or
 * ours) changes the model with no hook/PTY signal, so the launch flag goes
 * stale. Tail-reads the file (transcripts grow to MBs) and skips `<synthetic>`
 * messages (interrupts/errors carry no chosen model). Null ⇒ leave as-is.
 */
export function lastAssistantModel(transcriptPath: string): string | null {
  return transcriptTail(transcriptPath, 0).model;
}

/**
 * The tail facts of a claude log: the last real model, and the `version` of the
 * newest record written at or after `sinceMs`.
 *
 * `sinceMs` is what keeps the version honest across a restart: a resumed
 * conversation's log still ends in the OLD process's records until the new one
 * writes its first, so a record older than this session's own start says
 * nothing about the binary it runs. Null for either ⇒ leave as-is.
 */
export function transcriptTail(transcriptPath: string, sinceMs: number): { model: string | null; version: string | null } {
  let model: string | null = null;
  let version: string | null = null;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - 128 * 1024);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(transcriptPath, "r");
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first line may be a partial record
    for (let i = lines.length - 1; i >= 0 && (!model || !version); i--) {
      const ln = lines[i].trim();
      if (!ln) continue;
      let o: any;
      try { o = JSON.parse(ln); } catch { continue; }
      const m = o?.message?.model;
      if (!model && typeof m === "string" && m && m !== "<synthetic>") model = m;
      if (!version && typeof o?.version === "string") {
        const at = Date.parse(o?.timestamp ?? "");
        if (Number.isFinite(at) && at >= sinceMs) version = parseCliVersion(o.version) ?? null;
      }
    }
  } catch { /* unreadable/absent transcript — keep the current label */ }
  return { model, version };
}

/**
 * The version of the binary a FRESH spawn runs — `<bin> --version`, asked right
 * after the spawn. Only for a create: a tmux re-attach's process predates this
 * daemon, and asking the binary on disk would report the NEW version for the
 * very process that is still on the old one. Those learn it from their log.
 * A log reading that already landed wins (it is the process speaking).
 */
export function readSpawnVersion(core: SessionCore, s: Session | undefined): void {
  if (!s || s.backend.caps.transcript !== "claude-jsonl") return;
  execFile(s.backend.bin(), ["--version"], { timeout: 15_000 }, (err, stdout) => {
    if (err) return;
    const v = parseCliVersion(String(stdout));
    if (!v || s.info.cliVersion) return;
    s.info.cliVersion = v;
    core.emit("updated", s.info);
  });
}

// ── Claude conversation id detection ────────────────────────────────
// Sessions spawned with --continue / the picker / --fork-session (and tmux
// re-attaches of pre-upgrade sessions) don't know their conversation UUID up
// front. Find it by watching the claude project dir: the newest .jsonl
// modified after our spawn — excluding conversations already claimed by
// other live sessions in the same cwd — is ours.

export function detectClaudeId(core: SessionCore, s: Session): string | null {
  const used = new Set<string>();
  for (const o of core.sessions.values()) {
    if (o !== s && o.info.claudeSessionId && o.info.cwd === s.info.cwd) used.add(o.info.claudeSessionId);
  }
  try {
    const dir = claudeProjectDir(s.info.cwd);
    let best: { id: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const cid = f.slice(0, -".jsonl".length);
      if (used.has(cid)) continue;
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (mtime >= s.spawnedAt && (!best || mtime > best.mtime)) best = { id: cid, mtime };
    }
    return best?.id ?? null;
  } catch { return null; } // no project dir yet / unreadable — try again later
}

/** Record a detected conversation id: SessionInfo, LiveMeta, recent list. */
export function adoptClaudeId(core: SessionCore, s: Session, cid: string | null): void {
  if (!cid || s.info.claudeSessionId) return;
  s.info.claudeSessionId = cid;
  core.persistLive({ id: s.info.id, cwd: s.info.cwd, title: s.info.title, launch: s.launch, createdAt: s.info.createdAt, claudeSessionId: cid, ...(s.origin ? { origin: s.origin } : {}) });
  core.rememberRecent(s);
  core.emit("updated", s.info);
}

export function watchClaudeId(core: SessionCore, s: Session): void {
  let tries = 0;
  const tick = () => {
    s.claudeIdTimer = null;
    if (!core.sessions.has(s.info.id) || !s.info.running || s.info.claudeSessionId) return;
    const cid = detectClaudeId(core, s);
    if (cid) { adoptClaudeId(core, s, cid); return; }
    // Only conversations that produced OUTPUT have a jsonl to find; keep
    // polling while the session lives, but back off after the cap (the picker
    // can sit unanswered for a long time). A final attempt runs at close.
    if (++tries < CLAUDE_ID_POLL_MAX) s.claudeIdTimer = setTimeout(tick, CLAUDE_ID_POLL_MS);
  };
  s.claudeIdTimer = setTimeout(tick, CLAUDE_ID_POLL_MS);
}

export function stopClaudeIdWatch(s: Session): void {
  if (s.claudeIdTimer) { clearTimeout(s.claudeIdTimer); s.claudeIdTimer = null; }
  if (s.storeIdTimer) { clearTimeout(s.storeIdTimer); s.storeIdTimer = null; }
}

// ── Another backend's conversation id ───────────────────────────────────────
//
// A backend with no `--session-id` (opencode: `packages/extensions/opencode/`) cannot have its
// conversation id MINTED the way claude's is. It can only be DISCOVERED, by the store reader its
// `caps.transcript` names (`backends/readers.ts`, `PluginStoreReader.discover`). The watcher here
// mirrors `watchClaudeId` deliberately — same cadence, same cap, same "a final attempt runs at
// close" — and the RULE (exactly one candidate, or none) is the reader's, stated with its store.
//
// **No health observation, either way.** A plugin backend has `healthScope: false`, and this is a
// reader written for that backend rather than a claude reader that missed: an adoption that has
// not happened yet is not a heuristic that failed.

/**
 * One pass of the discovery, through the backend's store reader. An id only when it is
 * unambiguous; null when the reader is not there (its plugin switched off) or could not tell.
 */
export function detectBackendId(core: SessionCore, s: Session): string | null {
  const reader = storeReaderFor(s.backend.caps);
  if (!reader) return null;
  const used = new Set<string>();
  for (const o of core.sessions.values()) {
    if (o !== s && o.info.backendSessionId) used.add(o.info.backendSessionId);
  }
  // The store records a REALPATH (`/private/tmp`, not `/tmp`), so the compare
  // has to be made on one. `paths.ts`'s resolver, not a bare `realpathSync`:
  // a cwd that has since gone away must degrade, not throw.
  const dir = realResolve(s.info.cwd);
  let v: { id: string | null; carry: unknown };
  try {
    v = reader.discover({
      dir, ownRow: !!s.createdRecord, spawnedAt: s.spawnedAt,
      ...(s.storePromptProbe ? { probe: s.storePromptProbe } : {}),
      adopted: used, carry: s.storeIdCarry ?? null, now: Date.now(),
    });
  } catch { return null; }
  s.storeIdCarry = v.carry ?? null;
  return typeof v.id === "string" && v.id ? v.id : null;
}

/** Record a discovered backend conversation id: SessionInfo, LiveMeta, the
 *  recent list. The twin of `adoptClaudeId`, and as deliberately narrow: an
 *  id already known is never overwritten. */
export function adoptBackendId(core: SessionCore, s: Session, id: string | null): void {
  if (!id || s.info.backendSessionId) return;
  s.info.backendSessionId = id;
  s.storePromptProbe = undefined;
  s.storeIdCarry = null;
  core.persistLive({
    id: s.info.id, cwd: s.info.cwd, title: s.info.title, launch: s.launch,
    createdAt: s.info.createdAt, claudeSessionId: s.info.claudeSessionId, backendSessionId: id,
    ...(s.origin ? { origin: s.origin } : {}),
  });
  core.rememberRecent(s);
  core.emit("updated", s.info);
}

export function watchBackendId(core: SessionCore, s: Session): void {
  // **Not armed where the id is KNOWN at spawn** (design §2, "conversation id").
  // On opencode's hybrid the daemon creates (or picks) the conversation on the
  // session's own server before the TUI attaches to it, and the side channel's
  // handle names it (`SourceHandle.backendSessionId`, adopted by
  // `sidechannel.ts`) — a store scan could only find the same id later, or,
  // racing a second session in the same repo, a stranger's.
  if (s.backend.sources) return;
  let tries = 0;
  const tick = () => {
    s.storeIdTimer = null;
    if (!core.sessions.has(s.info.id) || !s.info.running || s.info.backendSessionId) return;
    const id = detectBackendId(core, s);
    if (id) { adoptBackendId(core, s, id); return; }
    if (++tries < CLAUDE_ID_POLL_MAX) s.storeIdTimer = setTimeout(tick, CLAUDE_ID_POLL_MS);
  };
  s.storeIdTimer = setTimeout(tick, CLAUDE_ID_POLL_MS);
}

/** Re-derive info.model (and info.cliVersion) from the transcript and
 *  broadcast if either changed. Called on turn boundaries — catches a
 *  mid-session `/model` switch. */
export function refreshModel(core: SessionCore, s: Session, transcriptPath?: string): void {
  if (s.backend.caps.transcript !== "claude-jsonl") return;
  const path = transcriptPath
    || (s.info.claudeSessionId ? join(claudeProjectDir(s.info.cwd), s.info.claudeSessionId + ".jsonl") : null);
  if (!path || !existsSync(path)) return;
  const { model: m, version: v } = transcriptTail(path, s.info.createdAt);
  let changed = false;
  if (m && m !== s.info.model) { s.info.model = m; changed = true; }
  if (v && v !== s.info.cliVersion) { s.info.cliVersion = v; changed = true; }
  if (changed) core.emit("updated", s.info);
}
