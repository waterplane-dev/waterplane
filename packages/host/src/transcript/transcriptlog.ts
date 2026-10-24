/** The CLI log's location, freshness and record predicates. Moved from transcript.ts. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { LABEL_CAP, isConversationId } from "@waterplane/shared";
import { claudeProjectDir } from "../claudeconfig.js";

/** Parse at most this much of the log (tail-read beyond it). Transcripts of a
 *  long day reach tens of MB; this keeps a fetch bounded. */
export const MAX_READ = 24 * 1024 * 1024;

export function transcriptPath(cwd: string, claudeSessionId: string): string {
  // A non-id (`../../x`) never becomes a path: the join would leave the project
  // dir. The returned path simply does not exist, so every reader (stat, read,
  // tail) degrades to "no log" instead of throwing.
  if (!isConversationId(claudeSessionId)) return join(claudeProjectDir(cwd), "invalid-conversation-id.jsonl");
  return join(claudeProjectDir(cwd), claudeSessionId + ".jsonl");
}

/** Last-modified time of a conversation log, or null if it isn't there. Lets a
 *  polling client be answered from a stat instead of re-parsing tens of MB. */
export function logMtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * When this conversation last carried a real TURN — the newest `user` or
 * `assistant` record in the log's tail.
 *
 * Deliberately not the file's mtime. The CLI rewrites its own bookkeeping rows
 * (`mode`, `permission-mode`, `last-prompt`, `atis-latch`, `bridge-session`)
 * whenever a client attaches, and a `npm run restart` re-attaches every tmux
 * session at once — so mtime moves on a hundred conversations that did no work.
 * Measured on this host: of 97 live sessions, 92 had an mtime under an hour old
 * and a last real turn 87 to 143 HOURS old. The whole point of this field is to
 * answer "has anything happened here since yesterday", and mtime answers "did
 * anything open the file", which after a restart is always yes.
 *
 * Bounded tail read, memoized on the file's own identity, so the common case is
 * a `stat`: this is asked once per session per settle, with a hundred sessions
 * live. Null when the tail holds no message record at all — absent, never a
 * guess, and callers fall back to what they had before.
 */
export const turnAtCache = new Map<string, { key: string; at: number | null }>();
export const TURN_TAIL = 256 * 1024;
/**
 * Cap on the memo, because nothing else ever emptied it: an entry was added per
 * PATH this process asked about and none was ever dropped, so a long-lived
 * daemon accumulated one per conversation it had ever touched — sessions closed
 * weeks ago included. 512 is several boots' worth against the 107 live sessions
 * measured on this host, i.e. it never evicts anything the steady state is
 * actually re-asking for. Delete-and-reinsert on a hit makes Map insertion order
 * an approximate LRU, which is all that is wanted here: the entries are tiny and
 * a miss costs one bounded tail read.
 */
export const TURN_CACHE_MAX = 512;

export function lastTurnAt(path: string): number | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = turnAtCache.get(path);
  if (hit && hit.key === key) { turnAtCache.delete(path); turnAtCache.set(path, hit); return hit.at; }
  let at: number | null = null;
  try {
    const len = Math.min(TURN_TAIL, st.size);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: { type?: string; timestamp?: string };
      try { r = JSON.parse(line); } catch { continue; }  // a half-written head line
      if (r.type !== "assistant" && r.type !== "user") continue;
      if (!r.timestamp) continue;
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t) && (at === null || t > at)) at = t;
    }
  } catch { at = null; }
  turnAtCache.delete(path);
  turnAtCache.set(path, { key, at });
  if (turnAtCache.size > TURN_CACHE_MAX) {
    const oldest = turnAtCache.keys().next().value;
    if (oldest !== undefined) turnAtCache.delete(oldest);
  }
  return at;
}

/** Read the (tail of the) log. Returns null when it isn't there yet. */
export function readLog(path: string): { lines: string[]; bytes: number; partial: boolean; mtime: number } | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const start = Math.max(0, st.size - MAX_READ);
  const len = st.size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // first line of a tail-read is usually half a record
  return { lines, bytes: st.size, partial: start > 0, mtime: st.mtimeMs };
}

/** Text of a content part, whatever shape it takes. */
function partText(p: any): string {
  if (typeof p === "string") return p;
  if (!p || typeof p !== "object") return "";
  if (typeof p.text === "string") return p.text;
  if (typeof p.thinking === "string") return p.thinking;
  if (p.type === "image") return "[image]";
  return "";
}

/** Flatten a tool_result's `content` (string, or an array of text parts). */
export function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(partText).filter(Boolean).join("\n");
  if (c && typeof c === "object") return partText(c);
  return "";
}

/**
 * Prompt records the user never typed: hook output, slash-command plumbing,
 * task notifications, the CLI's own caveats. They'd each open a bogus turn.
 */
function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|agent-message|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]/.test(t)
    || t.startsWith("Caveat: The messages below were generated");
}

/**
 * The LOCAL COMMAND a raw user record carries — `/goal`, `/context`, `/help`.
 *
 * The CLI writes these as an envelope of plumbing tags rather than as a prompt,
 * which is exactly why `isSyntheticPrompt` drops them: they must not open a
 * model turn and they must not title an archive row. But dropping them also
 * deleted them from the reader, and a command somebody typed — with its answer
 * printed under it — is a thing that happened in the conversation. So they are
 * recognised here and given a turn of their own (`local: "log"`), which is a
 * different claim from a prompt and is labelled as one.
 *
 * Returns the command as a person typed it. Null for anything else, including
 * a record whose args are missing — a bare `<command-name>` is still a command.
 */
