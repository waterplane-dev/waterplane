/**
 * The two health-index asks — one week, and the whole trend — as prompts for
 * a repo's agent, plus the context both read (`healthAskContextOf`). Split out
 * of `setupRemedy.ts` (which re-exports it) past the 900-line cap; the rules
 * are its own: every claim is worded off the wire, absent stays absent, and
 * nothing here is sent — the sheet hands the words to the Send sheet.
 */
import { BRAND, REPOHEALTH_OWN_FILE, REPOHEALTH_TOOL, isoWeekOf, type HealthEntry, type RepoHealthPlot, type RepoHealthPoint } from "@waterplane/shared";
import {
  HEALTH_ENTRY_MEASURE, HEALTH_ENTRY_NAME, HEALTH_ENTRY_OF_SERIES, HEALTH_ENTRY_ORDER, indexBasketWords, signedTenths,
} from "./healthIndexWords.ts";
import { seriesValueWords } from "./repoHealthWords.ts";
import { nf } from "./repoHealthWords/repoHealthWordsFmt.ts";

/** One basket of a health-index week, as the prompt needs it. */
export interface IndexMoverSubject {
  /** The index's own key (`size`, `retouch`, …). */
  key: string;
  /** The phone's plain name for it. */
  name: string;
  /** Its share of the week's move, in score points; negative = the reading grew. */
  points: number;
}

/** A picked week of the health index, as the ask on that section sends it. */
export interface IndexWeekSubject {
  /** The ISO week's Monday this point is. */
  week: string;
  /** The week it was linked to, or null where there is none. */
  prevWeek: string | null;
  index: number;
  /** The move against `prevWeek` in score points, or null where the week has no link. */
  delta: number | null;
  /** Every basket that contributed, in the index's order. */
  movers: readonly IndexMoverSubject[];
  /** The alert sentences on that week, worst first; absent/empty = none. */
  alerts?: readonly string[];
  /** The cap sentence where the cap set that week's score. */
  cap?: string | null;
}

/** What holds the latest score down, handed to the trend ask beside its weeks. */
export interface IndexNow {
  alerts: readonly string[];
  cap: string | null;
}

/** "Vs N weeks ago" as the prompts state it: the week actually compared with, named. */
export interface IndexVsSubject {
  delta: number;
  thenWeek: string;
  weeks: number;
}

/** A repo's disable or override of one basket, as the prompts name it. */
export interface HealthAskVariant {
  key: HealthEntry;
  kind: "disabled" | "override";
  /** The repo's own reason. */
  why: string;
  /** An override: what the repo's command counts. */
  means?: string;
  /** An override: its first measurement, or null when it has none yet. */
  since?: string | null;
}

/** One of the repo's own readings, worded for the prompt. */
export interface HealthOwnReading {
  key: string;
  label: string;
  /** Its values over the span, already worded (`3 on 2026-10-14 → 5 on 2026-10-16`). */
  span: string;
  /** The declaration's own `means`, verbatim. */
  means: string;
  /** The declaration's `better`, attributed to the repo. */
  better: "lower" | "higher" | null;
}

/** The repo's own readings as the index prompts carry them. */
export interface HealthOwnSubject {
  /** The declaration file, from the repo root. */
  file: string;
  declared: boolean;
  /** The readings with at least one value. */
  readings: readonly HealthOwnReading[];
  /** The engine's reason a declared file yields nothing to list. */
  absent?: string | null;
}

/**
 * What both index prompts are told about the tree beside the numbers. Every
 * field is ABSENT where the wire did not carry it, and then the prompt says
 * nothing on that subject — an agent told the engine "is probably not in this
 * repo" while standing in the repo that holds it went looking for the wrong
 * thing, so where it is comes off `RepoHealthView.engine` or not at all.
 */
