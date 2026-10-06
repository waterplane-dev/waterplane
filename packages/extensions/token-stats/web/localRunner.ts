/**
 * The "Local runner" view's words and cuts — pure, so `node --test` runs it.
 *
 * What the RUNNER did (`GET /api/localusage`), per model: compute time, tokens,
 * memory. Three rules hold every line here:
 *  - **The runner's own durations and "time to answer" are never mixed.** Busy
 *    time is prompt processing + generation (the runner's `print_timing`);
 *    loading is its own line; time to answer is the HTTP request's wall time,
 *    which includes waiting in the runner's queue, and is SAID to.
 *  - **A total is never printed without its split** (busy → prompt / generate;
 *    tokens → processed / reused / generated; requests → by endpoint).
 *  - **Absent is a sentence, never a zero**, and a rate is a ratio of measured sums.
 */
import {
  computeMs, fmtBytes, fmtCount, fmtDurationMs, localDayKey, localModelTotals, meanOf, requestCount, tokPerSec,
  type LocalModelDay, type LocalUsageDoc, type LocalUsageDay,
} from "@waterplane/shared";

export type RunnerSpan = "today" | "7" | "30" | "all";
export const RUNNER_SPANS: { id: RunnerSpan; label: string }[] = [
  { id: "today", label: "today" }, { id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "all", label: "all" },
];

/** The first day (`YYYY-MM-DD`) a span keeps, or undefined for all. */
export function spanFromDay(span: RunnerSpan, now: number): string | undefined {
  if (span === "all") return undefined;
  const back = span === "today" ? 0 : Number(span) - 1;
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  return localDayKey(d.getTime());
}

/** Whether the picker offers the tab: the host has the ledger AND it has seen
 *  the runner or holds a day. Absent (not dimmed) otherwise — a desktop with no
 *  local models gets no empty tab. */
export function showRunnerTab(doc: LocalUsageDoc | null | undefined): boolean {
  return !!doc && doc.available === true && (doc.reachable === true || doc.days.length > 0);
}

export interface RunnerModelView {
  key: string;
  title: string;
  unidentified: boolean;
  /** Runner busy time — the total, then its split. */
  busy: { total: string; split: string[] } | null;
  /** Requests — the total, then by endpoint. */
  requests: { total: string; split: string[] } | null;
  answer: string | null;
  untimed: string | null;
  loads: string | null;
  tokens: { total: string; split: string[] } | null;
  rates: string[];
  memory: string[];
  machine: string[];
  /** One sentence per family with nothing measured. */
  absent: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const rate = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} tok/s`;

export function runnerModelView(m: LocalModelDay): RunnerModelView {
  const c = m.compute;
  const absent: string[] = [];
  const busyMs = computeMs(m);
  const busy = c && busyMs > 0 ? {
    total: fmtDurationMs(busyMs),
    split: [`prompt processing ${fmtDurationMs(c.promptMs)}`, `generating ${fmtDurationMs(c.genMs)}`],
  } : null;
  const nReq = requestCount(m);
  const apis = Object.entries(m.byApi ?? {}).sort((a, b) => b[1] - a[1]);
  const apiTotal = apis.reduce((a, [, n]) => a + n, 0);
  const requests = nReq > 0 ? {
    total: plural(nReq, "request"),
    split: [
      ...apis.map(([p, n]) => `${p} ${n.toLocaleString()}`),
      ...(nReq > apiTotal ? [`endpoint not paired ${(nReq - apiTotal).toLocaleString()}`] : []),
    ],
  } : null;
  const answer = m.timed && m.timed.requests > 0
    ? `Time to answer ${fmtDurationMs(m.timed.ms)} over ${plural(m.timed.requests, "request")} — the HTTP request from arrival to last byte, including waiting in the runner's queue and any load; not compute.`
    : null;
  const untimed = m.untimed && m.untimed.requests > 0
    ? `${plural(m.untimed.requests, "request")} with no runner timings in its log — time to answer only: ${fmtDurationMs(m.untimed.ms)}.`
    : null;
  const loads = m.loads && m.loads.loads > 0 ? `Loading ${fmtDurationMs(m.loads.ms)} over ${plural(m.loads.loads, "load")} — not in the busy time.` : null;
  if (!busy) absent.push(nReq > 0 ? "No runner timings for these requests — only their time to answer." : "No request tied to this model in this span.");

  const tokens = c && c.promptTok + c.cachedTok + c.genTok > 0 ? {
    total: `${fmtCount(c.promptTok + c.cachedTok + c.genTok)} tokens`,
    split: [
      `prompt processed ${fmtCount(c.promptTok)}`,
      `prompt reused from the runner's cache ${fmtCount(c.cachedTok)}`,
      `generated ${fmtCount(c.genTok)}`,
    ],
  } : null;
  const rates: string[] = [];
  const pr = tokPerSec(c?.promptTok, c?.promptMs);
  const gr = tokPerSec(c?.genTok, c?.genMs);
  if (pr != null) rates.push(`prompt processing ${rate(pr)}`);
  if (gr != null) rates.push(`generation ${rate(gr)}`);

  const memory: string[] = [];
  const mem = m.mem;
  if (mem && mem.samples > 0) {
    const mean = meanOf(mem.sumBytes, mem.samples)!;
    memory.push(`Resident ${fmtBytes(mean)} typical (mean of ${plural(mem.samples, "sample")}), ${fmtBytes(mem.peakBytes)} at peak.`);
    const vMean = meanOf(mem.sumVram, mem.samples)!;
    const share = mem.peakBytes > 0 ? mem.peakVram / mem.peakBytes : null;
    memory.push(`On the GPU ${fmtBytes(vMean)} typical, ${fmtBytes(mem.peakVram)} at peak${share != null ? ` (${Math.round(share * 100)}% of it — unified memory reads 100%)` : ""}.`);
    memory.push(`Seen resident for ${fmtDurationMs(mem.residentMs)}${mem.contextLength ? `, with a ${fmtCount(mem.contextLength)}-token context` : ""}.`);
  } else absent.push("No memory reading — the runner was not sampled while this model was loaded.");
  const machine: string[] = [];
  const mc = m.machine;
  if (mc && mc.samples > 0) {
    const used = meanOf(mc.usedSum, mc.samples)!;
    machine.push(`While it was loaded the desktop used ${fmtBytes(used)} of ${fmtBytes(mc.totalBytes)} typical, ${fmtBytes(mc.usedPeak)} at peak; ${fmtBytes(mc.availMin)} was the least left available.`);
    if (mc.swapPeak != null) machine.push(`Swap in use at most ${fmtBytes(mc.swapPeak)}.`);
  }
  return {
    key: m.model ?? "\u0000unidentified",
    title: m.model ?? "model not identified",
    unidentified: m.model === null,
    busy, requests, answer, untimed, loads, tokens, rates, memory, machine, absent,
  };
}

