/**
 * The notification feed's pure half — no React, no storage, no socket — so
 * `logic.test.mjs` runs it under `node --test` straight over the TypeScript.
 */

/** Rows kept in the feed on this phone; a live push past this drops the oldest. */
export const FEED_CAP = 100;

/** A live `notification` push: newest first, capped. A new array, never a mutation. */
export function pushNotif<T>(prev: readonly T[], item: T, cap = FEED_CAP): T[] {
  return [item, ...prev].slice(0, cap);
}

/** The newest `ts` in the feed — what "seen" is advanced to when the feed is on
 *  screen. 0 for an empty feed. */
export function newestTs(items: readonly { ts: number }[]): number {
  return items.reduce((m, n) => Math.max(m, n.ts), 0);
}

/** How many desktop alerts arrived after the seen marker. This phone's own
 *  toasts are never counted — a badge that counts "copied" is one nobody reads. */
export function unreadCount(items: readonly { ts: number }[], seenTs: number): number {
  return items.filter((n) => n.ts > seenTs).length;
}

/** The badge's words: the count, or `9+` past nine. */
export function badgeText(n: number): string {
  return n > 9 ? "9+" : String(n);
}

/**
 * Which repo a *Backlog* alert is about — **only when exactly one repo answers
 * to the name**, else null (open the backlog unscoped rather than guess).
 *
 * The alert carries no repo field; the host writes the worktree's basename as
 * the last `·`-separated part of the title (`cwd.split("/").pop()`), so that is
 * what is matched — never `repoName`, which routinely differs for a worktree.
 */
export function backlogRepoFor(title: string, repos: readonly { worktreePath: string }[]): string | null {
  const name = title.split("·").pop()?.trim() ?? "";
  if (!name) return null;
  const hit = repos.filter((r) => r.worktreePath.split("/").filter(Boolean).pop() === name);
  return hit.length === 1 ? hit[0].worktreePath : null;
}

/**
 * Label and one line of "what fires this" per notification kind. Read by the
 * feed and by App's settings switches. Ordered by use through
 * `NOTIFICATION_KINDS`, which puts the two kinds a person has to answer at the
 * top and the chatty ones at the bottom. The icons are `NOTIF_ICON`, beside the
 * sheet that draws them (a lucide import is not pure).
 */
export const NOTIF_LABEL: Record<string, { name: string; note: string }> = {
  prompt: { name: "Needs you", note: "A session is parked on a question and cannot continue without an answer." },
  limit: { name: "Usage limit", note: "A session hit the account limit, and whether auto-continue got it running again." },
  backlog: { name: "Backlog", note: "A queued backlog item started, finished, or failed." },
  artifact: { name: "Artifacts", note: "A build produced a file, or an auto-download queued one. Auto-download itself keeps working when this is off — the push is how the phone starts fetching with the app closed." },
  image: { name: "New images", note: "An agent wrote a picture into the repo." },
  plugin: { name: "Plugins", note: "Something an installed plugin wanted you to know — its own words, from the desktop." },
  autofire: { name: "Auto-answered", note: "A question was answered for you, and with what." },
  idle: { name: "Turn finished", note: "Fires on EVERY turn of EVERY session — a handful of agents on a backlog is a notification a minute, which buries the two kinds above. Off unless you turn it on." },
  info: { name: "Other", note: "Sessions opening, builds, host notices." },
  undelivered: { name: "Prompt not delivered", note: "A session opened but the prompt never made it in. The only report of a message that is otherwise gone — the phone acked the op long before the typing failed." },
};
