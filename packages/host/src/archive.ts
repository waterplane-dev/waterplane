/**
 * The conversation ARCHIVE: every conversation the `claude` CLI ever wrote for a
 * repo, listed straight off disk.
 *
 * Closing a session was never a delete — the PTY dies, the tmux session dies,
 * and the conversation log stays in `~/.claude/projects/<slug>/<uuid>.jsonl`,
 * reopenable with `--resume <uuid>`. What was missing is the ROUTE BACK: the
 * only records of which conversations those were are the reopen stack and the
 * recent list, and both are shortlists with a cap. One bulk close of a busy repo
 * retires more sessions than either can hold, and everything past the edge is
 * still on disk and unreachable from the phone.
 *
 * So this module reads the truth instead of remembering it. No bookkeeping to
 * keep in sync, no cap, nothing to lose in a restart — the listing is a
 * `readdir` plus a `stat`, and a row is resumable because the filename IS the
 * conversation id. `sessions.json` / `closed.json` stay as the fast shortlist.
 *
 * Cost discipline: a repo here has thousands of logs, so a TITLE (the first user
 * prompt) is read only for the page actually being returned — a bounded head
 * read, not a parse — and memoized by conversation id, which is safe because a
 * conversation's first prompt never changes once written. A text QUERY is the
 * one path that must title everything to filter it; that first sweep warms the
 * same cache, so it is paid once per repo per boot.
 */
import { closeSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isConversationId } from "@waterplane/shared";
import type { ArchivedConversation, ArchiveListing, Bookmark, TranscriptDoc, TranscriptToolDetail } from "@waterplane/shared";
import { claudeProjectDir, logMtime, parseTranscript, promptLabel, promptOf, toolDetails, transcriptPath } from "./transcript.js";

/** Bytes read from the head of a log to find its first prompt. A conversation
 *  opens with a handful of records; a system-reminder block is the only thing
 *  that makes that long, and it is bounded too. */
const HEAD_BYTES = 96 * 1024;
/** Rows returned when a caller names no limit. */
const PAGE = 60;
const TITLE_CAP = 200;

/** id → first-prompt one-liner. A conversation's first prompt is immutable, so
 *  this never needs invalidating; it is dropped whole with the process. */
const titles = new Map<string, string>();

/** Read the first `HEAD_BYTES` of a file as text. Partial trailing line included
 *  — the JSON parse below rejects it. */
function head(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * The label for one conversation: its first real user prompt, one line.
 *
 * Empty when the log holds no prompt yet — a session that was opened and closed
 * without being typed into. The caller shows that as "(no prompt)" rather than
 * inventing a name from the uuid, because a row you cannot recognise is worse
 * than a row that admits it has nothing to show.
 */
function titleOf(id: string, path: string): string {
  const cached = titles.get(id);
  if (cached != null) return cached;
  let out = "";
  for (const raw of head(path).split("\n")) {
    const ln = raw.trim();
    if (!ln) continue;
    let rec: any;
    try { rec = JSON.parse(ln); } catch { continue; } // truncated tail of the window
    const text = promptOf(rec);
    if (text) { out = promptLabel(text, TITLE_CAP); break; }
  }
  titles.set(id, out);
  return out;
}

/** Every conversation log for a directory, newest first, as id + stat only. */
function statAll(cwd: string): Array<{ id: string; path: string; mtime: number; size: number }> {
  const dir = claudeProjectDir(cwd);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; } // no conversations here yet
  const out: Array<{ id: string; path: string; mtime: number; size: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ id: name.slice(0, -".jsonl".length), path, mtime: st.mtimeMs, size: st.size });
    } catch { /* vanished between readdir and stat */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * One page of a repo's archive.
 *
 * `q` filters on the title, which means titling every log — the expensive path,
 * and the reason the un-filtered listing exists at all. It also matches a row's
 * `name` and its bookmark's note. `bookmarked` cuts to the conversations
 * `bookmarks` names BEFORE the query (cheap: a bookmarked repo has a handful).
 * `total` is the count AFTER filtering, so the UI can say "N of M" honestly.
 *
 * `bookmarks` and `names` are the caller's (the bookmark store, and the tab
 * names the session roster still knows); this module remembers neither. A
 * bookmark whose log is gone is never listed — the listing is what is on disk.
 */
