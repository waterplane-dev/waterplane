/**
 * The settings files the skills and plugins switch reads (docs/analysis/skills-switch/PLAN.md, P2).
 *
 * Read with `readFileSync` + `JSON.parse`, NEVER `readJsonGuarded`: that MOVES an unparseable file
 * aside, and a settings file is the person's. An unreadable file is a layer saying so, and its
 * maps count as empty (the write path refuses it, P3). Read-only here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillLayer, SwitchLevel } from "@waterplane/shared";
import { claudeConfigDir } from "../claudeconfig.js";

export type JsonMap = Record<string, unknown>;

export interface LayerRead {
  layer: SkillLayer;
  /** The two switch maps of this file (empty when absent or unreadable). */
  skillOverrides: JsonMap;
  enabledPlugins: JsonMap;
  /** `skillListingMaxDescChars` when this file sets it. */
  maxDesc?: number;
  /** The absolute file. */
  file: string;
}

export interface SkillLayers {
  reads: LayerRead[];
  /** Managed (policy) settings: read-only locks. */
  policy: { skillOverrides: JsonMap; enabledPlugins: JsonMap };
  maxDesc?: number;
}

const isObj = (v: unknown): v is JsonMap => !!v && typeof v === "object" && !Array.isArray(v);

/** `~/…` for a path under the home dir, else the path as is. */
export function displayPath(abs: string): string {
  const h = homedir();
  return abs === h ? "~" : abs.startsWith(h + "/") ? "~" + abs.slice(h.length) : abs;
}

export function readLayer(level: SwitchLevel, file: string, display: string): LayerRead {
  const empty = { skillOverrides: {}, enabledPlugins: {}, file };
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { layer: { level, path: display, rev: "absent", readable: true }, ...empty };
    return { layer: { level, path: display, rev: "absent", readable: false, why: `${display} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}).` }, ...empty };
  }
  const rev = createHash("sha1").update(text).digest("hex");
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    return { layer: { level, path: display, rev, readable: false, why: `${display} is not valid JSON, so nothing here reads or writes it.` }, ...empty };
  }
  if (!isObj(json)) return { layer: { level, path: display, rev, readable: false, why: `${display} is not a JSON object.` }, ...empty };
  for (const k of ["skillOverrides", "enabledPlugins"]) {
    if (k in json && !isObj(json[k])) return { layer: { level, path: display, rev, readable: false, why: `${display} has a "${k}" that is not an object.` }, ...empty };
  }
  const md = json.skillListingMaxDescChars;
  return {
    layer: { level, path: display, rev, readable: true },
    skillOverrides: (json.skillOverrides as JsonMap | undefined) ?? {},
    enabledPlugins: (json.enabledPlugins as JsonMap | undefined) ?? {},
    maxDesc: typeof md === "number" && md > 0 ? md : undefined,
    file,
  };
}

/** Where managed settings live (best effort, read-only). */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  return null;
}

/** The global layer, and with a worktree the two repo layers. Order: global, repo-shared, repo-local. */
export function readSkillLayers(worktree?: string): SkillLayers {
  const reads = [readLayer("global", join(claudeConfigDir(), "settings.json"), displayPath(join(claudeConfigDir(), "settings.json")))];
  if (worktree) {
    reads.push(readLayer("repo-shared", join(worktree, ".claude", "settings.json"), ".claude/settings.json"));
    reads.push(readLayer("repo-local", join(worktree, ".claude", "settings.local.json"), ".claude/settings.local.json"));
  }
  const mp = managedSettingsPath();
  const m = mp ? readLayer("global", mp, mp) : null;
  const maxDesc = [...reads, ...(m ? [m] : [])].map((r) => r.maxDesc).filter((n): n is number => n !== undefined).pop(); // merged settings: the highest-precedence source wins (managed > local > shared > global)
  return { reads, policy: { skillOverrides: m?.skillOverrides ?? {}, enabledPlugins: m?.enabledPlugins ?? {} }, maxDesc };
}
