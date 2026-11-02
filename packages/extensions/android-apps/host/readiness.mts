/**
 * `readiness`: the desktop's half of "will the next build of this app install itself" — one
 * `AppRepoFacts` per Android app module in every primary checkout, from core's `api.repoApps()`
 * (the facts stay core's, `appready.ts`; only the HTTP route is gone). Facts, never a verdict: the
 * phone words the checks. `at` is when this desktop read them.
 */
import type { HostPluginApi } from "@waterplane/shared";
import type { ReadinessReply } from "../shared/wire.mjs";

export async function readiness(api: Pick<HostPluginApi, "repoApps">, now: () => number = Date.now): Promise<ReadinessReply> {
  const apps = await api.repoApps();
  return { at: now(), apps };
}
