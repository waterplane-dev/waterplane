/**
 * What THIS desktop adds to every Claude Code session, whatever the repo: the user CLAUDE.md, the
 * auto-memory file of the repo's project slug, user skills, plugin skills (minus the plugins
 * `enabledPlugins` turns off, which get a row saying so), user and local-scope MCP servers, and ONE
 * unsized row for the managed/synced plugin packs no file here names — the static list is what
 * disk shows; a session's measured skill listing is the truth (`SessionCarried`). Hooks that can
 * put text in context (`CONTEXT_HOOK_EVENTS`) are one unsized row per file and event: the log
 * records the event, never the command, so only the session's measured "hook context" has a size.
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
import { trimEndChars } from "./lineartrim.js";

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
  /** Context hooks of the user's settings.json; null = unreadable (a row says so). */
  hooks?: ContextHook[] | null;
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
  hook: "context hook",
} as const;

/** Why a plugin row has no skills listed: `enabledPlugins` turned it off. */
export const PLUGIN_DISABLED = "disabled in settings.json enabledPlugins — its skills are not carried";
/** Why a plugin enabled in settings has no number: nothing under the config dir to read. */
export const PLUGIN_UNREAD = "enabled in settings, but not installed under the config dir — its skills are not sized here";
/** The one row for plugin packs no file on this desktop names (claude.ai-managed, synced). */
export const MANAGED_SKILLS =
  "skills from claude.ai-managed or synced plugins are not on disk here; the session view's skill listing (what a session's first request carried) is the measured count";

/** The two hook events whose output reaches the model's context; every other event injects nothing. */
export const CONTEXT_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;
export type ContextHookEvent = (typeof CONTEXT_HOOK_EVENTS)[number];

/** One file's commands on one event. A count, never the command text: that can hold a secret, and these rows reach the phone. */
export interface ContextHook {
  event: ContextHookEvent;
  /** The file that declares it, in the row's own path words. */
  path: string;
  commands: number;
}

// closed: `event` comes from this build's own CONTEXT_HOOK_EVENTS, read off this desktop's settings, never off the wire
const HOOK_REACH: Record<ContextHookEvent, string> = { SessionStart: "every session", UserPromptSubmit: "every prompt" };

/** Why a context-hook row has no number, and where its size is measured instead. */
export const hookUnsized = (h: Pick<ContextHook, "event" | "commands">): string => {
  const [runs, it] = h.commands === 1 ? ["a command", "it"] : ["commands", "them"];
  return `runs ${runs} whose output the CLI adds to ${HOOK_REACH[h.event]}; a session's context view measures the size as "hook context", and /hooks lists ${it}`;
};

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

const hookKind = (h: ContextHook, plugin?: string) =>
  `${DESKTOP_KINDS.hook} ${h.event} (${h.commands} ${h.commands === 1 ? "command" : "commands"}${plugin ? `, plugin ${plugin}` : ""})`;

const hookRow = (h: ContextHook, plugin?: string): InstructionFile => ({ path: h.path, kind: hookKind(h, plugin), parts: [], unsized: hookUnsized(h) });

const hooksUnreadRow = (path: string): InstructionFile => ({ path, kind: `${DESKTOP_KINDS.hook}s`, parts: [], unsized: `${path} could not be read` });

/** The hooks an enabled plugin ships. The reader cannot tell missing from unreadable, so null is no rows; text that is not JSON says so. */
function pluginHookRows(fs: AgentFilesFs, p: { name: string; rel: string }): InstructionFile[] {
  const path = `${trimEndChars(p.rel, "/")}/hooks/hooks.json`;
  const text = fs.read(path);
  if (text == null) return [];
  let json: unknown;
  try { json = JSON.parse(text); } catch { return [hooksUnreadRow(path)]; }
  return isObj(json) ? contextHooksOf(json, path).map((h) => hookRow(h, p.name)) : [hooksUnreadRow(path)];
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
      for (const s of skillsUnder(i.fs, `${trimEndChars(p.rel, "/")}/skills`)) {
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
  if (i.hooks === null) out.push({ ...hooksUnreadRow("settings.json"), ...D });
  for (const h of i.hooks ?? []) out.push({ ...hookRow(h), ...D });
  // `plugins` holds the enabled ones only: a disabled plugin's hooks do not load, so they are never read.
  for (const p of i.plugins ?? []) for (const r of pluginHookRows(i.fs, p)) out.push({ ...r, ...D });
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

/** A settings-shaped object's context hooks, one entry per event with a command. A missing or non-object `hooks` is none. */
function contextHooksOf(json: Record<string, unknown>, path: string): ContextHook[] {
  const hooks = json.hooks;
  if (!isObj(hooks)) return [];
  const out: ContextHook[] = [];
  for (const event of CONTEXT_HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const commands = groups.flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []))
      .filter((h) => isObj(h) && h.type === "command" && typeof h.command === "string").length;
    if (commands) out.push({ event, path, commands });
  }
  return out;
}

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
  /** Context hooks of the user's settings.json; null = that file is there but unreadable. */
  hooks: ContextHook[] | null;
  /** Context hooks of the repo's settings files: repo rows, unsized. */
  projectHooks: ContextHook[];
  /** The repo's settings files that are there but unreadable: one row each. */
  projectHooksUnread: string[];
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

  const out: DesktopSources = { plugins: [], outside: [], disabledPlugins: [], userOnlyPlugins: [], projectPlugins: [], userMcp: [], localMcp: [], mcpjsonDeclined: [], hooks: [], projectHooks: [], projectHooksUnread: [] };
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

  if (isObj(i.userSettings)) out.hooks = contextHooksOf(i.userSettings, "settings.json");
  else if (i.userSettings !== "missing") out.hooks = null;
  for (const p of i.projectSettings) {
    if (isObj(p.json)) out.projectHooks.push(...contextHooksOf(p.json, p.path));
    else if (p.json !== "missing") out.projectHooksUnread.push(p.path);
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
 * claiming tool schemas, and the plugins and context hooks the repo's settings turn on are listed,
 * unsized.
 */
export function repoRowsOnThisDesktop(files: InstructionFile[], s: Pick<DesktopSources, "mcpjsonDeclined" | "projectPlugins"> & Partial<Pick<DesktopSources, "projectHooks" | "projectHooksUnread">>): InstructionFile[] {
  const declined = new Set(s.mcpjsonDeclined);
  const rows = files.map((f) => (f.path === ".mcp.json" && f.kind.startsWith("MCP server ") && declined.has(f.kind.slice("MCP server ".length))
    ? { ...f, unsized: MCP_DECLINED }
    : f));
  for (const p of s.projectPlugins) {
    rows.push({ path: p.path, kind: `project ${DESKTOP_KINDS.plugin} ${p.key}`, parts: [], unsized: "enabled in this repo's settings — its skills load from the plugin cache and are not sized here" });
  }
  for (const path of s.projectHooksUnread ?? []) rows.push(hooksUnreadRow(path));
  for (const h of s.projectHooks ?? []) rows.push(hookRow(h));
  return rows;
}
