/**
 * What THIS desktop adds to every Claude Code session, whatever the repo: the user CLAUDE.md, the
 * auto-memory file of the repo's project slug, user skills, plugin skills (minus the plugins
 * `enabledPlugins` turns off, which get a row saying so), user and local-scope MCP servers, and ONE
 * unsized row for the managed/synced plugin packs no file here names — the static list is what
 * disk shows; a session's measured skill listing is the truth (`SessionCarried`).
 * The per-repo half is `agentfiles.ts` `instructionInventory()`; these rows carry `scope: "desktop"`
 * so a list can hold both and say which is which.
 *
 * Pure: the caller hands in a reader rooted at the CLI config dir (`~/.claude`, or
 * `CLAUDE_CONFIG_DIR`) and whatever it could resolve outside it (the slug, the plugin install
 * dirs, `~/.claude.json`'s server names — `desktopSources` reads those files the one way both readers
 * share). Paths are config-dir-relative and worded by `desktopPathWords` (alwaysonwords.ts); the
 * `~/.claude.json` rows carry their own `~`, an outside plugin its absolute path, the managed row none. An input the caller could not read becomes a row that SAYS so, never a silent
 * nothing and never a 0.
 */
import { classifySkill, MCP_UNSIZED } from "./agentfiles.js";
import type { AgentFilesFs, InstructionFile } from "./agentfiles.js";
import { skillDescChars } from "./contextweight.js";

export interface DesktopInventoryInput {
  /** Rooted at the CLI config dir (`claudeConfigDirOf`). */
  fs: AgentFilesFs;
  /** `projects/<slug>/memory/MEMORY.md`, relative to the config dir; null = caller could not slug the cwd. */
  memoryRel: string | null;
  /** Plugin install dirs relative to the config dir (from installed_plugins.json); null = file unreadable (a row says so). */
  plugins: { name: string; rel: string }[] | null;
  /** `mcpServers` keys of the user's `.claude.json`; null = unreadable. */
  userMcp: string[] | null;
  /** User-scope plugins `enabledPlugins` turns OFF (by name): one row each saying so, no skills listed. */
  disabledPlugins?: string[];
  /** `enabledPlugins` keys turned ON in the user's settings.json with no user-scope install to read: unsized rows. */
  userOnlyPlugins?: string[];
  /** `mcpServers` keys of `~/.claude.json` `projects[<cwd realpath>]` — local scope (`claude mcp add`). */
  localMcp?: string[];
}

/** Every kind word `desktopInventory` writes (plugin skills carry their plugin in brackets after it). */
export const DESKTOP_KINDS = {
  userClaudeMd: "user CLAUDE.md",
  memory: "auto-memory",
  userSkill: "user skill",
  pluginSkill: "plugin skill",
  pluginSkills: "plugin skills",
  userMcp: "user MCP server",
  userMcpServers: "user MCP servers",
  localMcp: "local MCP server",
  plugin: "plugin",
  managedSkills: "managed plugin skills",
} as const;

/** Why a plugin row has no skills listed: `enabledPlugins` turned it off. */
export const PLUGIN_DISABLED = "disabled in settings.json enabledPlugins — its skills are not carried";
/** Why a plugin enabled in settings has no number: nothing under the config dir to read. */
export const PLUGIN_UNREAD = "enabled in settings, but not installed under the config dir — its skills are not sized here";
/** The one row for plugin packs no file on this desktop names (claude.ai-managed, synced). */
export const MANAGED_SKILLS =
  "skills from claude.ai-managed or synced plugins are not on disk here; the session view's skill listing (what a session's first request carried) is the measured count";

/** `~/.claude.json` sits in the home dir, BESIDE the config dir, so its rows name it whole (a `~` path is already words). */
export const USER_CLAUDE_JSON = "~/.claude.json";

const D = { scope: "desktop" as const };

function skillsUnder(fs: AgentFilesFs, dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of [...fs.list(dir)].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.dir) continue;
    const path = `${dir}/${e.name}/SKILL.md`;
    const text = fs.read(path);
    if (text != null) out.push({ path, text });
  }
  return out;
}

const skillKind = (base: string, text: string) => (skillDescChars(text) > 0 ? base : `${base} — no description found in its frontmatter`);

