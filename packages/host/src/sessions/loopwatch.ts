/**
 * A session stuck in a tool loop, TOLD to the person — the wiring around
 * `toolloop.ts`'s pure rule. Ridden on the agent poll (`agentpoll.ts`), so it
 * is asked only while a turn runs or agents do, and costs nothing when idle.
 *
 * Reads the CLI's own log INCREMENTALLY: the cursor starts at the file's size
 * when first asked (a long conversation is never read whole) and moves on by
 * whole lines (`readRange`). Only a backend that keeps claude's jsonl is asked
 * (`derive(b).keepsClaudeLog`); any other stays silent.
 *
 * The output is the session's follow-up flag, `by: "host"`, with the loop in
 * one line — the phone's bell, the push and the flag filter already carry it,
 * and only a person's tap clears it. Nothing is stopped, nothing typed. A flag
 * somebody else already set is never overwritten.
 */
import { statSync } from "node:fs";
import { derive } from "../backends/derive.js";
import { readRange } from "../ctxlog/ctxcursor.js";
import { feedLoopRow, loopReason, loopVerdict, newLoopState, type LoopState } from "../toolloop.js";
import { transcriptPath } from "../transcript.js";
import type { Session, SessionCore } from "./core.js";
import { TOOL_LOOP_AT } from "./knobs.js";

/** Chunks read per tick at most — a burst is caught up over the next ticks. */
const MAX_CHUNKS = 8;

interface Cursor { path: string; offset: number; st: LoopState }
const cursors = new WeakMap<Session, Cursor>();

export function checkToolLoop(core: SessionCore, s: Session, now = Date.now()): void {
  if (!(TOOL_LOOP_AT > 0) || !s.info.running || !s.info.claudeSessionId) return;
  if (!derive(s.backend).keepsClaudeLog) return;
  const path = transcriptPath(s.info.cwd, s.info.claudeSessionId);
  let c = cursors.get(s);
  if (!c || c.path !== path) {
    let size: number;
    try { size = statSync(path).size; } catch { return; }
    cursors.set(s, { path, offset: size, st: newLoopState() });
    return;
  }
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const r = readRange(path, c.offset);
    if (!r) return;
    if (r.size < c.offset) { c.offset = r.size; c.st = newLoopState(); return; } // rewritten: start over
    for (const line of r.lines) {
      if (!line.startsWith("{")) continue;
      try { feedLoopRow(c.st, JSON.parse(line)); } catch { /* a torn line reads as nothing */ }
    }
    const done = r.consumed === c.offset || r.consumed >= r.size;
    c.offset = r.consumed;
    if (done) break;
  }
  const v = loopVerdict(c.st, TOOL_LOOP_AT);
  if (!v) return;
  c.st.told = true;
  if (core.followUpOf(s.info.id)) return; // a flag is already up — never overwrite it
  core.setFollowUp(s.info.id, { by: "host", at: now, reason: loopReason(v, now) });
}
