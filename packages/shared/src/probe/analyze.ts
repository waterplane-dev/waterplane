/**
 * What a probe result says, and how sure it is. Pure.
 *
 * From the pilot (2026-11-14, on this repo, 20 hard questions, A/A/A + one B): correctness sits at the
 * ceiling, so it is a pass/fail GATE and never the headline. The headline is tokens and requests at
 * equal correctness, paired per question on the log scale (pooled per-question repeat log SD ≈ 0.22;
 * 20 paired questions resolve about ±15% at 1 repeat, ±8% at 3). Calls are noisier (CV 16%), and
 * dollars are never a figure: the prompt cache decides them.
 */
import { medianOf } from "../agentseries/stats.js";
import { fmtCount } from "../tokens.js";
import type {
  ProbeAnalysis, ProbeArmSummary, ProbeFingerprint, ProbePairedFigure, ProbeResult, ProbeRunRecord,
} from "../wire/probe.js";

/** The pilot's pooled per-question repeat log SD, used when a result has no repeats of its own. */
export const PROBE_PRIOR_LOG_SD = 0.22;
/** The fewest paired questions a ratio is shown for. */
export const PROBE_MIN_PAIRED = 10;
/** The gate: every arm right on at least this share of its runs… */
export const PROBE_GATE_MIN = 0.9;
/** …and the arms' shares no further apart than this. */
export const PROBE_GATE_GAP = 0.1;

type Metric = "tokens" | "requests" | "calls";
const totalOf = (r: ProbeRunRecord): number | null => (r.tokens ? r.tokens.in + r.tokens.cw + r.tokens.cr + r.tokens.out : null);
const valueOf = (r: ProbeRunRecord, m: Metric): number | null =>
  m === "tokens" ? totalOf(r) : m === "requests" ? r.requests : r.toolCalls + 1; // calls+1: a zero-call answer has a log
const usable = (r: ProbeRunRecord): boolean => !r.error;

function armSummary(result: ProbeResult, arm: string, model: string): ProbeArmSummary {
  const rs = result.runs.filter((r) => r.arm === arm);
  const ok = rs.filter(usable);
  const med = (xs: (number | null)[]): number | undefined => {
    const v = medianOf(xs.filter((x): x is number => x != null));
    return v == null ? undefined : v;
  };
  const tok = med(ok.map(totalOf));
  const req = med(ok.map((r) => r.requests));
  const calls = med(ok.map((r) => r.toolCalls));
  return {
    arm, model, runs: ok.length, correct: ok.filter((r) => r.correct).length,
    capHits: ok.filter((r) => r.capHit).length, errors: rs.length - ok.length,
    ...(tok != null ? { medianTokens: tok } : {}), ...(req != null ? { medianRequests: req } : {}), ...(calls != null ? { medianCalls: calls } : {}),
  };
}

const share = (a: ProbeArmSummary): number => (a.runs ? a.correct / a.runs : 0);
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The correctness gate over the arms compared. */
export function probeGate(arms: readonly ProbeArmSummary[]): { pass: boolean; text: string } {
  const said = arms.map((a) => `${a.model} ${a.correct} of ${a.runs}${a.capHits ? ` (${a.capHits} at the turn cap)` : ""}`).join(", ");
  if (arms.some((a) => a.runs === 0)) return { pass: false, text: `An arm has no answered run, so nothing is compared (${said}).` };
  const low = arms.filter((a) => share(a) < PROBE_GATE_MIN);
  const gap = Math.max(...arms.map(share)) - Math.min(...arms.map(share));
  if (low.length) return { pass: false, text: `Found right: ${said}. Under ${pct(PROBE_GATE_MIN)}, so this setup finds things worse there and tokens are not compared.` };
  if (gap > PROBE_GATE_GAP) return { pass: false, text: `Found right: ${said}. The arms differ by more than ${pct(PROBE_GATE_GAP)}, so tokens are not compared.` };
  return { pass: true, text: `Found right: ${said} — correctness passes, so the comparison is on tokens and requests.` };
}