export function localCommandOf(rec: any): string | null {
  if (rec?.type !== "user" || rec?.isSidechain || rec?.isMeta) return null;
  const content = rec?.message?.content;
  const parts: any[] = Array.isArray(content) ? content : content == null ? [] : [{ type: "text", text: String(content) }];
  if (parts.some((p) => p?.type === "tool_result")) return null;
  const text = parts.map(partText).filter(Boolean).join("\n");
  const name = /^\s*<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  const slashed = name.startsWith("/") ? name : `/${name}`;
  return (args ? `${slashed} ${args}` : slashed).slice(0, LABEL_CAP * 8);
}

/**
 * The OUTPUT a local command printed, out of the record that follows its
 * envelope. `stderr` counts: a command that failed said so there, and hiding it
 * would leave a turn that reads as if the command did nothing.
 */
export function localOutputOf(rec: any): string | null {
  if (rec?.type !== "user" || rec?.isSidechain) return null;
  const content = rec?.message?.content;
  const parts: any[] = Array.isArray(content) ? content : content == null ? [] : [{ type: "text", text: String(content) }];
  const text = parts.map(partText).filter(Boolean).join("\n");
  const m = /^\s*<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text);
  if (!m) return null;
  return m[1].trim();
}

/**
 * The user PROMPT a raw log record carries, or null when it is not one — a tool
 * result, a hook echo, a slash-command envelope, the resume caveat. Exported
 * because `archive.ts` titles a conversation by its first prompt and the reader
 * opens a turn on the same records: two copies of this rule would drift, and the
 * visible symptom would be an archive row labelled `<command-name>`.
 */
export function promptOf(rec: any): string | null {
  if (rec?.type !== "user" || rec?.isSidechain || rec?.isMeta) return null;
  const content = rec?.message?.content;
  const parts: any[] = Array.isArray(content) ? content : content == null ? [] : [{ type: "text", text: String(content) }];
  if (parts.some((p) => p?.type === "tool_result")) return null;
  const text = parts.map(partText).filter(Boolean).join("\n");
  return isSyntheticPrompt(text) ? null : text;
}

/**
 * **A prompt the CLI took mid-turn, out of the `attachment` record that is the
 * only trace of it.**
 *
 * The TUI holds a prompt typed into a busy session. When the turn ends it
 * normally starts it properly and the log gets a `user` record — which is what
 * `promptOf` reads and what every turn in this parser is built on. But it may
 * instead absorb the prompt into the turn already running, and then there is no
 * `user` record ever: the words appear once, as
 * `{"type":"attachment","attachment":{"type":"queued_command","prompt":…}}`,
 * alongside `queue-operation` bookkeeping rows this parser has no use for.
 *
 * Measured across seven days of logs on this desktop: 48 of 62 real queued
 * prompts (77%) were written that way and no other. Every one of them was
 * invisible to the reader, its answer was folded into the previous prompt's
 * turn, and `queuedTurns` — which retires a row by finding the log's own copy of
 * the prompt — never found one, so waterplane's own "sent · the CLI has not started
 * it yet" row stayed on screen for ever, sorted below the answer.
 *
 * The record's `timestamp` is when the person sent it, not when it was absorbed,
 * which is what the row should say and what keeps it in time order against the
 * prompt above it.
 *
 * Synthetic prompts are dropped here for `isSyntheticPrompt`'s reasons — 261 of
 * the 348 queued rows in that sample were `<task-notification>` plumbing, which
 * must no more open a turn from an attachment than it does from a `user` record.
 */
export function queuedPromptOf(rec: any): string | null {
  if (rec?.type !== "attachment" || rec?.isSidechain) return null;
  const a = rec?.attachment;
  if (a?.type !== "queued_command") return null;
  const text = typeof a.prompt === "string" ? a.prompt : "";
  return isSyntheticPrompt(text) ? null : text;
}

/**
 * Does this raw record OPEN a turn?
 *
 * The same question `parseTranscript` asks record by record, exported so a
 * COUNT of turns and the LIST of them cannot disagree — which is exactly what
 * happened when the count was taken off the context series instead: that series
 * has one reading per REQUEST, so a turn that ran thirteen tools contributed
 * fourteen, and a four-turn conversation was labelled twenty-four.
 *
 * It is the two openers the parser has: a prompt somebody typed, and a local
 * command (`/model`), which gets a turn of its own and is listed as one. A
 * tool result, a hook echo and a command's own stdout open nothing.
 *
 * Two things the parser counts that this cannot see, both of which make a count
 * built on it a FLOOR and are worded as one at the call site: the synthetic
 * "(continued)" turn a resumed log's pre-prompt tail opens, and the screen-only
 * turns `screenCommandTurns` splices in from what this host typed.
 *
 * `queuedPromptOf` is deliberately NOT a third opener here, though the parser
 * opens a turn on it. Whether one of those attachments is a turn depends on
 * whether the SAME words also reached the log as a `user` record — a question
 * about the whole file, which a per-record predicate cannot ask. Counting it
 * here would double-count every prompt the CLI did start properly, and this
 * count's contract is that it is a floor.
 */
export function opensTurn(rec: any): boolean {
  return localCommandOf(rec) != null || promptOf(rec) != null;
}

