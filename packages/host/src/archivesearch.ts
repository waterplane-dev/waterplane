/**
 * Session search over ARCHIVED conversations — the prompts alone.
 *
 * The archive is every log the CLI ever wrote (`archive.ts`): tens of thousands
 * of files and many gigabytes on a busy desktop, so a full-text scan per
 * keystroke batch is out of the question. What a person searches the archive
 * FOR is almost always "where did I ask that", and the CLI already keeps exactly
 * that, small: `<config dir>/history.jsonl`, one line per prompt typed into the
 * TUI — `{display, pastedContents, timestamp, project, sessionId}`. Every prompt
 * waterplane delivers is typed into the TUI, so it lands there too.
 *
 * So this reads that one file (cached on size + mtime), groups it by
 * conversation, and answers in the live search's own shape. What it does NOT
 * find, and the sheet says so: the CLI's replies, and a `-p` run (headless
 * prompts are never written there). A missing or unreadable file is ABSENT —
 * `null`, which the route reports as not searched — never an empty archive.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionSearchMatch, SessionSearchResult } from "@waterplane/shared";
import { archivedExists, archivedTitle } from "./archive.js";
import { claudeConfigDir } from "./claudeconfig.js";
import { shownTitleForCwd } from "./reponames.js";
import { scanText } from "./sessionSearch.js";

/** Archived conversations returned per search; the rest are COUNTED (`omitted`). */
export const ARCHIVED_CONVERSATIONS_CAP = 30;
/** Snippets carried per archived conversation; `total` keeps the real count. */
export const ARCHIVED_HITS_PER_CONVERSATION = 5;

/** One prompt line of the CLI's history, as the scan needs it. */
export interface HistoryPrompt { text: string; at: number; cwd: string; conv: string }

/**
 * Parse `history.jsonl` text. Pasted blocks are appended to the line they were
 * pasted into — the display shows only a `[Pasted text #1]` placeholder, and the
 * words a person pasted are words they sent. Lines without a conversation id or
 * a project are skipped (they cannot be opened), as is anything unparsable.
 */
export function parseHistory(raw: string): HistoryPrompt[] {
  const out: HistoryPrompt[] = [];
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let r: any;
    try { r = JSON.parse(ln); } catch { continue; }
    if (typeof r?.sessionId !== "string" || typeof r?.project !== "string" || typeof r?.display !== "string") continue;
    const pasted = r.pastedContents && typeof r.pastedContents === "object"
      ? Object.values(r.pastedContents as Record<string, any>)
        .filter((p) => p && p.type === "text" && typeof p.content === "string").map((p) => p.content as string)
      : [];
    out.push({ text: [r.display, ...pasted].join("\n"), at: Number(r.timestamp) || 0, cwd: r.project, conv: r.sessionId });
  }
  return out;
}

let cache: { key: string; rows: HistoryPrompt[] } | null = null;

/** The CLI's prompt history, or null when there is none to read. */
function loadHistory(path = join(claudeConfigDir(), "history.jsonl")): HistoryPrompt[] | null {
  try {
    const st = statSync(path);
    const key = `${st.size}:${st.mtimeMs}`;
    if (cache?.key !== key) cache = { key, rows: parseHistory(readFileSync(path, "utf8")) };
    return cache.rows;
  } catch {
    return null;
  }
}

/**
 * Scan prompts for `query`, grouped by conversation, newest conversation first.
 * `skip` = conversation ids already searched as live sessions. `exists` and
 * `title` are injected so the test needs no CLI directory; a conversation whose
 * log is gone is not archived any more and is left out (it could not be opened).
 */
export function searchPrompts(
  rows: readonly HistoryPrompt[],
  query: string,
  skip: ReadonlySet<string>,
  exists: (cwd: string, conv: string) => boolean = archivedExists,
  title: (cwd: string, conv: string) => string = archivedTitle,
): { results: SessionSearchResult[]; omitted: number } {
  const q = query.trim();
  if (!q) return { results: [], omitted: 0 };
  const byConv = new Map<string, { cwd: string; last: number; matches: SessionSearchMatch[]; total: number }>();
  // Newest first, so a conversation's kept snippets are its latest prompts.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (skip.has(r.conv)) continue;
    let g = byConv.get(r.conv);
    const kind = r.text.startsWith("/") ? "command" as const : "prompt" as const;
    const before = g?.total ?? 0;
    const matches = g?.matches ?? [];
    const total = scanText(r.text, q, matches, before, { kind, text: r.text.slice(0, 120), sentAt: r.at });
    if (total === before) continue;
    if (!g) { g = { cwd: r.cwd, last: 0, matches, total: 0 }; byConv.set(r.conv, g); }
    g.total = total;
    g.last = Math.max(g.last, r.at);
  }
  const hit = [...byConv.entries()].filter(([conv, g]) => exists(g.cwd, conv)).sort((a, b) => b[1].last - a[1].last);
  const results = hit.slice(0, ARCHIVED_CONVERSATIONS_CAP).map<SessionSearchResult>(([conv, g]) => ({
    id: conv,
    title: title(g.cwd, conv) || "(no prompt)",
    cwd: g.cwd,
    repoLabel: shownTitleForCwd(g.cwd, basename(g.cwd)),
    running: false,
    archived: true,
    matches: g.matches.slice(0, ARCHIVED_HITS_PER_CONVERSATION),
    total: g.total,
  }));
  return { results, omitted: Math.max(0, hit.length - results.length) };
}

/** The route's call: null when the CLI keeps no prompt history to search. */
export function searchArchivedPrompts(query: string, skip: ReadonlySet<string>): { results: SessionSearchResult[]; omitted: number } | null {
  const rows = loadHistory();
  return rows ? searchPrompts(rows, query, skip) : null;
}
