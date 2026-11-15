/**
 * The lookup probe card's words and the pure picks behind it (R-metrics-074), beside
 * `agentReadingsWords.ts`. The host's analysis (shared `analyzeProbe`) supplies the figures; the
 * sentences here are the phone's, so the card never says "better" or "worse": it says found right
 * or not, how many tokens and requests a question took, and whether a ratio sits outside or within
 * the normal variation between repeats. Where a probe comes from is shared `probeSourceText()`,
 * said once on the card and in its `?`.
 */
import { fmtCount, probeDrawKey, probeSourceText, SHARE_MODEL_RE } from "@waterplane/shared";
import type { ProbeAnalysis, ProbeArmSummary, ProbeKind, ProbePairedFigure, ProbeResult, ProbeStatus, SetupShareProbe } from "@waterplane/shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const x2 = (r: number): string => `×${(Math.round(r * 100) / 100).toString()}`;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

export const PROBE_TITLE = "Search test";

/** Under the title, always: what the test is, in one line, for someone who has never run one. */
export const PROBE_WHAT = "Asks the agent questions about this repo whose answers are known, and counts the tokens and requests each answer took.";

/** The three uses, in the order the owner ranked them (model against model first). */
export const PROBE_KINDS: readonly ProbeKind[] = ["models", "baseline", "against"];

/** The kind as a chip says it. */
export const PROBE_KIND_LABEL: Record<ProbeKind, string> = {
  models: "compare two models",
  baseline: "save a baseline",
  against: "rerun against the baseline",
};

/** The kind inside a sentence (headline, share block); open, because a block's kind is an open string. */
export const PROBE_KIND_SHORT: Readonly<Record<string, string>> = {
  models: "model against model",
  baseline: "a baseline",
  against: "against a baseline",
};

/** What each kind does, under its chip. */
export const PROBE_KIND_HELP: Record<ProbeKind, string> = {
  models: "Two models on this desktop's setup as it is now, the questions interleaved between them.",
  baseline: "One model, kept as the \"before\": change the setup afterwards, then rerun against it.",
  against: "The baseline's questions and model again, now, compared with the stored run.",
};

/** The `?` behind the card: what a probe is, what it measures, and where it comes from. */
export function probeHelp(): string {
  return "A search test asks lookup questions with known answers from the repo's committed pool, read-only, in a scratch checkout, and counts the tokens and requests each answer took. Correctness is a gate: the figures are compared only when both sides found about as many right. A ratio is said outside or within the normal variation between repeats of the same question; it says how far finding things moved, and nothing about building. It is started only by a tap, against the estimate shown before it. " + probeSourceText();
}

export const PROBE_MODELS_ASK = "The two models (ids as the CLI takes them):";
export const PROBE_MODEL_B_MISSING = "Type a second, different model to compare against — then the start appears here.";
export const PROBE_BASELINE_ASK = "The model the baseline runs on:";
export const PROBE_MODEL_MISSING = "Type a model id — then the start appears here.";
export const PROBE_AGAINST_NONE = "No baseline is stored on this desktop yet: save one first, change the setup, then rerun against it.";
export const PROBE_RUNNING_ELSEWHERE = "A search test is running for this repo, so a new one cannot start until it finishes.";
export const PROBE_POOL_READING = "Reading the repo's test questions…";
export const PROBE_RESULTS_NONE = "No search test has run for this repo on this desktop yet.";

/**
 * The stored results were not read (offline, an older desktop, a failed fetch, or still loading):
 * that is not "none" and no card may say "none run yet" or "no baseline is stored" off it.
 * `loading` is the first read still on its way.
 */
export function probeResultsUnreadLine(loading: boolean, error?: string | null): string {
  return loading ? "Reading the stored search test results…" : `The stored search test results could not be read${error ? `: ${error}` : ""}, so whether one exists is not known.`;
}

export function probeAgainstWhich(base: ProbeResult): string {
  return `Against the baseline of ${dayOf(base.finishedAt ?? base.startedAt)} on ${base.arms[0]?.model ?? "its model"} (${plural(base.questions.length, "question")}, ${plural(base.repeats, "repeat")}).`;
}

/** The two-tap's second label: the price, in dollars when priced, tokens beside. */
export function probeConfirmText(e: { tokens: number; usd: number | null }): string {
  return e.usd == null ? `spend about ${fmtCount(e.tokens)} tokens?` : `spend about $${e.usd.toFixed(2)}?`;
}

export function probeStartedText(): string {
  return "The search test started on the desktop. Its progress shows here; you can leave this screen.";
}

/** Progress while a run is live. */
export function probeStatusLine(s: ProbeStatus): string {
  const n = s.of ? `${s.done ?? 0} of ${plural(s.of, "question")} asked` : "starting";
  return `Running on this desktop: ${n}${s.note ? ` — ${s.note}` : ""}.`;
}

/** The result's heading: kind and day. */
export function probeResultTitle(r: ProbeResult): string {
  return `${PROBE_KIND_SHORT[r.kind] ?? r.kind}, ${dayOf(r.finishedAt ?? r.startedAt)}`;
}

/** The arm labels the card uses: model ids, or before/now for a rerun against a baseline. */
export function probeArmLabels(r: ProbeResult, base: ProbeResult | null): { a?: string; b?: string } {
  if (r.kind === "against") return { a: `before (${base?.arms[0]?.model ?? "baseline"})`, b: `now (${r.arms[0]?.model ?? "?"})` };
  return { a: r.arms[0]?.model, b: r.arms[1]?.model };
}

