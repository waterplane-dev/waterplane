/**
 * The copilot-usage extension's host half: Copilot's quota as a usage source (`api.usageProbe`),
 * drawn as its own segment of the phone's usage chip beside claude's.
 *
 * Registered only when this desktop actually uses Copilot — a `copilot` executable on `PATH`
 * (looked up once, at activation, without spawning anything) — so a desktop that never runs it
 * never spawns `gh`. The probe is one `gh api /copilot_internal/user` (`ghquota.mts`), an HTTPS
 * GET with the gh keyring's own token: no new credential, no PTY, no model call, which is why the
 * halt latch is not asked. Every miss — gh missing, not signed in, a non-2xx, a shape this does
 * not recognise — is null (the segment is absent), logged once per cause until it recovers.
 *
 * `WATERPLANE_GH_BIN` names the gh binary (default `gh` on PATH); the e2e stubs it.
 */
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { makeEnvReader, type HostPluginApi, type UsageReading } from "@waterplane/shared";
import { fetchCopilotQuota, parseCopilotQuota } from "./ghquota.mjs";

export { parseCopilotQuota, fetchCopilotQuota } from "./ghquota.mjs";

const { env } = makeEnvReader(process.env, (text) => console.warn(text));

/** How often the quota is asked while polling is on. A monthly quota moves slowly. */
export const COPILOT_EVERY_MS = 15 * 60_000;

/** Is `name` an executable somewhere on `pathVar`? A stat per directory; nothing is run. */
export function onPath(name: string, pathVar: string = process.env.PATH || ""): boolean {
  for (const dir of pathVar.split(":").filter(Boolean)) {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** The probe, over an injectable fetch (the test's seam). */
export function makeProbe(
  fetch: () => ReturnType<typeof fetchCopilotQuota>,
  log: (msg: string) => void,
  now: () => number = Date.now,
): () => Promise<UsageReading | null> {
  let lastMiss = "";
  return async () => {
    const got = await fetch();
    const miss = "miss" in got ? `${got.miss}: ${got.detail}` : null;
    const reading = "body" in got ? parseCopilotQuota(got.body, now()) : null;
    const why = miss ?? (reading ? "" : "the quota answer had no window this reads");
    if (why && why !== lastMiss) log(`Copilot quota not read — ${why}`);
    lastMiss = why;
    return reading;
  };
}

export function activate(api: HostPluginApi): void {
  if (!onPath("copilot")) {
    api.log("no copilot on PATH — Copilot's quota is not read");
    return;
  }
  const gh = (env("GH_BIN") || "").trim() || "gh";
  // A host with no usage registry (a test harness) refuses in words; that is no reading, not a failure.
  try {
    api.usageProbe({
      // Copilot's account, never claude's: with no backend the reading would be account-only,
      // and a claude session whose own reading is absent would print Copilot's in its place.
      source: "copilot", label: "Copilot", backend: "copilot", everyMs: COPILOT_EVERY_MS,
      probe: makeProbe(() => fetchCopilotQuota(gh), (m) => api.log(m)),
    });
  } catch (e) {
    api.log(`Copilot's quota is not read: ${e instanceof Error ? e.message : String(e)}`);
  }
}
