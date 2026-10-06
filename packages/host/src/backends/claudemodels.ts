/**
 * The claude backend's model catalogue — the ONE table (the phone used to carry
 * a second copy; it now reads `BackendInfo.models` off the wire) — plus the
 * optional per-user override `<config dir>/models.json`.
 *
 * **The built-in ids are read off the installed binary's strings, never
 * recalled.** Re-derive rather than edit by hand:
 *
 *     strings -a "$(readlink -f "$(which claude)")" \
 *       | grep -oE 'claude-(opus|sonnet|haiku|fable)-[0-9][0-9a-z-]*(\[1m\])?' \
 *       | sort -u | grep -vE '\-v1$|-[0-9]{8}'
 *
 * Newest first. Dated snapshots and `-fast` variants are out (aliases of what
 * is already here). A model id invented here is a launch that fails minutes
 * later in a binary's own words.
 *
 * ── models.json ─────────────────────────────────────────────────────────────
 *   { "add":  { "aliases": ["…"], "ids": ["…"] },   // appended, de-duplicated
 *     "hide": ["id-or-alias", …] }                   // removed from the built-ins
 * Either key may be absent. Entries are non-empty strings, nothing else. A file
 * that is not valid JSON, or whose shape is wrong, is IGNORED WHOLE (the
 * built-in list stands) with one log line — never a crash, never half applied.
 * `hide` also hides what `add` added, so one file can say "only these".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendModels } from "./types.js";
import { configDir } from "../branddirs.js";

export const CLAUDE_BUILTIN_ALIASES: readonly string[] = [
  "opus", "opus[1m]",
  "sonnet", "sonnet[1m]",
  "haiku",
  "fable",
  // Opus while planning, the resting model after — the CLI's own pairing.
  "opusplan", "opusplan[1m]",
];

export const CLAUDE_BUILTIN_IDS: readonly string[] = [
  "claude-opus-5-5",
  "claude-opus-5-5[1m]",
  "claude-opus-5",
  "claude-opus-5[1m]",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-sonnet-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

export interface ModelsOverride { add: { aliases: string[]; ids: string[] }; hide: string[] }

const isStrList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");

/** Parse + validate the file's text. Returns the override, or a sentence saying why not. */
export function parseModelsOverride(text: string): ModelsOverride | { error: string } {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { return { error: `not valid JSON (${(e as Error).message})` }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "top level must be an object" };
  const o = j as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "add" && k !== "hide") return { error: `unknown key "${k}" (allowed: add, hide)` };
  const out: ModelsOverride = { add: { aliases: [], ids: [] }, hide: [] };
  if (o.hide !== undefined) {
    if (!isStrList(o.hide)) return { error: `"hide" must be a list of non-empty strings` };
    out.hide = o.hide.map((s) => s.trim());
  }
  if (o.add !== undefined) {
    const a = o.add as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || Array.isArray(a)) return { error: `"add" must be an object` };
    for (const k of Object.keys(a)) if (k !== "aliases" && k !== "ids") return { error: `unknown key "add.${k}" (allowed: aliases, ids)` };
    for (const k of ["aliases", "ids"] as const) {
      if (a[k] === undefined) continue;
      if (!isStrList(a[k])) return { error: `"add.${k}" must be a list of non-empty strings` };
      out.add[k] = (a[k] as string[]).map((s) => s.trim());
    }
  }
  return out;
}

/** Merge: built-ins, then `add`, de-duplicated in order, minus `hide`. Pure. */
export function mergeModels(o: ModelsOverride | null): BackendModels {
  const hide = new Set(o?.hide ?? []);
  const pick = (base: readonly string[], add: string[]) =>
    [...new Set([...base, ...add])].filter((x) => !hide.has(x));
  return {
    aliases: pick(CLAUDE_BUILTIN_ALIASES, o?.add.aliases ?? []),
    ids: pick(CLAUDE_BUILTIN_IDS, o?.add.ids ?? []),
  };
}

/** The catalogue for `claude`: built-ins merged with `<config dir>/models.json`
 *  when present. Never throws; a bad file is one log line and the built-ins. */
export function claudeModels(file: string = join(configDir(), "models.json")): BackendModels {
  if (!existsSync(file)) return mergeModels(null);
  try {
    const r = parseModelsOverride(readFileSync(file, "utf8"));
    if ("error" in r) {
      console.warn(`[models] ${file} ignored: ${r.error}; using the built-in model list`);
      return mergeModels(null);
    }
    return mergeModels(r);
  } catch (e) {
    console.warn(`[models] ${file} unreadable: ${(e as Error).message}; using the built-in model list`);
    return mergeModels(null);
  }
}
