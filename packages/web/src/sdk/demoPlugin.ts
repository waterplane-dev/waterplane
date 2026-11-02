/**
 * The demo's seam for a plugin's host methods: an extension registers value-free `calls` and `pushes` for
 * ITS plugin id, and `pluginClient(id)` answers from them while `isDemo()`. Nothing plugin-specific lives
 * in `demo/`: the transport replays the pushes of whatever is registered. Outside the demo this registry is
 * never read.
 */
import type { PluginView } from "@waterplane/shared";
import { isDemo } from "../demo/mode.ts";
import { setDemoListed } from "./demoListed.ts";

export interface DemoPlugin {
  /** `method` → the answer a real host would give (a value, or a thrown/returned `{ ok:false }` is up to the fixture: return the whole `PluginCallResult`). */
  calls: Record<string, (args: unknown) => unknown>;
  /** The pushes to replay when the fake socket opens: `[pushName, payload]` pairs. */
  pushes: () => Array<[string, unknown]>;
  /** Answer `calls` in EVERY demo, not only under `?demoPlugins` — for an extension the demo's default
   *  plugin list (`demo/host`'s `plugins`) shows switched on, whose screen would otherwise print the
   *  fake host's refusal. Its pushes still replay only under `?demoPlugins`. */
  always?: boolean;
  /** The demo desktop's `plugin.list` row for this plugin when a scenario lists none (`demo/host`):
   *  a builtin a real desktop has on. Absent = not listed (the default, every other demo unchanged). */
  listed?: PluginView;
}

const registry = new Map<string, DemoPlugin>();

/** Register (or replace) a plugin's demo fixture. Cheap and pure: call it at module load. */
export function registerDemoPlugin(id: string, plugin: DemoPlugin): void {
  registry.set(id, plugin);
  setDemoListed(id, plugin.listed);
}

/** The pushes a registered plugin replays for the demo, or [] when none is registered. */
export function demoPluginPushes(id: string): Array<[string, unknown]> {
  return registry.get(id)?.pushes() ?? [];
}

/** `?demoPlugins` on the page URL: only then do registered demo plugins answer and push. Off by default, so every other demo, the docs films and the aria snapshots stay exactly as they were. */
export function demoPluginsOn(href: string = globalThis.location?.href ?? ""): boolean {
  // Read once: the app takes the demo's query off the address bar after boot, and the answer must outlive that.
  if (seen === null) { try { seen = new URL(href).searchParams.has("demoPlugins"); } catch { seen = false; } }
  return seen;
}
let seen: boolean | null = null;

/** Every registered plugin's pushes as `plugin.push` payloads: what the demo socket replays when it opens. */
export function demoPluginReplay(): Array<{ plugin: string; event: string; data: unknown }> {
  return [...registry].flatMap(([plugin, p]) => p.pushes().map(([event, data]) => ({ plugin, event, data })));
}

/**
 * The demo's answer to `pluginClient(id).call(method, args)`, or `undefined` when this is not the demo or
 * the plugin/method is not registered (the real path then runs — in the demo that is the fake host's refusal).
 */
export function demoPluginCall(id: string, method: string, args: unknown): unknown {
  if (!isDemo()) return undefined;
  const p = registry.get(id);
  if (!p?.always && !demoPluginsOn()) return undefined;
  const fn = p?.calls[method];
  return fn ? fn(args) : undefined;
}

export { isDemo };
