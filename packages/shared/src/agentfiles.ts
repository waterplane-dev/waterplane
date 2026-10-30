/**
 * Every agent-instruction file in a folder, with WHO reads it and WHEN — one inventory for the
 * host's `context-weight` row, the phone that words it and the VS Code extension's Always-on view,
 * so the three cannot count a folder differently. Claude Code and GitHub Copilot overlap: both read
 * CLAUDE.md and `.claude/skills`, only Copilot reads AGENTS.md and `.github/…`, only Claude
 * expands a CLAUDE.md `@path` import. One file, one row, its readers named.
 *
 * Copilot's rules are VS Code's documented ones (code.visualstudio.com/docs/copilot/customization,
 * read 2026-10-20):
 *   .github/copilot-instructions.md          every request (github.copilot.chat.codeGeneration.useInstructionFiles)
 *   AGENTS.md at the root                    every request (chat.useAgentsMdFile); nested ones are off by default
 *   CLAUDE.md, .claude/CLAUDE.md             every request (chat.useClaudeMdFile)
 *   .github/instructions/**\/*.instructions.md  `applyTo` glob: attached when a matching file is touched;
 *                                            `description`: loaded when it matches the task, so the
 *                                            description is carried and the body is on demand
 *   .claude/rules/**\/*.md                   `paths` globs, defaulting to `**` (= every request) — Claude Code too
 *   .github/skills, .claude/skills, .agents/skills  name + description always, body on demand
 *
 * Copilot counts only where the folder has a file of Copilot's own (`isCopilotFile`); a Claude-only
 * repo is not weighed for it.
 *
 * A setting the person turned OFF drops Copilot from that row's readers (said in the row); one
 * that is unset or unknown (the host cannot see VS Code's settings) is not second-guessed.
 *
 * Pure: the caller hands in a synchronous reader over the folder (`AgentFilesFs`).
 */
import { CHARS_PER_TOKEN, frontmatterLines, skillDescChars } from "./contextweight.js";
import type { ContextWeightInput, SkillWeight } from "./contextweight.js";
import { wordOf } from "./wordof.js";

export type InstructionReader = "claude" | "copilot";

/** When a file reaches the model. `scoped` carries the globs; `on-demand` covers bodies, prompts and manual attaches. */
export type InstructionWhen = { kind: "always" } | { kind: "scoped"; globs: string[] } | { kind: "on-demand" };

export interface InstructionPart {
  /** Agents that load this part under `when`. Empty = nobody does (a setting is off). */
  readers: InstructionReader[];
  when: InstructionWhen;
  chars: number;
}

export interface InstructionFile {
  /** Folder-relative, `/`-separated. */
  path: string;
  /** What the file is, in two or three words ("Copilot instructions", "skill", "rule"). */
  kind: string;
  /** Usually one part; a skill or a described instruction file has its description (always) and body (on demand). */
  parts: InstructionPart[];
  /** A Copilot setting that is off and so dropped Copilot from this row, by name. */
  off?: string;
  /** `"desktop"`: a row this desktop adds to every session whatever the repo (`desktopInventory`). Absent = the folder's own. */
  scope?: "desktop";
  /**
   * Set when the row's weight cannot be known from a file (an MCP server's tool schemas arrive when
   * it connects): the sentence why. Such a row has no parts and is NEVER counted as 0.
   */
  unsized?: string;
}

export interface InstructionTotals { always: number; scoped: number; onDemand: number; files: number }

/** The VS Code settings that switch a family of files off for Copilot; false = off, absent = not known. */
export interface CopilotSwitches {
  instructionFiles?: boolean; agentsMd?: boolean; claudeMd?: boolean;
  /** `chat.useAgentSkills`: skills in `.claude/skills`, `.github/skills`, `.agents/skills`. */
  skills?: boolean;
  /** `chat.includeApplyingInstructions`: `.instructions.md` files attached by their `applyTo`. */
  applyingInstructions?: boolean;
}

