/**
 * The demo's answers for this extension's host methods (`registerDemoPlugin("android-apps", …)` in
 * `index.ts`, `always: true`: the demo desktop lists this builtin as on, so the screen answers in
 * every demo, not only under `?demoPlugins`). Pure data, relative to the (frozen) demo clock. Every
 * name is the demo's own fiction (`todo-garden`, a "Pixel 8").
 *
 *  - `readiness`: the demo's repos report no Android module facts — the setup pane says so.
 *  - `log`: three installs of todo-garden on one phone (the history pane's rows).
 *  - `report`: a receipt that keeps nothing — the demo desktop stores no records.
 */
import type { PluginView } from "@waterplane/shared";
import type { InstallLogDoc, ReadinessReply, ReportReply } from "../shared/wire.mts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

export function demoLog(now: number): InstallLogDoc {
  const ago = (ms: number) => now - ms;
  const base = { deviceId: "dev-pixel", deviceName: "Pixel 8", deviceModel: "Pixel 8", pkg: "app.todogarden.debug", label: "todo-garden", file: "todo-garden-debug.apk", repo: "todo-garden" };
  return {
    entries: [
      { ...base, key: "dev-pixel:pu-apk3:1", reportedAt: ago(26 * HOUR) + 4_000, pullId: "pu-apk3", version: "0.4.1", code: 42, outcome: "installed", auto: true, at: ago(26 * HOUR) },
      { ...base, key: "dev-pixel:pu-apk2:1", reportedAt: ago(3 * DAY) + 4_000, pullId: "pu-apk2", version: "0.4.0", code: 41, outcome: "failed", error: "Not enough storage on the device", auto: false, at: ago(3 * DAY) },
      { ...base, key: "dev-pixel:pu-apk1:1", reportedAt: ago(3 * DAY - 10 * MIN) + 4_000, pullId: "pu-apk1", version: "0.4.0", code: 41, outcome: "installed", auto: false, at: ago(3 * DAY - 10 * MIN) },
    ],
    devices: [{ id: "dev-pixel", name: "Pixel 8", model: "Pixel 8", lastAt: ago(26 * HOUR), installs: 2, failures: 1 }],
    total: 3,
  };
}

/** The whole `PluginCallResult` per method, as `registerDemoPlugin` takes it. */
export const demoCalls: Record<string, (args: unknown) => unknown> = {
  readiness: () => ({ ok: true, result: { at: Date.now(), apps: [] } satisfies ReadinessReply }),
  log: () => ({ ok: true, result: demoLog(Date.now()) }),
  report: () => ({ ok: true, result: { n: 3, at: Date.now(), kept: false } satisfies ReportReply }),
};

/** The demo desktop's `plugin.list` row: on and active, as on a desktop whose repo builds an Android
 *  app (the demo's `todo-garden` does). The manifest words are `waterplane-plugin.json`'s. */
export const demoListed: PluginView = {
  manifest: {
    id: "android-apps", name: "Android apps", version: "0.1.0", apiVersion: "2.5", optional: true, autoOn: "androidRepo",
    description: "Your repos' Android apps on this phone: build, download and install each one, and the history of what installed itself where. On by itself when a repo here builds an Android app.",
  },
  source: "builtin", enabled: true, state: "active", values: {},
  auto: { state: "on", why: "a repo here builds an Android app" },
};
