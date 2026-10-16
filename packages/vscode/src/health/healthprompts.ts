/**
 * The two repo-health prompts as TEXT — pure. Same two forms and the same rules as
 * `src/data/promptText.ts`: `copy` keeps paragraphs, `terminal` is ONE line with no C0 control or
 * DEL, and anything quoted from the series (a file path) is scrubbed in both. Each returns "" when
 * nothing in the reading qualifies; `render` turns that into a sentence.
 */
import { BRAND, fmtCount } from "@waterplane/shared";
import type { RepoHealthPlotSeries, RepoHealthPoint } from "@waterplane/shared";
import type { HealthDoc } from "../protocol.js";
import { formJoin, scrub } from "../data/promptform.js";
import type { PromptForm } from "../data/promptform.js";
// The definitions and the variant wording are the phone's, never a third copy: what each index
// reading counts (`HEALTH_ENTRY_MEASURE`) and what a repo's disable/override did to it.
import { HEALTH_ENTRY_MEASURE, HEALTH_ENTRY_OF_SERIES } from "../../../web/src/healthIndexWords.js";
import { variantWords } from "../../../web/src/repoHealthWords/repoHealthWordsCentral.js";

const fmtV = (v: number): string => (Number.isInteger(v) ? fmtCount(v) : String(Math.round(v * 100) / 100));
const withUnit = (v: number, unit: string): string => (unit ? `${fmtV(v)} ${scrub(unit)}` : fmtV(v));
const valued = (pts: RepoHealthPoint[]): (RepoHealthPoint & { v: number })[] =>
  pts.filter((p): p is RepoHealthPoint & { v: number } => typeof p.v === "number" && Number.isFinite(p.v));

/** The file that grew most: its path, its length now, its length N readings ago, and the repo's p95. */
export function splitLongest(h: HealthDoc | null, form: PromptForm): string {
  const plot = h?.plot;
  const lg = plot?.longest;
  if (!plot || !lg?.path) return "";
  const pts = valued(lg.points);
  const now = pts.at(-1);
  if (!now) return "";
  const back = Math.min(pts.length - 1, Math.max(1, plot.windowReadings || 1));
  const then = pts.length > 1 ? pts[pts.length - 1 - back] : null;
  const path = scrub(lg.path);
  const p95 = plot.series.find((s) => s.key === "size.p95");
  const facts = [
    `The longest source file in this repo is ${path}, at ${fmtCount(now.v)} lines on ${scrub(now.day)}.`,
    then ? `${back} reading${back === 1 ? "" : "s"} earlier (${scrub(then.day)}) the longest file was ${fmtCount(then.v)} lines.` : null,
    p95?.last != null ? `For comparison, 95% of the repo's source files (tests excluded) are at most ${withUnit(p95.last, p95.unit)}.` : null,
    `These figures come from the repo-health series the ${BRAND.name} VS Code extension measures from git history.`,
  ].filter((x): x is string => !!x);
  return formJoin([
    facts.join(" "),
    `Read ${path} and propose how to split this file into cohesive modules: what each new file would own, what stays, and which imports change. Keep behaviour identical.`,
    "Propose a diff; apply nothing until I say so.",
  ], form);
}

/** The rising series with the highest rank in its own window, or null. */
export function risingSeries(h: HealthDoc | null): RepoHealthPlotSeries | null {
  let best: RepoHealthPlotSeries | null = null;
  for (const s of h?.plot?.series ?? []) {
    if (s.reading.slope !== "rising" || s.reading.rank == null || s.last == null) continue;
    if (!best || s.reading.rank > (best.reading.rank ?? -1)) best = s;
  }
  return best;
}

/**
 * What the series counts, in the phone's words (`HEALTH_ENTRY_MEASURE`), and what the repo's
 * committed health.json did to it (`variantWords`) — or null for a series no index entry reads.
 */
export function definitionOf(s: RepoHealthPlotSeries): string | null {
  const entry = HEALTH_ENTRY_OF_SERIES[s.key];
  const measure = entry ? `"${scrub(s.label)}" is ${scrub(HEALTH_ENTRY_MEASURE[entry])}.` : null;
  const v = s.variant ? variantWords(s.variant) : null;
  const variant = v ? [v.lead, v.why, v.absent].filter((x): x is string => !!x).map(scrub).join(" ") : null;
  const out = [measure, variant].filter((x): x is string => !!x).join(" ");
  return out || null;
}

/** Why the most-rising metric is rising: causes and three proposals, in text. */
export function explainRising(h: HealthDoc | null, form: PromptForm): string {
  const s = risingSeries(h);
  if (!s || s.last == null || s.reading.rank == null) return "";
  const pct = Math.round(s.reading.rank * 100);
  const window = `${s.reading.n} reading${s.reading.n === 1 ? "" : "s"}${s.reading.from ? ` since ${scrub(s.reading.from)}` : ""}`;
  const detail = s.detail ? ` ${scrub(s.detail)}` : "";
  return formJoin([
    `In this repo's repo-health series (measured from git history), "${scrub(s.label)}" is rising: it reads ${withUnit(s.last, s.unit)} now, higher than ${pct}% of its own last ${window}.${detail}`,
    ...(definitionOf(s) ? [definitionOf(s) as string] : []),
    "From the git history of this repo, explain what most likely drove it up — which commits, files or areas — and give three concrete proposals to bring it back down, each with what it would cost.",
    "Do not change files; answer in text.",
  ], form);
}
