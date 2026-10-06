/**
 * What a tap on the feed does. Every verb goes through `core()` — the one
 * download path, the one viewer, `attach` — never a copy of any of them.
 */
import type { NotificationItem, NotificationKind, NotifyPrefs } from "@waterplane/shared";
import { core, type CoreApi } from "../../sdk";
import { viewerHandles } from "../../docKind";
import { LS, lsSet } from "../../storage";
import { backlogRepoFor, newestTs, pushNotif } from "./logic";
import { mutes, notifs, seenTs } from "./store";

/** A live `notification`: into the feed, and said once as a toast. */
export function onNotification(item: NotificationItem, c: CoreApi): void {
  notifs.set((prev) => pushNotif(prev, item));
  c.say.toast(item.title, item);
}

export function onNotificationList(items: NotificationItem[]): void {
  notifs.set(items);
}

/** `notify.prefs`: the host's merged set of muted kinds. */
export function onNotifyPrefs(prefs: NotifyPrefs): void {
  mutes.set(prefs);
}

/**
 * Switch one kind on or off. Optimistic — the host echoes the merged set back
 * as `notify.prefs` — and a plain `send`, as it always was: the toast says what
 * was asked for, and the mute is enforced on the desktop.
 */
export function setNotifyKind(kind: NotificationKind, on: boolean, name: string): void {
  const c = core();
  mutes.set((prev) => ({ ...prev, [kind]: on }));
  c.conn.send({ t: "notify.prefs.set", prefs: { [kind]: on } });
  c.say.toast(`${name}: ${on ? "on" : "muted"}`);
}

/** The feed is on screen: everything in it — including anything that arrives
 *  while it is open — is seen. */
export function markAllSeen(): void {
  const items = notifs.get();
  if (!items.length) return;
  const newest = newestTs(items);
  if (newest > seenTs.get()) {
    seenTs.set(newest);
    lsSet(LS.notifSeen, String(newest));
  }
}

export function openNotifs(): void {
  core().nav.open("notifications");
}

/** Act on a tapped notification: read its file, download it, open its image,
 *  or focus its session. */
export function openNotif(n: NotificationItem): void {
  const c = core();
  // A report an agent dropped in the outbox is something to READ. It used to
  // be a download and nothing else, which on a phone means a transfer, a
  // notification shade, and whatever app Android picks to render markdown —
  // three steps to look at six kilobytes of text the app can already paint.
  // Anything the viewer can't paint (an APK, a zip) is the download it was.
  if (n.file && viewerHandles(n.file.relPath)) { c.files.openArtifact(n.file); return; }
  if (n.file) { c.files.downloadArtifact(n.file); return; } // keep the feed open — more files may follow
  c.nav.close("notifications");
  if (n.image) { c.files.viewImage(n.image, n.sessionId); return; }
  if (n.sessionId) {
    const s = c.world.sessions.find((x) => x.id === n.sessionId);
    // A tap that closes the feed and lands nowhere reads as a dead row. The
    // session can be gone by now (closed, or an alert kept across a restart),
    // so say so — Recently closed / Archive is where it went.
    if (s) c.nav.attach(s);
    else c.say.toast("that session is closed — reopen it from Recently closed or Archive");
    return;
  }
  /**
   * **"undo is on the row" has to land on a row.**
   *
   * The *Backlog groomed* alert is the one the smart pick's whole safety case
   * rests on: it wakes somebody to say a machine rewrote two of their items,
   * and the undo is on the row it names. It carried no `sessionId`, no `file`
   * and no `image`, so tapping it did LITERALLY NOTHING — the feed closed and
   * the reader was left to find the repo, the menu, the backlog and the row
   * by hand, at whatever hour the pass ran.
   *
   * The repo is not on the alert either (see `docs/notes/web.md` for the host
   * field that would put it and the row ids there). What IS on it is the
   * repo's basename, in the title the host writes. So this resolves it the
   * way `fileRefs.ts` resolves a bare filename — **only when exactly one repo
   * answers to that name** (`backlogRepoFor`) — and opens the repo's backlog.
   * Two repos called `myapp` and it opens the sheet unscoped rather than
   * picking one, because a tap that lands on the wrong repo's list is worse
   * than one that lands on the last one you looked at.
   */
  if (n.kind === "backlog") {
    const dir = backlogRepoFor(n.title, c.world.visibleRepos);
    if (dir) c.nav.openBacklogCut(dir);
    else c.nav.open("backlog");
  }
}
