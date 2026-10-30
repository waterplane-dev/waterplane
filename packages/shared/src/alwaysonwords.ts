/**
 * The rows and sentences of the always-on context feature, worded ONCE for the phone and the
 * VS Code extension: what a repo and this desktop put in every turn (`alwaysOnRows`,
 * `alwaysOnTotalsWords`) and what one conversation's first request carried (`carriedRows`,
 * `carriedWords`, `carriedRemainder`).
 *
 * Rules (CLAUDE.md, skill `web-numbers`): a total is never said without its split; chars are the
 * fact and tokens per part are an estimate, always worded `~`/"about"; an unsized row is NAMED,
 * never counted as 0; nothing here refuses or applies anything.
 */
import { countedByThreshold, claudeWeightInput, MCP_UNSIZED } from "./agentfiles.js";
import type { InstructionFile, InstructionReader } from "./agentfiles.js";
import { CHARS_PER_TOKEN, weighContext } from "./contextweight.js";
import { fmtCount } from "./tokens.js";
import { CARRIED_KINDS } from "./wire/alwayson.js";
import type { CarriedKind, CarriedPart, SessionCarried } from "./wire/alwayson.js";
import { wordOf } from "./wordof.js";

type Fmt = (n: number) => string;
const tokOf = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── per repo + per desktop, statically ──

export interface AlwaysOnRow {
  path: string;
  kind: string;
  scope: "repo" | "desktop";
  /** Who reads any part of it. */
  readers: InstructionReader[];
  /** Chars sent every turn / when a matching file is touched / on demand. Null on an unsized row — never 0. */
  always: number | null;
  scoped: number | null;
  onDemand: number | null;
  /** Why this row has no number (an MCP server). */
  unsized?: string;
  /** Whether the threshold reading (the `context-weight` row) counts it — D1, `countedByThreshold`. */
  counted: boolean;
  /** A Copilot setting that dropped Copilot from the row. */
  off?: string;
}

/** One row per inventory row, in the inventory's order. */
export function alwaysOnRows(files: InstructionFile[]): AlwaysOnRow[] {
  return files.map((f) => {
    const readers = [...new Set(f.parts.flatMap((p) => p.readers))];
    const sum = (k: "always" | "scoped" | "on-demand") => (f.unsized ? null : f.parts.filter((p) => p.when.kind === k).reduce((n, p) => n + p.chars, 0));
    const row: AlwaysOnRow = {
      path: f.path, kind: f.kind, scope: f.scope ?? "repo", readers,
      always: sum("always"), scoped: sum("scoped"), onDemand: sum("on-demand"),
      counted: countedByThreshold(f) && readers.includes("claude"),
    };
    if (f.unsized) row.unsized = f.unsized;
    if (f.off) row.off = f.off;
    return row;
  });
}

/**
 * Claude Code's every-turn chars over a set of rows, how many sized files that is, how many MCP
 * servers send schemas nobody can size, and how many other rows have no number (a plugin pack not
 * on disk, a source that could not be read, a server declined here) — never called servers.
 */
function claudeAlways(files: InstructionFile[]): { chars: number; files: number; servers: number; other: number } {
  let chars = 0, n = 0, servers = 0, other = 0;
  for (const f of files) {
    if (f.unsized) { if (f.unsized === MCP_UNSIZED) servers++; else other++; continue; }
    const mine = f.parts.filter((p) => p.readers.includes("claude") && p.when.kind === "always");
    if (!mine.length) continue;
    n++;
    chars += mine.reduce((s, p) => s + p.chars, 0);
  }
  return { chars, files: n, servers, other };
}

const unsizedWords = (c: { servers: number; other: number }, where: string) =>
  (c.servers ? ` ${plural(c.servers, "MCP server")} ${where}add tool schemas nobody can size from here.` : "")
  + (c.other ? ` ${plural(c.other, "more row")} ${c.other === 1 ? "has" : "have"} no size here; each says why.` : "");

/**
 * The list's lead: what Claude Code carries every turn from the repo's files, how much of that
 * the threshold row counts (and which families), then this desktop's rows the same way. The total
 * never stands without the split; unsized rows are counted by name, never as 0.
 */
