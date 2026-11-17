/**
 * The Setup check's one write into a tracked file a person edits: the generic efficiency-rules
 * block (`@waterplane/shared` `efficiencyrules.ts`) into the repo's own `CLAUDE.md` or `AGENTS.md`.
 *
 *  - The PLAN is shared and pure (`planEfficiencyWrite`): append, up to date, replace an untouched
 *    block we shipped, or refuse. A block somebody edited is never overwritten.
 *  - The person picks the file; this never creates a second instruction file beside an existing
 *    one, never follows a link (a rename onto a link would replace the link with a copy), and never
 *    commits.
 *  - The path goes through `containedReal`, and the write is `jsonstore.ts`' `writeTextAtomicKeepMode`:
 *    tmp + fsync + rename in the same directory, the original mode carried over.
 *  - The write presents the sha of the bytes the confirm screen was drawn from; a file that changed
 *    since then is `stale` and nothing is written.
 *
 * The route (`routes/apirepowork.ts`) gates the POST through `confirmgate.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EFFICIENCY_RULES_VERSION, EFFICIENCY_TARGETS, efficiencyBlock, efficiencyTargetOf, planEfficiencyWrite, readEfficiencyBlock,
  type EfficiencyPlan, type EfficiencyTarget,
} from "@waterplane/shared";
import { writeTextAtomicKeepMode } from "./jsonstore.js";
import { containedReal } from "./paths.js";

/** An instruction file past this is not one a person keeps by hand; it is refused, not read. */
const MAX_BYTES = 1024 * 1024;

/** The project instruction file the CLI also reads on every request; an existing one means no second file is started. */
const NESTED = ".claude/CLAUDE.md";

const sha = (s: Buffer | string): string => createHash("sha256").update(s).digest("hex");

export const isEfficiencyTarget = (t: unknown): t is EfficiencyTarget => typeof t === "string" && (EFFICIENCY_TARGETS as readonly string[]).includes(t);

/** One candidate file as the confirm screen shows it. */
export interface EfficiencyTargetState {
  target: EfficiencyTarget;
  exists: boolean;
  /** What a write would do; `refuse` carries its sentence. */
  plan: EfficiencyPlan["kind"];
  why?: string;
  /** sha256 of the bytes read ("" when the file does not exist): the POST presents it back. */
  sha: string;
}

interface Read { full: string; text: string | null; sha: string }

/** Read one target, or say why it cannot be touched. */
function readTarget(wt: string, target: string): Read | { refuse: string } {
  const full = containedReal(wt, target);
  if (!full) return { refuse: `${target} resolves outside this worktree, so it is left alone.` };
  let st;
  try { st = lstatSync(full); } catch { return { full, text: null, sha: "" }; }
  if (st.isSymbolicLink()) return { refuse: `${target} is a link to another file; choose the file it points to.` };
  if (!st.isFile()) return { refuse: `${target} is not a regular file.` };
  if (st.size > MAX_BYTES) return { refuse: `${target} is larger than 1 MB, so it is not edited from here.` };
  let buf: Buffer;
  try { buf = readFileSync(full); } catch (e) { return { refuse: `${target} could not be read: ${(e as Error).message}` }; }
  // Bytes that are not valid UTF-8 would be replaced by U+FFFD on the way back out: refuse rather than damage the person's text.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return { refuse: `${target} is not valid UTF-8 text, so it is not edited from here.` }; }
  return { full, text, sha: sha(buf) };
}

/** The plan for one target, with the second-instruction-file rule applied. */
function planFor(wt: string, target: EfficiencyTarget): { read: Read | null; plan: EfficiencyPlan } {
  const r = readTarget(wt, target);
  if ("refuse" in r) return { read: null, plan: { kind: "refuse", why: r.refuse } };
  if (r.text === null) {
    const other = EFFICIENCY_TARGETS.find((t) => t !== target)!;
    let otherThere = false;
    try { lstatSync(join(wt, other)); otherThere = true; } catch { /* absent */ }
    if (!otherThere) {
      try { lstatSync(join(wt, NESTED)); } catch { /* absent */ return { read: r, plan: planEfficiencyWrite(r.text) }; }
      return { read: r, plan: { kind: "refuse", why: `${target} does not exist and this repo already has ${NESTED}; put the rules there rather than in a second instruction file.` } };
    }
    if (otherThere) return { read: r, plan: { kind: "refuse", why: `${target} does not exist and this repo already has ${other}; the rules go into ${other} rather than a second instruction file.` } };
  }
  return { read: r, plan: planEfficiencyWrite(r.text) };
}

