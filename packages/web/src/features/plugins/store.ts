/**
 * What the phone knows about installed plugins and the decision log. Each
 * store has ONE writer: `plugins` — the `plugin.list` handler; `results` — the
 * `plugin.actionResult` handler and `runPluginAction` (in flight); `errors` —
 * the `plugin.error` handler and `setPluginValue`/`enablePlugin` (clearing the
 * last refusal before a new try); `decisions` — the `decisions.log` handler;
 * `decisionScope` — `openDecisions` and the sheet's close.
 */
import type { DecisionLogEntry, PluginView, UpdatesRestart, UpdatesStatus, UpdatesTarget } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";

/** Every installed plugin as the host last listed it; null until it has said. */
export const plugins = createStore<PluginView[] | null>(null);

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
