/**
 * Slash-command catalogue. Combines the built-in Claude Code commands with
 * the user's custom commands discovered from `.claude/commands/*.md` (project
 * and personal scopes). The web client renders these in a palette; selecting
 * one just types the command into the PTY, so anything `claude` accepts works
 * even if it's not in this list.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claudeconfig.js";

export interface SlashCommand {
  name: string;        // includes leading slash, e.g. "/context"
  source: "builtin" | "project" | "user";
  description?: string;
}

// Common built-ins (Claude Code 2.x). Not exhaustive — custom + free typing
// cover the rest. /btw is surfaced specially in the UI.
const BUILTINS: [string, string][] = [
  ["/btw", "Queue a note for later without interrupting the current turn"],
  ["/context", "Show context window usage breakdown"],
  // The CLI's own command table (2.1.236) reads
  // `{ name: "usage", aliases: ["cost", "stats"] }` — `usage` is the command and
  // `cost` is an alias it keeps answering to, which is why its menu entry draws
  // as "/usage (cost)". Both stay listed (an older CLI on someone's machine only
  // has `/cost`), but the canonical one carries the CLI's own words and is what
  // the toolbar sends.
  ["/usage", "Show session cost, plan usage, and activity stats"],
  ["/cost", "Show session cost, plan usage, and activity stats (alias of /usage)"],
  ["/clear", "Clear conversation history"],
  ["/compact", "Summarize and compact the conversation"],
  ["/config", "Open settings"],
  ["/model", "Switch the model"],
  ["/output-style", "Switch the output style"],
  ["/agents", "Manage subagents"],
  ["/mcp", "Manage MCP servers"],
  ["/hooks", "Manage hooks"],
  ["/permissions", "Manage tool permissions"],
  ["/sandbox", "Manage sandbox settings"],
  ["/add-dir", "Add a working directory to the session"],
  ["/remote-control", "Drive this session from claude.ai (Remote Control)"],
  ["/ide", "Connect to an IDE integration"],
  ["/review", "Review a pull request"],
  ["/pr-comments", "Show pull-request comments"],
  ["/install-github-app", "Install the Claude GitHub app"],
  ["/init", "Generate a CLAUDE.md for the repo"],
  ["/memory", "Edit memory files"],
  ["/todos", "Show the session's todo list"],
  ["/resume", "Resume a previous session"],
  ["/rewind", "Rewind to an earlier checkpoint"],
  // Answered by the HOST, never typed: it opens the fork as a new tab here
  // (`shared/slash.ts`'s `slashForkTitle` — the CLI's own would vanish into its daemon).
  ["/fork", "Fork this conversation into a new tab (optional title after it)"],
  ["/export", "Export the conversation"],
  ["/bashes", "List background bash shells"],
  ["/status", "Show session status"],
  ["/statusline", "Configure the status line"],
  ["/doctor", "Diagnose and verify the installation"],
  ["/upgrade", "Upgrade Claude Code"],
  ["/terminal-setup", "Configure terminal key bindings"],
  ["/vim", "Toggle vim mode"],
  ["/bug", "Report a bug to Anthropic"],
  ["/feedback", "Send feedback to Anthropic"],
  ["/privacy-settings", "Manage privacy settings"],
  ["/release-notes", "Show release notes"],
  ["/help", "List all commands"],
  ["/login", "Authenticate"],
  ["/logout", "Sign out"],
];

function discoverDir(dir: string, source: "project" | "user"): SlashCommand[] {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  const walk = (base: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(base, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.endsWith("/")) {
        walk(join(base, e.slice(0, -1)), `${prefix}${e.slice(0, -1)}:`);
      } else if (e.endsWith(".md")) {
        out.push({ name: `/${prefix}${e.slice(0, -3)}`, source });
      }
    }
  };
  walk(dir, "");
  return out;
}

export function listSlashCommands(cwd: string): SlashCommand[] {
  const builtins: SlashCommand[] = BUILTINS.map(([name, description]) => ({ name, source: "builtin", description }));
  const project = discoverDir(join(cwd, ".claude", "commands"), "project");
  const user = discoverDir(join(claudeConfigDir(), "commands"), "user");
  // Dedupe by name, builtins first.
  const seen = new Set<string>();
  const all: SlashCommand[] = [];
  for (const c of [...builtins, ...project, ...user]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    all.push(c);
  }
  return all;
}

/**
 * The TUI-local command list lives in `@waterplane/shared` now: the PHONE needs the
 * same answer this file used to keep to itself, so that a view is not delivered
 * into a session mid-turn like an interjection. Re-exported here because
 * `deliver.ts` has always asked this module.
 */
export { isLocalCommand, startsNoTurn, worksUnannounced } from "@waterplane/shared";