/** Per question, the log values of one arm's usable runs. */
function logsBy(runs: readonly ProbeRunRecord[], arm: string, m: Metric): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of runs) {
    if (r.arm !== arm || !usable(r)) continue;
    const v = valueOf(r, m);
    if (v == null || !(v > 0)) continue;
    const l = out.get(r.id) ?? [];
    l.push(Math.log(v));
    out.set(r.id, l);
  }
  return out;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * B against A, paired over `ids`. The band is the repeat noise alone: what two runs of the SAME arm
 * would differ by at this n — pooled from this result's own repeats where it has them, else the
 * pilot's prior, said.
 */
function paired(aRuns: readonly ProbeRunRecord[], a: string, bRuns: readonly ProbeRunRecord[], b: string, ids: readonly string[], m: Metric): ProbePairedFigure | null {
  const A = logsBy(aRuns, a, m), B = logsBy(bRuns, b, m);
  const d: number[] = [];
  const within: number[] = [];
  let ra = 0, rb = 0;
  for (const id of ids) {
    const la = A.get(id), lb = B.get(id);
    if (!la?.length || !lb?.length) continue;
    d.push(mean(lb) - mean(la));
    ra += la.length; rb += lb.length;
    if (la.length >= 2) within.push(sd(la) ** 2);
    if (lb.length >= 2) within.push(sd(lb) ** 2);
  }
  const n = d.length;
  if (n === 0) return null;
  const md = mean(d);
  const bandFromPrior = within.length === 0;
  const s = bandFromPrior ? PROBE_PRIOR_LOG_SD : Math.sqrt(mean(within));
  const bandLog = 1.96 * s * Math.sqrt(1 / (ra / n) + 1 / (rb / n)) / Math.sqrt(n);
  const se = n >= 3 ? sd(d) / Math.sqrt(n) : null;
  return {
    ratio: Math.exp(md),
    ...(se != null ? { lo: Math.exp(md - 1.96 * se), hi: Math.exp(md + 1.96 * se) } : {}),
    band: Math.exp(bandLog) - 1,
    bandFromPrior,
    outside: Math.abs(md) > bandLog,
  };
}

/** Question ids every run of both arms answered right. */
function equalCorrect(aRuns: readonly ProbeRunRecord[], a: string, bRuns: readonly ProbeRunRecord[], b: string, ids: readonly string[]): string[] {
  const allRight = (runs: readonly ProbeRunRecord[], arm: string, id: string): boolean => {
    const rs = runs.filter((r) => r.arm === arm && r.id === id && usable(r));
    return rs.length > 0 && rs.every((r) => r.correct);
  };
  return ids.filter((id) => allRight(aRuns, a, id) && allRight(bRuns, b, id));
}

const x2 = (v: number): string => `${v.toFixed(2)}×`;

/** One figure in words: "B took 1.20× A's tokens (95% 1.00–1.43), outside the ±14% repeat noise". */
export function probeFigureText(label: string, f: ProbePairedFigure, a: string, b: string): string {
  const ci = f.lo != null && f.hi != null ? ` (95% ${f.lo.toFixed(2)}–${f.hi.toFixed(2)})` : "";
  const band = `±${Math.round(f.band * 100)}% repeat noise${f.bandFromPrior ? " (the pilot's, this run had no repeats)" : ""}`;
  return `${b} took ${x2(f.ratio)} ${a}'s ${label}${ci}, ${f.outside ? "outside" : "inside"} the ${band}.`;
}

/**
 * The analysis of one result. For `against`, pass the baseline: A is the baseline's arm, B this
 * result's. For `models`, A and B are the result's first two arms. A `baseline` alone has arms and
 * a gate, no pair.
 */
