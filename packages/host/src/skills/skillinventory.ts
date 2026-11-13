/**
 * The skills and plugins this desktop's claude would list, with the state at each settings level and
 * what each costs (docs/analysis/skills-switch/PLAN.md, P2). Read-only. Counts are P4's (`usage` here
 * is absent until then); bundled skills are not enumerated (no file names them).
 *
 * A plugin skill is `switchable:false`: the CLI ignores `skillOverrides` for it (fact 3), only the
 * plugin's own switch works. Plugin ids and installs come from `claude plugin list --json` (cached
 * 60 s); a failure falls back to `installed_plugins.json` + the synced dir and SAYS so in `hostNote`.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addLocalDays, lineCost, resolvePluginEnabled, resolveSkillState,
  type PluginRow, type SkillInventoryDoc, type SkillRow, type SkillSource,
} from "@waterplane/shared";
import { claudeBin } from "../backends/claude.js";
import { claudeConfigDir } from "../claudeconfig.js";
import { disablesModelInvocation, weightOf } from "./skillweight.js";
import { readSkillLayers } from "./skilllayers.js";

export const PLUGIN_SKILLS_SWITCHABLE = false;
const PLUGIN_SKILL_WHY = "The CLI ignores per-skill switches for plugin skills; switch the whole plugin.";
const LIST_TTL_MS = 60_000;

export interface InstalledPlugin { id: string; version?: string; scope: string; enabled: boolean; installPath: string }
interface PluginList { plugins: InstalledPlugin[]; note?: string }

const cache = new Map<string, { at: number; list: PluginList }>();

function runPluginList(cwd?: string, timeoutMs = 10_000): Promise<InstalledPlugin[]> {
  return new Promise((resolve, reject) => {
    execFile(claudeBin(), ["plugin", "list", "--json"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env, ...(cwd ? { cwd } : {}) }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(stdout);
        if (!Array.isArray(j)) throw new Error("not a list");
        resolve(j.filter((p) => p && typeof p.id === "string" && typeof p.installPath === "string").map((p) => ({
          id: p.id, version: typeof p.version === "string" ? p.version : undefined, scope: String(p.scope ?? ""),
          enabled: p.enabled !== false, installPath: p.installPath,
        })));
      } catch (e) { reject(e as Error); }
    });
  });
}

/** installed_plugins.json (v2: plugins[id] = [{scope, installPath, version}]) + the synced dir. */
export function fallbackPlugins(): InstalledPlugin[] {
  const out: InstalledPlugin[] = [];
  const root = join(claudeConfigDir(), "plugins");
  try {
    const j = JSON.parse(readFileSync(join(root, "installed_plugins.json"), "utf8"));
    for (const [id, arr] of Object.entries(j?.plugins ?? {})) {
      const e = Array.isArray(arr) ? arr[0] : null;
      if (e && typeof e.installPath === "string") out.push({ id, version: e.version, scope: String(e.scope ?? ""), enabled: true, installPath: e.installPath });
    }
  } catch { /* none */ }
  try {
    for (const acct of readdirSync(join(root, "synced"))) {
      const dir = join(root, "synced", acct);
      if (!statSync(dir).isDirectory()) continue;
      for (const d of readdirSync(dir)) {
        if (d.endsWith(".json") || !statSync(join(dir, d)).isDirectory()) continue;
        const name = d.replace(/~g\d+$/, "");
        const id = `${name}@synced`;
        if (!out.some((p) => p.id === id)) out.push({ id, scope: "synced", enabled: true, installPath: join(dir, d) });
      }
    }
  } catch { /* none */ }
  return out;
}

/** Asked from the repo's own folder, so its on/off default folds in THAT repo's settings and no other's. */
async function pluginList(worktree?: string): Promise<PluginList> {
  const key = worktree ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.list;
  let list: PluginList;
  try { list = { plugins: await runPluginList(worktree) }; } catch {
    list = { plugins: fallbackPlugins(), note: "claude plugin list could not be run, so plugins are read from the files on disk and a plugin's on/off default is assumed on." };
  }
  cache.set(key, { at: Date.now(), list });
  return list;
}
/** Dropped after a write (a settings file just changed) and by tests. */
export function resetPluginListCache(): void { cache.clear(); }

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** `<dir>/*\/SKILL.md`, symlinks followed. */
function skillFiles(dir: string): { dir: string; file: string }[] {
  const out: { dir: string; file: string }[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const file = join(dir, n, "SKILL.md");
    if (existsSync(file)) out.push({ dir: n, file });
  }
  return out;
}

