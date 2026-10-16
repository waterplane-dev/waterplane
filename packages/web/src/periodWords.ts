/**
 * Dollar periods as words: the chip an API-key or cloud account reads instead of
 * the two scraped windows, the pacing sentence under a period card, the label of
 * a configured period, and the form that builds one — all pure, so
 * `periodWords.test.mjs` runs it under `node --test`.
 *
 * Top-level (not in a feature) because three places that may not import each
 * other speak it: the launcher and session chips (core, through `features/tokens`),
 * the settings form (`features/tokens`) and the month card (the token-stats
 * extension, which reaches it through `@waterplane/sdk`).
 *
 * **Every figure is this desktop's local ledger at list price** — never the
 * invoice — and the wording that says so lives with the card's caption, once.
 * **Nothing here guesses**: a period nobody measured has no chip, a period with
 * no edge has no "per day left", a first-tenth burst has no projection
 * (`projectedEnd`), and every one of those is `null`, never a zero.
 * The maths itself is `@waterplane/shared`'s (`period.ts`), not re-derived.
 */
import {
  budgetLimits, fmtUsd, linearPace, normalizeModel, perDayLeft, projectedEnd,
  type BudgetPeriod, type CalendarPeriod, type CostConvo, type CostConvoRest, type ModelSlice, type PeriodState, type UsageBudget,
} from "@waterplane/shared";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** The widest span the host folds in one read (`COST_WINDOW_MAX_MS`). */
export const READ_MAX_MS = 35 * DAY_MS;

/** Dollars as a person reads a budget: `$412`, `$2000`, `$0.48`. */
export const usdWords = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : fmtUsd(n));

/** The cap on a dollar period, or null. */
export function periodCap(budget: UsageBudget | null | undefined, id: string): number | null {
  if (!budget) return null;
  return budgetLimits(budget).find((l) => l.periodId === id && l.unit === "usd")?.max ?? null;
}

const KIND_RANK = (p: BudgetPeriod): number =>
  p.kind === "calendar" ? (p.cycle === "month" ? 0 : p.cycle === "week" ? 2 : 3) : p.kind === "rolling" ? 1 : 4;

/**
 * The period a chip and the month card speak for: an ACTIVE dollar period, one
 * with a cap before one without, then month, rolling 30 days, week, day, span.
 * Null when none is configured — then there is nothing to say, not a default.
 */
export function primaryUsdPeriod(states: readonly PeriodState[] | null | undefined, budget: UsageBudget | null | undefined, now: number = Date.now()): PeriodState | null {
  // A period whose reset has passed is last period's; the host re-sends it, and until then it is not spoken for.
  const usd = (states ?? []).filter((s) => s.period.unit === "usd" && s.active && !(s.resetAt != null && now >= s.resetAt));
  if (!usd.length) return null;
  const rank = (s: PeriodState) => (periodCap(budget, s.period.id) != null ? 0 : 10) + KIND_RANK(s.period);
  return usd.slice().sort((a, b) => rank(a) - rank(b))[0];
}

function fmtDate(t: number, tz: string | undefined, o: Intl.DateTimeFormatOptions): string {
  const fmt = (z?: string) => new Intl.DateTimeFormat("en-US", { ...o, ...(z ? { timeZone: z } : {}) });
  let f: Intl.DateTimeFormat;
  try { f = fmt(tz); } catch { f = fmt(); }
  // "15 Sep", not en-US's "Sep 15" - the day first, as a billing day is said.
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  const date = [p.day, p.month, p.year].filter(Boolean).join(" ");
  return [date, p.hour && p.minute ? `${p.hour}:${p.minute}` : ""].filter(Boolean).join(" ");
}