export interface HealthAskContext {
  /** Which engine measured the tree (`RepoHealthView.engine.kind`). */
  engine?: "repo" | "bundled" | null;
  /** Source files at the baseline week and at the latest reading. */
  tree?: { baselineFiles: number; nowFiles: number } | null;
  /** `undefined`/null = no `own` block on the wire (absent ≠ declares none). */
  own?: HealthOwnSubject | null;
  /** The repo's disables and overrides on the latest day, one per basket; absent = none on the wire. */
  variants?: readonly HealthAskVariant[];
  /** The file holding them (`plot.central.file`). */
  centralFile?: string;
  /** The engine's own detail sentence beside each basket's reading today
   *  (the hatch breakdown, the files near the longest, the skill bodies…), verbatim. */
  details?: readonly { key: HealthEntry; label: string; detail: string }[];
  /** "Vs 12 weeks ago" at the week the prompt is about; absent = none that old. */
  vs?: IndexVsSubject | null;
  /** The latest score's cap and alerts, for the trend prompt; absent = none stated. */
  now?: IndexNow | null;
}

/** The last measured point of a series inside one ISO week, or null. */
function lastInWeek(points: readonly RepoHealthPoint[], week: string): number | null {
  let v: number | null = null;
  for (const p of points) if (p.v != null && isoWeekOf(p.day) === week) v = p.v;
  return v;
}

/**
 * The context the two index prompts read, from what the series region
 * already holds. Pure; each part degrades to absent on its own.
 */
export function healthAskContextOf(
  plot: Pick<RepoHealthPlot, "classics" | "own"> & Partial<Pick<RepoHealthPlot, "series" | "central">> | null | undefined,
  engine: "repo" | "bundled" | null | undefined,
  baselineWeek: string,
  vs?: IndexVsSubject | null,
): HealthAskContext {
  const ctx: HealthAskContext = {};
  if (engine) ctx.engine = engine;
  if (vs) ctx.vs = vs;
  const variants: HealthAskVariant[] = [];
  const details: { key: HealthEntry; label: string; detail: string }[] = [];
  for (const s of plot?.series ?? []) {
    const key = HEALTH_ENTRY_OF_SERIES[s.key];
    if (!key) continue;
    if (s.detail?.trim()) details.push({ key, label: s.label, detail: s.detail.trim() });
    const v = s.variant;
    if (!v || variants.some((x) => x.key === key)) continue;
    variants.push(v.kind === "disabled"
      ? { key, kind: "disabled", why: v.why }
      : { key, kind: "override", why: v.why, means: v.means, since: v.since });
  }
  if (variants.length) ctx.variants = variants;
  if (plot?.central?.file) ctx.centralFile = plot.central.file;
  if (details.length) ctx.details = details;
  const files = plot?.classics?.files ?? [];
  const baselineFiles = lastInWeek(files, baselineWeek);
  let nowFiles: number | null = null;
  for (const p of files) if (p.v != null) nowFiles = p.v;
  if (baselineFiles != null && nowFiles != null) ctx.tree = { baselineFiles, nowFiles };
  const own = plot?.own;
  if (own) {
    const readings: HealthOwnReading[] = [];
    for (const s of own.series) {
      const got = s.points.filter((p) => p.v != null);
      if (!got.length) continue;
      const a = got[0];
      const b = got[got.length - 1];
      const span = got.length === 1
        ? `${seriesValueWords(a.v, s.unit)} on ${a.day} (its only reading so far)`
        : `${seriesValueWords(a.v, s.unit)} on ${a.day} → ${seriesValueWords(b.v, s.unit)} on ${b.day} (${got.length} readings)`;
      readings.push({ key: s.key, label: s.label, span, means: s.means, better: s.better });
    }
    ctx.own = { file: own.file, declared: own.declared, readings, absent: own.absent ?? null };
  }
  return ctx;
}

/** Whose engine took the readings — or null, and then nothing is said. */
function engineWords(kind: HealthAskContext["engine"]): string | null {
  if (kind === "repo") return `The readings were measured by this repo's own ${REPOHEALTH_TOOL}, and the keys are its names for them — read it if you come to doubt a number.`;
  if (kind === "bundled") return `The readings were measured by ${BRAND.displayName}'s bundled engine, and the keys are its names for them; it is not part of this repo, so do not look for it here.`;
  return null;
}

/** Whole weeks between two ISO-week Mondays, or null for a malformed one. */
function weeksApart(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / (7 * 86_400_000)) : null;
}

/** A link reaching across weeks with no row: said, because a move over seven
 *  silent weeks is not one week's work. */
function linkSpanWords(from: string, to: string): string {
  const n = weeksApart(from, to);
  return n !== null && n > 1 ? ` (one link over ${n} weeks with no measured week between)` : "";
}

