/**
 * What a tap on the feed does. Every verb goes through `core()` — the one
 * download path, the one viewer, `attach` — never a copy of any of them.
 */
import type { NotificationItem, NotificationKind, NotifyPrefs } from "@waterplane/shared";
import { core, type CoreApi } from "../../sdk";
import { viewerHandles } from "../../docKind";
import { LS, lsBool, lsSetBool } from "../../storage";
import { landOnExplain } from "../../gitLanding";
import { backlogRepoFor, needsYouItems, newlyResolved, notifTarget, pushNotif, repoChipKeys, resolvedWords } from "./logic";
import { heard, mutes, notifCut, notifFocus, notifs, pushInfo } from "./store";

/** A live `notification`: into the feed, and said once as a toast. */
export function onNotification(item: NotificationItem, c: CoreApi): void {
  const before = repoChipKeys(notifs.get());
  notifs.set((prev) => pushNotif(prev, item));
  c.say.toast(item.title, item);
  if (repoChipKeys(notifs.get()) !== before) c.world.refreshRepos();
}

export function onNotificationList(items: NotificationItem[]): void {
  // An attention item whose cause went away is told once, on the screen the
  // person is on: a red chip that vanishes without a word reads as a bug.
  const c = core();
  for (const n of newlyResolved(notifs.get(), items)) c.say.toast(resolvedWords(n));
  const chipsMoved = repoChipKeys(notifs.get()) !== repoChipKeys(items);
  notifs.set(items);
  if (!heard.get().list) heard.set({ ...heard.get(), list: true });
  if (chipsMoved) c.world.refreshRepos();
}

/** `done` on a needs-you row: the host stores it (idempotent, any device).
 *  Optimistic here — the host's next `notification.list` replaces it. */
export function handleNotif(id: string): void {
  const c = core();
  // Not sent (socket down): no optimistic write — the row would read "done"
  // while the desktop never heard. The host's next list marks it.
  if (!c.conn.liveSend({ t: "notification.handle", id }, "marked done")) return;
  const before = repoChipKeys(notifs.get());
  notifs.set((prev) => prev.map((n) => (n.id === id && !n.handled ? { ...n, handled: { at: Date.now(), by: "person" as const } } : n)));
  // The chip and the stored banner are an HTTP read: re-read when one went.
  if (repoChipKeys(notifs.get()) !== before) c.world.refreshRepos();
}

/** `notify.prefs`: the host's merged set of muted kinds. */
export function onNotifyPrefs(prefs: NotifyPrefs, info?: boolean): void {
  mutes.set(prefs);
  pushInfo.set(!!info);
  if (!heard.get().prefs) heard.set({ ...heard.get(), prefs: true });
}

/** "Push information too": off by default, host-persisted. */
export function setPushInfo(on: boolean): void {
  const c = core();
  pushInfo.set(on);
  c.conn.send({ t: "notify.prefs.set", prefs: {}, pushInfo: on });
  c.say.toast(on ? "Information is pushed too" : "Information is listed only, not pushed");
}

/** The one-time note at the top of the sheet (ux §1): shown until `got it`. */
export function infoNoteSeen(): boolean { return lsBool(LS.notifInfoNote, false); }
export function dismissInfoNote(): void { lsSetBool(LS.notifInfoNote, true); }

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

/** The whole feed (settings door, a tap that wants a row). */
export function openNotifs(): void {
  notifCut.set(null);
  core().nav.open("notifications");
}

/** The bell. With a number on it the tap is a filter: exactly those items. */
export function openBell(): void {
  const ids = needsYouItems(notifs.get()).map((n) => n.id);
  notifCut.set(ids.length ? ids : null);
  core().nav.open("notifications");
}

/** The sheet on exactly these ids (a repo's failures), "n of N", clearable. */
export function openNotifCut(ids: string[]): void {
  notifCut.set(ids.length ? ids : null);
  core().nav.open("notifications");
}

export function showAllNotifs(): void { notifCut.set(null); }

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
    case "git": {
      if (c.world.repos.some((r) => r.id === t.repoId)) { if (t.explain) landOnExplain(t.repoId); c.nav.openGit(t.repoId); }
      else showRow(n, "that repo is not in the list on this desktop any more");
      return;
    }
    case "setup": {
      if (c.world.repos.some((r) => r.id === t.repoId)) c.nav.openSetup(t.repoId, { region: "watch" });
      else showRow(n, "that repo is not in the list on this desktop any more");
      return;
    }
    case "build": {
      const repo = c.world.repos.find((r) => r.id === t.repoId);
      if (repo) c.nav.openBuild(repo);
      else showRow(n, "that repo is not in the list on this desktop any more");
      return;
    }
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
  notifCut.set(null); // the row asked for may be outside a cut
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
    if (t.to === "repohealth" || t.to === "git" || t.to === "build" || t.to === "setup") return w.repos.some((r) => r.id === t.repoId);
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
