/**
 * The cost window, read: where a span's money went, cut the ways a person asks.
 *
 * `GET /api/costwindow` hands the phone a `CostWindowDoc` (wire/costwindow.ts):
 * hours, conversations and totals for an arbitrary `[from, to)`. This module is
 * everything both ends must agree on about it, so the host's push and the
 * phone's card cannot say two different things about one week:
 *
 *  - **the hour** (`hourFloor`/`hourKey`/`hourKeyMs`) — the finest bucket on
 *    record, host-local, one copy;
 *  - **the one bucketing function** (`weekCut`) — the number on an hour and the
 *    list that hour opens come from the same predicate over `CostConvo.byHour`,
 *    because a count on a control is a filter;
 *  - **what launched it** (`foldLaunches`) — a fan-out run is ONE row, not the
 *    thirty-six sessions it opened;
 *  - **repos ranked with their sessions** (`rankRepos`);
 *  - **weekly points** (`ptsCalibration`) — dollars per point of the weekly
 *    limit, from the usage log's climb against the ledger's cost over the same
 *    hours. A HEURISTIC, so it refuses (in words) rather than guessing: too few
 *    readings, too short, unstable, or disagreeing with the per-reading level
 *    calibration is a refusal, never a number;
 *  - two per-session/per-run sentences (`agentModelInsight`, `fanoutHintText`).
 *
 * No clock in here: anything that needs "now" takes it. Every output is a
 * reading or a sentence — nothing applies itself.
 */
import type { CostBreakdown } from "./pricing.js";
import { addCost, fmtUsd, normalizeModel, zeroCost } from "./pricing.js";
import { addTotals, hourToMs, tokenTotal, zeroTotals } from "./tokens.js";
import type { ModelSlice, TokenGroup, TokenTotals, UsageSample } from "./wire/telemetry.js";
import type { CostConvo, CostConvoRest, CostHour, CostHourRepo, CostLaunch, CostWindowDoc } from "./wire/costwindow.js";
import type { FanoutRun } from "./wire/work.js";
import { usageStretches } from "./burn.js";

export const HOUR_MS = 3_600_000;

/**
 * Conversations a `CostWindowDoc` carries whole; the rest are folded into
 * `rest` by repo × launch. A week here was 591 conversations and 782 KB, nearly
 * all of it per-conversation hour and model splits nobody scrolls to; the
 * dearest 60 are what a person opens, and the fold keeps every total whole.
 */
export const COST_CONVOS_CAP = 60;

