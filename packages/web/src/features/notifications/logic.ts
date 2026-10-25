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
  approval: { name: "Approvals", note: "A plugin asked for something you must approve now, such as a vault fingerprint. Loud on purpose." },
  limit: { name: "Usage limit", note: "A session hit the account limit, and whether auto-continue got it running again." },
  burn: { name: "Week burning fast", note: "The weekly limit climbed faster than the threshold over the last stretch of readings — one push naming what spent it. Nothing is paused." },
  weekburn: { name: "Week-end burn", note: "Once a week, if you are on pace to leave budget unused: pick repos to spend it on." },
  disk: { name: "Desktop disk almost full", note: "The desktop's disk dropped under 10 GB free (and again under 3 GB). On a Mac, low space makes macOS end apps to clear their caches — Tailscale among them, which cuts this phone off. Words only; nothing is deleted." },
  agent: { name: "Large subagent", note: "A running subagent passed the context size you set on the context sheet (default 500k) — one push per agent, naming it. It warns only; nothing is stopped." },
  backlog: { name: "Backlog", note: "A queued backlog item started, finished, or failed." },
  followup: { name: "Follow up", note: "A session was flagged for follow up without your tap — by a launch you ticked to flag when done, or by its own agent with one line on what to read. A flag you set by hand sends none." },
  health: { name: "Repo health index", note: "A repo's health index moved by more than is usual for that repo's own past — at most one push per repo per week, in words, naming the readings that carried it." },
  artifact: { name: "Artifacts", note: "A build produced a file, or an auto-download queued one. Auto-download itself keeps working when this is off — the push is how the phone starts fetching with the app closed." },
  image: { name: "New images", note: "An agent wrote a picture into the repo." },
  plugin: { name: "Plugins", note: "Something an installed plugin wanted you to know — its own words, from the desktop." },
  autofire: { name: "Auto-answered", note: "A question was answered for you, and with what." },
  idle: { name: "Turn finished", note: "Fires on EVERY turn of EVERY session — a handful of agents on a backlog is a notification a minute, which buries the two kinds above. Off unless you turn it on." },
  info: { name: "Other", note: "Sessions opening, builds, host notices." },
  undelivered: { name: "Prompt not delivered", note: "A session opened but the prompt never made it in. The only report of a message that is otherwise gone — the phone acked the op long before the typing failed." },
};

/**
 * Where a tapped alert lands, read off the item alone — the one ladder the
 * feed row, the service worker's tap and the Android shell's tap all take
 * (`openNotif`). `row` is the floor: an alert that names nothing else opens
 * the feed on its own row, whose full text is the "more" — a tap never lands
 * on the bare launcher. A `to` this bundle does not know is `row` too.
 */
export type NotifTarget =
  | { to: "file" }
  | { to: "plugin"; id: string }
  | { to: "image" }
  | { to: "session"; sessionId: string }
  | { to: "backlog"; cwd: string; ids: string[] }
  | { to: "backlogByName" }
  | { to: "repohealth"; repoId: string }
  | { to: "tokens" }
  | { to: "weekburn" }
  | { to: "row" };

export function notifTarget(n: {
  kind: string; file?: unknown; image?: unknown; sessionId?: string; plugin?: string;
  backlog?: { cwd: string; ids: string[] }; open?: { to: string; repoId?: string; id?: string };
}): NotifTarget {
  if (n.file) return { to: "file" };
  if (n.plugin && !n.sessionId && !n.image) return { to: "plugin", id: n.plugin };
  if (n.image) return { to: "image" };
  if (n.sessionId) return { to: "session", sessionId: n.sessionId };
  if (n.backlog?.cwd) return { to: "backlog", cwd: n.backlog.cwd, ids: n.backlog.ids ?? [] };
  const o = n.open;
  if (o?.to === "repohealth" && o.repoId) return { to: "repohealth", repoId: o.repoId };
  if (o?.to === "tokens") return { to: "tokens" };
  if (n.kind === "weekburn") return { to: "weekburn" };
  if (o?.to === "plugin" && o.id) return { to: "plugin", id: o.id };
  if (n.kind === "backlog") return { to: "backlogByName" };
  return { to: "row" };
}
