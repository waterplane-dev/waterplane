import { levelOf, needsYou, notifyLevel, type NotificationItem, type NotificationKind } from "@waterplane/shared";

/**
 * The notification feed's pure half — no React, no storage, no socket — so
 * `logic.test.mjs` runs it under `node --test` straight over the TypeScript.
 */

/** Rows kept in the feed on this phone; a live push past this drops the oldest. */
export const FEED_CAP = 100;

/** A live `notification` push: newest first, capped. A new array, never a
 *  mutation. The cap only ever drops information and handled rows: an
 *  unhandled attention item stays until it is handled, however busy the day. */
export function pushNotif<T extends Pick<NotificationItem, "kind" | "level" | "handled">>(prev: readonly T[], item: T, cap = FEED_CAP): T[] {
  const all = [item, ...prev];
  let room = cap - all.filter((n) => needsYou(n)).length;
  return all.filter((n) => {
    if (needsYou(n)) return true;
    if (room > 0) { room--; return true; }
    return false;
  });
}

/** Every desktop alert that still needs the person: the ONE cut behind the
 *  bell's number, the sheet a tap on it opens, and its "n of N". */
/**
 * The unhandled attention keys the repo listing turns into chips (`git:` and
 * `build:`, `RepoTarget.gitFailed`/`buildFailed`). The listing is an HTTP read,
 * so a change in this set is the phone's cue to re-read it — the chip and the
 * bell stay one predicate instead of the chip waiting for the next rescan.
 */
export function repoChipKeys(items: readonly NotificationItem[]): string {
  return items.filter((n) => needsYou(n) && /^(git|build):/.test(n.key ?? "")).map((n) => n.key).sort().join("\n");
}

export function needsYouItems<T extends Pick<NotificationItem, "kind" | "level" | "handled">>(items: readonly T[]): T[] {
  return items.filter((n) => needsYou(n));
}

/** The bell's number: items that need you. Information never counts. */
export function needsYouCount(items: readonly Pick<NotificationItem, "kind" | "level" | "handled">[]): number {
  return needsYouItems(items).length;
}

/** What the sheet lists. `only` (ids) is a cut a count opened; null = everything.
 *  `shown`/`total` feed "n of N" — the same predicate the number used. */
export function feedCut<T extends Pick<NotificationItem, "id">>(items: readonly T[], only: readonly string[] | null): { shown: T[]; total: number; filtered: boolean } {
  if (!only) return { shown: [...items], total: items.length, filtered: false };
  const set = new Set(only);
  return { shown: items.filter((n) => set.has(n.id)), total: items.length, filtered: true };
}

export function feedCutWords(shown: number, total: number): string {
  return `${shown} of ${total} shown`;
}

/** The two sections of a (cut) feed. Needs-you: unhandled first, then handled
 *  (a handled attention item stays, saying how). Information: the rest. */
export function feedSections<T extends Pick<NotificationItem, "kind" | "level" | "handled" | "ts">>(items: readonly T[]): { needs: T[]; handled: T[]; info: T[] } {
  const needs: T[] = [], handled: T[] = [], info: T[] = [];
  for (const n of items) {
    if (levelOf(n) === "info") info.push(n);
    else if (n.handled) handled.push(n);
    else needs.push(n);
  }
  return { needs, handled, info };
}

/** Items that turned handled-by-cause between two `notification.list`s AND
 *  whose red chip (`git:` / `build:` key) vanishes with it: each is toasted
 *  once. Other resolves are silent (the row already says the note), and a
 *  repeat failure replacing the old one is never told. Only items the phone
 *  already held as unhandled count, so a first list never toasts history. */
export function newlyResolved<T extends Pick<NotificationItem, "id" | "handled" | "key">>(prev: readonly T[], next: readonly T[]): T[] {
  const was = new Map(prev.map((n) => [n.id, n]));
  return next.filter((n) => {
    const o = was.get(n.id);
    return !!o && !o.handled && n.handled?.by === "resolved" && !!n.handled.note && n.handled.note !== "replaced by a newer one" && /^(git|build):/.test(n.key ?? "");
  });
}

/** The toast for one resolved chip: what it refers to, then why it went. */
export function resolvedWords(n: Pick<NotificationItem, "title" | "handled">): string {
  return `${n.title} — ${n.handled?.note ?? "resolved"}`;
}

/** "done 14:02", or the host's note when the cause went away. */
export function handledWords(h: NonNullable<NotificationItem["handled"]>): string {
  if (h.note) return h.note;
  const d = new Date(h.at);
  return `done ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const INFO_NOTE_TEXT = "Information no longer counts on the bell; it is listed below. Settings › Notifications can push it again.";

/** Which level a kind lands in, in the settings row's words. */
export function levelWords(kind: NotificationKind): string {
  if (kind === "followup") return "needs you — a launch option's flag is information";
  return notifyLevel(kind) === "attention" ? "needs you" : "information — failures of a run are needs you";
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
  git: { name: "Git pull / push", note: "A pull or push the desktop ran ended. A failed one needs you and stays until the next run of that verb works or you tap done; a successful push is information; a successful pull says nothing." },
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
  | { to: "git"; repoId: string }
  | { to: "build"; repoId: string; buildId?: string }
  | { to: "weekburn" }
  | { to: "row" };

export function notifTarget(n: {
  kind: string; file?: unknown; image?: unknown; sessionId?: string; plugin?: string;
  backlog?: { cwd: string; ids: string[] }; open?: { to: string; repoId?: string; id?: string; buildId?: string };
}): NotifTarget {
  if (n.file) return { to: "file" };
  if (n.plugin && !n.sessionId && !n.image) return { to: "plugin", id: n.plugin };
  if (n.image) return { to: "image" };
  if (n.sessionId) return { to: "session", sessionId: n.sessionId };
  if (n.backlog?.cwd) return { to: "backlog", cwd: n.backlog.cwd, ids: n.backlog.ids ?? [] };
  const o = n.open;
  if (o?.to === "repohealth" && o.repoId) return { to: "repohealth", repoId: o.repoId };
  if (o?.to === "tokens") return { to: "tokens" };
  if (o?.to === "git" && o.repoId) return { to: "git", repoId: o.repoId };
  if (o?.to === "build" && o.repoId) return { to: "build", repoId: o.repoId, buildId: o.buildId };
  if (n.kind === "weekburn") return { to: "weekburn" };
  if (o?.to === "plugin" && o.id) return { to: "plugin", id: o.id };
  if (n.kind === "backlog") return { to: "backlogByName" };
  return { to: "row" };
}