export interface EfficiencyStateDoc {
  version: number;
  /** The block as it would be written (so the screen can show exactly what is added). */
  block: string;
  /** The file a write goes to when the person has not chosen. */
  suggested: EfficiencyTarget;
  /** Either file already carries a block (ours or edited by hand). */
  present: boolean;
  targets: EfficiencyTargetState[];
}

/** `GET …/efficiencyrules`: both candidate files and what a write to each would do. Reads only. */
export function efficiencyState(wt: string): EfficiencyStateDoc {
  const plainOf: Record<string, boolean> = {};
  const targets = EFFICIENCY_TARGETS.map((target): EfficiencyTargetState => {
    const { read, plan } = planFor(wt, target);
    let exists = false, plain = false;
    try { const st = lstatSync(join(wt, target)); exists = true; plain = !st.isSymbolicLink(); } catch { /* absent */ }
    plainOf[target] = plain;
    return { target, exists, plan: plan.kind, ...(plan.kind === "refuse" ? { why: plan.why } : {}), sha: read?.sha ?? "" };
  });
  // A link cannot take the write, so it does not count as the file to suggest: a CLAUDE.md that links to AGENTS.md suggests AGENTS.md.
  const exists = Object.fromEntries(targets.map((t) => [t.target, plainOf[t.target]])) as Record<EfficiencyTarget, boolean>;
  // Any marker counts: a block somebody edited (or broke) still means the person chose to carry the rules.
  const present = [...EFFICIENCY_TARGETS, NESTED].some((t) => { const r = readTarget(wt, t); return !("refuse" in r) && r.text !== null && readEfficiencyBlock(r.text).kind !== "none"; });
  return { version: EFFICIENCY_RULES_VERSION, block: efficiencyBlock(), suggested: efficiencyTargetOf(exists), present, targets };
}

/** The Setup check's fact: is the block there, and which file would take it. */
export function efficiencyFact(wt: string): { present: boolean; target: EfficiencyTarget } {
  const s = efficiencyState(wt);
  return { present: s.present, target: s.suggested };
}

export type EfficiencyWriteResult =
  | { ok: true; written: boolean; plan: "append" | "replace" | "upToDate"; created?: boolean }
  | { ok: false; code: "refused" | "stale" | "failed"; error: string };

/**
 * Write the block into `target`, only over the exact bytes the screen was drawn from (`baseSha`,
 * "" for a file that did not exist). Never commits.
 */
export function writeEfficiencyRules(wt: string, target: EfficiencyTarget, baseSha: string): EfficiencyWriteResult {
  const { read, plan } = planFor(wt, target);
  if (!read || plan.kind === "refuse") return { ok: false, code: "refused", error: plan.kind === "refuse" ? plan.why : "refused" };
  if (typeof baseSha !== "string" || read.sha !== baseSha) {
    return { ok: false, code: "stale", error: `${target} changed since the screen was drawn; nothing was written. Open it again.` };
  }
  if (plan.kind === "upToDate") return { ok: true, written: false, plan: "upToDate" };
  // Last look before the write: an agent in the same repo may have written since the plan was read.
  let now = "";
  try { now = sha(readFileSync(read.full)); } catch { now = ""; }
  if (now !== read.sha || (read.text === null && existsSync(read.full))) {
    return { ok: false, code: "stale", error: `${target} changed while it was being written; nothing was written. Open it again.` };
  }
  try {
    // tmp + fsync + rename, mode carried over, never through a link out of the worktree.
    writeTextAtomicKeepMode(read.full, plan.next, wt);
  } catch (e) {
    return { ok: false, code: "failed", error: String((e as Error)?.message || e) };
  }
  return plan.kind === "append" ? { ok: true, written: true, plan: "append", created: plan.created } : { ok: true, written: true, plan: "replace" };
}