const ord = (n: number): string => {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** The short name a chip wears: `Oct`, `15 Oct` (an anchor off the 1st), `30d`, `wk`, `today`, `span`. */
export function periodShort(s: PeriodState): string {
  const p = s.period;
  if (p.kind === "calendar") {
    if (p.cycle === "month") return fmtDate(s.start + 6 * 3_600_000, p.tz, (p.anchorDay ?? 1) > 1 ? { day: "numeric", month: "short" } : { month: "short" });
    return p.cycle === "week" ? "wk" : "today";
  }
  return p.kind === "rolling" ? "30d" : "span";
}

/** The card's title, naming the span it covers. */
export function periodTitle(p: BudgetPeriod): string {
  if (p.kind === "calendar") return p.cycle === "month" ? "Where the month went" : p.cycle === "week" ? "Where this calendar week went" : "Where today went";
  return p.kind === "rolling" ? "Where the last 30 days went" : "Where this span went";
}

/** A configured period in one line, for the settings list. */
export function periodDescribe(p: BudgetPeriod): string {
  if (p.kind === "calendar") {
    if (p.cycle === "month") return `calendar month from the ${(p.anchorDay ?? 1) === 1 ? "1st" : ord(p.anchorDay ?? 1)} · ${p.tz}`;
    if (p.cycle === "week") return `calendar week from ${DOW[p.startDow ?? 0]} · ${p.tz}`;
    return `each day · ${p.tz}`;
  }
  if (p.kind === "rolling") return "rolling 30 days";
  const f = (t: number) => fmtDate(t, undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${f(p.from)} to ${f(p.to - 1)}`;
}

/** Where spend stands against an even pace. */
export type Pace = "over" | "ahead" | "on" | "under";

export interface Pacing {
  pace: Pace | null;
  /** What may still be spent per day to the reset; null with no cap or no edge. */
  perDay: number | null;
  /** Spend at the reset if the rate holds; null early in the period or with no edge. */
  projected: number | null;
}

/** Within this share of the straight line counts as on pace. */
const PACE_BAND = 0.1;

export function pacing(s: PeriodState, cap: number | null, now: number): Pacing {
  const spent = s.spentUsd ?? null;
  if (spent == null) return { pace: null, perDay: null, projected: null };
  const projected = projectedEnd(spent, s.start, s.resetAt, now);
  if (cap == null) return { pace: null, perDay: null, projected };
  const perDay = perDayLeft(cap, spent, s.resetAt, now);
  if (spent >= cap) return { pace: "over", perDay, projected };
  const line = linearPace(cap, s.start, s.resetAt, now);
  // Before a hundredth of the cap is the straight line, a ratio against it is noise.
  if (line == null || line < cap * 0.01) return { pace: null, perDay, projected };
  const r = spent / line;
  return { pace: r > 1 + PACE_BAND ? "ahead" : r < 1 - PACE_BAND ? "under" : "on", perDay, projected };
}

export const PACE_WORD: Record<Pace, string> = { over: "over the cap", ahead: "ahead of pace", on: "on pace", under: "under pace" };

export interface PeriodChip {
  /** `Oct $412 / $2000 · on pace`. */
  text: string;
  /** At 80% of the cap or more: the chip wears the danger class the percent chip does. */
  hot: boolean;
  /** The long form, for the tooltip: the same figures with their reset and pacing. */
  title: string;
}

/** The chip, or null where the period was not measured (absent, never `$0` or `?`). */
export function periodChip(s: PeriodState, cap: number | null, now: number): PeriodChip | null {
  const spent = s.spentUsd;
  if (spent == null || !Number.isFinite(spent)) return null;
  // The figure is last period's once the reset has passed (a phone that slept): absent, not stale.
  if (s.resetAt != null && now >= s.resetAt) return null;
  const pc = pacing(s, cap, now);
  const text = `${periodShort(s)} ${usdWords(spent)}${cap != null ? ` / ${usdWords(cap)}` : ""}${pc.pace ? ` · ${PACE_WORD[pc.pace]}` : ""}`;
  const bits = [
    `${usdWords(spent)} spent${cap != null ? ` of a ${usdWords(cap)} cap` : ""} · ${periodDescribe(s.period)}`,
    ...(s.resetAt != null ? [`resets ${fmtDate(s.resetAt, s.period.kind === "calendar" ? s.period.tz : undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`] : []),
    ...(pc.perDay != null ? [`${usdWords(pc.perDay)}/day left`] : []),
    ...(pc.projected != null ? [`projected ${usdWords(pc.projected)} at the reset`] : []),
    "this desktop, list price",
  ];
  return { text, hot: cap != null && spent >= cap * 0.8, title: bits.join(" · ") };
}

/** The pacing as the card prints it under the hero; empty when there is nothing to say. */
export function pacingLine(s: PeriodState, cap: number | null, now: number): string[] {
  const pc = pacing(s, cap, now);
  return [
    ...(pc.pace ? [PACE_WORD[pc.pace]] : []),
    ...(pc.perDay != null && pc.pace !== "over" ? [`${usdWords(pc.perDay)}/day left`] : []),
    ...(pc.projected != null ? [`projected ${usdWords(pc.projected)} at the reset`] : []),
  ];
}

// ── the read behind the card ────────────────────────────────────────────────

/** The span to read for a period (`from` on the hour the cut starts on is the caller's), or why not. */
export function periodReadSpan(s: PeriodState, now: number): { from: number; to: number } | { refusal: string } {
  const closed = s.resetAt != null && s.resetAt <= now;
  const to = s.resetAt != null ? Math.min(s.resetAt, now) : now;
  // The ledger keeps hour buckets: an edge inside an hour would count spend from outside the range.
  // A rolling window's start slides with the clock, so it is read from the next whole hour (the
  // first minutes are left out, never counted); the live edge `now` is the open hour and is exempt.
  const from = s.period.kind === "rolling" ? Math.ceil(s.start / HOUR_MS) * HOUR_MS : s.start;
  if (to <= from) return { refusal: "This period has not begun." };
  if (from % HOUR_MS !== 0 || (closed && to % HOUR_MS !== 0)) {
    return { refusal: "This period starts or ends inside an hour, and the desktop keeps its spend by the hour — no breakdown is drawn rather than one that counts the wrong minutes." };
  }
  if (to - from > READ_MAX_MS) return { refusal: "This span is longer than 35 days, the most the desktop folds in one read — the figure on the chip is unaffected." };
  return { from, to };
}

export interface ModelRow { model: string; label: string; usd: number; tokens: number }

/**
 * A window's money by model, folded over the carried conversations AND the ones
 * the host's cap folded away (`rest`), so the rows add up to the document's
 * total. Descending by cost; an unpriced model is a row of tokens with `usd` 0,
 * never dropped.
 */
export function modelRows(convos: readonly CostConvo[], rest: readonly CostConvoRest[] | undefined): ModelRow[] {
  const acc = new Map<string, ModelRow>();
  const add = (list: readonly ModelSlice[] | undefined) => {
    for (const m of list ?? []) {
      const r = acc.get(m.model) ?? { model: m.model, label: normalizeModel(m.model) ?? (m.model || "unknown model"), usd: 0, tokens: 0 };
      r.usd += m.cost?.total ?? 0;
      r.tokens += (m.totals?.input ?? 0) + (m.totals?.output ?? 0) + (m.totals?.cacheRead ?? 0) + (m.totals?.cacheWrite ?? 0);
      acc.set(m.model, r);
    }
  };
  for (const c of convos) add(c.byModel);
  for (const r of rest ?? []) add(r.byModel);
  return [...acc.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

// ── the form ────────────────────────────────────────────────────────────────

export type PeriodKindId = "month" | "week" | "day" | "rolling30d" | "span";

export const PERIOD_KINDS: readonly { id: PeriodKindId; label: string }[] = [
  { id: "month", label: "calendar month" },
  { id: "week", label: "calendar week" },
  { id: "day", label: "day" },
  { id: "rolling30d", label: "rolling 30 days" },
  { id: "span", label: "from – to" },
];

export interface PeriodDraft {
  kind: PeriodKindId;
  /** Calendar month: the day billing starts, 1..31 (typed). */
  anchorDay: string;
  /** Calendar week: 0 = Sunday. */
  startDow: number;
  tz: string;
  /** Span: `YYYY-MM-DD`, first day and LAST day (included). */
  from: string;
  to: string;
}

export const phoneZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

export const emptyDraft = (): PeriodDraft => ({ kind: "month", anchorDay: "1", startDow: 1, tz: phoneZone(), from: "", to: "" });

const validZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

function dayStart(text: string, plus = 0): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const base = new Date(y, mo - 1, d);
  // 2026-02-30 rolls into March: that is a typo, not a day.
  if (base.getFullYear() !== y || base.getMonth() !== mo - 1 || base.getDate() !== d) return null;
  return new Date(y, mo - 1, d + plus).getTime();
}

export type BuiltPeriod = { ok: true; period: BudgetPeriod } | { ok: false; reason: string };

/** A typed draft → a period, or the SENTENCE that says why not (the host refuses the same shapes). */
export function buildPeriod(d: PeriodDraft): BuiltPeriod {
  const tz = d.tz.trim();
  if ((d.kind === "month" || d.kind === "week" || d.kind === "day") && (!tz || !validZone(tz))) {
    return { ok: false, reason: `“${tz}” is not a time zone — try Europe/Berlin or America/New_York` };
  }
  if (d.kind === "month") {
    const a = Number(d.anchorDay.trim().replace(/(st|nd|rd|th)$/i, ""));
    if (!Number.isInteger(a) || a < 1 || a > 31) return { ok: false, reason: "the billing day is a whole number from 1 to 31" };
    return { ok: true, period: { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: a, tz } };
  }
  if (d.kind === "week") return { ok: true, period: { id: "calweek", kind: "calendar", unit: "usd", cycle: "week", startDow: d.startDow, tz } satisfies CalendarPeriod };
  if (d.kind === "day") return { ok: true, period: { id: "day", kind: "calendar", unit: "usd", cycle: "day", tz } };
  if (d.kind === "rolling30d") return { ok: true, period: { id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 30 * DAY_MS, scraped: false } };
  const from = dayStart(d.from);
  const to = dayStart(d.to, 1);
  if (from == null || to == null) return { ok: false, reason: "type both days as YYYY-MM-DD" };
  if (to <= from) return { ok: false, reason: "the last day has to be on or after the first" };
  if (from % HOUR_MS !== 0 || to % HOUR_MS !== 0) {
    return { ok: false, reason: "this phone's midnight is not on a whole UTC hour, and the desktop keeps spend by the hour — a span here would count the wrong minutes" };
  }
  return { ok: true, period: { id: `span-${d.from.trim()}`, kind: "span", unit: "usd", from, to } };
}
