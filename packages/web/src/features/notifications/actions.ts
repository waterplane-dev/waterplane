/**
 * What a tap on the feed does. Every verb goes through `core()` — the one
 * download path, the one viewer, `attach` — never a copy of any of them.
 */
import type { NotificationItem, NotificationKind, NotifyPrefs } from "@waterplane/shared";
import { core, type CoreApi } from "../../sdk";
import { viewerHandles } from "../../docKind";
import { LS, lsSet } from "../../storage";
import { backlogRepoFor, newestTs, notifTarget, pushNotif } from "./logic";
import { mutes, notifFocus, notifs, seenTs } from "./store";

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

/**
 * Act on a tapped notification — its row in the feed, or the OS shade's
 * (`openNotifFromOutside`: the service worker, the Android shell).
 * **Every tap lands on a page that says more about what was tapped**: its
 * file, image, session, backlog rows, repo health chart, token stats or plugin
 * screen (`notifTarget`), and when there is none — or it is gone — the alert's
 * own row in the feed, flashed, with its whole text. A tap from the shade that
 * dropped the reader on the bare launcher was the bug this replaced.
 */
export function openNotif(n: NotificationItem): void {
  const c = core();
  const t = notifTarget(n);
  // A report an agent dropped in the outbox is something to READ. It used to
  // be a download and nothing else, which on a phone means a transfer, a
  // notification shade, and whatever app Android picks to render markdown —
  // three steps to look at six kilobytes of text the app can already paint.
  // Anything the viewer can't paint (an APK, a zip) is the download it was.
  if (t.to === "file" && n.file) {
    if (viewerHandles(n.file.relPath)) c.files.openArtifact(n.file);
    else c.files.downloadArtifact(n.file); // keep the feed open — more files may follow
    return;
  }
  if (t.to === "row") { showRow(n); return; }
  c.nav.close("notifications");
  switch (t.to) {
    case "plugin":
      // A plugin's alert (a vault ask), or an alert naming a plugin's screen: that screen, else the row.
      if (!c.nav.openPlugin(t.id)) showRow(n, "that screen is not available on this phone");
      return;
    case "image":
      c.files.viewImage(n.image!, n.sessionId);
      return;
    case "session": {
      const s = c.world.sessions.find((x) => x.id === t.sessionId);
      // The session can be gone by now (closed, or an alert kept across a
      // restart): the row, saying where it went — never a dead tap.
      if (s) c.nav.attach(s);
      else showRow(n, "that session is closed — reopen it from Recently closed or Archive");
      return;
    }
    case "backlog":
      c.nav.openBacklogCut(t.cwd, t.ids, t.ids.length ? n.title : undefined);
      return;
    case "backlogByName": {
      // An older alert with no `backlog` field: the repo by its basename in the
      // title, only when exactly ONE repo answers to it (`backlogRepoFor`) —
      // the wrong repo's list is worse than the unscoped one.
      const dir = backlogRepoFor(n.title, c.world.visibleRepos);
      if (dir) c.nav.openBacklogCut(dir);
      else c.nav.open("backlog");
      return;
    }
    case "repohealth": {
      const repo = c.world.repos.find((r) => r.id === t.repoId);
      if (repo) c.nav.openRepoHealth(repo);
      else showRow(n, "that repo is not in the list on this desktop any more");
      return;
    }
    case "tokens":
      c.nav.open("tokens");
      return;
    case "weekburn":
      c.nav.open("weekburn");
      return;
  }
}

/**
 * The floor every tap can reach: the feed, scrolled to this alert and flashed.
 * An alert the feed no longer holds (cleared, or the host restarted — its feed
 * is in memory) is put back on this phone so the tap still has a row to show.
 * `why` says which target went missing, when one did.
 */
function showRow(n: NotificationItem, why?: string): void {
  const c = core();
  if (!notifs.get().some((x) => x.id === n.id)) notifs.set((prev) => pushNotif(prev, n));
  notifFocus.set(n.id);
  c.nav.open("notifications");
  if (why) c.say.toast(why);
}

/** The sheet scrolled to and flashed the focused row: the tap was the ask, not a setting. */
export function clearNotifFocus(): void {
  notifFocus.set(null);
}

/**
 * A tap from OUTSIDE the page (the shade), which can arrive on a cold start
 * before the session and repo lists have landed. Waits — up to
 * `OUTSIDE_WAIT_MS` — for the list its target needs, so "not loaded yet" is
 * never read as "gone"; then opens it however things stand.
 */
export function openNotifFromOutside(n: NotificationItem): void {
  const t = notifTarget(n);
  const ready = () => {
    const w = core().world;
    if (t.to === "session") return w.sessions.some((s) => s.id === t.sessionId);
    if (t.to === "repohealth") return w.repos.some((r) => r.id === t.repoId);
    if (t.to === "backlogByName") return w.visibleRepos.length > 0;
    return true;
  };
  const started = Date.now();
  const tick = () => {
    if (ready() || Date.now() - started >= OUTSIDE_WAIT_MS) { openNotif(n); return; }
    setTimeout(tick, OUTSIDE_POLL_MS);
  };
  tick();
}
const OUTSIDE_WAIT_MS = 15_000;
const OUTSIDE_POLL_MS = 300;