export function analyzeProbe(result: ProbeResult, baseline?: ProbeResult | null): ProbeAnalysis {
  const arms = result.arms.map((a) => armSummary(result, a.arm, a.model));
  const lines: string[] = [];
  const voidWhy = result.void ?? (baseline?.void ? `its baseline is void: ${baseline.void}` : undefined);
  if (voidWhy) {
    return { arms, gate: { pass: false, text: "Void: no figure is read." }, void: voidWhy, pairedAbsent: voidWhy, lines: [`This run is void: ${voidWhy}.`] };
  }
  if (result.stopped) lines.push(`Stopped early: ${result.stopped}.`);

  let aRuns = result.runs, bRuns = result.runs, a: string | undefined, b: string | undefined, aModel = "", bModel = "";
  let compared = arms;
  if (result.kind === "against") {
    if (!baseline) {
      const why = "the baseline it was run against is no longer stored";
      return { arms, gate: probeGate(arms), pairedAbsent: why, lines: [...lines, `Not compared: ${why}.`] };
    }
    const base = baseline.arms[0]!, now = result.arms[0]!;
    aRuns = baseline.runs; a = base.arm; aModel = `before (${base.model})`;
    b = now.arm; bModel = `now (${now.model})`;
    compared = [armSummary(baseline, base.arm, `before (${base.model})`), { ...arms[0]!, model: `now (${now.model})` }];
    const fb = baseline.fingerprints[base.arm], fn = result.fingerprints[now.arm];
    const diff = fb && fn ? probeFingerprintDiff(fb, fn) : "";
    if (diff) lines.push(diff);
    if (fb && fn && fb.backend !== fn.backend) {
      return { arms, gate: probeGate(arms), pairedAbsent: "the two runs are from different backends", lines };
    }
  } else if (result.arms.length >= 2) {
    a = result.arms[0]!.arm; b = result.arms[1]!.arm; aModel = result.arms[0]!.model; bModel = result.arms[1]!.model;
  }
  const gate = probeGate(compared);
  lines.push(gate.text);
  for (const s of compared) {
    if (s.medianTokens != null) {
      lines.push(`${s.model}: median ${fmtCount(s.medianTokens)} tokens, ${s.medianRequests ?? "–"} requests and ${s.medianCalls ?? "–"} tool calls a question.`);
    }
  }
  if (!a || !b) return { arms, gate, pairedAbsent: "one arm only: this is a baseline for a later run", lines };
  if (!gate.pass) return { arms, gate, pairedAbsent: gate.text, lines };

  const ids = equalCorrect(aRuns, a, bRuns, b, result.questions);
  if (ids.length < PROBE_MIN_PAIRED) {
    const why = `only ${ids.length} questions were answered right every time in both arms; a ratio needs ${PROBE_MIN_PAIRED}`;
    return { arms, gate, pairedAbsent: why, lines: [...lines, `Not compared: ${why}.`] };
  }
  const tokens = paired(aRuns, a, bRuns, b, ids, "tokens");
  const requests = paired(aRuns, a, bRuns, b, ids, "requests");
  const calls = paired(aRuns, a, bRuns, b, ids, "calls");
  if (!tokens || !requests || !calls) {
    const why = "the runs reported no token usage";
    return { arms, gate, pairedAbsent: why, lines: [...lines, `Not compared: ${why}.`] };
  }
  lines.push(`Over the ${ids.length} questions both found every time:`);
  lines.push(probeFigureText("tokens", tokens, aModel, bModel));
  lines.push(probeFigureText("requests", requests, aModel, bModel));
  lines.push(`${probeFigureText("tool calls", calls, aModel, bModel)} Calls repeat least well; read tokens first.`);
  lines.push("This measures finding things with read-only tools, not building: say “finds as well / worse”, never “works better”.");
  return { arms, gate, paired: { a, b, n: ids.length, tokens, requests, calls }, lines };
}

/**
 * How a baseline's setup differs from now, in words ("" when it does not): the reason a before and
 * an after can differ although nobody changed anything on purpose (memory grows daily).
 */
export function probeFingerprintDiff(before: ProbeFingerprint, now: ProbeFingerprint): string {
  const out: string[] = [];
  if (before.backend !== now.backend) out.push(`backend ${before.backend} → ${now.backend} (not comparable)`);
  if (before.model && now.model && before.model !== now.model) out.push(`model ${before.model} → ${now.model}`);
  if (before.cli && now.cli && before.cli !== now.cli) out.push(`CLI ${before.cli} → ${now.cli}`);
  if (before.startTok != null && now.startTok != null && Math.abs(now.startTok - before.startTok) >= 200) {
    const d = now.startTok - before.startTok;
    out.push(`start context ${d > 0 ? "+" : "−"}${fmtCount(Math.abs(d))} tokens`);
  }
  if (before.commit !== now.commit) out.push(`commit ${before.commit.slice(0, 8)} → ${now.commit.slice(0, 8)}`);
  return out.length ? `The baseline's setup differs in: ${out.join(", ")}.` : "";
}
