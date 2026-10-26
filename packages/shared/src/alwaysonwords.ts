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
import { countedByThreshold, claudeWeightInput } from "./agentfiles.js";
import type { InstructionFile, InstructionReader } from "./agentfiles.js";
import { CHARS_PER_TOKEN, weighContext } from "./contextweight.js";
import { fmtCount } from "./tokens.js";
import { CARRIED_KINDS } from "./wire/alwayson.js";
import type { CarriedKind, CarriedPart, SessionCarried } from "./wire/alwayson.js";

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

/** Claude Code's every-turn chars over a set of rows, and how many sized files and unsized rows it covers. */
function claudeAlways(files: InstructionFile[]): { chars: number; files: number; unsized: number } {
  let chars = 0, n = 0, unsized = 0;
  for (const f of files) {
    if (f.unsized) { unsized++; continue; }
    const mine = f.parts.filter((p) => p.readers.includes("claude") && p.when.kind === "always");
    if (!mine.length) continue;
    n++;
    chars += mine.reduce((s, p) => s + p.chars, 0);
  }
  return { chars, files: n, unsized };
}

const unsizedWords = (n: number, where: string) =>
  n ? ` ${plural(n, "MCP server")} ${where}add tool schemas nobody can size from here.` : "";

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
    out.push(`Claude Code carries ~${fmt(tokOf(r.chars))} tokens (${fmt(r.chars)} chars) from ${plural(r.files, "repo file")} on every turn${split}.${unsizedWords(r.unsized, "")}`);
  } else if (repo.length) {
    out.push(`Claude Code carries nothing from this repo's files on every turn.${unsizedWords(r.unsized, "")}`);
  }
  const d = claudeAlways(desk);
  if (d.files) {
    out.push(`This desktop adds ~${fmt(tokOf(d.chars))} tokens (${fmt(d.chars)} chars) from ${plural(d.files, "file")} to every session, whatever the repo; the threshold row counts none of it.${unsizedWords(d.unsized, "of this desktop's ")}`);
  } else if (desk.length && d.unsized) {
    out.push(unsizedWords(d.unsized, "of this desktop's ").trim());
  }
  return out.join(" ");
}

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
  files?: { label: string; chars: number; words: string }[];
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
  }
}

const charsWords = (chars: number, fmt: Fmt) => `~${fmt(tokOf(chars))} tokens · ${fmt(chars)} chars`;

/**
 * `firstRequestTok` minus the parts' estimated tokens, clamped at 0; null without the anchor.
 * An estimate by construction (the parts are chars), so it is always worded `≈`.
 */
export function carriedRemainder(c: SessionCarried): number | null {
  if (c.firstRequestTok == null) return null;
  const sum = c.parts.reduce((n, p) => n + p.chars, 0);
  return Math.max(0, c.firstRequestTok - Math.round(sum / CHARS_PER_TOKEN));
}

/** The parts in `CarriedKind` order, then the remainder row when the first request has been answered. */
export function carriedRows(c: SessionCarried, fmt: Fmt = fmtCount): CarriedRow[] {
  const order = (k: CarriedKind) => CARRIED_KINDS.indexOf(k);
  const rows: CarriedRow[] = [...c.parts].sort((a, b) => order(a.kind) - order(b.kind)).map((p) => {
    const row: CarriedRow = { key: p.kind, label: carriedLabel(p), chars: p.chars, tok: tokOf(p.chars), words: charsWords(p.chars, fmt) };
    if (p.files) row.files = p.files.map((f) => ({ label: `${f.path} · ${f.type}`, chars: f.chars, words: charsWords(f.chars, fmt) }));
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

const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The section's lead: the whole first request, then how much of it the documented attachments
 * explain (chars, and tokens as "about"), what the undocumented snapshot adds where it was seen,
 * and what the rest is. Later deltas are counted in one sentence, never folded in.
 */
export function carriedWords(c: SessionCarried, fmt: Fmt = fmtCount): string {
  const kinds = new Set(c.parts.map((p) => p.kind));
  const documented = CARRIED_KINDS.filter((k) => kinds.has(k) && k !== "system_prompt" && k !== "tool_schemas");
  const docChars = c.parts.filter((p) => !p.undocumented && p.kind !== "system_prompt" && p.kind !== "tool_schemas").reduce((n, p) => n + p.chars, 0);
  const later = c.laterDeltas > 0
    ? ` ${c.laterDeltas} of these changed later in the conversation and ${c.laterDeltas === 1 ? "is" : "are"} not folded in.`
    : "";
  if (c.firstRequestTok == null) {
    return `No request has been answered yet; these are the attachments the CLI has written so far (chars).${later}`;
  }
  const out = [`The first request carried ${fmt(c.firstRequestTok)} tokens.`];
  if (documented.length) out.push(`About ${fmt(tokOf(docChars))} of them (${fmt(docChars)} chars) are ${andList(documented.map((k) => PART_NOUN[k]))} the CLI attached;`);
  const snap = (["system_prompt", "tool_schemas"] as const).filter((k) => kinds.has(k));
  const unknown = (["system_prompt", "tool_schemas"] as const).filter((k) => !kinds.has(k)).map((k) => PART_NOUN[k]);
  if (snap.length) {
    const said = snap.map((k) => {
      const chars = c.parts.filter((p) => p.kind === k).reduce((n, p) => n + p.chars, 0);
      return `${PART_NOUN[k]} at about ${fmt(tokOf(chars))} tokens (${fmt(chars)} chars)`;
    });
    out.push(`${documented.length ? "an" : "An"} undocumented record puts ${andList(said)};`);
  }
  out.push(`${out[out.length - 1].endsWith(";") ? "the" : "The"} rest is ${andList([...unknown, "your prompt"])}.`);
  return out.join(" ") + later;
}
