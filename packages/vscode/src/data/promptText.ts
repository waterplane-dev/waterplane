/**
 * The optimisation prompts as TEXT — pure, no `vscode`, so the test bundle pins it.
 *
 * Two forms of every prompt:
 *  - `copy`: paragraphs, for the clipboard; the person pastes it where they choose.
 *  - `terminal`: ONE line. It is typed into whatever the active terminal runs — a plain shell
 *    executes each line it is handed, and a TUI may take a chunked LF as Enter. So the terminal
 *    form carries no newline, no carriage return, no ESC and no other C0 control, ever.
 *
 * Anything quoted from a log or a file (a prompt excerpt, a skill name) is scrubbed of C0/DEL in
 * BOTH forms: a transcript can hold `\x1b[31m` or `\r\nrm -rf ~`, and a prompt that quotes it must
 * not carry it anywhere.
 */
import { coldStartText, costText, fmtCount, fmtUsd } from "@waterplane/shared";
import { sessionTotal } from "./sessiontotal.js";
import type { HealthDoc, PromptDef, PromptId, SessionDoc, TurnCost, WeightDoc } from "../protocol.js";
import { explainRising, splitLongest } from "../health/healthprompts.js";
import { formJoin, scrub } from "./promptform.js";
import type { PromptForm } from "./promptform.js";

export { formJoin, scrub };
export type { PromptForm };

export const PROMPTS: PromptDef[] = [
  { id: "groom-claudemd", title: "Groom CLAUDE.md", needs: ["weight"] },
  { id: "shrink-skill-descs", title: "Shrink skill descriptions", needs: ["weight"] },
  { id: "handoff-fresh-session", title: "Hand off to a fresh session", needs: ["session"] },
  { id: "explain-turn", title: "Why was this prompt expensive?", needs: ["session", "turn"] },
  { id: "split-longest-file", title: "Split the file that grew most", needs: ["health"] },
  { id: "explain-rising-metric", title: "Why is this health metric rising?", needs: ["health"] },
];

export interface PromptCtx { session: SessionDoc | null; weight: WeightDoc | null; health?: HealthDoc | null; turn?: number }
export type Rendered = { ok: true; text: string } | { ok: false; why: string };

const NO_CHANGES = "Do not change files; answer in text.";
const NO_HEALTH = "No repo-health reading for this folder yet — open Repo health in the sidebar and measure it.";
const PROPOSE = "Propose a diff; apply nothing until I say so.";

function groom(w: WeightDoc, form: PromptForm): string {
  const r = w.reading;
  return formJoin([
    `My always-on context is ${fmtCount(r.alwaysOnChars)} characters (about ${fmtCount(r.alwaysOnTokens)} tokens at roughly 4 characters per token): CLAUDE.md is ${fmtCount(w.claudeMdChars)} characters and ${r.skillCount} skill descriptions make up the rest. Every turn re-sends all of it.`,
    "Read CLAUDE.md. Keep what is dangerous not to know before acting: security boundaries, never-do rules, commands that must be run a certain way. Move reference material (module indexes, protocol detail, heuristics) into skills that load only when that code is being edited, and drop what is stale or duplicated.",
    PROPOSE,
  ], form);
}

function shrink(w: WeightDoc, form: PromptForm): string {
  const longest = [...w.skills].sort((a, b) => b.descChars - a.descChars).slice(0, 8);
  if (!longest.length) return "";
  const items = longest.map((s) => `${scrub(s.name)}: ${fmtCount(s.descChars)} characters in the description`);
  const rows = form === "copy" ? items.map((x) => `- ${x}`).join("\n") : items.join("; ");
  return formJoin([
    "A skill's description is loaded into every turn; its body only when the skill is used. These descriptions are the longest:",
    rows,
    "Rewrite each to say only when the skill applies, in as few words as keep it triggering correctly. Leave the bodies alone.",
    PROPOSE,
  ], form);
}

function handoff(s: SessionDoc, form: PromptForm): string {
  // The same total the panel and the status bar print (own + agents, or withheld).
  const tot = sessionTotal(s);
  const sentences = [tot.cost ? costText(tot.cost.total, tot.agentUsd, tot.unpricedTok) : null, coldStartText(s.coldStarts, "session")]
    .filter((x): x is string => !!x);
  return formJoin([
    `This session has run ${s.turns} prompt${s.turns === 1 ? "" : "s"} and carried ${fmtCount(s.usageTok)} tokens so far.${sentences.length ? " " + sentences.join(" ") : ""} Every further prompt re-sends the whole conversation.`,
    "Write a handoff note I can paste into a fresh session: the goal, what is done, what is half-done, decisions and why, files touched, and the very next step. Keep it under 400 words and leave out anything a fresh session can read from the repo.",
    NO_CHANGES,
  ], form);
}

function explain(s: SessionDoc, t: TurnCost, form: PromptForm): string {
  const ctx = t.ctxTok == null ? "an unknown amount of context" : `${fmtCount(t.ctxTok)} tokens of context`;
  const k = t.kinds;
  const cost = t.costUsd == null ? "unpriced" : `${fmtUsd(t.costUsd)} at list prices`;
  const again = scrub(s.turnCosts.find((x) => x.n === t.n)?.prompt ?? t.prompt);
  return formJoin([
    `Prompt ${t.n} of this session ("${again}") cost ${cost} over ${t.requests} request${t.requests === 1 ? "" : "s"}, the last carrying ${ctx}. Tokens: ${fmtCount(k.input)} input, ${fmtCount(k.output)} output, ${fmtCount(k.cacheRead)} cache read, ${fmtCount(k.cacheWrite)} cache write.`,
    "Explain from the transcript why that prompt was dear: how many tool calls and file reads it took, whether the context was already large or the cache had gone cold, and what I could have done differently.",
    NO_CHANGES,
  ], form);
}

/** One prompt in the form asked for, or a sentence saying why it cannot be built. */
export function render(id: PromptId, ctx: PromptCtx, form: PromptForm = "copy"): Rendered {
  const w = ctx.weight, s = ctx.session;
  if (id === "groom-claudemd") return w ? { ok: true, text: groom(w, form) } : { ok: false, why: "No CLAUDE.md weight could be read for this folder, so there is nothing to quote." };
  if (id === "shrink-skill-descs") {
    const t = w ? shrink(w, form) : "";
    return t ? { ok: true, text: t } : { ok: false, why: "This folder has no skills with descriptions, so there is nothing to shrink." };
  }
  if (id === "split-longest-file" || id === "explain-rising-metric") {
    const h = ctx.health ?? null;
    if (!h?.plot) return { ok: false, why: NO_HEALTH };
    if (id === "split-longest-file") {
      const t = splitLongest(h, form);
      return t ? { ok: true, text: t } : { ok: false, why: "This folder's repo-health series names no longest file, so there is nothing to split." };
    }
    const t = explainRising(h, form);
    return t ? { ok: true, text: t } : { ok: false, why: "No metric in this folder's series is rising right now, so there is nothing to ask about." };
  }
  if (id === "handoff-fresh-session") return s ? { ok: true, text: handoff(s, form) } : { ok: false, why: "No session was found for this folder yet." };
  // Turn 0 is the records before the first prompt: there is no prompt to ask about.
  const turn = ctx.turn != null && ctx.turn > 0 ? s?.turnCosts.find((x) => x.n === ctx.turn) : undefined;
  return s && turn ? { ok: true, text: explain(s, turn, form) } : { ok: false, why: "That prompt is not in the session's log any more; pick one from the list." };
}
