/**
 * Searching a session's text — the scan itself, with no session attached.
 *
 * This came out of `SessionManager`, which is 2,500 lines and 56 methods
 * covering PTY lifecycle, idle tracking, limit resumption, per-session flags and
 * this. The scan has no dependency on any of that: it is a substring walk with
 * context lines and two caps, and the caps are the part worth pinning — a flood
 * of matches must not bloat a socket frame on a link that is already the
 * bottleneck, and a hit has to carry enough around it to be READ in place,
 * because jumping into a terminal on a phone to see a match in context is the
 * thing the search sheet exists to avoid.
 *
 * `SessionManager.search()` still decides WHAT to scan — the rendered scrollback
 * for "recent", every recorded turn for "history", the recorded prompts alone
 * for "prompts". That part needs the sessions.
 */
import { basename } from "node:path";
import type { HistoryEntry, SessionSearchMatch, SessionSearchResult } from "@waterplane/shared";

/** Context lines each side of a hit, so a match reads in place. */
export const SEARCH_CONTEXT_LINES = 2;
/** Hits kept per session. `total` still reports the real count. */
export const SEARCH_HITS_PER_SESSION = 40;

/** What the scan needs to know about a session, and nothing more. */
export interface SearchTarget {
  id: string;
  title: string;
  cwd: string;
  running: boolean;
}

/**
 * Find `query` in `body`, appending to `matches` and counting into `total`.
 *
 * Returns the new total. Matches stop being COLLECTED at the cap but keep being
 * COUNTED, so the sheet can say "40 of 300" rather than quietly implying the
 * search found forty things.
 */
export function scanText(
  body: string,
  query: string,
  matches: SessionSearchMatch[],
  total: number,
  turn?: SessionSearchMatch["turn"],
): number {
  if (!body) return total;
  const q = query.toLowerCase();
  const lines = body.split("\n");
  let n = total;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(q)) continue;
    n++;
    if (matches.length < SEARCH_HITS_PER_SESSION) {
      matches.push({
        before: lines.slice(Math.max(0, i - SEARCH_CONTEXT_LINES), i),
        hit: lines[i],
        after: lines.slice(i + 1, i + 1 + SEARCH_CONTEXT_LINES),
        turn,
      });
    }
  }
  return n;
}

/** Every turn of a session's recorded history, prompt and output alike. */
export function scanHistory(history: HistoryEntry[], query: string): { matches: SessionSearchMatch[]; total: number } {
  const matches: SessionSearchMatch[] = [];
  let total = 0;
  for (const e of history) {
    const turn = { kind: e.kind, text: e.text.slice(0, 120), sentAt: e.sentAt };
    total = scanText(e.text, query, matches, total, turn);
    total = scanText(e.output ?? "", query, matches, total, turn);
  }
  return { matches, total };
}

/**
 * The PROMPTS of a session's recorded history — what was sent INTO it, alone.
 *
 * Not `scanHistory` with a flag: the two answer different questions and the
 * difference is the whole point. A turn's output is hundreds of lines the CLI
 * wrote, so a word common to both ("test", a filename, a branch) buries the one
 * or two lines a person typed under the reply to them. Searching what you asked
 * for is the more common question of the two, which is why it is the sheet's
 * default.
 *
 * Every recorded kind counts — a slash command and a filed backlog item were
 * both sent into the session by a person — and each hit still carries its turn
 * label, so the snippet says which kind it was.
 */
export function scanPrompts(history: HistoryEntry[], query: string): { matches: SessionSearchMatch[]; total: number } {
  const matches: SessionSearchMatch[] = [];
  let total = 0;
  for (const e of history) {
    total = scanText(e.text, query, matches, total, { kind: e.kind, text: e.text.slice(0, 120), sentAt: e.sentAt });
  }
  return { matches, total };
}

/** Wrap a scan's output as the result the wire carries. Null when nothing hit —
 *  a session with no matches is absent from the list, not present and empty. */
export function searchResult(
  t: SearchTarget,
  matches: SessionSearchMatch[],
  total: number,
): SessionSearchResult | null {
  if (total <= 0) return null;
  return {
    id: t.id, title: t.title, cwd: t.cwd,
    repoLabel: basename(t.cwd), running: t.running, matches, total,
  };
}
