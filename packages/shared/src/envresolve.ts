/**
 * Which environment variable a knob is read from, across renames. Pure — the
 * environment is a parameter, so a test hands it a plain object and the host
 * hands it `process.env` (`host/src/env.ts`).
 *
 * The current name wins; then each legacy name, newest first. A legacy hit is
 * REPORTED (once per name, by the reader) rather than refused: an old `.env`
 * keeps working across a rename, and the person is told what to change.
 */
import { BRAND, LEGACY } from "./brand.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvHit {
  /** The value, or undefined when no name for the knob is set. */
  value: string | undefined;
  /** The name it was read from — the current name when nothing is set. */
  name: string;
  /** True when the value came from a legacy name. */
  legacy: boolean;
}

/** Resolve `key` (no prefix: `"PORT"`) against `env`. An empty string counts as
 *  set, exactly as `process.env.X` would read it. */
export function resolveEnv(env: EnvSource, key: string): EnvHit {
  const current = `${BRAND.envPrefix}${key}`;
  if (env[current] !== undefined) return { value: env[current], name: current, legacy: false };
  for (const l of LEGACY) {
    const name = `${l.envPrefix}${key}`;
    if (env[name] !== undefined) return { value: env[name], name, legacy: true };
  }
  return { value: undefined, name: current, legacy: false };
}

/** The sentence a legacy hit is reported with. `where` names the file that set
 *  it, when anybody knows. */
export function legacyEnvText(legacyName: string, key: string, where?: string): string {
  const from = where ? ` (set in ${where})` : "";
  return `[${BRAND.slug}] ${legacyName} is a legacy name — rename it to ${BRAND.envPrefix}${key}${from}. It still works.`;
}

/** Truthy spellings, matching what the knobs have always accepted. */
const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export interface EnvReader {
  env(key: string): string | undefined;
  envStr(key: string, dflt: string): string;
  envBool(key: string, dflt: boolean): boolean;
  envInt(key: string, dflt: number): number;
}

/**
 * A reader over `source` that calls `warn` ONCE per legacy name it reads from.
 * `where(name)` may say which file set a name, for the warning.
 *
 * `envBool`: an unset or empty knob, or one that is neither a true nor a false
 * spelling, is the default. `envInt`: an unset, empty or non-integer value is
 * the default — a typo in a knob degrades to the default, never to NaN.
 */
export function makeEnvReader(
  source: EnvSource,
  warn: (text: string) => void,
  where?: (name: string) => string | undefined,
): EnvReader {
  const warned = new Set<string>();
  const env = (key: string): string | undefined => {
    const hit = resolveEnv(source, key);
    if (hit.legacy && !warned.has(hit.name)) {
      warned.add(hit.name);
      warn(legacyEnvText(hit.name, key, where?.(hit.name)));
    }
    return hit.value;
  };
  return {
    env,
    envStr: (key, dflt) => {
      const v = env(key);
      return v === undefined || v === "" ? dflt : v;
    },
    envBool: (key, dflt) => {
      const v = env(key)?.trim().toLowerCase();
      if (!v) return dflt;
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      return dflt;
    },
    envInt: (key, dflt) => {
      const v = env(key)?.trim();
      if (!v || !/^[-+]?\d+$/.test(v)) return dflt;
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : dflt;
    },
  };
}