const BACKLOG_COMMIT =
  "A week's move may be one large commit landing work done over a longer stretch: check whether a single commit carries most of it before attributing the move to that week.";

/** One reading's line, with what kind of number it is. */
function measureOf(key: string): string {
  const m = HEALTH_ENTRY_MEASURE[key as HealthEntry];
  return m ? ` It is ${m}.` : "";
}

/** The repo's own readings as a block, or null where the wire said nothing. */
function ownBlock(own: HealthOwnSubject | null | undefined): string | null {
  if (!own) return null;
  if (own.readings.length) {
    const lines = own.readings.map((r) =>
      `- ${r.label} (\`${r.key}\`): ${r.span}${r.better ? `; the repo wants it ${r.better}` : ""}. ${r.means.trim()}`);
    return `This repo's own readings, declared in ${own.file} — not part of the index, which is built from its five readings only:\n\n${lines.join("\n")}`;
  }
  if (own.declared) return `This repo declares readings of its own in ${own.file}, but none has a value yet${own.absent ? `: ${own.absent.trim()}` : "."}`;
  return `This repo declares no readings of its own; ${own.file} is where one would be declared.`;
}

/** What the index is built from, as the prompt head says it. */
function basketHead(ctx: HealthAskContext): string {
  const disabled = (ctx.variants ?? []).filter((v) => v.kind === "disabled").map((v) => v.key);
  const overridden = (ctx.variants ?? []).filter((v) => v.kind === "override").map((v) => v.key);
  const b = indexBasketWords({ disabled, overridden }, BRAND.displayName);
  return b ? ` ${b}` : "";
}

/**
 * The repo's disables and overrides, named, and what they do to comparing —
 * or null where it changed nothing. `carried` lists the weeks the index was
 * carried because that config changed.
 */
