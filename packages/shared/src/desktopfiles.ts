/**
 * What THIS desktop adds to every Claude Code session, whatever the repo: the user CLAUDE.md, the
 * auto-memory file of the repo's project slug, user skills, plugin skills and user MCP servers.
 * The per-repo half is `agentfiles.ts` `instructionInventory()`; these rows carry `scope: "desktop"`
 * so a list can hold both and say which is which.
 *
 * Pure: the caller hands in a reader rooted at the CLI config dir (`~/.claude`, or
 * `CLAUDE_CONFIG_DIR`) and whatever it could resolve outside it (the slug, the plugin install
 * dirs, `~/.claude.json`'s server names). Paths are config-dir-relative; the UI prefixes `~/.claude/`
 * only in words (the `~/.claude.json` rows already carry their own `~`). An input the caller could not read becomes a row that SAYS so, never a silent
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
} as const;

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
  if (i.userMcp == null) {
    out.push({ path: USER_CLAUDE_JSON, kind: DESKTOP_KINDS.userMcpServers, parts: [], unsized: "~/.claude.json could not be read", ...D });
  } else {
    for (const name of i.userMcp) {
      out.push({ path: USER_CLAUDE_JSON, kind: `${DESKTOP_KINDS.userMcp} ${name}`, parts: [], unsized: MCP_UNSIZED, ...D });
    }
  }
  return out;
}
