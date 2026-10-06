/**
 * Which notification KINDS this user wants to hear about.
 *
 * Every alert the daemon fires goes two places at once — the in-app feed and,
 * when subscribed, an OS push — and until now every one of them went to both,
 * unconditionally. That is fine for the kinds that need a human (a question
 * waiting, a usage limit) and wrong for `idle`, the "Turn finished" ping: it
 * fires once per turn per session, so a handful of agents working a backlog
 * produce a notification a minute and the feed becomes a wall of identical
 * rows with the two urgent kinds buried in it.
 *
 * The gate lives on the HOST rather than in the client's synced settings for
 * one reason: the push is sent from here, and muting a kind the phone hides
 * afterwards still buzzes the phone. `settings.ts` cannot hold it either — it
 * stores opaque strings the daemon never parses, by design.
 *
 * Persisted to <STATE_DIR>/notify.json, tmp+rename, same shape as the other
 * small stores here. Sparse on purpose (see `NotifyPrefs`): a kind added in a
 * later version arrives with its own default instead of being silently muted
 * by a file written before it existed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanNotifyPrefs, notifyEnabled, type NotificationKind, type NotifyPrefs } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

export class NotifyPrefsStore {
  private path: string;
  private prefs: NotifyPrefs = {};

  constructor(root: string) {
    const dir = hostStateDir(root);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "notify.json");
    try {
      if (existsSync(this.path)) this.prefs = cleanNotifyPrefs(readJsonGuarded<any>(this.path, null));
    } catch { /* corrupt or unreadable → defaults, never throw on boot */ }
  }

  get(): NotifyPrefs {
    return { ...this.prefs };
  }

  /** Whether a kind may be published at all (feed AND push). */
  enabled(kind: NotificationKind): boolean {
    return notifyEnabled(this.prefs, kind);
  }

  /** Merge a sparse patch in — a client sends only what it changed. */
  set(patch: NotifyPrefs): NotifyPrefs {
    this.prefs = { ...this.prefs, ...cleanNotifyPrefs(patch) };
    this.save();
    return this.get();
  }

  private save(): void {
    try {
      writeJsonAtomic(this.path, this.prefs, { space: 2 });
    } catch { /* a lost preference is not worth taking the daemon down for */ }
  }
}