function variantBlock(ctx: HealthAskContext, carried: readonly string[] = []): string | null {
  const vs = ctx.variants ?? [];
  if (!vs.length && !carried.length) return null;
  const file = ctx.centralFile ?? REPOHEALTH_OWN_FILE;
  const lines = vs.map((v) => {
    const name = `${HEALTH_ENTRY_NAME[v.key]} (\`${v.key}\`)`;
    const why = v.why.trim();
    if (v.kind === "disabled") return `- ${name}: disabled — still measured, left out of the index. The repo's reason: ${why}`;
    const means = v.means?.trim() ? ` — ${v.means.trim()}` : "";
    const since = v.since ? `; first measured ${v.since}` : "; not measured yet";
    return `- ${name}: the index reads this repo's own command instead of the engine's reading${means}${since}. The repo's reason: ${why}`;
  });
  const weeks = carried.length
    ? `\nWeeks whose move is not compared (their scores are still measured) because this repo changed which readings it overrides or disables: ${carried.join(", ")}.`
    : "";
  return `${vs.length ? `This repo changes what the index is built from, in ${file} (\`central\`):\n\n${lines.join("\n")}\n\n` : ""}` +
    "The score is not comparable across a change of that config: the week it lands is scored as measured, but its move is not compared " +
    "with the week before, so a jump there is not a move; and a score built from a different set of readings does not compare with another repo's on those readings." +
    weeks;
}

/** The engine's own sentences beside the readings today, or null. */
function detailBlock(ctx: HealthAskContext): string | null {
  const d = ctx.details ?? [];
  if (!d.length) return null;
  return `What the engine says beside the readings on the latest day, verbatim:\n\n${d.map((x) => `- ${x.label} (\`${x.key}\`): ${x.detail}`).join("\n")}`;
}

/** What holds a score down — the cap and the alerts, verbatim — or "" where nothing does. */
function holdingWords(alerts: readonly string[] | undefined, cap: string | null | undefined): string {
  const lines = [...(cap ? [cap] : []), ...(alerts ?? []).map((a) => `- ${a}`)];
  return lines.length ? `\nWhat is holding the score down (the alarm the person sees first; name the offenders when you answer):\n${lines.join("\n")}\n` : "";
}

/** "Vs 12 weeks ago", naming the week compared with, or "". */
function vsLine(vs: IndexVsSubject | null | undefined, index: number): string {
  if (!vs) return "";
  const then = Math.round(index - vs.delta);
  return ` Against the week of ${vs.thenWeek}, ${vs.weeks} week${vs.weeks === 1 ? "" : "s"} earlier, it was ${then} (${signedTenths(vs.delta)} since).`;
}

/**
 * One week of the health index, as a question for the repo's agent.
 *
 * Not the series prompt at a bigger size. The series prompt asks whether a
 * reading is serving the repo and so must hold no side; the index is the one
 * layer that HAS taken one, and its bars already say which reading moved it and
 * by how much. What the screen cannot say is WHY — which commits in that week
 * grew or shrank the reading. So the opening verb points the agent at the
 * week's work, never at the arithmetic (see `seriesRemedyPrompt` for what the
 * first verb decides), and the biggest mover comes first because that is the
 * one worth the agent's time.
 *
 * It is the week the person picked on the line, not always the latest: the
 * bars under the line are that week's too, so the prompt and the screen it was
 * sent from say the same thing.
 */
export function healthIndexRemedyPrompt(w: IndexWeekSubject, repoName: string, ctx: HealthAskContext = {}): string {
  const ranked = [...w.movers].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const items = ranked.map((m) => {
    const dir = Math.round(m.points * 10) === 0
      ? "barely moved it"
      : m.points > 0 ? "pushed it up (that reading shrank)" : "pulled it down (that reading grew)";
    return `- ${m.name} (\`${m.key}\`): ${signedTenths(m.points)} — ${dir}.${measureOf(m.key)}`;
  });
  const span = w.prevWeek
    ? `between the week of ${w.prevWeek} and the week of ${w.week}${linkSpanWords(w.prevWeek, w.week)}`
    : `in the week of ${w.week}`;
  const head =
    `${BRAND.displayName}'s health index for ${repoName} was ${Math.round(w.index)} in the week of ${w.week}` +
    `${w.delta !== null ? ` (${signedTenths(w.delta)} against the week before)` : ""}; each week is the ISO week starting that Monday.` +
    `${vsLine(ctx.vs, w.index)} ` +
    `It is a score out of 100 against fixed good values for five readings of the repo, held within 30 points of its worst one, and it falls when a reading grows past its good value.${basketHead(ctx)} ` +
    "That week's move split across the readings like this, in score points, biggest first:";
  const own = ownBlock(ctx.own);
  const engine = engineWords(ctx.engine);
  const variants = variantBlock(ctx);
  const details = detailBlock(ctx);
  return `${head}

${items.join("\n")}
${holdingWords(w.alerts, w.cap)}${details ? `\n${details}\n` : ""}${variants ? `\n${variants}\n` : ""}${own ? `\n${own}\n` : ""}
What happened in ${repoName} ${span} that moved these readings, and is it work you would keep? Answer it about the commits and the files — use the git history for that span — starting with the reading that moved the index most, and the second one if it moved it by a comparable amount. Name the commits and files behind each, and say whether the change is the repo getting healthier, a cost worth paying for what the work bought, or something to undo. ${BACKLOG_COMMIT}

${engine ? `${engine} ` : ""}A small move is often nothing: "this was ordinary work and nothing needs doing" is a complete answer, and so is "this is an artefact of how it is measured" — say which, and stop there.

Change no file, run no fix, commit nothing. Finish with the options as you see them, in order of what each would cost.`;
}

/** One week of the index as the trend prompt lists it. */
export interface IndexTrendWeek {
  week: string;
  index: number;
  gap: boolean;
  /** Null on the first scored week and on a gap week (its move is not compared). */
  lnLink: number | null;
  contributions: Partial<Record<string, number>>;
  /** Why a gap week was marked; absent on an older host. */
  gapReason?: "prereg" | "central" | "nothing";
}

/**
 * The whole index, as one tap: read whether this repo is getting healthier,
 * then propose what would make it so — each proposal a backlog row.
 *
 * Three things this prompt must hold that the week prompt need not:
 *
 * PROPOSALS ARE TALKED THROUGH, THEN ROWS. Advice in chat is read once and
 * lost, so a kept proposal becomes a backlog row (agent backlog add — held,
 * never started). But a row posted unasked is a to-do list nobody chose: the
 * session lists its proposals, stops, and posts only the ones the person picks
 * in their reply. Nothing applies itself: the session changes no file, and a
 * row runs only on a tap.
 *
 * THE TREND COMES FIRST. The proposals are argued from what the git history
 * says moved the readings, not from the gauge alone.
 *
 * THE READINGS ARE NOT THE REPO. They are five generic measures the engine can
 * take of any tree. The change that would help this repo most may move none of
 * them, and advice steered by the index alone would optimise the gauge. So the
 * proposals start from the repo's OWN readings where it declares any, and where
 * the biggest lever has no measure one proposal is to declare one in the repo's
 * declaration file — a row like the others, never written by this session.
 */
