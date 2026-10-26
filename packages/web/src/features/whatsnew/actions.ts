/**
 * What's new's verbs. Every door OPENS a screen — nothing here changes a
 * setting, a feed or a clock (nothing applies itself).
 */
import { core } from "../../sdk";
import { LS, lsSet } from "../../storage";
import { openSettingsAt } from "../../settingsFocus";
import type { FeedSource } from "../../feedSlot";
import type { Door } from "./logic";
import { normVersion } from "./logic";
import { desktopVersion, seen } from "./store";

/** `updates.status`: keep the desktop's version (the whole status is the plugins feature's). */
export function onDesktopVersion(current: string | undefined): void {
  const v = current?.trim() || null;
  if (v !== desktopVersion.get()) desktopVersion.set(v);
}

/** Either verb on the launcher row, and opening the sheet itself: this version has been told. */
export function markSeen(version: string): void {
  const v = normVersion(version);
  if (!v || v === seen.get()) return;
  seen.set(v);
  lsSet(LS.whatsNewSeen, v);
}

export function openWhatsNew(): void {
  const v = desktopVersion.get();
  if (v) markSeen(v);
  core().nav.open("whatsnew");
}

/** Go through one row's door. A door that needs the feed and finds no feed opens the feed sheet plainly. */
export function openDoor(d: Door, feed: FeedSource | null): void {
  const c = core();
  switch (d.kind) {
    case "sheet": c.nav.open(d.id); return;
    case "setting": openSettingsAt(d.id); return;
    case "bell": if (feed) feed.openBell(); else c.nav.open("notifications"); return;
    case "feed": if (feed) feed.openFeed(); else c.nav.open("notifications"); return;
    case "feedCut": if (feed) feed.openCut(d.ids); else c.nav.open("notifications"); return;
    case "automationCut": c.nav.openScheduleCut(d.ids, d.label); return;
    case "git": c.nav.openGit(d.repoId); return;
    case "build": {
      const repo = c.world.repos.find((r) => r.id === d.repoId);
      if (repo) c.nav.openBuild(repo);
      else c.say.toast("That repo is not in the desktop's list right now");
      return;
    }
  }
}
