/**
 * The conditional default of an `optional` builtin whose manifest names `autoOn`
 * (docs/notes/android-apps-architecture.md §6). Three things live here, apart from the registry:
 *
 * - the DERIVED cache `<state dir>/auto-probe.json` `{ <probe>: { result, at } }` — never
 *   `plugins.json`, never a person's choice, deletable at no cost. Written only after a definite
 *   probe; `null` (unknown) writes nothing.
 * - the sentence `PluginView.auto` carries while no choice exists.
 * - nothing else: WHAT a probe walks is the host's (`main.ts` supplies it), so a manifest can only
 *   name one, never bring one.
 */
import { join } from "node:path";
import type { AutoOnProbe } from "@waterplane/shared";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import { androidReposProbe } from "../androidenv.js";
import { discoverTargets } from "../repos.js";

/** How often `resolveAuto` asks again after the first run (an `unref`'d timer). */
export const AUTO_PROBE_EVERY_MS = 15 * 60_000;

export type AutoProbes = Partial<Record<AutoOnProbe, () => Promise<boolean | null>>>;
/**
 * The probes this host supplies (`main.ts` hands them to the registry). `androidRepo`: is any PRIMARY
 * checkout under `root` an Android app — bounded walks, one repo at a time, `null` when a repo ran
 * out of budget. Asked by the 15-minute timer alone: repo discovery has no change event to hook.
 */
export function hostAutoProbes(root: string): AutoProbes {
  return {
    androidRepo: () => androidReposProbe(async () => (await discoverTargets(root)).filter((t) => t.isPrimary).map((t) => t.worktreePath)),
  };
}

type CacheDoc = Partial<Record<AutoOnProbe, { result: boolean; at: number }>>;

const isCacheDoc = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

export function autoProbePath(stateDir: string): string {
  return join(stateDir, "auto-probe.json");
}

/** The last definite answer of `probe`, or null when none was ever cached (or the entry is malformed). */
export function cachedProbe(stateDir: string, probe: AutoOnProbe): boolean | null {
  const doc = readJsonGuarded<CacheDoc>(autoProbePath(stateDir), {}, isCacheDoc);
  const r = doc[probe]?.result;
  return typeof r === "boolean" ? r : null;
}

/** Record a definite answer. Never throws — a cache that cannot be written is a slower next boot. */
export function writeProbeCache(stateDir: string, probe: AutoOnProbe, result: boolean, at = Date.now()): void {
  try {
    const path = autoProbePath(stateDir);
    const doc = readJsonGuarded<CacheDoc>(path, {}, isCacheDoc);
    doc[probe] = { result, at };
    writeJsonAtomic(path, doc, { space: 2 });
  } catch { /* derived: the next definite probe writes it again */ }
}

/**
 * The line under the switch. `seen` = the last definite probe answer (null = never one);
 * `unknown` = the latest probe could not tell (a repo too big to walk whole, or the listing failed).
 * A probe that can never tell must not read "until checked" for ever: it names the switch instead.
 */
export function autoWhy(probe: AutoOnProbe, on: boolean, seen: boolean | null, unknown = false): string {
  switch (probe) {
    case "androidRepo":
      if (on) return seen === false
        ? "on automatically until the next restart — no repo here is an Android app any more"
        : "on automatically — a repo on this desktop is an Android app";
      if (seen === false) return "off automatically — no repo here is an Android app; checked every 15 minutes";
      return unknown
        ? "off — a repo here is too big to look through whole, so this desktop cannot tell; turn it on if a repo here builds an Android app"
        : "off until this desktop's repos are checked for an Android app; checked every 15 minutes";
  }
}