/** This desktop's always-on rows, user files first, then skills, then the unsized MCP rows. */
export function desktopInventory(i: DesktopInventoryInput): InstructionFile[] {
  const out: InstructionFile[] = [];
  const claudeMd = i.fs.read("CLAUDE.md");
  if (claudeMd != null) out.push({ path: "CLAUDE.md", kind: DESKTOP_KINDS.userClaudeMd, parts: [{ readers: ["claude"], when: { kind: "always" }, chars: claudeMd.length }], ...D });
  if (i.memoryRel) {
    const mem = i.fs.read(i.memoryRel);
    if (mem != null) out.push({ path: i.memoryRel, kind: DESKTOP_KINDS.memory, parts: [{ readers: ["claude"], when: { kind: "always" }, chars: mem.length }], ...D });
  }
  for (const s of skillsUnder(i.fs, "skills")) {
    out.push({ path: s.path, kind: skillKind(DESKTOP_KINDS.userSkill, s.text), parts: classifySkill(s.text, ["claude"]), ...D });
  }
  if (i.plugins == null) {
    out.push({ path: "plugins/installed_plugins.json", kind: DESKTOP_KINDS.pluginSkills, parts: [], unsized: "installed_plugins.json could not be read", ...D });
  } else {
    for (const p of i.plugins) {
      for (const s of skillsUnder(i.fs, `${p.rel.replace(/\/+$/, "")}/skills`)) {
        out.push({ path: s.path, kind: skillKind(`${DESKTOP_KINDS.pluginSkill} (${p.name})`, s.text), parts: classifySkill(s.text, ["claude"]), ...D });
      }
    }
  }
  for (const name of i.disabledPlugins ?? []) {
    out.push({ path: "settings.json", kind: `${DESKTOP_KINDS.plugin} ${name}`, parts: [], unsized: PLUGIN_DISABLED, ...D });
  }
  for (const key of i.userOnlyPlugins ?? []) {
    out.push({ path: "settings.json", kind: `${DESKTOP_KINDS.plugin} ${key}`, parts: [], unsized: PLUGIN_UNREAD, ...D });
  }
  if (i.userMcp == null) {
    out.push({ path: USER_CLAUDE_JSON, kind: DESKTOP_KINDS.userMcpServers, parts: [], unsized: "~/.claude.json could not be read", ...D });
  } else {
    for (const name of i.userMcp) {
      out.push({ path: USER_CLAUDE_JSON, kind: `${DESKTOP_KINDS.userMcp} ${name}`, parts: [], unsized: MCP_UNSIZED, ...D });
    }
  }
  for (const name of i.localMcp ?? []) {
    out.push({ path: USER_CLAUDE_JSON, kind: `${DESKTOP_KINDS.localMcp} ${name}`, parts: [], unsized: MCP_UNSIZED, ...D });
  }
  // No file names a managed pack, so this row is always there: the static list cannot see them.
  out.push({ path: "", kind: DESKTOP_KINDS.managedSkills, parts: [], unsized: MANAGED_SKILLS, ...D });
  return out;
}

// ── reading the desktop's settings, once for the host and the VS Code extension ──

/** A parsed JSON file: the value, `"missing"` when there is no file, null when it is there but unreadable. */
type JsonRead = unknown;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface DesktopSourcesInput {
  /** `<config dir>/plugins/installed_plugins.json`. */
  installed: JsonRead;
  /** `<config dir>/settings.json`. */
  userSettings: JsonRead;
  /** The repo's `.claude/settings.json` then `.claude/settings.local.json` (later wins), with their repo-relative paths. */
  projectSettings: { path: string; json: JsonRead }[];
  /** The user's `.claude.json`. */
  claudeJson: JsonRead;
  /** The session cwd's realpath — the key of `.claude.json` `projects`. */
  projectKey: string | null;
  /** An install path relative to the config dir (`/`-separated), or null when it lies outside it. */
  relToConfig: (abs: string) => string | null;
}

export interface DesktopSources {
  /** Enabled user-scope plugins under the config dir; null = installed_plugins.json unreadable. */
  plugins: { name: string; rel: string }[] | null;
  /** Enabled user-scope plugins installed outside the config dir: listed, unsized. */
  outside: { name: string; path: string }[];
  disabledPlugins: string[];
  userOnlyPlugins: string[];
  /** Plugins the REPO's settings turn on: repo rows, unsized (path = the settings file that enabled it). */
  projectPlugins: { key: string; path: string }[];
  userMcp: string[] | null;
  localMcp: string[];
  /** `.mcp.json` servers this desktop declined (`disabledMcpjsonServers`, in `.claude.json` or any settings file). */
  mcpjsonDeclined: string[];
}

