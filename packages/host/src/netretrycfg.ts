/**
 * The person's switch for the network-error retry (`sessions/apiretry.ts`,
 * R-connection-025), persisted to `<state dir>/netretry.json` the way the
 * halt latch is (`halt.ts`): module state, read once, written atomically.
 *
 * - Absent file ⇒ ON (the default; a host that was never switched has no file).
 *   A present-but-unreadable file is moved aside by `readJsonGuarded` and reads
 *   as the default too: the retry is the safe side of an outage.
 * - `WATERPLANE_NET_RETRY=0` (`NET_RETRY_ENV_ON` below, read once at import) is a HARD
 *   override: off whatever the switch says, and `netRetryConfig().envOff` says
 *   so for the phone's sentence (shared `netRetryEnvOffText`).
 * - Turning it off cancels every pending retry — that is the caller's (the
 *   route), through the slice's own cancel path (`SessionManager.netRetryCancel`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logTag, type NetRetryConfig } from "@waterplane/shared";
import { ROOT, env } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** The env half: `WATERPLANE_NET_RETRY=0` forces the retry off whatever the switch says. */
const NET_RETRY_ENV_ON = env("NET_RETRY") !== "0";

let saved: boolean | null = null;
const path = (): string => join(hostStateDir(ROOT), "netretry.json");

function load(): boolean {
  if (saved != null) return saved;
  const p = path();
  if (!existsSync(p)) return (saved = true);
  const v = readJsonGuarded<{ enabled?: unknown }>(p, { enabled: true }, (x) => typeof x === "object" && x !== null);
  return (saved = v.enabled !== false);
}

/** The gate `apiretry.ts` asks before arming a retry. */
export function netRetryOn(): boolean { return NET_RETRY_ENV_ON && load(); }

/** What `netretry.config` carries. */
export function netRetryConfig(): NetRetryConfig {
  return NET_RETRY_ENV_ON ? { enabled: load() } : { enabled: load(), envOff: true };
}

/** Save the switch. A failed write keeps the in-memory value for this process. */
export function setNetRetry(enabled: boolean): NetRetryConfig {
  saved = enabled;
  try { writeJsonAtomic(path(), { enabled }); }
  catch (e) { console.error(`${logTag} net retry: could not persist the switch (${enabled ? "on" : "off"}) — it holds until this process ends`, e); }
  return netRetryConfig();
}