/** Top of the local hour `t` is in. Same as host `hourFloorMs` / web `hourFloor`. */
export function hourFloor(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * Where a cut of hour buckets starts for a window that opened at `openedAt`: the NEAREST local
 * hour boundary, never always the floor. An hour is the finest bucket on record, so a window
 * opening mid-hour cannot be cut at its own minute; flooring counted the whole opening hour —
 * a week resetting Thu 18:59 counted 59 minutes of the PREVIOUS week (measured: ≈ 4 weekly
 * points on a 35% week). Rounding bounds the edge error at 30 minutes either way, and a window
 * that resets at the next window's start then tiles with it: `[windowStartHour(opened),
 * windowStartHour(resets))` is each window, no hour in two.
 *
 * THE one rule for every window edge — the live session/week cut, the heat grid cells (host
 * `windowCells`), the week card's and the Totals box's `/api/costwindow` `from`. Idempotent on
 * an hour boundary, so the host's `hourFloor(from)` is the identity on what the phone sends.
 * Ties (exactly :30) go to the later hour, `Math.round`'s way.
 */
export function windowStartHour(openedAt: number): number {
  return hourFloor(openedAt + HOUR_MS / 2);
}

/** `YYYY-MM-DDTHH` in the LOCAL zone — the host's `localHour`, one copy both ends use. */
export function hourKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** `YYYY-MM-DDTHH` → the local top of that hour, epoch ms (`tokens.ts`' `hourToMs`). */
export function hourKeyMs(key: string): number {
  return hourToMs(key);
}

// ── small folds ──────────────────────────────────────────────────────────

const byCostDesc = <T extends { cost: CostBreakdown; totals: TokenTotals }>(a: T, b: T): number =>
  b.cost.total - a.cost.total || tokenTotal(b.totals) - tokenTotal(a.totals);

/** Merge model slices by the RAW logged id, descending by tokens. */
function mergeModels(lists: readonly (readonly ModelSlice[] | undefined | null)[]): ModelSlice[] {
  const m = new Map<string, ModelSlice>();
  for (const list of lists) {
    for (const s of list ?? []) {
      const cur = m.get(s.model) ?? { model: s.model, totals: zeroTotals(), cost: zeroCost() };
      addTotals(cur.totals, s.totals);
      addCost(cur.cost, s.cost);
      m.set(s.model, cur);
    }
  }
  return [...m.values()].sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals) || a.model.localeCompare(b.model));
}

// ── the one bucketing function ───────────────────────────────────────────

export interface WeekBucket {
  hour: string;
  t: number;
  usd: number;
  tok: number;
  byRepo: CostHourRepo[];
  /** Only CARRIED conversations — a folded one has no row to open (`restConvos` counts those). */
  convoIds: string[];
  /** Conversations with a turn in this hour that the cap folded into `rest` (0 when none). */
  restConvos: number;
}

export interface WeekCut {
  /** One per hour WITH activity, ascending. An hour nothing ran in is absent, never a zero bucket. */
  buckets: WeekBucket[];
  /** The conversations in one bucket (null = no filter = all), in the document's order. Built
   *  from the same predicate as `buckets[i].convoIds`, so "n of N" is the list it opens. */
  convosIn(hour: string | null): CostConvo[];
  /** `3 of 41 sessions · Tue 14:00–15:00`, or null when unfiltered. N is every conversation in
   *  the window, carried or folded (`convosTotal`); the hour is the bucket's own `t`, never the
   *  key re-parsed on this device's clock. */
  filterText(hour: string | null): string | null;
  /** Every conversation in the window — the N of "n of N" (`convosTotal ?? convos.length`). */
  total: number;
  /** "4 more sessions in this hour are not listed" / "531 cheaper sessions not listed · $12.40",
   *  or null when the cap folded nothing there. Says what the list is hiding. */
  restText(hour: string | null): string | null;
}

/** Whether a conversation counted anything in an hour — THE predicate behind both halves of `weekCut`. */
function ranIn(c: CostConvo, hour: string): boolean {
  return (c.byHour ?? []).some((h) => h.hour === hour && (h.tok > 0 || h.usd > 0));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (t: number) => `${String(new Date(t).getHours()).padStart(2, "0")}:00`;

export function weekCut(doc: CostWindowDoc): WeekCut {
  const convos = doc.convos ?? [];
  const map = new Map<string, WeekBucket>();
  for (const h of doc.hours ?? []) {
    map.set(h.hour, {
      hour: h.hour, t: h.t, usd: h.cost.total, tok: tokenTotal(h.totals), byRepo: h.byRepo ?? [], convoIds: [],
      restConvos: Number.isFinite(h.restConvos) && h.restConvos! > 0 ? h.restConvos! : 0,
    });
  }
  // An hour a conversation names that the hour rows do not still gets a bucket,
  // summed from the conversations — what ran is never left off the strip.
  for (const c of convos) {
    for (const ch of c.byHour ?? []) {
      if (map.has(ch.hour) || !(ch.tok > 0 || ch.usd > 0)) continue;
      map.set(ch.hour, { hour: ch.hour, t: hourKeyMs(ch.hour), usd: 0, tok: 0, byRepo: [], convoIds: [], restConvos: 0 });
    }
  }
  const fromHoursRows = new Set((doc.hours ?? []).map((h) => h.hour));
  for (const b of map.values()) {
    for (const c of convos) {
      if (!ranIn(c, b.hour)) continue;
      b.convoIds.push(c.id);
      if (!fromHoursRows.has(b.hour)) {
        for (const ch of c.byHour) if (ch.hour === b.hour) { b.usd += ch.usd; b.tok += ch.tok; }
      }
    }
  }
  const buckets = [...map.values()]
    .filter((b) => b.tok > 0 || b.usd > 0 || b.convoIds.length > 0)
    .sort((a, b) => a.t - b.t || a.hour.localeCompare(b.hour));
  const rest = doc.rest ?? [];
  const restCount = rest.reduce((n, r) => n + (r.count > 0 ? r.count : 0), 0);
  const total = Math.max(convos.length + restCount, Number.isFinite(doc.convosTotal) ? doc.convosTotal! : 0);
  const convosIn = (hour: string | null): CostConvo[] => (hour == null ? convos.slice() : convos.filter((c) => ranIn(c, hour)));
  const filterText = (hour: string | null): string | null => {
    if (hour == null) return null;
    const n = convosIn(hour).length;
    const head = `${n} of ${total} ${total === 1 ? "session" : "sessions"}`;
    // The bucket's own instant: the key is HOST-local, and re-parsing it here
    // on a phone in another zone would print a second clock beside the strip's.
    const t = map.get(hour)?.t;
    return t == null ? head : `${head} · ${DAYS[new Date(t).getDay()]} ${hhmm(t)}–${hhmm(t + HOUR_MS)}`;
  };
  const restText = (hour: string | null): string | null => {
    if (hour == null) {
      if (restCount <= 0) return null;
      const usd = rest.reduce((s, r) => s + (Number.isFinite(r.cost?.total) ? r.cost.total : 0), 0);
      return `${restCount} cheaper ${restCount === 1 ? "session" : "sessions"} not listed${usd > 0 ? ` · ${fmtUsd(usd)}` : ""}`;
    }
    const r = map.get(hour)?.restConvos ?? 0;
    return r > 0 ? `${r} more ${r === 1 ? "session" : "sessions"} in this hour ${r === 1 ? "is" : "are"} not listed` : null;
  };
  return { buckets, convosIn, filterText, total, restText };
}

// ── group by launch ──────────────────────────────────────────────────────

/** A launch row's kind: what opened it, or `unrecorded` — nothing on this host says (the
 *  daemon's own `claude -p` calls, a session past the closed stack's limit). Never "by hand". */
export type LaunchKind = CostLaunch["kind"] | "unrecorded";

/** The one wording of a launch kind, both ends. */
export const LAUNCH_KIND_WORD: Record<LaunchKind, string> = {
  fanout: "fan-out", backlog: "backlog item", schedule: "schedule", agent: "agent", resurrect: "resumed at reset",
  hand: "by hand", fork: "fork", unrecorded: "no launch record",
};

export interface LaunchRow {
  /** `runId ?? itemId ?? c:<conversation id>`; `rest:<repo>:<kind>` for folded conversations with no id to group by. */
  key: string;
  kind: LaunchKind;
  /** "architect review · 36 repos" / a backlog label / a session title. */
  label: string;
  /** Distinct repo keys. */
  repos: number;
  /** Descending by cost. Only the CARRIED conversations; `more` counts the folded ones. */
  convos: CostConvo[];
  /** Conversations of this launch the cap folded into `rest` — in the totals, not in `convos`. */
  more: number;
  totals: TokenTotals;
  cost: CostBreakdown;
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  firstAt: number | null;
  lastAt: number | null;
}

const launchKey = (c: CostConvo): string => c.launch?.runId || c.launch?.itemId || `c:${c.id}`;
/** A folded group's key: its run or item when it has one (so it joins that launch's row), else
 *  one row per repo and kind — a folded conversation has no id of its own to stand on. */
const restKey = (r: CostConvoRest): string =>
  r.launch?.runId || r.launch?.itemId || `rest:${r.repo}:${r.launch?.kind ?? "unrecorded"}`;

/** The first `n` words of a text, with an ellipsis when it had more. */
function firstWords(text: string, n: number): string {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" ");
}

const handLabel = (c: CostConvo): string => c.title || `${c.label} · ${c.id.slice(0, 8)}`;
const reposText = (n: number) => `${n} ${n === 1 ? "repo" : "repos"}`;

/**
 * A launch row's name. `fanout`: the run's label (else the first words of a
 * session's title) and how many repos it reached; `backlog`/`schedule`/`agent`:
 * the label, a sweep across several repos saying how many; a hand session (or
 * one nobody labelled): its title, else `repo · id8`.
 */
export function launchLabel(row: Omit<LaunchRow, "label">, rest: readonly CostConvoRest[] = []): string {
  const head = row.convos[0];
  const label = row.convos.find((c) => c.launch?.label)?.launch?.label ?? rest.find((r) => r.launch?.label)?.launch?.label;
  if (!head && !label) {
    // Folded conversations only, and none of them named: say what they are.
    const n = row.more;
    const where = rest[0]?.label;
    return `${n} more ${n === 1 ? "session" : "sessions"}${where ? ` · ${where}` : ""}`;
  }
  if (row.kind === "fanout") {
    const name = label || firstWords(row.convos.find((c) => c.title)?.title ?? "", 6) || "fan-out";
    return `${name} · ${reposText(row.repos)}`;
  }
  if (label && (row.kind === "backlog" || row.kind === "schedule" || row.kind === "agent")) {
    return row.repos > 1 ? `${label} · ${reposText(row.repos)}` : label;
  }
  return head ? handLabel(head) : label!;
}

/**
 * The RUN's kind, never the dearest member's: a key that is a fan-out runId is
 * a fan-out even when one target was resumed at reset (and that target is the
 * dearest); otherwise the first kind that is not a resume — the resume is what
 * happened to the launch, not what launched it — then `resurrect`, then
 * `unrecorded`.
 */
function runKind(key: string, kinds: readonly (CostLaunch | undefined)[]): LaunchKind {
  if (kinds.some((l) => l?.runId && l.runId === key)) return "fanout";
  const known = kinds.map((l) => l?.kind).filter((k): k is CostLaunch["kind"] => !!k);
  return known.find((k) => k !== "resurrect") ?? known[0] ?? "unrecorded";
}

/**
 * Called ONCE per list, never per row (fanoutruns.ts' rule). Descending by cost.
 * Pass the document's `rest` so a launch whose conversations the cap folded is
 * still whole — forty cheap fan-out targets are one dear run.
 */
export function foldLaunches(convos: readonly CostConvo[], rest: readonly CostConvoRest[] = []): LaunchRow[] {
  const groups = new Map<string, { convos: CostConvo[]; rest: CostConvoRest[] }>();
  const group = (k: string) => groups.get(k) ?? groups.set(k, { convos: [], rest: [] }).get(k)!;
  for (const c of convos) group(launchKey(c)).convos.push(c);
  for (const r of rest) if (r.count > 0) group(restKey(r)).rest.push(r);
  const rows: LaunchRow[] = [];
  for (const [key, g] of groups) {
    const sorted = g.convos.slice().sort(byCostDesc);
    const folded = g.rest.slice().sort(byCostDesc);
    const totals = zeroTotals(); const cost = zeroCost();
    const agentTotals = zeroTotals(); const agentCost = zeroCost();
    let firstAt: number | null = null; let lastAt: number | null = null;
    for (const c of [...sorted, ...folded]) {
      addTotals(totals, c.totals); addCost(cost, c.cost);
      addTotals(agentTotals, c.agentTotals); addCost(agentCost, c.agentCost);
      if (c.firstAt != null) firstAt = firstAt == null ? c.firstAt : Math.min(firstAt, c.firstAt);
      if (c.lastAt != null) lastAt = lastAt == null ? c.lastAt : Math.max(lastAt, c.lastAt);
    }
    const kind = runKind(key, [...sorted.map((c) => c.launch), ...folded.map((r) => r.launch)]);
    const repos = new Set([...sorted.map((c) => c.repo), ...folded.map((r) => r.repo)]).size;
    const more = folded.reduce((n, r) => n + r.count, 0);
    const base = { key, kind, repos, convos: sorted, more, totals, cost, agentTotals, agentCost, firstAt, lastAt };
    rows.push({ ...base, label: launchLabel(base, folded) });
  }
  return rows.sort((a, b) => byCostDesc(a, b) || a.key.localeCompare(b.key));
}

// ── ranked repos with their sessions ─────────────────────────────────────

export interface RepoRow {
  repo: string;
  label: string;
  totals: TokenTotals;
  cost: CostBreakdown;
  agentCost: CostBreakdown;
  /** Descending by cost. Only the CARRIED conversations; `more` counts the folded ones. */
  convos: CostConvo[];
  /** This repo's conversations the cap folded into `rest` — in the totals, not in `convos`. */
  more: number;
  byModel: ModelSlice[];
}

/** Descending by cost, tokens tie-break. Pass the document's `rest` so a repo's total keeps
 *  the sessions the cap folded. */
export function rankRepos(convos: readonly CostConvo[], rest: readonly CostConvoRest[] = []): RepoRow[] {
  const groups = new Map<string, { convos: CostConvo[]; rest: CostConvoRest[] }>();
  const group = (k: string) => groups.get(k) ?? groups.set(k, { convos: [], rest: [] }).get(k)!;
  for (const c of convos) group(c.repo).convos.push(c);
  for (const r of rest) if (r.count > 0) group(r.repo).rest.push(r);
  const rows: RepoRow[] = [];
  for (const [repo, g] of groups) {
    const sorted = g.convos.slice().sort(byCostDesc);
    const totals = zeroTotals(); const cost = zeroCost(); const agentCost = zeroCost();
    for (const c of [...sorted, ...g.rest]) { addTotals(totals, c.totals); addCost(cost, c.cost); addCost(agentCost, c.agentCost); }
    const label = sorted[0]?.label ?? g.rest[0]?.label ?? repo;
    const more = g.rest.reduce((n, r) => n + r.count, 0);
    rows.push({ repo, label, totals, cost, agentCost, convos: sorted, more, byModel: mergeModels([...sorted, ...g.rest].map((c) => c.byModel)) });
  }
  return rows.sort((a, b) => byCostDesc(a, b) || a.repo.localeCompare(b.repo));
}

/** A `RepoRow` as a `TokenGroup`, so `Bars`/`topGroups` draw it unchanged. */
export function repoRowAsGroup(r: RepoRow): TokenGroup {
  return { key: r.repo, label: r.label, ...r.totals, cost: { ...r.cost }, byModel: r.byModel };
}

// ── weekly points ────────────────────────────────────────────────────────

export interface PtsCalibration {
  usdPerPt: number;
  /** Pooled over the stretches that qualified. */
  usd: number;
  dPts: number;
  stretches: number;
  /** The level calibration it was checked against (`weekUsdPerPct`), when there was one. */
  levelUsdPerPt?: number | null;
}
export type PtsRefusal = { why: "noSamples" | "shortStretches" | "smallDelta" | "unstable" | "disagreesWithLevel" | "noCost" };

/** A stretch shorter than this is edge noise (the cost side is hour buckets). */
export const CAL_MIN_SPAN_MS = 6 * HOUR_MS;
/** A stretch must climb this many points to count at all. */
export const CAL_MIN_DPTS = 5;
/** One stretch alone must climb this many. */
export const CAL_SINGLE_MIN_DPTS = 10;
/** Every stretch within ±35% of the pooled rate. */
export const CAL_SPREAD = 0.35;
/** And the pooled rate within ±40% of the level calibration. */
export const CAL_LEVEL_SPREAD = 0.4;

export function isPtsCal(x: PtsCalibration | PtsRefusal | null | undefined): x is PtsCalibration {
  return !!x && typeof (x as PtsCalibration).usdPerPt === "number";
}

/**
 * Dollars per weekly point from Δw (the usage log's `w`) against the ledger's
 * cost over the same hours.
 *
 * Readings are cut into STRETCHES by `usageStretches(samples, "week")` — a reset
 * (`wr` moved past `RESET_EPS_MS`, or `w` fell past `DROP_EPS_PCT`) ends one —
 * so a reset inside the span never contributes a negative Δ. A stretch's
 * dollars are Σ `hours[].cost.total` for hours whose top is in
 * `[hourFloor(a.t), hourFloor(b.t))`: the partial last hour is left out and
 * `CAL_MIN_SPAN_MS` bounds the edge error. A stretch qualifies when it is long
 * enough, climbed enough and the ledger has cost in it; the qualifying ones are
 * pooled. Refused — never a number — when none qualify, when a lone stretch
 * climbed under `CAL_SINGLE_MIN_DPTS`, when any stretch's rate is outside
 * `CAL_SPREAD` of the pooled one, or when a level calibration exists and
 * disagrees past `CAL_LEVEL_SPREAD`.
 */
export function ptsCalibration(
  samples: readonly UsageSample[],
  hours: readonly CostHour[],
  levelUsdPerPct?: number | null,
): PtsCalibration | PtsRefusal {
  const stretches = usageStretches(samples ?? [], "week").filter((s) => s.pts.length >= 2);
  if (!stretches.length) return { why: "noSamples" };
  const long = stretches.filter((s) => s.pts[s.pts.length - 1].t - s.pts[0].t >= CAL_MIN_SPAN_MS);
  if (!long.length) return { why: "shortStretches" };
  const climbed = long.filter((s) => s.pts[s.pts.length - 1].v - s.pts[0].v >= CAL_MIN_DPTS);
  if (!climbed.length) return { why: "smallDelta" };
  const measured = climbed.map((s) => {
    const a = s.pts[0];
    const b = s.pts[s.pts.length - 1];
    const lo = hourFloor(a.t);
    const hi = hourFloor(b.t);
    let usd = 0;
    for (const h of hours ?? []) if (h.t >= lo && h.t < hi && Number.isFinite(h.cost?.total)) usd += h.cost.total;
    return { usd, dPts: b.v - a.v };
  });
  const priced = measured.filter((m) => m.usd > 0);
  if (!priced.length) return { why: "noCost" };
  if (priced.length === 1 && priced[0].dPts < CAL_SINGLE_MIN_DPTS) return { why: "smallDelta" };
  const usd = priced.reduce((s, m) => s + m.usd, 0);
  const dPts = priced.reduce((s, m) => s + m.dPts, 0);
  const usdPerPt = usd / dPts;
  if (!(usdPerPt > 0) || !Number.isFinite(usdPerPt)) return { why: "noCost" };
  if (priced.some((m) => Math.abs(m.usd / m.dPts / usdPerPt - 1) > CAL_SPREAD)) return { why: "unstable" };
  const level = levelUsdPerPct != null && Number.isFinite(levelUsdPerPct) && levelUsdPerPct > 0 ? levelUsdPerPct : null;
  if (level != null && Math.abs(usdPerPt / level - 1) > CAL_LEVEL_SPREAD) return { why: "disagreesWithLevel" };
  return { usdPerPt, usd, dPts, stretches: priced.length, levelUsdPerPt: level };
}

/** `≈ 15 pts` (2 significant figures; `<0.1 pt` under 0.05; `≈ 1 pt` singular). Null without a
 *  calibration or a positive figure — absent, never a zero. */
export function ptsText(usd: number | null | undefined, cal: PtsCalibration | PtsRefusal | null | undefined): string | null {
  if (!isPtsCal(cal) || usd == null || !Number.isFinite(usd) || !(usd > 0)) return null;
  if (!(cal.usdPerPt > 0) || !Number.isFinite(cal.usdPerPt)) return null;
  const pts = usd / cal.usdPerPt;
  if (!Number.isFinite(pts)) return null;
  if (pts < 0.05) return "<0.1 pt";
  const n = Number(pts.toPrecision(2));
  return n === 1 ? "≈ 1 pt" : `≈ ${n} pts`;
}

/** One sentence per refusal — a statement of what is missing, never a hint. */
export function ptsRefusalText(r: PtsRefusal): string {
  switch (r.why) {
    case "noSamples":
      return "Points can't be calibrated yet — there are not two weekly readings in this span to compare.";
    case "shortStretches":
      return `Points can't be calibrated yet — no run of weekly readings without a reset spans ${CAL_MIN_SPAN_MS / HOUR_MS} hours.`;
    case "smallDelta":
      return `Points can't be calibrated yet — the week has not climbed ${CAL_MIN_DPTS} points inside one stretch of readings (${CAL_SINGLE_MIN_DPTS} when there is only one).`;
    case "noCost":
      return "Points can't be calibrated — this desktop's logs have no cost in the hours the weekly figure climbed.";
    case "unstable":
      return `Points are not shown — the dollars per point moved by more than ${Math.round(CAL_SPREAD * 100)}% between stretches of readings, so no one figure is right.`;
    case "disagreesWithLevel":
      return `Points are not shown — the climb-based rate and the per-reading rate disagree by more than ${Math.round(CAL_LEVEL_SPREAD * 100)}%.`;
  }
}

