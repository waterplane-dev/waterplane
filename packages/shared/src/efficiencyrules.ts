// The generic efficiency rules: how an agent keeps a session cheap and recoverable, worded with no
// product name, route or variable in them, so any repo can carry them in its own CLAUDE.md or
// AGENTS.md. ONE copy: the host's repo-facing skill (`host/src/reposkilltext.ts`) builds its
// matching bullets from these bodies, and the Setup check's `repo.efficiency-rules` write puts
// the block below into the repo's instruction file.
//
// The write never overwrites typed words: a block whose inside is not byte-equal to a version this
// code shipped is somebody's edit, and `planEfficiencyWrite` refuses it with a sentence.

export interface EfficiencyRule {
  id: "terse" | "batch" | "resumable" | "subagents" | "max-turns";
  /** The bold lead in the block's bullet. */
  lead: string;
  /** The rule itself; the repo-facing skill puts its own framing in front of it. */
  body: string;
}

export const EFFICIENCY_RULES: readonly EfficiencyRule[] = [
  {
    id: "terse",
    lead: "Keep output short.",
    body: "Say the conclusion in a few lines. Put anything bigger (a report, a table, a long diff, a screenshot) in a file and name its path, rather than printing it.",
  },
  {
    id: "batch",
    lead: "Batch your questions.",
    body: "A question can wait hours for an answer. Ask your questions together, at the end of what you can do without the answer, and never block on a choice you could make and report.",
  },
  {
    id: "resumable",
    lead: "Keep work resumable.",
    body: "A session can stop at any time and be resumed later. Commit or note progress as you go rather than holding it all in the conversation.",
  },
  {
    id: "subagents",
    lead: "Subagent windows are not capped by the session's compaction setting.",
    body: "An agent re-reads its whole window on every step, so one that grows to 500k costs that much per step. Give each agent one narrow work package, set `model` explicitly (a smaller model for mechanical lanes), and brief it to return before about 200k of context.",
  },
  {
    id: "max-turns",
    lead: "Cap agent steps.",
    body: "In a repo's own agent definitions, `maxTurns` in the frontmatter caps how many steps an agent may take.",
  },
];

/** The body of one rule, by id (the repo-facing skill composes its bullets from these). */
export function efficiencyRule(id: EfficiencyRule["id"]): string {
  const r = EFFICIENCY_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no efficiency rule ${id}`);
  return r.body;
}

/** The version the block is written at now. Bump it whenever `EFFICIENCY_RULES` changes. */
export const EFFICIENCY_RULES_VERSION = 1;
export const EFFICIENCY_END = "<!-- efficiency-rules:end -->";
export const efficiencyStart = (v: number): string => `<!-- efficiency-rules:start v${v} -->`;
const START_RE = /<!-- efficiency-rules:start v(\d+) -->/g;

/** What sits between the two marker lines, for the rules as they are now. */
function currentInside(): string {
  return `\n## Working efficiently\n\n${EFFICIENCY_RULES.map((r) => `- **${r.lead}** ${r.body}`).join("\n")}\n`;
}

/**
 * The inside of every block this code has ever shipped, by version. A block whose marker names
 * one of these and whose inside is byte-equal to it was written by us and nobody touched it, so
 * it may be replaced. ANYTHING else is a person's edit.
 *
 * When `EFFICIENCY_RULES` changes: freeze the old inside here as a literal string under its
 * version, bump `EFFICIENCY_RULES_VERSION`, and point the new version at `currentInside()`.
 * `shared/test/efficiencyrules.test.mjs` pins v1's bytes, so an edit that forgets fails there.
 */
export const SHIPPED_EFFICIENCY_INSIDES: Readonly<Record<number, string>> = {
  1: currentInside(),
};

/** The whole block, marker lines included, with no trailing newline. */
export function efficiencyBlock(eol: "\n" | "\r\n" = "\n"): string {
  const s = `${efficiencyStart(EFFICIENCY_RULES_VERSION)}${currentInside()}${EFFICIENCY_END}`;
  return eol === "\n" ? s : s.replace(/\n/g, "\r\n");
}

export type EfficiencyBlockRead =
  | { kind: "none" }
  | { kind: "malformed"; why: string }
  | { kind: "block"; version: number; inside: string; start: number; end: number };