export function alwaysOnTotalsWords(files: InstructionFile[], fmt: Fmt = fmtCount): string {
  const repo = files.filter((f) => f.scope !== "desktop");
  const desk = files.filter((f) => f.scope === "desktop");
  const out: string[] = [];
  const r = claudeAlways(repo);
  if (r.files) {
    const counted = weighContext(claudeWeightInput(repo)).alwaysOnChars;
    const listed = r.chars - counted;
    const split = listed > 0
      ? `; the threshold row counts ${fmt(counted)} of those (CLAUDE.md, its imports, rules, skill descriptions), the other ${fmt(listed)} are listed beside it (CLAUDE.local.md, subagent descriptions)`
      : "; the threshold row counts all of them (CLAUDE.md, its imports, rules, skill descriptions)";
    out.push(`Claude Code carries ~${fmt(tokOf(r.chars))} tokens (${fmt(r.chars)} chars) from ${plural(r.files, "repo file")} on every turn${split}.${unsizedWords(r, "")}`);
  } else if (repo.length) {
    out.push(`Claude Code carries nothing from this repo's files on every turn.${unsizedWords(r, "")}`);
  }
  const d = claudeAlways(desk);
  if (d.files) {
    out.push(`This desktop adds ~${fmt(tokOf(d.chars))} tokens (${fmt(d.chars)} chars) from ${plural(d.files, "file")} to every session, whatever the repo; the threshold row counts none of it.${unsizedWords(d, "of this desktop's ")}`);
  } else if (desk.length && (d.servers || d.other)) {
    out.push(unsizedWords(d, "of this desktop's ").trim());
  }
  return out.join(" ");
}

/** The CLI config dir as words when the reader did not say (`RepoInstructionsDoc.configDir` absent: an older host). */
export const DEFAULT_CONFIG_DIR_WORDS = "~/.claude";

/**
 * A desktop row's path as words, ONE rule for the phone and VS Code: a config-dir-relative path gets
 * the config dir in front; a `~` or absolute path (`~/.claude.json`, a plugin installed elsewhere)
 * is already words; the managed-plugins row has no path at all.
 */
export function desktopPathWords(p: string, configDirWords: string = DEFAULT_CONFIG_DIR_WORDS): string {
  if (!p) return "not on disk";
  if (p.startsWith("~") || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) return p;
  return `${configDirWords.replace(/[\\/]+$/, "")}/${p}`;
}

/** Whether an unsized row is an MCP server whose schemas arrive at connect time (the When column says "every request" only for those). */
export const isUnsizedServer = (f: { unsized?: string }): boolean => f.unsized === MCP_UNSIZED;

// ── per session, measured ──

export interface CarriedRow {
  key: CarriedKind | "remainder";
  label: string;
  /** The fact. Null on the remainder row, which is tokens by subtraction. */
  chars: number | null;
  /** About this many tokens: chars / CHARS_PER_TOKEN, or the remainder's subtraction. Always an estimate. */
  tok: number;
  /** `~4.3k tokens · 17.2k chars`, or `≈5k tokens` for the remainder. */
  words: string;
  /** `instructions` only: one sub-row per file, `~/.claude/CLAUDE.md · User`. */
  files?: { label: string; path: string; type: string; chars: number; words: string }[];
  names?: string[];
  undocumented?: true;
}

export const CARRIED_REMAINDER_LABEL =
  "everything else in the first request: your prompt, and whatever the harness sent that the log does not record (≈)";

const UNDOC = "(undocumented record)";

function carriedLabel(p: CarriedPart): string {
  const n = p.count;
  switch (p.kind) {
    case "instructions": return "instruction files";
    case "skill_listing": return n != null ? `skill listing (${plural(n, "skill")})` : "skill listing";
    case "mcp_instructions": return n != null ? `MCP instructions (${plural(n, "server")})` : "MCP instructions";
    case "deferred_tools": return n != null ? `deferred tool names (${n})` : "deferred tool names";
    case "agent_listing": return n != null ? `subagent listing (${n})` : "subagent listing";
    case "hook_context": return n != null && n > 1 ? `hook context (${n})` : "hook context";
    case "system_prompt": return `system prompt ${UNDOC}`;
    case "tool_schemas": return `tool schemas ${UNDOC}`;
    // `kind` is the host's reading of the CLI's log: a kind a newer host
    // names reaches an older phone with no case for it.
    default: return "a part this app version cannot name";
  }
}

const charsWords = (chars: number, fmt: Fmt) => `~${fmt(tokOf(chars))} tokens · ${fmt(chars)} chars`;

const partsTok = (c: SessionCarried) => Math.round(c.parts.reduce((n, p) => n + p.chars, 0) / CHARS_PER_TOKEN);

/**
 * `firstRequestTok` minus the parts' estimated tokens; null without the anchor, and null — never 0 —
 * when the estimate already exceeds the request (JSON schemas tokenise denser than ~4 chars a token,
 * so a tool-heavy request can overshoot): the remainder then cannot be placed, and `carriedWords`
 * says so. An estimate by construction (the parts are chars), so it is always worded `≈`.
 */
export function carriedRemainder(c: SessionCarried): number | null {
  if (c.firstRequestTok == null) return null;
  const rest = c.firstRequestTok - partsTok(c);
  return rest >= 0 ? rest : null;
}

/** The sentence beside a remainder that could not be placed. */
export const CARRIED_REMAINDER_UNPLACED =
  "The parts' estimate already exceeds the request, so the rest (your prompt among it) cannot be placed.";