/**
 * Which plugins and MCP servers a session started in this repo on this desktop gets, out of the
 * files that decide it: `enabledPlugins` (user < project < local; `false` turns a plugin off),
 * `installed_plugins.json` (user scope only — those are the ones with skills to read), and
 * `.claude.json`'s user and local-scope `mcpServers` plus the `.mcp.json` servers declined here.
 */
export function desktopSources(i: DesktopSourcesInput): DesktopSources {
  const enabled = new Map<string, { on: boolean; path: string | null }>();
  const takeEnabled = (json: JsonRead, path: string | null) => {
    if (!isObj(json) || !isObj(json.enabledPlugins)) return;
    for (const [k, v] of Object.entries(json.enabledPlugins)) if (typeof v === "boolean") enabled.set(k, { on: v, path });
  };
  takeEnabled(i.userSettings, null);
  for (const p of i.projectSettings) takeEnabled(p.json, p.path);

  const out: DesktopSources = { plugins: [], outside: [], disabledPlugins: [], userOnlyPlugins: [], projectPlugins: [], userMcp: [], localMcp: [], mcpjsonDeclined: [] };
  const userKeys = new Set<string>();
  if (i.installed !== "missing") {
    if (!isObj(i.installed) || !isObj(i.installed.plugins)) out.plugins = null;
    else {
      for (const [key, installs] of Object.entries(i.installed.plugins)) {
        if (!Array.isArray(installs)) continue;
        const name = key.split("@")[0] || key;
        for (const inst of installs) {
          if (!isObj(inst) || inst.scope !== "user" || typeof inst.installPath !== "string") continue;
          userKeys.add(key);
          if (enabled.get(key)?.on === false) { if (!out.disabledPlugins.includes(name)) out.disabledPlugins.push(name); continue; }
          const rel = i.relToConfig(inst.installPath);
          if (rel) out.plugins!.push({ name, rel });
          else out.outside.push({ name, path: inst.installPath });
        }
      }
    }
  }
  for (const [key, e] of enabled) {
    if (!e.on || userKeys.has(key)) continue;
    if (e.path) out.projectPlugins.push({ key, path: e.path });
    else out.userOnlyPlugins.push(key);
  }

  const declined = new Set<string>();
  for (const p of i.projectSettings) if (isObj(p.json)) strs(p.json.disabledMcpjsonServers).forEach((n) => declined.add(n));
  if (isObj(i.userSettings)) strs(i.userSettings.disabledMcpjsonServers).forEach((n) => declined.add(n));
  if (i.claudeJson !== "missing") {
    if (!isObj(i.claudeJson)) out.userMcp = null;
    else {
      out.userMcp = isObj(i.claudeJson.mcpServers) ? Object.keys(i.claudeJson.mcpServers).sort() : [];
      const proj = i.projectKey && isObj(i.claudeJson.projects) ? i.claudeJson.projects[i.projectKey] : undefined;
      if (isObj(proj)) {
        out.localMcp = isObj(proj.mcpServers) ? Object.keys(proj.mcpServers).sort() : [];
        strs(proj.disabledMcpjsonServers).forEach((n) => declined.add(n));
      }
    }
  }
  out.mcpjsonDeclined = [...declined].sort();
  return out;
}

/** Why a `.mcp.json` server row will not load here. */
export const MCP_DECLINED = "declined on this desktop (disabledMcpjsonServers) — not loaded";

/**
 * The repo rows as THIS desktop loads them: a `.mcp.json` server it declined says so instead of
 * claiming tool schemas, and the plugins the repo's settings turn on are listed, unsized.
 */
export function repoRowsOnThisDesktop(files: InstructionFile[], s: Pick<DesktopSources, "mcpjsonDeclined" | "projectPlugins">): InstructionFile[] {
  const declined = new Set(s.mcpjsonDeclined);
  const rows = files.map((f) => (f.path === ".mcp.json" && f.kind.startsWith("MCP server ") && declined.has(f.kind.slice("MCP server ".length))
    ? { ...f, unsized: MCP_DECLINED }
    : f));
  for (const p of s.projectPlugins) {
    rows.push({ path: p.path, kind: `project ${DESKTOP_KINDS.plugin} ${p.key}`, parts: [], unsized: "enabled in this repo's settings — its skills load from the plugin cache and are not sized here" });
  }
  return rows;
}