/** The correctness gate, pass or fail, with the counts; never "worse". */
export function probeGateLine(arms: readonly { label: string; s: ProbeArmSummary }[], pass: boolean): string {
  const said = arms.map(({ label, s }) => `${label} ${s.correct} of ${s.runs}${s.capHits ? ` (${s.capHits} at the turn cap)` : ""}`).join(", ");
  return pass
    ? `Correctness gate passed: ${said} found right, so tokens and requests are compared.`
    : `Correctness gate not passed: ${said} found right — too few, or too far apart, so tokens and requests are not compared.`;
}

/** One arm's figures per question. */
export function probeArmLine(label: string, s: ProbeArmSummary): string {
  const tok = s.medianTokens !== undefined ? `${fmtCount(s.medianTokens)} tokens (fresh input, cache write, cache read and output together)` : "tokens not reported";
  const req = s.medianRequests !== undefined ? `${s.medianRequests} requests` : "requests not reported";
  const err = s.errors ? `; ${plural(s.errors, "run")} gave no answer and ${s.errors === 1 ? "is" : "are"} left out` : "";
  return `${label}: median ${tok} and ${req} a question${err}.`;
}

/** One paired figure, B against A, with its interval and its band. */
export function probePairLine(what: string, f: ProbePairedFigure, a: string, b: string): string {
  const ci = f.lo != null && f.hi != null ? ` (95% ${f.lo.toFixed(2)}–${f.hi.toFixed(2)})` : "";
  const band = `±${Math.round(f.band * 100)}% between repeats${f.bandFromPrior ? ", the pilot's band: this run had no repeats" : ""}`;
  return `${what}: ${b} ${x2(f.ratio)} of ${a}${ci}, ${f.outside ? "outside" : "within"} normal variation (${band}).`;
}

export function probeVoidLine(why: string): string {
  return `Void: ${why}. No figure of this run is read.`;
}

/** The headline's one line for the newest result. */
export function probeLastLine(r: ProbeResult, an: ProbeAnalysis, base: ProbeResult | null = null): string {
  const head = `Last search test: ${probeResultTitle(r)}`;
  if (an.void) return `${head} — void (${an.void}).`;
  if (an.paired) {
    // The ratio is B of A (`probePairLine`): name both sides, and say requests beside tokens, never a bare number.
    const { a, b } = probeArmLabels(r, base);
    const A = a ?? an.paired.a, B = b ?? an.paired.b;
    const fig = (what: string, f: ProbePairedFigure) => `${what} ${B} ${x2(f.ratio)} of ${A}, ${f.outside ? "outside" : "within"} normal variation`;
    return `${head} — ${fig("tokens", an.paired.tokens)}; ${fig("requests", an.paired.requests)}; correctness gate passed.`;
  }
  if (r.kind === "baseline") return `${head} — ${an.gate.pass ? "kept as a baseline" : "kept, correctness gate not passed"}.`;
  return `${head} — ${an.gate.pass ? "not compared" : "correctness gate not passed"}.`;
}

/**
 * The export block's probe slot (R-metrics-073) from the newest single-arm result (a baseline or a rerun, never
 * model against model) that is not void and answered something: its end day, its kind, the share found right over every answered run, and
 * the median tokens a question over those runs. Null when none qualifies.
 */
export function probeShareOf(results: readonly { result: ProbeResult; analysis: ProbeAnalysis }[]): SetupShareProbe | null {
  for (const { result: r, analysis: an } of results) {
    if (an.void || r.void) continue;
    // A model-against-model result has two arms and the slot names no model: one pooled figure would
    // describe neither. Its slot stays empty; the next qualifying single-arm result is read instead.
    if (r.kind === "models" || r.arms.length !== 1) continue;
    const runs = r.runs.filter((x) => !x.error);
    if (!runs.length) continue;
    const tok = runs.flatMap((x) => (x.tokens ? [x.tokens.in + x.tokens.cw + x.tokens.cr + x.tokens.out] : [])).sort((a, b) => a - b);
    if (!tok.length) continue;
    const m = tok.length % 2 ? tok[(tok.length - 1) / 2]! : (tok[tok.length / 2 - 1]! + tok[tok.length / 2]!) / 2;
    // The model and the draw travel with the figures: each desktop draws its own questions and a probe's model is typed, so
    // without them two people's lines read as a setup difference that is a model or a draw difference.
    const model = r.arms[0]?.model;
    // `id` on a run record is the QUESTION it asked (not a run id): the distinct questions over the answered runs.
    const questionIds = runs.map((x) => x.id);
    const asked = [...new Set(questionIds)];
    return {
      day: dayOf(r.finishedAt ?? r.startedAt), kind: r.kind, correct: runs.filter((x) => x.correct).length / runs.length, tokPerQuestion: Math.round(m), repeats: r.repeats,
      ...(model && SHARE_MODEL_RE.test(model) ? { model } : {}),
      // Counted over the questions an answered run asked, not the drawn list: a run that stopped early drew more than it asked.
      ...(asked.length >= 1 && asked.length <= 1000 ? { questions: asked.length, draw: probeDrawKey(asked) } : {}),
    };
  }
  return null;
}
