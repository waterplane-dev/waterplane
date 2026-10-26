/**
 * The folder's sessions as a list: which logs are worth a row, what a row says, and how a row is
 * kept fresh without re-reading what did not change.
 *
 * A row is a `SessionSummary` — one number each, none of the chart data — cut from the same
 * `readSession` doc the drilled-in view uses, so a row and the headline never differ. Only logs
 * in the recent window are ever read (cap `MAX_ROWS`); each keeps its cursor, and a log whose
 * size and mtime are unchanged is not touched at all, so a poll costs one `stat` per listed log.
 * The selected session is the exception: it is always advanced (its subagents write while the
 * parent log sleeps). A row's cost is therefore as fresh as its PARENT log; an unselected
 * session's subagent spend shows up the next time its own log moves.
 */
import { open } from "node:fs/promises";
import type { SessionDoc, SessionRow, SessionSummary } from "../protocol.js";
import { readSession } from "./session.js";
import type { SessionCursor } from "./session.js";
import { sessionTotal } from "./sessiontotal.js";

/** A session older than this (by its log's last write) is not listed — unless it is the newest or the picked one. */
export const WINDOW_MS = 24 * 60 * 60_000;
export const MAX_ROWS = 12;

/**
 * The rows worth listing, newest first (as `listSessions` gives them): interactive logs written
 * within `WINDOW_MS`, the newest interactive one always, `keepId` (the selected one) always, at
 * most `MAX_ROWS`. `auto(row)` says a log is an unattended `claude -p` / SDK run (see `isAutomated`);
 * those are never listed unless selected, and still count in All sessions.
 *
 * `older` = logs outside the window, `capped` = recent interactive ones the cap cut,
 * `automated` = recent automated ones left out.
 */
export function recentRows(
  rows: SessionRow[], now: number, keepId: string | null, auto: (r: SessionRow) => boolean = () => false,
): { listed: SessionRow[]; older: number; capped: number; automated: number } {
  const newestHuman = rows.find((r) => !auto(r));
  const recent = (r: SessionRow): boolean => now - r.mtime < WINDOW_MS;
  const fresh = rows.filter((r) => r.id === keepId || (!auto(r) && (r === newestHuman || recent(r))));
  let listed = fresh.slice(0, MAX_ROWS);
  const keep = keepId ? fresh.find((r) => r.id === keepId) : undefined;
  if (keep && !listed.includes(keep)) listed = [...listed.slice(0, MAX_ROWS - 1), keep];
  const automated = rows.filter((r) => r.id !== keepId && auto(r) && recent(r)).length;
  return { listed, older: rows.length - fresh.length - automated, capped: fresh.length - listed.length, automated };
}

/**
 * Is this `entrypoint` an unattended run? The CLI stamps every record with how it was started:
 * "cli" for the interactive TUI, "sdk-cli" for `claude -p`, "sdk-ts" / "sdk-py" for the SDKs,
 * "claude-vscode" for the VS Code extension. Absent or unknown = interactive: a log is hidden
 * only on positive evidence.
 */
export const isAutomated = (entrypoint: string | null | undefined): boolean =>
  typeof entrypoint === "string" && entrypoint.startsWith("sdk");

const ENTRY = /"entrypoint":"([^"\\]*)"/;
/** The head of a log that is read to find its entrypoint: it rides the first few records. */
const PEEK_BYTES = 16 * 1024;

/** The `entrypoint` named in the head of a log, or null when none is (yet). */
export async function peekEntrypoint(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PEEK_BYTES, 0);
    return ENTRY.exec(buf.toString("utf8", 0, bytesRead))?.[1] ?? null;
  } catch { return null; } finally { await fh?.close().catch(() => undefined); }
}

/** One doc as a row. `mtime` is the log's stat, the same clock the list sorts by. */
export function summarize(doc: SessionDoc, mtime: number): SessionSummary {
  const total = sessionTotal(doc);
  const typed = doc.turnCosts.filter((t) => t.n > 0);
  const last = doc.turnCosts[doc.turnCosts.length - 1];
  return {
    id: doc.id, path: doc.path, mtime,
    costUsd: total.cost ? total.cost.total : null,
    costNote: total.cost ? null : total.withheld ? "withheld" : "no price",
    lastTok: doc.lastTok, windowTok: doc.windowTok,
    prompts: typed.length,
    lastPrompt: typed.length ? typed[typed.length - 1].prompt : "",
    open: last?.open === true,
    openAt: last?.open === true ? last.at : 0,
    firstTok: doc.carried?.firstRequestTok ?? null,
  };
}

const sigOf = (r: SessionRow): string => `${r.size}:${r.mtime}`;
const yieldTurn = (): Promise<void> => new Promise((res) => setImmediate(res));

export class SessionLedger {
  private cursors = new Map<string, SessionCursor | null>();
  private sums = new Map<string, { sig: string; sum: SessionSummary }>();
  /** How many `readSession` calls this ledger made; the tests pin "unchanged logs are not re-read" on it. */
  reads = 0;
  /** path → entrypoint, once a log named one (it never changes). */
  private entries = new Map<string, string>();

  /** Is this log an unattended run? Known only for logs `peek` has seen. */
  auto = (r: SessionRow): boolean => isAutomated(this.entries.get(r.path));

  /** Learn the entrypoint of every row not yet known (head of the file only; cached once found). */
  async peek(rows: SessionRow[]): Promise<void> {
    const now = new Set(rows.map((r) => r.path));
    for (const p of [...this.entries.keys()]) if (!now.has(p)) this.entries.delete(p);
    await Promise.all(rows.filter((r) => !this.entries.has(r.path)).map(async (r) => {
      const e = await peekEntrypoint(r.path);
      if (e != null) this.entries.set(r.path, e);
    }));
  }

  clear(): void { this.cursors.clear(); this.sums.clear(); this.entries.clear(); }

  /** Advance one log (always) and return its doc and row. */
  async read(row: SessionRow, folder: string): Promise<{ doc: SessionDoc | null; why?: string; sum: SessionSummary | null }> {
    this.reads++;
    const r = await readSession(row.path, this.cursors.get(row.path) ?? null, folder);
    this.cursors.set(row.path, r.cursor);
    const sum = r.doc ? summarize(r.doc, row.mtime) : null;
    if (sum) this.sums.set(row.path, { sig: sigOf(row), sum });
    else this.sums.delete(row.path);
    return { doc: r.doc, why: r.why, sum };
  }

  /**
   * Rows for `listed`, in order. `selected` is skipped (the caller read it, and passes its row);
   * every other log is read only when its size/mtime moved, with a turn of the event loop between
   * logs so a cold start of twelve big ones does not freeze the extension host. Forgets the
   * cursors of logs that left the list, so memory is bounded by the window.
   */
  async rows(listed: SessionRow[], folder: string, selected: SessionSummary | null): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const row of listed) {
      if (selected && row.id === selected.id) { out.push(selected); continue; }
      const hit = this.sums.get(row.path);
      if (hit && hit.sig === sigOf(row)) { out.push(hit.sum); continue; }
      await yieldTurn();
      const { sum } = await this.read(row, folder);
      if (sum) out.push(sum);
    }
    const keep = new Set(listed.map((r) => r.path));
    for (const p of [...this.cursors.keys()]) if (!keep.has(p)) { this.cursors.delete(p); this.sums.delete(p); }
    return out;
  }
}