export function healthTrendRemedyPrompt(
  weeks: readonly IndexTrendWeek[],
  _baselineWeek: string,
  repoName: string,
  ctx: HealthAskContext = {},
): string {
  const rows = weeks.map((w, i) => {
    const prev = i > 0 ? weeks[i - 1] : null;
    if (w.lnLink === null) {
      const why = w.gapReason === "central"
        ? "move not compared: this repo changed which readings it overrides or disables"
        : w.gapReason === "prereg" ? "move not compared: the engine's definitions changed" : "move not compared with the week before";
      return `- ${w.week}: ${Math.round(w.index)} — ${w.gap ? why : "first scored week"}`;
    }
    const parts = HEALTH_ENTRY_ORDER
      .filter((k) => typeof w.contributions[k] === "number")
      .map((k) => `${HEALTH_ENTRY_NAME[k]} ${signedTenths(w.contributions[k] as number)}`);
    const reach = prev ? linkSpanWords(prev.week, w.week) : "";
    return `- ${w.week}: ${Math.round(w.index)} (${prev ? signedTenths(w.index - prev.index) : "?"})${reach} — ${parts.join(", ")}`;
  });
  const sums = HEALTH_ENTRY_ORDER.map((k) => {
    let t = 0;
    let n = 0;
    for (const w of weeks) {
      const c = w.contributions[k];
      if (typeof c === "number" && Number.isFinite(c)) { t += c; n++; }
    }
    return n ? `- ${HEALTH_ENTRY_NAME[k]} (\`${k}\`): ${signedTenths(t)} over ${n} week${n === 1 ? "" : "s"}.${measureOf(k)}` : null;
  }).filter(Boolean);
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const tree = ctx.tree
    ? `\nThe tree went from ${nf(ctx.tree.baselineFiles)} source files at the first scored week to ${nf(ctx.tree.nowFiles)} now — weigh "healthier than then" accordingly.\n`
    : "";
  const own = ownBlock(ctx.own);
  const engine = engineWords(ctx.engine);
  const variants = variantBlock(ctx, weeks.filter((w) => w.gap && w.gapReason === "central").map((w) => w.week));
  const details = detailBlock(ctx);
  const ownFile = ctx.own?.file ?? REPOHEALTH_OWN_FILE;
  const hasOwn = !!ctx.own?.readings.length;
  const advice = [
    ...(hasOwn ? ["- Start from this repo's own readings above: say whether they moved over this span, and what moved them."] : []),
    "- Say plainly that the five index readings are generic measures any tree can be given, and that the change which would help this repo most may move none of them. If that is so, say it, and propose it anyway.",
    `- Where that lever has no measure${ctx.own && !hasOwn ? " — this repo has none of its own yet" : ""}, propose one of this repo's own — what it would count and why it tracks the thing that matters — as a proposal to declare it in ${ownFile} with a script that prints it.`,
    "- Keep it to the few changes worth their cost, about this repo rather than repos in general; a file that is generated or bundled is a case for excluding it from the readings, not for splitting it.",
  ];
  return `${BRAND.displayName}'s health index for ${repoName} went from ${Math.round(first.index)} in the week of ${first.week} to ${Math.round(last.index)} in the week of ${last.week}.${vsLine(ctx.vs, last.index)} It is a score out of 100 against fixed good values for five readings of the repo — file length, re-touched files, escape hatches, CLAUDE.md + skills, untested modules — held within 30 points of its worst entry, and it falls when a reading grows past its good value.${basketHead(ctx)} Each week, with what each reading added or took away in score points:

${rows.join("\n")}
${holdingWords(ctx.now?.alerts, ctx.now?.cap)}
Each reading's total over the whole series, and what kind of number it is:

${sums.join("\n")}
${tree}${details ? `\n${details}\n` : ""}${variants ? `\n${variants}\n` : ""}${own ? `\n${own}\n` : ""}
Is ${repoName} getting healthier? Answer it about the repo — read the git history over this span and the code the readings point at — and use the numbers as what prompted the question, not as the answer. Say over which stretch it improved or slipped, which readings carried that, and whether the work behind them is the repo getting better or only the readings moving (a file split for its own sake, tests added that test nothing, a carried-over week, a count diluted by code growing faster). ${BACKLOG_COMMIT}${engine ? ` ${engine}` : ""}

Then propose what to change for a healthier code base:
${advice.join("\n")}

List the proposals as a numbered list, ordered by what each would buy for what it costs — for each, the change in a few words, then what it buys, what it costs and how to check it worked. Leave out anything that only moves a reading. Then ask the person which ones to put in the backlog, and stop: post nothing until they answer, and expect them to drop, merge or reword some.

When they answer, post only the ones they picked to this repo's backlog with ${BRAND.displayName}'s backlog add (\`POST /api/agent/backlog\`, no \`when\`; your ${BRAND.displayName} skill has the shape), one row per change, as they agreed it. Each row's prompt is the whole instruction a fresh session needs to make that change — what, where, why, and how to check it worked — and its label says the change in a few words. Use a key per change that names it, so asking again does not post it twice. End with the list of rows you posted, one line each, and say they wait in the backlog until the person fires one.

Change no file, run no fix, commit nothing: the backlog rows the person picked are the only thing you write.`;
}

