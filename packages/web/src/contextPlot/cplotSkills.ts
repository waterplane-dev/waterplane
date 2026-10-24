/**
 * The skills as events on the same axis: one row per skill, a mark per load, and the sentences about them.
 *
 * A skill's body enters the window when the `Skill` tool runs, and the host reads that moment off
 * the log (`SkillLoad`): for the conversation itself (`ContextSeriesDoc.skills`) and for each
 * subagent (`AgentRun.skills`). A row per skill NAME, rather than one strip of dots, because the
 * question this chart answers is "which skills, and how often" — the same skill loaded by eleven
 * agents is eleven marks on ONE row, which is the repetition worth seeing.
 *
 * What is NOT here: a token count per skill. The request that carried a body reports one total
 * for everything it held, so the only per-skill size the log has is its length in characters.
 * A token figure is said as an estimate (`SKILL_CHARS_PER_TOK`), with its method, never bare.
 */

import type { AgentRun, SkillLoad } from "@waterplane/shared";
import { fmtTokens, fmtAxisTime } from "../kit/chart/chartFmt.ts";
import type { Plot } from "./cplotAxis.ts";

/** Characters per token the estimate divides by — English prose and code
 *  markdown land near four. A rough rule, which is why every figure built on
 *  it is printed with "≈" and the method beside it. */
export const SKILL_CHARS_PER_TOK = 4;

/** One load, placed. `agent` is absent for the conversation's own. */
export interface SkillMark {
  load: SkillLoad;
  agent?: AgentRun;
  x: number;
  row: number;
}

export interface SkillRow {
  name: string;
  marks: SkillMark[];
}

/** Every load in one list, oldest first: the conversation's and each agent's. */
export function allSkillLoads(own: SkillLoad[] | undefined, agents: AgentRun[]): { load: SkillLoad; agent?: AgentRun }[] {
  const out: { load: SkillLoad; agent?: AgentRun }[] = (own ?? []).map((load) => ({ load }));
  for (const a of agents) for (const load of a.skills ?? []) out.push({ load, agent: a });
  return out.sort((a, b) => a.load.t - b.load.t);
}

/**
 * Rows in order of each skill's FIRST load, marks clamped into the plot (a
 * load before the first reading still draws, at the left edge — the agents'
 * rule).
 */
export function skillRows(p: Plot, own: SkillLoad[] | undefined, agents: AgentRun[]): SkillRow[] {
  const rows: SkillRow[] = [];
  const at = new Map<string, number>();
  for (const { load, agent } of allSkillLoads(own, agents)) {
    let row = at.get(load.name);
    if (row == null) { row = rows.length; at.set(load.name, row); rows.push({ name: load.name, marks: [] }); }
    const x = Math.max(p.x, Math.min(p.x + p.w, p.px(load.t)));
    rows[row].marks.push({ load, ...(agent ? { agent } : {}), x, row });
  }
  return rows;
}

/** Row height: a label line over a mark line. */
export const SKILL_ROW_H = 24;
/** Where in a row the marks sit, below its label. */
export const SKILL_MARK_DY = 17;

/**
 * The mark under a pointer: nearest in x within the pointer's row, or the
 * nearest anywhere when the pointer is off every row. By position, not an
 * exact hit — a 7-unit dot is not a target on a phone.
 */
export function skillAtPoint(rows: SkillRow[], plotY: number, x: number, y: number): SkillMark | null {
  const r = Math.floor((y - plotY) / SKILL_ROW_H);
  const pool = rows[r]?.marks.length ? rows[r].marks : rows.flatMap((w) => w.marks);
  if (!pool.length) return null;
  return pool.reduce((m, k) => (Math.abs(k.x - x) < Math.abs(m.x - x) ? k : m), pool[0]);
}

/** "≈2.1k tokens" off a character count — the estimate, always with its sign. */
export function skillTokText(chars: number): string {
  return `≈${fmtTokens(Math.round(chars / SKILL_CHARS_PER_TOK))} tokens`;
}

function whoLoaded(agent: AgentRun | undefined): string {
  return agent ? `a subagent${agent.type ? ` (${agent.type})` : ""}` : "this conversation";
}

/**
 * The headline: how many skills, how many loads, whose, and the estimate.
 * Null when nothing was loaded — the caller says that in its own sentence.
 */
export function skillSummary(own: SkillLoad[] | undefined, agents: AgentRun[]): string | null {
  const all = allSkillLoads(own, agents);
  if (!all.length) return null;
  const names = new Set(all.map((l) => l.load.name)).size;
  const mine = all.filter((l) => !l.agent).length;
  const theirs = all.length - mine;
  const chars = all.reduce((s, l) => s + l.load.chars, 0);
  const who = theirs === 0 ? "all by this conversation"
    : mine === 0 ? "all by subagents"
      : `${mine} by this conversation, ${theirs} by subagents`;
  const loads = all.length === 1 ? "1 load" : `${all.length} loads`;
  return `${names} skill${names === 1 ? "" : "s"} · ${loads}, ${who} · ${skillTokText(chars)} of skill text`;
}

/** The skill loaded most often, when it was loaded more than once — the
 *  repetition the rows exist to show, as one sentence. Null otherwise. */
export function skillRepeatText(rows: SkillRow[]): string | null {
  const top = rows.reduce<SkillRow | null>((m, r) => (!m || r.marks.length > m.marks.length ? r : m), null);
  if (!top || top.marks.length < 2) return null;
  const chars = top.marks.reduce((s, k) => s + k.load.chars, 0);
  return `${top.name} was loaded ${top.marks.length} times — ${skillTokText(chars)} in all.`;
}

/** What a tapped mark says, as a line of text under the chart. */
export function skillReadout(m: SkillMark, span: number): string {
  return `${m.load.name} · ${fmtAxisTime(m.load.t, span)} · by ${whoLoaded(m.agent)} · ${fmtTokens(m.load.chars)} chars, ${skillTokText(m.load.chars)}`;
}

/** How the chart is counted — method, so it folds. */
export const SKILL_METHOD = `A mark is the moment the Skill tool wrote that skill's text into a context window, read off the CLI's log. A filled dot is this conversation's own window; a ring is a subagent's — its own window, not this one. Size is the text's length in characters; the token figure divides by ${SKILL_CHARS_PER_TOK}, an estimate, because the request that carried the text reports one total for everything it held. A skill typed as a slash command is not counted here.`;