/** The views for a span, identified models first. */
export function runnerViews(days: readonly LocalUsageDay[], fromDay?: string): RunnerModelView[] {
  return localModelTotals(days, fromDay).map(runnerModelView);
}

export interface RunnerDayRow { key: string; day: string; model: string; text: string }

/** One line per model per day, newest day first — the per-day split of the cards above. */
export function runnerDayRows(days: readonly LocalUsageDay[], fromDay?: string): RunnerDayRow[] {
  const out: RunnerDayRow[] = [];
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (fromDay && d.day < fromDay) continue;
    for (const m of localModelTotals([d])) {
      const parts: string[] = [];
      const busy = computeMs(m);
      if (busy > 0 && m.compute) parts.push(`busy ${fmtDurationMs(busy)} (prompt ${fmtDurationMs(m.compute.promptMs)} · generate ${fmtDurationMs(m.compute.genMs)})`);
      if (m.compute) parts.push(`${fmtCount(m.compute.promptTok + m.compute.cachedTok)} prompt · ${fmtCount(m.compute.genTok)} generated`);
      const n = requestCount(m);
      if (n > 0) parts.push(plural(n, "request"));
      if (m.mem && m.mem.samples > 0) parts.push(`peak ${fmtBytes(m.mem.peakBytes)}`);
      if (!parts.length) continue;
      out.push({ key: `${d.day}:${m.model ?? ""}`, day: d.day, model: m.model ?? "model not identified", text: parts.join(" · ") });
    }
  }
  return out;
}

/** The All-backends card: a few lines, or the sentence instead. */
export function runnerCardLines(doc: LocalUsageDoc | null): { absent?: string; lines?: string[]; lastDay?: string | null } {
  if (!doc) return { absent: "The local runner's ledger has not been read yet." };
  if (doc.available === false) return { absent: doc.reason };
  const views = runnerViews(doc.days);
  if (!views.length) {
    return { absent: doc.reachable === false ? `Ollama is not running — nothing recorded yet.` : "No request or resident model recorded yet." };
  }
  const lines = views.slice(0, 4).map((v) => [
    v.title,
    v.busy ? `busy ${v.busy.total} (${v.busy.split.join(" · ")})` : null,
    v.tokens ? `${v.tokens.total} (${v.tokens.split.join(" · ")})` : null,
  ].filter(Boolean).join(" — "));
  if (views.length > 4) lines.push(`and ${plural(views.length - 4, "more model")} on the Local runner tab.`);
  return { lines, lastDay: doc.days.length ? doc.days[doc.days.length - 1].day : null };
}