// ── per-session insight ──────────────────────────────────────────────────

export const AGENT_MODEL_MIN_PCT = 15;

/** `claude-opus-5` → `Opus`. Null for anything that is not a claude model id. */
function modelFamily(model: string): string | null {
  const alias = normalizeModel(model);
  const word = alias?.split("-")[1];
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : null;
}

/**
 * "Opus subagents: 62% of this session's cost" — the dearest agent model
 * family, only when it is at least `AGENT_MODEL_MIN_PCT` of `cost.total` and
 * that is above zero. Null otherwise, and null when the slices add up to more
 * than the total (an inconsistent reading is absent, never a wrong share).
 * Takes anything with `cost` + `agentByModel`, so `TokenConvo` and `CostConvo`
 * both feed it.
 */
export function agentModelInsight(c: { cost: CostBreakdown; agentByModel?: ModelSlice[] | null }): string | null {
  const total = c.cost?.total;
  if (!(total > 0) || !Number.isFinite(total) || !c.agentByModel?.length) return null;
  const fam = new Map<string, number>();
  let sum = 0;
  for (const s of c.agentByModel) {
    const usd = s.cost?.total;
    if (!Number.isFinite(usd) || usd <= 0) continue;
    sum += usd;
    const f = modelFamily(s.model);
    if (f) fam.set(f, (fam.get(f) ?? 0) + usd);
  }
  if (sum > total * 1.001) return null;
  let best: [string, number] | null = null;
  for (const e of fam) if (!best || e[1] > best[1]) best = e;
  if (!best) return null;
  const pct = (best[1] / total) * 100;
  if (pct < AGENT_MODEL_MIN_PCT) return null;
  return `${best[0]} subagents: ${Math.round(pct)}% of this session's cost`;
}

