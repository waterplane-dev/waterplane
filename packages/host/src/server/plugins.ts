/**
 * `createPlugins(ctx, ptyHeld)` — the plugin registry (docs/notes/plugins.md) wired to this host:
 * its sessions, the backlog add (`host`), the decision log, the meter, the notification feed, the
 * plan usage, `plugin.push`/`plugin.list` over the one socket, the hook port, the stream sink,
 * the usage-source registry, the `autoOn` probes (`plugins/pluginauto.ts`) and `api.repoApps()`.
 *
 * Construction only: `main.ts` assigns `ctx.plugins` right after this returns, and keeps the boot
 * ORDER (`loadBuiltins` → `loadAll`, never in a doctor run; `startAuto` after listen). Every `ctx`
 * member a dep needs is read at CALL time, inside a closure; `sessions`, `ROOT` and `PORT` are
 * values the registry holds, all assigned before `main.ts` gets here.
 *
 * `hostAppReadiness(ctx)` is the ONE wiring of `appready.ts`'s report to this host's builds and
 * auto-download rules — `api.repoApps()` asks it (the android-apps extension's `readiness`).
 */
import type { WebSocket } from "ws";
import type { AppReadinessReport } from "@waterplane/shared";
import { PluginRegistry } from "../plugins/pluginregistry.js";
import { hostAutoProbes } from "../plugins/pluginauto.js";
import { appReadinessReport } from "../appready.js";
import { hostSecretDir } from "../secrets.js";
import type { ServerCtx } from "./ctx.js";

/** This host's Android app readiness: every primary checkout, its builds and auto-download rule. */
export function hostAppReadiness(ctx: ServerCtx): Promise<AppReadinessReport> {
  return appReadinessReport(ctx.ROOT, (d) => ctx.builds.list(d), (d) => ctx.autopull.config(d));
}

/**
 * `api.notifyDone`: every waiting attention item THIS plugin filed (`item.plugin`) under exactly that
 * (namespaced) tag is resolved — never another plugin's, never a core item (no `plugin`). A change is
 * broadcast like any handled item, so every phone stops counting it now, not at its next reconnect.
 */
export function settlePluginNotice(deps: Pick<ServerCtx, "attention" | "broadcast" | "notificationFeed">, plugin: string, tag: string): number {
  return settlePluginNotices(deps, plugin, (t) => t === tag);
}

/**
 * `api.notifyDoneExcept`: every waiting attention item THIS plugin filed whose (namespaced) tag is not in
 * `keep` is resolved — a plugin's start clearing what a previous run left behind. Same scoping as above.
 */
export function settlePluginNoticesExcept(deps: Pick<ServerCtx, "attention" | "broadcast" | "notificationFeed">, plugin: string, keep: readonly string[]): number {
  const kept = new Set(keep);
  return settlePluginNotices(deps, plugin, (t) => t === undefined || !kept.has(t));
}

/** The one settle: `plugin`'s own waiting items whose tag `which` picks, then one broadcast if any changed. */
export function settlePluginNotices(deps: Pick<ServerCtx, "attention" | "broadcast" | "notificationFeed">, plugin: string, which: (tag: string | undefined) => boolean): number {
  const mine = (r: { item: { plugin?: string; tag?: string } }): boolean => r.item.plugin === plugin && which(r.item.tag);
  const n = deps.attention.resolveWhere(mine, "no longer waiting");
  if (n) deps.broadcast({ t: "notification.list", items: deps.notificationFeed() });
  return n;
}

export function createPlugins(ctx: ServerCtx, ptyHeld: (ws: WebSocket) => boolean): PluginRegistry {
  const plugins: PluginRegistry = new PluginRegistry({
    root: ctx.ROOT, configDir: hostSecretDir(), sessions: ctx.sessions,
    host: ctx, // `host`: handToAgent's backlog add
    probes: hostAutoProbes(ctx.ROOT), // `autoOn`: what each named probe walks is the host's
    repoApps: async () => (await hostAppReadiness(ctx)).apps, // `api.repoApps()`
    decision: (row) => ctx.decisionLog.add(row),
    meter: (e) => ctx.meter.record(e),
    notify: (kind, p) => ctx.notify(kind, p),
    notifyDone: (plugin, tag) => { settlePluginNotice(ctx, plugin, tag); }, // `api.notifyDone`
    notifyDoneExcept: (plugin, keep) => { settlePluginNoticesExcept(ctx, plugin, keep); }, // `api.notifyDoneExcept`
    usage: () => ctx.usage.get(),
    push: (plugin, event, data) => ctx.broadcast({ t: "plugin.push", plugin, event, data }),
    changed: () => ctx.broadcast({ t: "plugin.list", plugins: plugins.views() }),
    hookPort: ctx.PORT,
    // `api.stream`, `api.usageProbe`
    streamSink: () => ({ sendJson: (ws, msg) => ctx.send(ws as WebSocket, msg), ptyHeld: (ws) => ptyHeld(ws as WebSocket) }),
    usageProbe: (_plugin, def) => ctx.usageSources.register(def),
  });
  return plugins;
}