/**
 * The third ask: a design-quality RUN that changes code, after the trend ask
 * has been read. Written from a measured run (picture-app, 2026-10-29): a
 * free-typed "work on anything related to quality" drifted, once the
 * design proposals were done, into rounds of file splits that took the index
 * from 46 to 100 while the repo's own reading moved under one point. So this
 * names the index as NOT the target, allows a split only as part of a design
 * change, keeps tests-first (it found most of that run's bugs), and stops at
 * "only splits remain" with proposals for the backlog. Nothing here is sent:
 * the Send sheet holds the words, and the person adds a budget or stop time.
 */
export function healthQualityRunPrompt(repoName: string, ctx: HealthAskContext = {}): string {
  const own = ownBlock(ctx.own);
  const hasOwn = !!ctx.own?.readings.length;
  const ownFile = ctx.own?.file ?? REPOHEALTH_OWN_FILE;
  const track = hasOwn
    ? "Report this repo's own readings (above) after each round; a round that moves only the health index is a wasted round."
    : `This repo has no reading of its own yet. If the design cause you work on most has a countable measure, declare it in ${ownFile} with a script that prints it, and report it after each round; a round that moves only the health index is a wasted round.`;
  return `Improve ${repoName}'s design, in rounds, until I stop you or the stop condition below is met. ${BRAND.displayName}'s health index is NOT the target: ignore its score, and never make a change because it would move a reading. The target is fewer places bugs come from.
${own ? `\n${own}\n` : ""}
Each round:
1. Re-plan from evidence: the fix commits in the git history (recent first), any bug audit or proposal list from earlier in this conversation, and what the last round found. Name the DESIGN cause behind each class of bug — logic duplicated in two places, a contract only one side enforces, state with two owners, an error path that goes silent, a missing seam that makes code hard to test.
2. Pick the changes that remove a cause rather than one symptom: unify duplicated logic, make an implicit contract explicit and tested on both sides, give state one owner, make an error policy uniform. Design each one before it is built — what changes, what it decouples, what would break if it is wrong — on the strongest model you have; mechanical implementation can go to a cheaper one.
3. A file split is allowed only as part of such a change, and its commit says which responsibility it separates and what now depends on less. Splitting a file for its length is out of scope, and so is any rule about line counts.
4. Tests first wherever behaviour is touched: pin what the code does now, then change it. A bug that turns up becomes its own fix commit with a test that fails without it.
5. Have each change reviewed by someone who did not write it, for behaviour drift and for tests that do not check what they claim, before it lands.
6. ${track}

Stop implementing when the only candidates left are file splits or cosmetic changes. Then review the main areas for design instead, and list what you would change next as proposals — what, why, what it costs, how to check it worked — and ask me which ones to put in the backlog; post nothing until I answer.

Keep the repo's own gate green after every round, and end with: what changed in the design (not the line counts), the bugs found, what each reading of this repo's own did, and what is left.`;
}
