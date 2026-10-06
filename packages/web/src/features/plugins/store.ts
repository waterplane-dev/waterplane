/**
 * What the phone knows about installed plugins and the decision log. Each
 * store has ONE writer: `plugins` — the `plugin.list` handler; `results` — the
 * `plugin.actionResult` handler and `runPluginAction` (in flight); `errors` —
 * the `plugin.error` handler and `setPluginValue`/`enablePlugin` (clearing the
 * last refusal before a new try); `decisions` — the `decisions.log` handler;
 * `decisionScope` — `openDecisions` and the sheet's close.
 */
import type { DecisionLogEntry, PluginView } from "@waterplane/shared";
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