export function listArchive(
  cwd: string,
  opts: {
    offset?: number; limit?: number; q?: string; bookmarked?: boolean;
    bookmarks?: ReadonlyMap<string, Bookmark>; names?: ReadonlyMap<string, string>;
  } = {},
): ArchiveListing {
  const all = statAll(cwd);
  const q = (opts.q ?? "").trim().toLowerCase();
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(500, opts.limit ?? PAGE));
  const marks = opts.bookmarks ?? new Map<string, Bookmark>();
  const nameOf = (id: string): string | undefined => opts.names?.get(id) || marks.get(id)?.name || undefined;

  let rows = all;
  if (opts.bookmarked) rows = rows.filter((r) => marks.has(r.id));
  if (q) {
    rows = rows.filter((r) => titleOf(r.id, r.path).toLowerCase().includes(q) || r.id.includes(q)
      || (nameOf(r.id) ?? "").toLowerCase().includes(q) || (marks.get(r.id)?.note ?? "").toLowerCase().includes(q));
  }

  const page = rows.slice(offset, offset + limit).map<ArchivedConversation>((r) => {
    const name = nameOf(r.id);
    const bookmark = marks.get(r.id);
    return {
      id: r.id,
      cwd,
      title: titleOf(r.id, r.path),
      mtime: r.mtime,
      size: r.size,
      ...(name ? { name } : {}),
      ...(bookmark ? { bookmark } : {}),
    };
  });
  return { cwd, total: rows.length, offset, rows: page, scanned: all.length, ...(opts.bookmarked ? { bookmarked: true } : {}) };
}

/** Does this directory hold a log for `id`? Bare ids only. */
export function archivedExists(cwd: string, id: string): boolean {
  if (!isConversationId(id)) return false;
  try { return statSync(transcriptPath(cwd, id)).isFile(); } catch { return false; }
}

/**
 * The reader's document for one ARCHIVED conversation, straight off its log —
 * no session, no `claude` spawned, no tokens. The same parser the live reader
 * uses (`parseTranscript`), so the phone draws it with the same view. `since`
 * answers `"unchanged"` from the log's mtime, as `/api/transcript` does.
 * Null for a bad id or a log that is not there; the path is `transcriptPath`
 * of a bare id, never anything the caller spelled.
 */
export function archivedTranscript(
  cwd: string, id: string, since = 0, detail: "lite" | "full" = "lite",
): TranscriptDoc | "unchanged" | null {
  if (!archivedExists(cwd, id)) return null;
  const path = transcriptPath(cwd, id);
  const mtime = logMtime(path);
  if (since && mtime != null && mtime <= since) return "unchanged";
  const parsed = parseTranscript(path, cwd, detail);
  return parsed ? { sessionId: id, claudeSessionId: id, source: "jsonl", ...parsed } : null;
}

/** The tool inputs/results a `lite` archived document withheld, for one turn. */
export function archivedToolDetails(cwd: string, id: string, turnId: string): Record<string, TranscriptToolDetail> | null {
  if (!archivedExists(cwd, id) || !turnId) return null;
  return toolDetails(transcriptPath(cwd, id), cwd, turnId);
}

/**
 * Delete one conversation log for good.
 *
 * The one genuinely destructive act in this file, and the only way to lose a
 * conversation in this app — hence a separate verb from closing a session, and a
 * confirm on the client. Refuses an id that is not a bare uuid-ish filename
 * (`transcriptPath` would otherwise happily take `../../…`), and never touches
 * anything outside the CLI's project directory for this cwd.
 */
export function deleteArchived(cwd: string, id: string): { ok: boolean; error?: string } {
  if (!isConversationId(id)) return { ok: false, error: "bad id" };
  const path = transcriptPath(cwd, id);
  try {
    if (!statSync(path).isFile()) return { ok: false, error: "not a conversation" };
  } catch {
    return { ok: false, error: "no such conversation" };
  }
  try { rmSync(path, { force: true }); } catch { return { ok: false, error: "delete failed" }; }
  titles.delete(id);
  return { ok: true };
}