/** Find the one block in a file's text. `start`/`end` span the marker lines themselves. */
export function readEfficiencyBlock(text: string): EfficiencyBlockRead {
  const starts = [...text.matchAll(START_RE)];
  const ends: number[] = [];
  for (let i = text.indexOf(EFFICIENCY_END); i >= 0; i = text.indexOf(EFFICIENCY_END, i + 1)) ends.push(i);
  // A start marker with an unreadable version still counts as a marker somebody wrote.
  const looseStarts = (text.match(/<!-- efficiency-rules:start/g) ?? []).length;
  if (!looseStarts && !ends.length) return { kind: "none" };
  if (looseStarts !== 1 || starts.length !== 1 || ends.length !== 1) {
    return { kind: "malformed", why: "it has more than one efficiency-rules marker, or one without its partner" };
  }
  const s = starts[0];
  const at = s.index ?? 0;
  const insideFrom = at + s[0].length;
  if (ends[0] < insideFrom) return { kind: "malformed", why: "its efficiency-rules end marker comes before the start marker" };
  return { kind: "block", version: Number(s[1]), inside: text.slice(insideFrom, ends[0]), start: at, end: ends[0] + EFFICIENCY_END.length };
}

/** True when the file carries a block (ours or edited by hand: either way the rules are there). */
export function hasEfficiencyBlock(text: string | null): boolean {
  return text !== null && readEfficiencyBlock(text).kind === "block";
}

export type EfficiencyPlan =
  /** No block yet: `next` is the file with the block added at its end (`created`: there was no file). */
  | { kind: "append"; next: string; created: boolean }
  /** The current block is there, untouched. Nothing to write. */
  | { kind: "upToDate" }
  /** An older shipped block, untouched: `next` swaps it for the current one in place. */
  | { kind: "replace"; next: string; from: number }
  /** Nothing may be written, and `why` says so in a sentence. */
  | { kind: "refuse"; why: string };

const HAND_EDIT = "The efficiency-rules block in this file was changed by hand, so it is left as it is. To take the current rules, delete the block (both marker lines too) and add it again.";

/**
 * What writing the block into this text would do. `null` = the file does not exist. Pure: the host
 * reads the file, asks this, and writes `next` only for `append` or `replace`.
 */
export function planEfficiencyWrite(text: string | null): EfficiencyPlan {
  if (text === null) return { kind: "append", next: `${efficiencyBlock()}\n`, created: true };
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const b = readEfficiencyBlock(text);
  if (b.kind === "none") {
    const sep = text === "" || text.endsWith(`${eol}${eol}`) ? "" : text.endsWith(eol) ? eol : `${eol}${eol}`;
    return { kind: "append", next: `${text}${sep}${efficiencyBlock(eol)}${eol}`, created: false };
  }
  if (b.kind === "malformed") return { kind: "refuse", why: `This file is left as it is: ${b.why}. Fix the markers by hand first.` };
  if (b.version > EFFICIENCY_RULES_VERSION) return { kind: "refuse", why: `The block in this file is v${b.version}, newer than this desktop knows (v${EFFICIENCY_RULES_VERSION}), so it is left as it is.` };
  const shipped = SHIPPED_EFFICIENCY_INSIDES[b.version];
  // Byte-equal to what we would have written, in either line ending; anything else is typed words.
  const ours = shipped !== undefined && (b.inside === shipped || b.inside === shipped.replace(/\n/g, "\r\n"));
  if (!ours) return { kind: "refuse", why: HAND_EDIT };
  if (b.version === EFFICIENCY_RULES_VERSION) return { kind: "upToDate" };
  const blockEol: "\n" | "\r\n" = b.inside.includes("\r\n") ? "\r\n" : "\n";
  return { kind: "replace", next: `${text.slice(0, b.start)}${efficiencyBlock(blockEol)}${text.slice(b.end)}`, from: b.version };
}

export type EfficiencyTarget = "CLAUDE.md" | "AGENTS.md";
export const EFFICIENCY_TARGETS: readonly EfficiencyTarget[] = ["CLAUDE.md", "AGENTS.md"];

/** Which file would take the block when the person has not chosen: the one that exists, CLAUDE.md first. */
export function efficiencyTargetOf(exists: Readonly<Record<EfficiencyTarget, boolean>>): EfficiencyTarget {
  return exists["CLAUDE.md"] || !exists["AGENTS.md"] ? "CLAUDE.md" : "AGENTS.md";
}
