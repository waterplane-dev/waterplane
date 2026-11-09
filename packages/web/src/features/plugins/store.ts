/**
 * What the phone knows about installed plugins and the decision log. Each
 * store has ONE writer: `plugins` and `pluginsOn` — the `plugin.list` handler; `results` — the
 * `plugin.actionResult` handler and `runPluginAction` (in flight); `errors` —
 * the `plugin.error` handler and `setPluginValue`/`enablePlugin` (clearing the
 * last refusal before a new try); `decisions` — the `decisions.log` handler;
 * `decisionScope` — `openDecisions` and the sheet's close.
 */
import type { DecisionLogEntry, PluginView, UpdatesRestart, UpdatesStatus, UpdatesTarget } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { cacheLiveList, readCachedList, type CachedPlugin } from "./logic";

/** Every SWITCHABLE plugin as the host last listed it (`fixed` rows left out, so every reader below is
 *  exactly what it was before the manager existed); null until it has said. */
export const plugins = createStore<PluginView[] | null>(null);

/** EVERY plugin the host lists, `fixed` builtins included — the plugin manager's rows. Same ONE writer. */
export const allPlugins = createStore<PluginView[] | null>(null);

/** What "is it on" reads (bound into the SDK's `isExtensionEnabled` by core): STARTS from this host's
 *  cached last list, so a cold start with no connection reads the desktop's last word; the live list
 *  replaces it (`cacheLiveList`). Null = this host never listed its plugins to this phone (off). */
export const pluginsOn = createStore<readonly CachedPlugin[] | null>(readCachedList());

/** False until this host's LIVE list has landed once this run (the value above may be the cache's).
 *  `watchExtensionEnabled` fires again when it turns true. Same ONE writer as `pluginsOn`. */
export const pluginsLive = createStore(false);

/** The `plugin.list` handler's cache half: the live list replaces `pluginsOn` (and the host's cached
 *  copy, only if it differs), THEN marks the list live so a watcher woken by it reads the live value. */
export function applyLiveList(list: readonly Pick<PluginView, "manifest" | "enabled" | "state">[]): void {
  pluginsOn.set(cacheLiveList(list, pluginsOn.get()));
  pluginsLive.set(true);
}

/** One action tap's answer, by `actionKey` — `pending` until the host replies. */
export type ActionResult = { reqId: string; pending: true } | { reqId: string; pending: false; ok: boolean; message: string };
export const results = createStore<Record<string, ActionResult>>({});

/** The last refused `plugin.set` / `plugin.enable`, by plugin id, in the host's words. */
export const errors = createStore<Record<string, string>>({});

/** The decision log, newest first. */
export const decisions = createStore<DecisionLogEntry[]>([]);

/** When set, the decision log is cut to this session; null = all sessions. */
export const decisionScope = createStore<string | null>(null);

/** The installed plugins (null = the host has not said yet). */
export function useAllPlugins(): PluginView[] | null {
  return useStore(allPlugins);
}

export function usePlugins(): PluginView[] | null {
  return useStore(plugins);
}

// ── updates ─ ONE writer each: `updatesStatus` — the `updates.status` handler; `applies` — `applyTarget` (pending) and the `updates.result` handler (settled).

/** The host's last `updates.status`; null until it has said (it sends one on hello). */
export const updatesStatus = createStore<UpdatesStatus | null>(null);

/** One apply, from tap to answer. `message` is the host's, verbatim. */
export type Apply =
  | { reqId: string; target: UpdatesTarget; pending: true; at: number }
  | { reqId: string; target: UpdatesTarget; pending: false; ok: boolean; message: string; restart: UpdatesRestart };

/** By `targetKey`, so a row shows its own answer and a new tap replaces the old one. */
export const applies = createStore<Record<string, Apply>>({});

/** A check in flight (the refresh button spins until the status arrives). */
export const checking = createStore<boolean>(false);

export function useUpdatesStatus(): UpdatesStatus | null {
  return useStore(updatesStatus);
}

/** A stable key for one target: the row it belongs to. */
export function targetKey(t: UpdatesTarget): string {
  switch (t.kind) {
    case "plugin-install": return `install:${t.repo ?? t.url ?? ""}`;
    case "plugin-update": return `update:${t.id}`;
    default: return t.kind;
  }
}
