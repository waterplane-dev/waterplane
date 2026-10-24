/**
 * Slash-command catalogue. Combines the built-in Claude Code commands with
 * the user's custom commands discovered from `.claude/commands/*.md` (project
 * and personal scopes). The web client renders these in a palette; selecting
 * one just types the command into the PTY, so anything `claude` accepts works
 * even if it's not in this list. A plugin backend's OWN list (2.2 `commands`)
 * is read at the bottom of this file, and so is what a delivery asks of it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand, SlashListDoc, SourceCommand } from "@waterplane/shared";
import { sourceCommandsProblems } from "@waterplane/shared";
import { claudeConfigDir } from "./claudeconfig.js";
import { derive } from "./backends/derive.js";
import { resolveBackend } from "./backends/index.js";
import type { BackendDescriptor } from "./backends/types.js";

/** The wire row (`shared/wire/slash.ts`); `name` includes the leading slash, e.g. "/context". */
export type { SlashCommand, SlashListDoc } from "@waterplane/shared";

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
  ["/effort", "Set the reasoning effort"],
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

// ── A backend's OWN commands (plugin contract 2.2, the `commands` slot) ────────────────────────
//
// `GET /api/slash?backend=<id>` answers from `sources.commands.list(cwd)` for a backend whose
// `commands` fact a source answers; the delivery asks the same list whether a `/word` it is about
// to type starts no turn (`deliveryCommandFacts`). ONE reader, ONE validation
// (`sourceCommandsProblems`): a malformed answer is dropped WHOLE, never kept in part.

type CommandsBackend = Pick<BackendDescriptor, "id" | "label" | "caps" | "facts" | "sources" | "forkVia">;

/** The longest a phone's slash sheet waits on a backend's list before saying it did not answer. */
export const COMMANDS_LIST_WAIT_MS = 5000;
/** The longest a DELIVERY waits on it: past this the descriptor's own rule decides, unasked. */
export const COMMANDS_DELIVERY_WAIT_MS = 1500;
/** A good list is reused this long by the sheet… */
const SHEET_FRESH_MS = 60_000;
/** …and this long by a delivery (a command's local-ness does not change between two sends). */
const DELIVERY_FRESH_MS = 10 * 60_000;

/** A source's answer, judged: the list (validated) or the sentence why there is none. */
type Asked = { list: SourceCommand[] } | { why: string };

/** Good lists only, by backend + cwd; a failure is never remembered (the next ask may succeed). */
const LISTS = new Map<string, { at: number; list: SourceCommand[] }>();
/** One question per backend + cwd in flight; a second asker joins it. */
const INFLIGHT = new Map<string, Promise<Asked>>();

/** Test seam: forget every remembered list. */
export function forgetBackendCommands(): void { LISTS.clear(); INFLIGHT.clear(); }

function ask(b: CommandsBackend, cwd: string): Promise<Asked> {
  const key = `${b.id}\n${cwd}`;
  const running = INFLIGHT.get(key);
  if (running) return running;
  const p = (async (): Promise<Asked> => {
    let answer: unknown;
    try { answer = await b.sources!.commands!.list(cwd); } catch (e) {
      return { why: `${b.label} could not list its commands: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (answer === null || answer === undefined) return { why: `${b.label} cannot say which commands it has right now` };
    const problems = sourceCommandsProblems(answer);
    if (problems.length) return { why: `${b.label}'s command list was dropped whole — ${problems[0]}` };
    const list = answer as SourceCommand[];
    LISTS.set(key, { at: Date.now(), list });
    return { list };
  })().finally(() => { if (INFLIGHT.get(key) === p) INFLIGHT.delete(key); });
  INFLIGHT.set(key, p);
  return p;
}

/** The list, from memory while fresh, else asked — bounded: a list that does not come in time is a sentence. */
async function listFor(b: CommandsBackend, cwd: string, freshMs: number, waitMs: number): Promise<Asked> {
  const kept = LISTS.get(`${b.id}\n${cwd}`);
  if (kept && Date.now() - kept.at < freshMs) return { list: kept.list };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Asked>((r) => {
    timer = setTimeout(() => {
      // A list that never settles must not be joined by every later ask: drop it so the next asks afresh.
      INFLIGHT.delete(`${b.id}\n${cwd}`);
      r({ why: `${b.label} did not list its commands in time` });
    }, waitMs);
  });
  try { return await Promise.race([ask(b, cwd), late]); } finally { clearTimeout(timer); }
}

const toRow = (c: SourceCommand): SlashCommand => ({
  name: c.name, source: "backend",
  ...(c.description ? { description: c.description } : {}),
  ...(c.args ? { args: c.args } : {}),
  ...(c.local === true ? { local: true as const } : {}),
});

/**
 * The slash sheet's answer for ONE backend (`GET /api/slash?backend=<id>`). A backend whose
 * `commands` fact a source answers: its own list, every row `source: "backend"`. One with none:
 * claude's set where its slash vocabulary IS claude's (`caps.slash === "claude"` — claude-local,
 * claude-endpoint), else an empty list WITH the sentence. A failing, null, late or malformed
 * answer is an empty list with the sentence, never a partial list and never claude's.
 */
export async function backendSlashCommands(b: CommandsBackend, cwd: string): Promise<SlashListDoc> {
  if (!derive(b).askSource("commands")) {
    if (b.caps.slash === "claude") return { commands: listSlashCommands(cwd) };
    return { commands: [], why: `${b.label} does not tell this host its slash commands` };
  }
  const got = await listFor(b, cwd, SHEET_FRESH_MS, COMMANDS_LIST_WAIT_MS);
  if ("why" in got) return { commands: [], why: got.why };
  if (!got.list.length) return { commands: [], why: `${b.label} lists no slash commands here` };
  return { commands: got.list.map(toRow) };
}

/**
 * Does `text`, typed into a session of backend `backendId`, open a VIEW (`local`) and/or start no
 * turn (`noTurn`)? The two facts `deliver/deliverrun.ts` hangs the sweep's Esc and the submit
 * proof off — asked of THE SESSION'S OWN descriptor (`delivery.isLocalCommand`/`startsNoTurn`):
 * claude's are `@waterplane/shared`'s, so claude is unchanged; a plugin's are its own (opencode
 * answers false, Copilot and Codex their measured lists), never claude's list typed at another
 * binary. Then, for a backend whose source lists its commands, the CLI's own word on that
 * command beats the static rule: `local: true` ⇒ both true (the proof is the screen moving),
 * `local: false` ⇒ both false; absent, unlisted, or no list in time ⇒ the descriptor's rule.
 * A backend this host no longer knows ⇒ neither (an ordinary prompt: a slower proof, never a
 * wrong one).
 */
export async function deliveryCommandFacts(backendId: string | undefined, cwd: string | undefined, text: string): Promise<{ local: boolean; noTurn: boolean }> {
  let b: BackendDescriptor;
  try { b = resolveBackend(backendId); } catch { return { local: false, noTurn: false }; }
  const rule = (f: (t: string) => boolean): boolean => { try { return !!f(text); } catch { return false; } };
  const local = rule(b.delivery.isLocalCommand);
  const noTurn = rule(b.delivery.startsNoTurn);
  const word = /^\/\S+/.exec(text.trim())?.[0];
  if (!word || !cwd || !derive(b).askSource("commands")) return { local, noTurn };
  const got = await listFor(b, cwd, DELIVERY_FRESH_MS, COMMANDS_DELIVERY_WAIT_MS);
  const said = "list" in got ? got.list.find((c) => c.name === word)?.local : undefined;
  return typeof said === "boolean" ? { local: said, noTurn: said } : { local, noTurn };
}
