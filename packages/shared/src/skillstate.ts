/**
 * Skills and plugins switch — the pure logic both ends agree on: which level wins, what a write
 * to a settings file may touch, and what a change set saves. Degrades to refusal-in-words, never
 * to a rewrite of a file it could not read.
 */
import { CHARS_PER_TOKEN } from "./contextweight.js";
import {
  SKILL_STATES,
  type PluginRow, type SkillChange, type SkillRow, type SkillState, type SwitchLevel,
} from "./wire/skills.js";

type Rank = Record<SkillState, number>;
const RANK: Rank = { "on": 0, "name-only": 1, "user-invocable-only": 2, "off": 3 };
const isState = (v: unknown): v is SkillState => typeof v === "string" && (SKILL_STATES as readonly string[]).includes(v);

/** Settings files, nearest first: `.local` beats project beats user. */
export interface SkillLayers<T> { local?: T; project?: T; user?: T }
export interface SkillLocks<T> { policy?: T; flag?: T }
export type ResolvedFrom = SwitchLevel | "default" | "locked";

const own = (o: object | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);

export function resolveSkillState(
  id: string,
  layers: SkillLayers<Record<string, unknown>>,
  locks: SkillLocks<Record<string, unknown>> = {},
): { state: SkillState; from: ResolvedFrom } {
  let locked: SkillState | null = null;
  for (const l of [locks.policy, locks.flag]) {
    const v = own(l, id) ? l![id] : undefined;
    if (isState(v) && (locked === null || RANK[v] > RANK[locked])) locked = v;
  }
  if (locked) return { state: locked, from: "locked" };
  const order: [keyof SkillLayers<unknown>, SwitchLevel][] = [["local", "repo-local"], ["project", "repo-shared"], ["user", "global"]];
  for (const [k, level] of order) {
    const m = layers[k];
    const v = own(m, id) ? m![id] : undefined;
    if (isState(v)) return { state: v, from: level };
  }
  return { state: "on", from: "default" };
}

export function resolvePluginEnabled(
  id: string,
  layers: SkillLayers<Record<string, unknown>>,
  locks: SkillLocks<Record<string, unknown>> = {},
  cliDefault = true,
): { enabled: boolean; from: ResolvedFrom } {
  const bools = [locks.policy, locks.flag].map((l) => (own(l, id) ? l![id] : undefined)).filter((v): v is boolean => typeof v === "boolean");
  if (bools.length) return { enabled: !bools.includes(false), from: "locked" };
  const order: [keyof SkillLayers<unknown>, SwitchLevel][] = [["local", "repo-local"], ["project", "repo-shared"], ["user", "global"]];
  for (const [k, level] of order) {
    const m = layers[k];
    const v = own(m, id) ? m![id] : undefined;
    if (typeof v === "boolean") return { enabled: v, from: level };
  }
  return { enabled: cliDefault, from: "default" };
}

const KEY_RE = /^[A-Za-z0-9._:@-]{1,255}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PLUGIN_RE = /^[A-Za-z0-9._-]{1,127}@[A-Za-z0-9._-]{1,127}$/;

/** null = fine, else a sentence. */
export function validateChange(c: SkillChange): string | null {
  if (!c || (c.kind !== "skill" && c.kind !== "plugin") || typeof c.id !== "string") return "A change needs a kind and an id.";
  if (FORBIDDEN_KEYS.has(c.id) || !KEY_RE.test(c.id)) return `"${c.id.slice(0, 60)}" is not a name this screen can write.`;
  if (c.kind === "plugin") {
    if (!PLUGIN_RE.test(c.id)) return `"${c.id}" is not a plugin id (name@marketplace).`;
    if (c.to !== true && c.to !== false && c.to !== "inherit") return `A plugin is switched on, off or back to inherit, not "${String(c.to)}".`;
    return null;
  }
  if (c.to !== "inherit" && !isState(c.to)) return `"${String(c.to)}" is not one of the four skill states.`;
  return null;
}