/** The parts in `CarriedKind` order, then the remainder row when the first request has been answered and the remainder could be placed (`carriedRemainder`). */
export function carriedRows(c: SessionCarried, fmt: Fmt = fmtCount): CarriedRow[] {
  const order = (k: CarriedKind) => CARRIED_KINDS.indexOf(k);
  const rows: CarriedRow[] = [...c.parts].sort((a, b) => order(a.kind) - order(b.kind)).map((p) => {
    const row: CarriedRow = { key: p.kind, label: carriedLabel(p), chars: p.chars, tok: tokOf(p.chars), words: charsWords(p.chars, fmt) };
    if (p.files) row.files = p.files.map((f) => ({ label: `${f.path} · ${f.type}`, path: f.path, type: f.type, chars: f.chars, words: charsWords(f.chars, fmt) }));
    if (p.names) row.names = p.names;
    if (p.undocumented) row.undocumented = true;
    return row;
  });
  const rest = carriedRemainder(c);
  if (rest != null) rows.push({ key: "remainder", label: CARRIED_REMAINDER_LABEL, chars: null, tok: rest, words: `≈${fmt(rest)} tokens` });
  return rows;
}

const PART_NOUN: Record<CarriedKind, string> = {
  instructions: "the instruction files",
  skill_listing: "the skill listing",
  mcp_instructions: "MCP instructions",
  deferred_tools: "deferred tool names",
  agent_listing: "the subagent listing",
  hook_context: "hook context",
  system_prompt: "the system prompt",
  tool_schemas: "tool schemas",
};
/** `laterKinds` are the host's, so a kind this build lacks is still a noun. */
const partNoun = (k: string): string => wordOf(PART_NOUN, k, "a part this app version cannot name");

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The section's lead: the whole first request, then how much of it the documented attachments
 * explain (chars, and tokens as "about"), what the undocumented snapshot adds where it was seen,
 * and what the rest is. Later deltas are counted in one sentence, never folded in.
 * `unplacedShown`: the caller draws `CARRIED_REMAINDER_UNPLACED`'s fact itself (the phone's strip
 * caption), so the lead leaves it out rather than saying it twice.
 */
export function carriedWords(c: SessionCarried, fmt: Fmt = fmtCount, opts: { unplacedShown?: boolean } = {}): string {
  const kinds = new Set(c.parts.map((p) => p.kind));
  const documented = CARRIED_KINDS.filter((k) => kinds.has(k) && k !== "system_prompt" && k !== "tool_schemas");
  const docChars = c.parts.filter((p) => !p.undocumented && p.kind !== "system_prompt" && p.kind !== "tool_schemas").reduce((n, p) => n + p.chars, 0);
  const named = (c.laterKinds ?? []).filter((k) => k in PART_NOUN);
  const later = named.length
    ? ` ${capital(andList(named.map((k) => partNoun(k))))} changed later in the conversation; the change is not folded in.`
    : c.laterDeltas > 0
      ? ` ${c.laterDeltas === 1 ? "One kind" : `${c.laterDeltas} kinds`} of these changed later in the conversation; the change is not folded in.`
      : "";
  if (c.firstRequestTok == null) {
    return `No request has been answered yet; these are the attachments the CLI has written so far (chars).${later}`;
  }
  const out = [`The first request carried ${fmt(c.firstRequestTok)} tokens.`];
  if (documented.length) out.push(`About ${fmt(tokOf(docChars))} of them (${fmt(docChars)} chars) are ${andList(documented.map((k) => partNoun(k)))} the CLI attached;`);
  const snap = (["system_prompt", "tool_schemas"] as const).filter((k) => kinds.has(k));
  const unknown = (["system_prompt", "tool_schemas"] as const).filter((k) => !kinds.has(k)).map((k) => partNoun(k));
  if (snap.length) {
    const said = snap.map((k) => {
      const chars = c.parts.filter((p) => p.kind === k).reduce((n, p) => n + p.chars, 0);
      return `${partNoun(k)} at about ${fmt(tokOf(chars))} tokens (${fmt(chars)} chars)`;
    });
    out.push(`${documented.length ? "an" : "An"} undocumented record puts ${andList(said)};`);
  }
  const lead = out[out.length - 1].endsWith(";");
  if (carriedRemainder(c) == null) {
    if (!opts.unplacedShown) out.push(lead ? CARRIED_REMAINDER_UNPLACED.replace(/^The/, "the") : CARRIED_REMAINDER_UNPLACED);
    else if (lead) out[out.length - 1] = out[out.length - 1].replace(/;$/, ".");
  }
  else out.push(`${lead ? "the" : "The"} rest is ${andList([...unknown, "your prompt with what the harness added to it"])}.`);
  return out.join(" ") + later;
}