// ── fan-out cost hint ────────────────────────────────────────────────────

/** Whitespace-collapsed, lower-cased text — "same prompt" for the hint. Not promptid's (that is a box fingerprint). */
export function fanoutTextKey(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The most recent FINISHED run with the same text key, else the most recent finished run, else null.
 *  A run still going is never the comparison — its cost is not known yet. */
export function pickSimilarRun(runs: readonly FanoutRun[], text: string): FanoutRun | null {
  const done = runs.filter((r) => r.finishedAt != null).sort((a, b) => b.startedAt - a.startedAt);
  const key = fanoutTextKey(text);
  if (key) {
    const same = done.find((r) => fanoutTextKey(r.text) === key);
    if (same) return same;
  }
  return done[0] ?? null;
}

/** `15`, `2.5`, `0.4` — a week share, the precision the calibration can carry. */
function fmtWeekPct(p: number): string {
  return p < 1 ? String(Number(p.toPrecision(1))) : p < 10 ? p.toFixed(1) : String(Math.round(p));
}

/**
 * "last similar run (36 repos): $218.00 ≈ 15% of week, 66% subagents" /
 * "last run (different prompt, 36 repos): …". `weekPct` null (or not a
 * positive figure) ⇒ the `≈` clause is omitted, never "0%".
 */
export function fanoutHintText(args: { same: boolean; usd: number; weekPct: number | null; agentPct: number; repos: number }): string {
  const { same, usd, weekPct, agentPct, repos } = args;
  const where = repos > 0 ? reposText(repos) : null;
  const head = same ? `last similar run${where ? ` (${where})` : ""}` : `last run (different prompt${where ? `, ${where}` : ""})`;
  const week = weekPct != null && Number.isFinite(weekPct) && weekPct > 0 ? ` ≈ ${fmtWeekPct(weekPct)}% of week` : "";
  const agents = Number.isFinite(agentPct) && agentPct >= 0 ? `, ${Math.round(Math.min(100, agentPct))}% subagents` : "";
  return `${head}: ${fmtUsd(usd)}${week}${agents}`;
}