export type SettingsWrite =
  | { ok: true; text: string; changed: { id: string; from: string; to: string }[] }
  | { ok: false; error: string };

function indentOf(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  if (!m) return 2;
  return m[0].includes("\t") ? "\t" : m[0].length;
}

const show = (v: unknown): string => (v === undefined ? "inherit" : String(v));

/**
 * Apply `changes` to a settings file's text. Touches only `skillOverrides` and `enabledPlugins`;
 * a new key appends, an existing key keeps its place, `inherit` deletes the key (and the object
 * only if this call emptied it). `text: null` = no file yet. Refuses an unparseable file.
 */
export function withSkillSettings(text: string | null, changes: SkillChange[]): SettingsWrite {
  for (const c of changes) {
    const bad = validateChange(c);
    if (bad) return { ok: false, error: bad };
  }
  let obj: Record<string, unknown> = {};
  let indent: string | number = 2;
  let trailingNl = true;
  if (text != null && text.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      return { ok: false, error: `not valid JSON, left as it is (${(e as Error).message})` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "not a JSON object, left as it is" };
    obj = parsed as Record<string, unknown>;
    indent = indentOf(text);
    trailingNl = text.endsWith("\n");
  }
  for (const k of ["skillOverrides", "enabledPlugins"]) {
    const v = obj[k];
    if (v !== undefined && (!v || typeof v !== "object" || Array.isArray(v))) return { ok: false, error: `"${k}" is not an object, left as it is` };
  }
  const changed: { id: string; from: string; to: string }[] = [];
  for (const c of changes) {
    const field = c.kind === "skill" ? "skillOverrides" : "enabledPlugins";
    const had = Object.prototype.hasOwnProperty.call(obj, field);
    const map = (had ? obj[field] : {}) as Record<string, unknown>;
    const before = own(map, c.id) ? map[c.id] : undefined;
    if (c.to === "inherit") {
      if (before === undefined) continue;
      delete map[c.id];
      if (had && Object.keys(map).length === 0) delete obj[field];
    } else {
      if (before === c.to) continue;
      map[c.id] = c.to;
      if (!had) obj[field] = map;
    }
    changed.push({ id: c.id, from: show(before), to: show(c.to === "inherit" ? undefined : c.to) });
  }
  if (changed.length === 0 && text != null) return { ok: true, text, changed };
  return { ok: true, text: JSON.stringify(obj, null, indent) + (trailingNl ? "\n" : ""), changed };
}

/** The listing line a skill costs in a given state: name-only keeps "- name", the others drop it or keep all of it. */
const NAME_LINE = 2;
export function lineCost(row: SkillRow, state: SkillState): number | null {
  if (row.listingChars === undefined) return null;
  if (state === "on") return row.listingChars;
  if (state === "name-only") return Math.min(row.listingChars, row.id.length + NAME_LINE);
  return 0;
}

export interface Savings { chars: number; tokens: number; unmeasured: number }

/**
 * Chars a change set would remove from the skill listing (negative = adds). Unmeasured rows and
 * `inherit` (whose result depends on the other levels) contribute nothing and are counted.
 */
export function savingsOf(rows: (SkillRow | PluginRow)[], changes: SkillChange[]): Savings {
  const byId = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  let chars = 0;
  let unmeasured = 0;
  for (const c of changes) {
    const r = byId.get(`${c.kind}:${c.id}`);
    if (!r || c.to === "inherit") { unmeasured++; continue; }
    if (r.kind === "skill" && c.kind === "skill") {
      if (!isState(c.to)) continue;
      const a = lineCost(r, r.effective);
      const b = lineCost(r, c.to);
      if (a === null || b === null) { unmeasured++; continue; }
      chars += a - b;
    } else if (r.kind === "plugin" && c.kind === "plugin" && typeof c.to === "boolean") {
      if (c.to === r.enabled) continue;
      if (r.listingChars === undefined) { unmeasured++; continue; }
      chars += c.to ? -r.listingChars : r.listingChars;
    }
  }
  return { chars, tokens: Math.round(chars / CHARS_PER_TOKEN), unmeasured };
}
