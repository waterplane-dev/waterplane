/**
 * The readings a plugin contributes to the machine and account readouts — `api.thermalReader`
 * (since 1.3) and `api.usageProbe` (since 1.7). Part of the plugin contract: re-exported from
 * `plugin.ts` and documented with it (`docs/plugins-api.md`).
 */
import type { FanRow } from "./wire/sysstat.js";
import type { UsageReading, UsageSourceId } from "./wire/telemetry.js";

/** How long the core waits for a contributed thermal reader before it counts as no reading. */
export const PLUGIN_THERMAL_TIMEOUT_MS = 8_000;

/**
 * What a contributed thermal reader answers (since 1.3). A READING carries what it read and
 * which tool read it (`source`, shown beside the figures — the numbers are that tool's); a
 * NOTE says why there is none and, optionally, shell commands that would fill it in (drawn as
 * copy blocks); null is "nothing to say".
 */
export type PluginThermalReading =
  | { cpuTempC?: number; gpuTempC?: number; fans: FanRow[]; source: string }
  | { note: string; fix?: string[] }
  | null;

/** A thermal reader (`api.thermalReader`). */
export interface PluginThermalReader {
  read(): Promise<PluginThermalReading>;
}

/** A usage probe (`api.usageProbe`, since 1.7): one account's quota as a `UsageReading`. */
export interface PluginUsageProbe {
  /** The reading's id: short, lowercase, `[a-z0-9:_-]` (`USAGE_SOURCE_RE`). Never `claude`. */
  source: UsageSourceId;
  /** As drawn on the chip: `"Copilot"`. */
  label: string;
  /** The backend id this account belongs to, when there is one (a session header shows its own). */
  backend?: string;
  /** Poll period while polling is on; default 15 min, never less than 60 s. */
  everyMs?: number;
  /** A reading, or null when there is nothing to say (the source is then absent). */
  probe(): Promise<UsageReading | null>;
}

/** How long a usage probe may take before it counts as a failure (its last reading is kept). */
export const PLUGIN_USAGE_PROBE_TIMEOUT_MS = 20_000;
