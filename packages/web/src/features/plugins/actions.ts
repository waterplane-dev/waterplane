/**
 * Everything a tap on a plugin control sends, and the writes the `plugin.*` /
 * `decisions.*` handlers make. Every tap goes through `liveSend`/`liveAsk`, so
 * with the link down it says so instead of queueing silently: a plugin setting
 * or a decision-log edit replayed an hour later is a decision about a
 * situation that has moved on.
 */
import type { HostMessage, PluginValue, PluginView } from "@waterplane/shared";
import { core } from "../../sdk";
import { seqId } from "../../format";
import { actionKey, changedValues } from "./logic";
import { decisionScope, errors, plugins, results } from "./store";

const OFFLINE = "no connection — plugins run on the desktop";

/** A request id for one action tap. `crypto.randomUUID` is not available over
 *  plain-http Tailscale, and this only has to be unique on this phone. */
function newReqId(): string {
  return seqId("pa");
}

function clearError(id: string): void {
  const cur = errors.get();
  if (!(id in cur)) return;
  const next = { ...cur };
  delete next[id];
  errors.set(next);
}

/** Change ONE setting. Nothing is sent when the value is what the host already has. */
export function setPluginValue(p: PluginView, key: string, value: PluginValue): void {
  const values = changedValues(p, key, value);
  if (!values) return;
  clearError(p.manifest.id);
  core().conn.liveSend({ t: "plugin.set", id: p.manifest.id, values }, `${p.manifest.name}: saved`, OFFLINE);
}

/** A typed value the phone refused before sending — shown where the host's own refusal would be. */
export function refuseValue(id: string, why: string): void {
  errors.set({ ...errors.get(), [id]: why });
}

export function enablePlugin(p: PluginView, enabled: boolean): void {
  clearError(p.manifest.id);
  core().conn.liveSend({ t: "plugin.enable", id: p.manifest.id, enabled }, `${p.manifest.name} ${enabled ? "on" : "off"}`, OFFLINE);
}

/** Tap a declared action. Its answer arrives as `plugin.actionResult` with this reqId. */
export function runPluginAction(pluginId: string, action: string, sessionId?: string): void {
  const reqId = newReqId();
  const frame = sessionId
    ? { t: "plugin.action" as const, id: pluginId, action, sessionId, reqId }
    : { t: "plugin.action" as const, id: pluginId, action, reqId };
  if (!core().conn.liveAsk(frame, OFFLINE)) return;
  results.set({ ...results.get(), [actionKey(pluginId, action, sessionId)]: { reqId, pending: true } });
}

/** One of a plugin's per-session switches; `null` = back to the manifest default. */
export function setSessionToggle(pluginId: string, sessionId: string, toggle: string, value: boolean | null, label: string): void {
  core().conn.liveSend({ t: "plugin.sessionToggle", id: pluginId, sessionId, toggle, value },
    `${label}: ${value === null ? "back to default" : value ? "on" : "off"}`, OFFLINE);
}

/** The core-owned "let <plugin> answer" switch for one session. */
export function setSessionAnswer(pluginId: string, name: string, sessionId: string, value: boolean): void {
  core().conn.liveSend({ t: "plugin.sessionAnswer", id: pluginId, sessionId, value },
    value ? `${name} may answer here` : `${name} only suggests here`, OFFLINE);
}

// ── handlers ──────────────────────────────────────────────────────────────────

export function onActionResult(msg: Extract<HostMessage, { t: "plugin.actionResult" }>): void {
  const cur = results.get();
  // Filed by reqId, not by button: a stale answer to an older tap of the same
  // button must not overwrite the newer one still pending.
  const key = Object.keys(cur).find((k) => cur[k].reqId === msg.reqId);
  if (!key) return;
  results.set({ ...cur, [key]: { reqId: msg.reqId, pending: false, ok: msg.ok, message: msg.message } });
  core().say.toast(`${nameOf(msg.id)}: ${msg.message}`);
}

export function onPluginError(msg: Extract<HostMessage, { t: "plugin.error" }>): void {
  errors.set({ ...errors.get(), [msg.id]: msg.error });
}

function nameOf(id: string): string {
  return plugins.get()?.find((p) => p.manifest.id === id)?.manifest.name || id;
}

// ── the decision log ─────────────────────────────────────────────────────────

/** Open the decision log, cut to one session or all of them (null), asking the
 *  host for a fresh copy. The caller dismisses its own menu. */
export function openDecisions(sessionId: string | null): void {
  const c = core();
  decisionScope.set(sessionId);
  c.conn.liveAsk(sessionId ? { t: "decisions.get", sessionId } : { t: "decisions.get" });
  c.say.track("overlay:decisions");
  c.nav.open("decisions");
}