/** Two always-on files one agent carries both of, repeating each other. */
export interface InstructionOverlap { a: string; b: string; chars: number; ofSmaller: number; readers: InstructionReader[] }

/** A synchronous view of one folder; paths are folder-relative and `/`-separated. Null / [] = absent. */
export interface AgentFilesFs {
  read(rel: string): string | null;
  list(relDir: string): { name: string; dir: boolean }[];
}

export interface InstructionInventory { files: InstructionFile[]; overlaps: InstructionOverlap[] }

export const READER_NAME: Record<InstructionReader, string> = { claude: "Claude Code", copilot: "Copilot" };

/** The YAML frontmatter as raw lines, or null. Only flat keys and simple lists are read. */
function frontmatter(text: string): string[] | null {
  return frontmatterLines(text);
}

/** A key's value as globs: `k: "a, b"`, `k: [a, b]`, or a `- a` list under `k:`. Null when the key is absent. */
export function fmGlobs(text: string, key: string): string[] | null {
  const lines = frontmatter(text);
  if (!lines) return null;
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return null;
  const unq = (s: string) => s.trim().replace(/^['"]|['"]$/g, "").trim();
  const rest = lines[i].slice(key.length + 1).trim();
  if (rest) {
    const inner = rest.startsWith("[") ? rest.replace(/^\[|\]$/g, "") : unq(rest);
    return inner.split(",").map(unq).filter(Boolean);
  }
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j++) out.push(unq(lines[j].replace(/^\s*-\s/, "")));
  return out;
}

const EVERYTHING = new Set(["**", "**/*", "*", "/**", "./**"]);

/** Globs that match every file are every request, not a scope. */
function whenOf(globs: string[]): InstructionWhen {
  return globs.some((g) => EVERYTHING.has(g)) ? { kind: "always" } : { kind: "scoped", globs };
}

/**
 * A `.github/instructions` file for Copilot: `applyTo` decides the body; a `description` alone
 * is carried every request and the body follows on demand; neither = attached by hand only.
 */
export function classifyInstructions(text: string, readers: InstructionReader[]): InstructionPart[] {
  const apply = fmGlobs(text, "applyTo");
  const desc = skillDescChars(text);
  if (apply && apply.length) return [{ readers, when: whenOf(apply), chars: text.length }];
  if (desc > 0) return [{ readers, when: { kind: "always" }, chars: desc }, { readers, when: { kind: "on-demand" }, chars: Math.max(0, text.length - desc) }];
  return [{ readers, when: { kind: "on-demand" }, chars: text.length }];
}

/** A `.claude/rules` file: `paths` globs, defaulting to `**`. */
export function classifyRule(text: string, readers: InstructionReader[]): InstructionPart[] {
  const paths = fmGlobs(text, "paths");
  return [{ readers, when: paths && paths.length ? whenOf(paths) : { kind: "always" }, chars: text.length }];
}

/** A skill: description always, the rest on demand. */
export function classifySkill(text: string, readers: InstructionReader[]): InstructionPart[] {
  const desc = skillDescChars(text);
  return [{ readers, when: { kind: "always" }, chars: desc }, { readers, when: { kind: "on-demand" }, chars: Math.max(0, text.length - desc) }];
}

/**
 * `@path` imports in a CLAUDE.md, folder-relative — Claude Code inlines them on every turn
 * (`@AGENTS.md` is the usual way one file serves both agents). Code spans and fences are not imports.
 */
export function claudeImports(text: string): string[] {
  const body = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = new Set<string>();
  for (const m of body.matchAll(/(?:^|\s)@((?:\.{0,2}\/)?[\w.\-/]+\.[\w]+)/g)) {
    // Home and absolute paths are the person's own files, and `..` leaves the folder: neither is this folder's weight.
    if (m[1].startsWith("~") || m[1].startsWith("/") || m[1].split("/").includes("..")) continue;
    out.add(m[1].replace(/^\.\//, ""));
  }
  return [...out];
}

const without = (rs: InstructionReader[], a: InstructionReader, off: boolean | undefined): InstructionReader[] => (off === false ? rs.filter((r) => r !== a) : rs);

function walk(fs: AgentFilesFs, dir: string, keep: (name: string) => boolean, depth = 4): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of [...fs.list(dir)].sort((a, b) => a.name.localeCompare(b.name))) {
    const p = `${dir}/${e.name}`;
    if (e.dir) out.push(...walk(fs, p, keep, depth - 1));
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

/** A file only Copilot's world writes: AGENTS.md, anything under `.github/` or `.agents/`. */
export const isCopilotFile = (path: string): boolean => path === "AGENTS.md" || path.startsWith(".github/") || path.startsWith(".agents/");

/** The kind word of a file only CLAUDE.local.md imports. */
const LOCAL_IMPORT = "imported by CLAUDE.local.md";

/** Why an MCP server row carries no number. */
export const MCP_UNSIZED = "its tool schemas are sent by the server when it connects — not measurable from the file";

/** Every instruction file in the folder, in a fixed order (always-on families first), and the repeats between them. */
export function instructionInventory(fs: AgentFilesFs, sw: CopilotSwitches = {}): InstructionInventory {
  const files: InstructionFile[] = [];
  const text = new Map<string, string>();
  const offWord = (v: boolean | undefined, name: string) => (v === false ? { off: name } : {});
  const add = (f: InstructionFile, t: string) => { if (!text.has(f.path)) { text.set(f.path, t); files.push(f); } };

  const claudeMds: string[] = [];
  for (const p of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    const t = fs.read(p);
    if (t == null) continue;
    claudeMds.push(t);
    add({ path: p, kind: "CLAUDE.md", parts: [{ readers: without(["claude", "copilot"], "copilot", sw.claudeMd), when: { kind: "always" }, chars: t.length }], ...offWord(sw.claudeMd, "chat.useClaudeMdFile") }, t);
  }
  // CLAUDE.local.md: the person's own, gitignored, Claude Code reads it every turn beside CLAUDE.md.
  const local = fs.read("CLAUDE.local.md");
  if (local != null) {
    add({ path: "CLAUDE.local.md", kind: "CLAUDE.local.md", parts: [{ readers: ["claude"], when: { kind: "always" }, chars: local.length }] }, local);
  }
  const imports = new Set(claudeMds.flatMap(claudeImports));
  // What only CLAUDE.local.md imports is the person's, like the file itself (D1: listed, not weighed).
  const localImports = new Set(local == null ? [] : claudeImports(local).filter((p) => !imports.has(p)));
  const importer = (p: string) => (localImports.has(p) ? LOCAL_IMPORT : "imported by CLAUDE.md");
  const agentsMd = fs.read("AGENTS.md");
  if (agentsMd != null) {
    const readers = without(["copilot"], "copilot", sw.agentsMd);
    const imported = imports.has("AGENTS.md") || localImports.has("AGENTS.md");
    if (imported) readers.unshift("claude");
    add({ path: "AGENTS.md", kind: imported ? `AGENTS.md, ${importer("AGENTS.md")}` : "AGENTS.md", parts: [{ readers, when: { kind: "always" }, chars: agentsMd.length }], ...offWord(sw.agentsMd, "chat.useAgentsMdFile") }, agentsMd);
  }
  for (const imp of [...imports, ...localImports]) {
    if (imp === "AGENTS.md" || text.has(imp)) continue;
    const t = fs.read(imp);
    if (t != null) add({ path: imp, kind: importer(imp), parts: [{ readers: ["claude"], when: { kind: "always" }, chars: t.length }] }, t);
  }
  const ci = fs.read(".github/copilot-instructions.md");
  if (ci != null) {
    add({ path: ".github/copilot-instructions.md", kind: "Copilot instructions", parts: [{ readers: without(["copilot"], "copilot", sw.instructionFiles), when: { kind: "always" }, chars: ci.length }], ...offWord(sw.instructionFiles, "github.copilot.chat.codeGeneration.useInstructionFiles") }, ci);
  }
  for (const p of walk(fs, ".github/instructions", (n) => n.endsWith(".instructions.md"))) {
    const t = fs.read(p);
    if (t == null) continue;
    const applies = (fmGlobs(t, "applyTo") ?? []).length > 0;
    const off = applies && sw.applyingInstructions === false;
    add({ path: p, kind: "instructions", parts: classifyInstructions(t, off ? [] : ["copilot"]), ...(off ? { off: "chat.includeApplyingInstructions" } : {}) }, t);
  }
  for (const p of walk(fs, ".claude/rules", (n) => n.endsWith(".md"))) {
    const t = fs.read(p);
    if (t != null) add({ path: p, kind: "rule", parts: classifyRule(t, ["claude", "copilot"]) }, t);
  }
  const skillDirs: [string, InstructionReader[]][] = [[".claude/skills", ["claude", "copilot"]], [".github/skills", ["copilot"]], [".agents/skills", ["copilot"]]];
  for (const [dir, readers] of skillDirs) {
    for (const e of [...fs.list(dir)].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.dir) continue;
      const p = `${dir}/${e.name}/SKILL.md`;
      const t = fs.read(p);
      if (t == null) continue;
      // A skill with no description read is not a quiet 0: the row says the frontmatter had none.
      const kind = skillDescChars(t) > 0 ? "skill" : "skill — no description found in its frontmatter";
      add({ path: p, kind, parts: classifySkill(t, without(readers, "copilot", sw.skills)), ...offWord(sw.skills, "chat.useAgentSkills") }, t);
    }
  }
  // Subagent definitions: Claude Code lists each one's description to the model every turn; the
  // body is the subagent's own prompt, sent only when it runs (as `instructionFileWeight` says).
  for (const p of walk(fs, ".claude/agents", (n) => n.endsWith(".md"), 0)) {
    const t = fs.read(p);
    if (t != null) add({ path: p, kind: "subagent", parts: classifySkill(t, ["claude"]) }, t);
  }
  // `.mcp.json`: the server NAMES are knowable, their weight is not — each server sends its tool
  // schemas when it connects. A row per server with no number; never 0, never a guess.
  const mcp = fs.read(".mcp.json");
  if (mcp != null) {
    let names: string[] | null = null;
    try {
      const j = JSON.parse(mcp) as { mcpServers?: unknown };
      const servers = j && typeof j === "object" ? j.mcpServers : undefined;
      names = servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
    } catch { names = null; }
    if (names == null) {
      files.push({ path: ".mcp.json", kind: ".mcp.json (unreadable)", parts: [], unsized: "the file is not valid JSON, so its servers could not be read" });
    } else {
      for (const name of names) files.push({ path: ".mcp.json", kind: `MCP server ${name}`, parts: [], unsized: MCP_UNSIZED });
    }
  }
  // Copilot also reads CLAUDE.md and `.claude/skills`, but a repo with no file of Copilot's own is
  // not one anybody drives with Copilot: counting it there put a Copilot sentence on every Claude
  // repo. Without such a file, Copilot is nobody's reader here.
  if (!files.some((f) => isCopilotFile(f.path))) {
    for (const f of files) for (const p of f.parts) p.readers = p.readers.filter((r) => r !== "copilot");
  }
  return { files, overlaps: overlapsOf(files, text) };
}

/** One agent's share of the inventory: what it carries every request, when a file matches, and on demand. */
export function instructionTotals(files: InstructionFile[], agent: InstructionReader): InstructionTotals {
  const t: InstructionTotals = { always: 0, scoped: 0, onDemand: 0, files: 0 };
  for (const f of files) {
    const mine = f.parts.filter((p) => p.readers.includes(agent));
    if (!mine.length) continue;
    t.files++;
    for (const p of mine) {
      if (p.when.kind === "always") t.always += p.chars;
      else if (p.when.kind === "scoped") t.scoped += p.chars;
      else t.onDemand += p.chars;
    }
  }
  return t;
}

/** Lines shorter than this are headings, rules and blank-ish filler: repeating them is not a cost worth naming. */
const MIN_LINE = 24;

/** The characters of `b`'s lines that also stand in `a`, whitespace-normalised, each distinct line once. */
export function sharedChars(a: string, b: string): number {
  const norm = (t: string) => t.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l.length >= MIN_LINE);
  const inA = new Set(norm(a));
  let n = 0;
  for (const l of new Set(norm(b))) if (inA.has(l)) n += l.length;
  return n;
}

/** Below both of these a shared line or two is a coincidence, not a copy. */
const OVERLAP_MIN_CHARS = 200;

/**
 * Every pair of whole files that ONE agent carries every request and that repeat each other —
 * the copy a migration leaves (Copilot's AGENTS.md pasted into a new CLAUDE.md, both still read).
 * A fact to state, never a verdict: which file to keep is the person's call.
 */
function overlapsOf(files: InstructionFile[], text: Map<string, string>): InstructionOverlap[] {
  const whole = files.filter((f) => f.parts.length === 1 && f.parts[0].when.kind === "always" && f.parts[0].readers.length);
  const out: InstructionOverlap[] = [];
  for (let i = 0; i < whole.length; i++) {
    for (let j = i + 1; j < whole.length; j++) {
      const a = whole[i], b = whole[j];
      const both = a.parts[0].readers.filter((r) => b.parts[0].readers.includes(r));
      const ta = text.get(a.path), tb = text.get(b.path);
      if (!both.length || ta == null || tb == null) continue;
      const chars = sharedChars(ta, tb);
      if (chars < OVERLAP_MIN_CHARS) continue;
      out.push({ a: a.path, b: b.path, chars, ofSmaller: chars / Math.min(ta.length, tb.length), readers: both });
    }
  }
  return out;
}

/**
 * Whether the threshold reading (`claudeWeightInput` → `weighContext(...).alwaysOnChars`) counts
 * this row. D1 (always-on plan, 2026-10-26): the threshold keeps measuring what it always measured.
 * Subagent descriptions, CLAUDE.local.md and what only it imports (gitignored — the working tree
 * would drift from the commit the repo-health series weighs) and unsized rows are LISTED with their
 * own figures, never folded in; desktop rows are not this repo's weight at all.
 */
export function countedByThreshold(f: InstructionFile): boolean {
  return !(f.unsized || f.scope === "desktop" || f.kind === "subagent" || f.kind === "CLAUDE.local.md" || f.kind.endsWith(LOCAL_IMPORT));
}

/**
 * Claude Code's half as `weighContext`'s input: what it carries every turn apart from skill
 * descriptions (CLAUDE.md, its imports, unscoped rules) and its skills. The one place the
 * inventory and the threshold reading meet, so the host and the extension feed it alike.
 */
export function claudeWeightInput(files: InstructionFile[]): ContextWeightInput {
  const skills: SkillWeight[] = [];
  let claudeMdChars = 0;
  for (const f of files) {
    // D1: see `countedByThreshold`.
    if (!countedByThreshold(f)) continue;
    const mine = f.parts.filter((p) => p.readers.includes("claude"));
    if (!mine.length) continue;
    if (f.kind === "skill") {
      skills.push({ name: f.path.split("/").slice(-2)[0], descChars: mine[0].chars, bodyChars: mine.reduce((n, p) => n + p.chars, 0) });
    } else {
      for (const p of mine) if (p.when.kind === "always") claudeMdChars += p.chars;
    }
  }
  return { claudeMdChars, skills };
}

/** One repeat, said: the two files, what they share, who carries both — and for the migration case, how one copy serves both agents. */
export function overlapWords(o: InstructionOverlap, fmt: (n: number) => string = String): string {
  const who = o.readers.map((r) => wordOf(READER_NAME, r, r)).join(" and ");
  const pair = new Set([o.a, o.b]);
  const fix = pair.has("CLAUDE.md") && pair.has("AGENTS.md")
    ? " One copy is enough: keep the text in AGENTS.md and let CLAUDE.md be the single line @AGENTS.md, which Claude Code inlines."
    : "";
  return `${o.a} and ${o.b} repeat ${fmt(o.chars)} characters (${Math.round(o.ofSmaller * 100)}% of the smaller one), and ${who} ${o.readers.length === 1 ? "carries" : "carry"} both on every request, so those lines are sent twice.${fix}`;
}

/**
 * Copilot's share, said: what it carries every request, what joins when a file matches, and why
 * the figure is about room rather than money. Null when Copilot reads nothing here.
 */
export function copilotWeightWords(t: InstructionTotals, fmt: (n: number) => string = String): string | null {
  if (!t.files) return null;
  const scoped = t.scoped ? `, plus ${fmt(t.scoped)} characters when a matching file is touched` : "";
  return `Copilot carries ~${fmt(Math.round(t.always / CHARS_PER_TOKEN))} tokens (${fmt(t.always)} characters) from ${t.files} ${t.files === 1 ? "file" : "files"} here on every request${scoped}. Copilot bills per request, not per token, so this costs context room, not money.`;
}

/** One instruction file's weight as the file viewer states it: the whole, and the share that rides every turn. */
export interface InstructionFileWeight { kind: string; chars: number; always: number; scoped: number; onDemand: number }

/**
 * The weight of ONE file opened on its own, recognised by its name and folder — the viewer has no
 * inventory, and a SKILL.md or CLAUDE.md is the same file under any root. Null for anything else.
 * Whole-file kinds (CLAUDE.md, AGENTS.md, …) count as always-on; a skill, subagent or command
 * carries its description every turn and its body when used.
 */
export function instructionFileWeight(path: string, text: string): InstructionFileWeight | null {
  const p = path.replace(/\\/g, "/");
  const name = p.split("/").pop() ?? p;
  let kind: string;
  let parts: InstructionPart[];
  if (["CLAUDE.md", "AGENTS.md", "GEMINI.md", "copilot-instructions.md"].includes(name)) {
    kind = name === "copilot-instructions.md" ? "Copilot instructions" : name;
    parts = [{ readers: [], when: { kind: "always" }, chars: text.length }];
  } else if (name === "SKILL.md") { kind = "skill"; parts = classifySkill(text, []); }
  else if (name.endsWith(".instructions.md")) { kind = "instructions"; parts = classifyInstructions(text, []); }
  else if (/(^|\/)\.claude\/rules\/.+\.md$/.test(p)) { kind = "rule"; parts = classifyRule(text, []); }
  else if (/(^|\/)\.claude\/agents\/[^/]+\.md$/.test(p)) { kind = "subagent"; parts = classifySkill(text, []); }
  else if (/(^|\/)\.claude\/commands\/.+\.md$/.test(p)) { kind = "command"; parts = classifySkill(text, []); }
  else return null;
  const w: InstructionFileWeight = { kind, chars: text.length, always: 0, scoped: 0, onDemand: 0 };
  for (const part of parts) {
    if (part.when.kind === "always") w.always += part.chars;
    else if (part.when.kind === "scoped") w.scoped += part.chars;
    else w.onDemand += part.chars;
  }
  return w;
}

/** `~740 tokens · 2,950 chars`, then the split: what rides every turn and what waits. Never the total alone. */
export function instructionFileWeightWords(w: InstructionFileWeight, fmt: (n: number) => string = String): string {
  const tok = (c: number) => `~${fmt(Math.round(c / CHARS_PER_TOKEN))} tokens`;
  const head = `${tok(w.chars)} · ${fmt(w.chars)} chars`;
  if (w.always === w.chars) return `${head}, all of it every turn`;
  const split: string[] = [];
  if (w.always) split.push(`${tok(w.always)} every turn`);
  if (w.scoped) split.push(`${tok(w.scoped)} when a matching file is touched`);
  if (w.onDemand) split.push(`${tok(w.onDemand)} only when used`);
  return split.length ? `${head} (${split.join(", ")})` : head;
}