function mcpCount(installPath: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(join(installPath, ".mcp.json"), "utf8"));
    const m = j && typeof j === "object" ? (j.mcpServers ?? j) : null;
    return m && typeof m === "object" && !Array.isArray(m) ? Object.keys(m).length : undefined;
  } catch { return undefined; }
}

export interface InventoryOpts { worktree?: string; repoId?: string; now?: number }
export interface InventoryOut { doc: SkillInventoryDoc; /** skill id -> its SKILL.md (for refs) */ files: Record<string, string> }

export async function buildInventory(opts: InventoryOpts = {}): Promise<InventoryOut> {
  const L = readSkillLayers(opts.worktree);
  const byLevel = (lvl: string) => L.reads.find((r) => r.layer.level === lvl);
  const user = byLevel("global"), shared = byLevel("repo-shared"), local = byLevel("repo-local");
  const layers = { user: user?.skillOverrides, project: shared?.skillOverrides, local: local?.skillOverrides };
  const pLayers = { user: user?.enabledPlugins, project: shared?.enabledPlugins, local: local?.enabledPlugins };
  const files: Record<string, string> = {};
  const rows: (SkillRow | PluginRow)[] = [];
  let unmeasured = 0;
  const seen = new Set<string>();

  // The CLI reserves a bare name for the personal / project skill that holds it: a synced skill's bare key is then ignored.
  const heldNames = new Set<string>();
  for (const s of skillFiles(join(claudeConfigDir(), "skills"))) if (s.dir !== "synced") heldNames.add(s.dir);
  if (opts.worktree) for (const s of skillFiles(join(opts.worktree, ".claude", "skills"))) heldNames.add(s.dir);

  const setOf = (id: string, bare?: string): SkillRow["set"] => {
    const set: SkillRow["set"] = {};
    for (const r of L.reads) {
      const v = r.skillOverrides[id] ?? (bare ? r.skillOverrides[bare] : undefined);
      if (typeof v === "string" && ["on", "name-only", "user-invocable-only", "off"].includes(v)) set[r.layer.level] = v as never;
    }
    return set;
  };
  const addSkill = (id: string, source: SkillSource, file: string, plugin?: string, bareName?: string): void => {
    if (seen.has(id)) return;
    const bare = bareName !== undefined && !heldNames.has(bareName) ? bareName : undefined;
    seen.add(id);
    let text: string | null = null;
    try { text = readFileSync(file, "utf8"); } catch { /* unreadable */ }
    const switchable = source === "plugin" ? PLUGIN_SKILLS_SWITCHABLE : true;
    const locks = { policy: L.policy.skillOverrides } as never;
    // The CLI reads the prefixed key at every level first, then the bare name of a synced skill.
    let res = resolveSkillState(id, layers as never, locks);
    if (bare && res.from === "default") res = resolveSkillState(bare, layers as never, locks);
    const authorLocked = text !== null && disablesModelInvocation(text);
    const row: SkillRow = {
      kind: "skill", id, source, set: setOf(id, bare), effective: res.state, from: res.from, switchable,
    };
    if (plugin) row.plugin = plugin;
    // The CLI fixes a skill with `disable-model-invocation: true` at user-invocable-only (never in the
    // model's listing) before it looks at any skillOverrides; only a managed "off" is stronger.
    // Any non-plugin "off" beats it (read from the CLI 2.1.322 resolver: overrides across all sources
    // return off first); a plugin skill ignores skillOverrides, so only a managed value counts there.
    if (authorLocked && !(res.state === "off" && (source !== "plugin" || res.from === "locked"))) {
      row.effective = "user-invocable-only"; row.from = "locked"; row.lockedBy = "author";
      row.locked = "The skill's own file says only you may run it (disable-model-invocation), so the model never lists it and no setting changes that.";
    } else if (res.from === "locked") row.locked = "A managed setting fixes this value; it cannot be changed here.";
    if (text !== null) {
      const w = weightOf(id, text, L.maxDesc);
      row.listingChars = w.listingChars; row.bodyChars = w.bodyChars;
      if (w.capped) row.capped = true;
    } else {
      unmeasured++;
      row.why = "Its SKILL.md could not be read, so its weight is not measured.";
    }
    if (!switchable) row.why = row.why ? `${row.why} ${PLUGIN_SKILL_WHY}` : PLUGIN_SKILL_WHY;
    files[id] = file;
    rows.push(row);
  };

  // Personal (and the claude.ai standalone skills under skills/synced/<account>/).
  const personal = join(claudeConfigDir(), "skills");
  for (const s of skillFiles(personal)) if (s.dir !== "synced") addSkill(s.dir, "personal", s.file);
  try {
    for (const acct of readdirSync(join(personal, "synced"))) {
      for (const s of skillFiles(join(personal, "synced", acct))) addSkill(`anthropic-skills:${s.dir}`, "synced-skill", s.file, undefined, s.dir);
    }
  } catch { /* none */ }
  // Project.
  if (opts.worktree) for (const s of skillFiles(join(opts.worktree, ".claude", "skills"))) addSkill(s.dir, "project", s.file);

  // Plugins.
  const pl = await pluginList(opts.worktree);
  for (const p of pl.plugins) {
    const name = p.id.split("@")[0] || p.id;
    let installPath = p.installPath;
    try { installPath = realpathSync(installPath); } catch { /* keep as given */ }
    const skillIds: string[] = [];
    if (isDir(installPath)) {
      for (const s of skillFiles(join(installPath, "skills"))) {
        // The CLI names a skills/<dir>/SKILL.md `<plugin>:<dir>` (odd characters become "-"); the frontmatter name is ignored.
        const id = `${name}:${s.dir.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        addSkill(id, "plugin", s.file, p.id);
        skillIds.push(id);
      }
    }
    const res = resolvePluginEnabled(p.id, pLayers as never, { policy: L.policy.enabledPlugins } as never, p.enabled);
    const set: PluginRow["set"] = {};
    for (const r of L.reads) if (typeof r.enabledPlugins[p.id] === "boolean") set[r.layer.level] = r.enabledPlugins[p.id] as boolean;
    const mine = rows.filter((r): r is SkillRow => r.kind === "skill" && skillIds.includes(r.id));
    const measured = mine.length > 0 && mine.every((r) => r.listingChars !== undefined);
    const prow: PluginRow = { kind: "plugin", id: p.id, name, scope: p.scope, set, enabled: res.enabled, from: res.from, skills: skillIds };
    if (p.version) prow.version = p.version;
    if (measured) prow.listingChars = mine.reduce((n, r) => n + (r.lockedBy === "author" ? 0 : r.listingChars ?? 0), 0); // an author-locked skill is never listed
    else prow.why = mine.length === 0 ? "No skills found in this plugin's folder, so its weight is not measured." : "Some of its skills could not be read, so its weight is not measured.";
    const mcp = isDir(installPath) ? mcpCount(installPath) : undefined;
    if (mcp !== undefined) prow.mcpServers = mcp;
    rows.push(prow);
  }

  // What the listing carries NOW: a skill counts at its effective state (name-only is its name line,
  // off is nothing) and a plugin's skills only while the plugin is on, so a save lowers the total.
  const pluginOn = new Map(rows.filter((r): r is PluginRow => r.kind === "plugin").map((p) => [p.id, p.enabled]));
  const carried = (r: SkillRow): number => (r.plugin && pluginOn.get(r.plugin) === false ? 0 : lineCost(r, r.effective) ?? 0);
  const sum = (pred: (r: SkillRow) => boolean): number | undefined => {
    const m = rows.filter((r): r is SkillRow => r.kind === "skill" && pred(r) && r.listingChars !== undefined);
    return m.length ? m.reduce((n, r) => n + carried(r), 0) : undefined;
  };
  const doc: SkillInventoryDoc = {
    v: 1, at: opts.now ?? Date.now(),
    layers: L.reads.map((r) => r.layer),
    rows,
    totals: { skillChars: sum((r) => r.source !== "plugin"), pluginChars: sum((r) => r.source === "plugin"), unmeasured },
    usage: { state: "absent", why: "Use counts are not read yet.", since30: addLocalDays(opts.now ?? Date.now(), -30) },
  };
  if (opts.repoId) doc.repoId = opts.repoId;
  const notes = [pl.note, "Bundled skills are not listed: no file names them."].filter(Boolean);
  doc.hostNote = notes.join(" ");
  return { doc, files };
}
