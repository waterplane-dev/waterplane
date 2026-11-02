/**
 * The rows registered demo fixtures ask the demo desktop to LIST in its `plugin.list` when a scenario
 * names none (`DemoPlugin.listed`, written by `registerDemoPlugin`). Its own DOM-free module because
 * the demo host's handler table (`demo/host/handlers.ts`) reads it and is type-checked without the DOM
 * (`demohost.test.mjs`); `demoPlugin.ts` imports `demo/mode.ts`, which needs it.
 */
import type { PluginView } from "@waterplane/shared";

const listed = new Map<string, PluginView>();

/** Set (or with `undefined` drop) a plugin's listed row. */
export function setDemoListed(id: string, view: PluginView | undefined): void {
  if (view) listed.set(id, view); else listed.delete(id);
}

/** The listed rows, in registration order. */
export function demoPluginViews(): PluginView[] {
  return [...listed.values()];
}
