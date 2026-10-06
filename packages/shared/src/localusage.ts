/**
 * The local runner's ledger (`wire/localusage.ts`): the folds and the sentences
 * both ends use. Pure.
 *
 * Folding is ADDITION for counts and durations and MAX/MIN for peaks — a peak
 * is never averaged, a mean is never derived from anything but a sum and the
 * count it was summed over, and a rate is a ratio of SUMS (`perRequest.ts`'s
 * rule). A field nobody measured stays absent through every fold.
 */
import type {
  LocalCompute, LocalLoads, LocalMachine, LocalMemory, LocalModelDay, LocalUsageAvailable, LocalUsageDay, LocalWall,
} from "./wire/localusage.js";

const addCompute = (a: LocalCompute | undefined, b: LocalCompute | undefined): LocalCompute | undefined =>
  !a ? (b ? { ...b } : undefined) : !b ? a : {
    requests: a.requests + b.requests, promptTok: a.promptTok + b.promptTok, promptMs: a.promptMs + b.promptMs,
    cachedTok: a.cachedTok + b.cachedTok, genTok: a.genTok + b.genTok, genMs: a.genMs + b.genMs,
  };

const addWall = (a: LocalWall | undefined, b: LocalWall | undefined): LocalWall | undefined =>
  !a ? (b ? { ...b } : undefined) : !b ? a : { requests: a.requests + b.requests, ms: a.ms + b.ms };

const addLoads = (a: LocalLoads | undefined, b: LocalLoads | undefined): LocalLoads | undefined =>
  !a ? (b ? { ...b } : undefined) : !b ? a : { loads: a.loads + b.loads, ms: a.ms + b.ms };

const addMem = (a: LocalMemory | undefined, b: LocalMemory | undefined): LocalMemory | undefined => {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  const ctx = b.contextLength ?? a.contextLength;
  return {
    samples: a.samples + b.samples, sumBytes: a.sumBytes + b.sumBytes, peakBytes: Math.max(a.peakBytes, b.peakBytes),
    sumVram: a.sumVram + b.sumVram, peakVram: Math.max(a.peakVram, b.peakVram), residentMs: a.residentMs + b.residentMs,
    ...(ctx != null ? { contextLength: ctx } : {}),
  };
};

const addMachine = (a: LocalMachine | undefined, b: LocalMachine | undefined): LocalMachine | undefined => {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  const swap = a.swapPeak == null ? b.swapPeak : b.swapPeak == null ? a.swapPeak : Math.max(a.swapPeak, b.swapPeak);
  return {
    samples: a.samples + b.samples, usedSum: a.usedSum + b.usedSum, usedPeak: Math.max(a.usedPeak, b.usedPeak),
    availMin: Math.min(a.availMin, b.availMin), totalBytes: Math.max(a.totalBytes, b.totalBytes),
    ...(swap != null ? { swapPeak: swap } : {}), source: b.source,
  };
};

function addApi(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** `a + b` for one model. Returns a NEW row; neither input is touched. */
export function addModelDay(a: LocalModelDay, b: LocalModelDay): LocalModelDay {
  const out: LocalModelDay = { model: a.model };
  const set = <K extends keyof LocalModelDay>(k: K, v: LocalModelDay[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set("compute", addCompute(a.compute, b.compute));
  set("timed", addWall(a.timed, b.timed));
  set("untimed", addWall(a.untimed, b.untimed));
  set("loads", addLoads(a.loads, b.loads));
  set("byApi", addApi(a.byApi, b.byApi));
  set("mem", addMem(a.mem, b.mem));
  set("machine", addMachine(a.machine, b.machine));
  return out;
}

/** The days on or after `fromDay` (`YYYY-MM-DD`, lexical = calendar), folded per model.
 *  Sorted: identified models by compute time, then the unidentified row last. */
export function localModelTotals(days: readonly LocalUsageDay[], fromDay?: string): LocalModelDay[] {
  const by = new Map<string | null, LocalModelDay>();
  for (const d of days) {
    if (fromDay && d.day < fromDay) continue;
    for (const m of d.models) {
      const prev = by.get(m.model);
      by.set(m.model, prev ? addModelDay(prev, m) : addModelDay({ model: m.model }, m));
    }
  }
  return [...by.values()].sort((a, b) =>
    (a.model === null ? 1 : 0) - (b.model === null ? 1 : 0)
    || computeMs(b) - computeMs(a)
    || (b.mem?.residentMs ?? 0) - (a.mem?.residentMs ?? 0)
    || String(a.model).localeCompare(String(b.model)));
}

/** The runner's busy time: prompt processing + generation. Loading is NOT in it. */
export function computeMs(m: LocalModelDay): number {
  return m.compute ? m.compute.promptMs + m.compute.genMs : 0;
}

/** Every request a row saw: with runner timings, plus those with time to answer only. */
export function requestCount(m: LocalModelDay): number {
  return (m.compute?.requests ?? 0) + (m.untimed?.requests ?? 0);
}

/** Tokens per second, from MEASURED sums only — null unless both are positive. */
export function tokPerSec(tok: number | undefined, ms: number | undefined): number | null {
  if (!tok || !ms || tok <= 0 || ms <= 0) return null;
  return tok / (ms / 1000);
}

/** Mean of samples, or null with none. */
export function meanOf(sum: number | undefined, n: number | undefined): number | null {
  return n && n > 0 && sum != null ? sum / n : null;
}

/** `YYYY-MM-DD` in local time. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A duration as a person reads it: `850 ms`, `12.4 s`, `4 min 12 s`, `2 h 10 min`. */
export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m - h * 60} min`;
}

/** The one sentence for a `model: null` row. */
export const UNATTRIBUTED_WHY =
  "The runner's log does not name the model. This host ties a request to one by what /api/ps said was resident around it; "
  + "when it was not watching at the time, when a load happened that ps did not show, or when two resident models could not be told apart, "
  + "the request is counted here instead of being guessed onto one.";

/**
 * What the Local runner view says INSTEAD of figures, or above them. Each is a
 * different fact and they are never collapsed: off, not running, no request
 * yet, log unreadable. Returns the sentences that apply, most important first.
 */
export function localUsageNotes(doc: LocalUsageAvailable, fmtTime: (ms: number) => string): string[] {
  const out: string[] = [];
  if (doc.reachable === false) {
    out.push(`Ollama is not running — it did not answer on ${doc.url}${doc.lastSampleAt ? ` at ${fmtTime(doc.lastSampleAt)}` : ""}. Nothing is sampled until it does.`);
  } else if (doc.reachable === null) {
    out.push(`Ollama has not been asked yet — the first sample is taken within ${Math.round(doc.intervalMs / 1000)} s of the host starting.`);
  }
  if (!doc.log.readable) out.push(`Server log not readable: ${doc.log.reason} Compute time and tokens need it; memory is still sampled.`);
  const any = doc.days.some((d) => d.models.some((m) => requestCount(m) > 0));
  if (!any && doc.log.readable) out.push(`No request seen yet — the runner's log has recorded no completed request since ${fmtTime(doc.since)}.`);
  return out;
}
