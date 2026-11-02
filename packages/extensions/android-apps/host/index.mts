/**
 * The android-apps extension's host half: the methods the phone's Apps sheet calls
 * (`shared/wire.mts`) over the install-log store and core's `repoApps()` facts. Contributed through
 * the same `HostPluginApi` an external plugin gets.
 *
 * Spends nothing; no poller. The transport is the generic plugin channel with its caps in mind
 * (architecture section 4): `report` arrives in idempotent chunks and answers `{ n, at, kept }` (`kept: false` while the store is read-only); the only
 * push is the `changed` ping `{ n, at }` after a chunk changed the log (phones then call `log` — a
 * pull); `log` is the one large reply and is trimmed oldest-first under 480 KB.
 */
import { join } from "node:path";
import { handleAll, type HostPluginApi } from "@waterplane/shared";
import { PUSH_CHANGED, type AndroidAppsMethods, type ChangedPush, type InstallReporter } from "../shared/wire.mjs";
import { InstallLogStore, type InstallLogOpts } from "./installlog.mjs";
import { readiness } from "./readiness.mjs";

export { InstallLogStore, WRITE } from "./installlog.mjs";

const deviceOf = (v: unknown): InstallReporter => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { id: typeof o.id === "string" ? o.id : "", name: typeof o.name === "string" ? o.name : undefined, model: typeof o.model === "string" ? o.model : undefined };
};

/** Wire a store to `api`'s methods. Exported so the tests drive the real handlers. */
export function serve(api: Pick<HostPluginApi, "handle" | "push" | "repoApps">, store: InstallLogStore, now: () => number = Date.now): () => void {
  return handleAll<AndroidAppsMethods>(api, {
    readiness: () => readiness(api, now),
    log: () => store.doc(),
    report: (a) => {
      const args = (a ?? {}) as { device?: unknown; entries?: unknown };
      const rows = Array.isArray(args.entries) ? args.entries : [];
      const changed = store.report(deviceOf(args.device), rows);
      const kept = store.writes;
      const n = store.count();
      if (changed.added || changed.updated) {
        const ping: ChangedPush = { n, at: now() };
        const refused = api.push(PUSH_CHANGED, ping);
        // `push` answers a refusal as a STRING, it does not throw: say it, or phones never hear.
        if (typeof refused === "string") console.warn(`android-apps: the changed ping was refused: ${refused}`);
      }
      return { n, at: now(), kept };
    },
  });
}

let off: (() => void) | null = null;
let store: InstallLogStore | null = null;

export async function activate(api: HostPluginApi, opts: InstallLogOpts = {}): Promise<void> {
  store = new InstallLogStore(join(api.stateDir, "installs.json"), opts);
  off = serve(api, store);
}

export function deactivate(): void {
  off?.();
  off = null;
  store?.flush();
  store = null;
}

/** The daemon is exiting: flush synchronously, whether or not the extension is still switched on. */
export function shutdown(): void {
  store?.flush();
}
