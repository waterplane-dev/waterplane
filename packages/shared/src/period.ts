/**
 * Budget PERIODS — the spans a spend or usage ceiling is measured over.
 *
 * A subscription has exactly two, both ROLLING and both read off the CLI's
 * `/usage` screen (`session` 5 h, `weekly` 7 d, unit `pct`). An API-key or
 * cloud account has none of that: what it answers to is spend per GOVERNED
 * period — usually a calendar month, often one that starts on the billing day
 * rather than the 1st. Those edges are COMPUTED, not scraped, so they live
 * here, once: `periodBounds` is the only place a period's start and reset are
 * decided, and the host and the phone both call it. Two copies of an edge is
 * two answers to "has the month reset yet".
 *
 * Pure, no clock (the caller passes `now`) and no dependency: zones go through
 * `Intl` via `schedzone.ts`, the same reading the schedule rules use, so a
 * period and a weekly rule cannot disagree across a DST edge.
 *
 * **Everything here degrades to null, never to a wrong number.**
 */
// Zone maths is kept local on purpose: `schedule.ts` reaches `budget.ts`, which
// reaches this file, and a runtime import back would close a cycle.
function zoneOffsetMs(zone: string, at: number): number | null {
  try {
    const p: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  } catch { return null; }
}

/** Epoch ms of a Y/M/D h:m wall clock in `zone` (month/day may overflow); host-local for an unknown zone.
 *  A wall clock inside a DST gap (São Paulo's midnight, Santiago's) does not exist: the answer is the
 *  first instant AFTER the gap, never the earlier one (which is still the evening before). */
function wallClockToEpoch(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  const off0 = zoneOffsetMs(zone, guess);
  if (off0 == null) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const c1 = guess - off0;
  const c2 = guess - (zoneOffsetMs(zone, c1) ?? off0);
  const wall = (t: number): number | null => { const o = zoneOffsetMs(zone, t); return o == null ? null : t + o; };
  if (wall(c2) === guess) return c2;
  if (wall(c1) === guess) return c1;
  return Math.max(c1, c2);
}

/** The calendar date `at` falls on in `zone` (host-local for an unknown zone). */
function zoneDate(zone: string, at: number): { y: number; mo: number; d: number } {
  try {
    const p: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    if (Number.isFinite(p.year) && Number.isFinite(p.month) && Number.isFinite(p.day)) return { y: p.year, mo: p.month - 1, d: p.day };
  } catch { /* unknown zone: fall through */ }
  const t = new Date(at);
  return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() };
}

/** Does `Intl` know this IANA zone? An invalid one would silently fall back to host-local. */
function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

/** A period's id. `session` and `weekly` are the two scraped windows and stay
 *  valid everywhere an id is taken; any other string names a configured one. */
export type PeriodId = string;
export const SESSION_PERIOD_ID: PeriodId = "session";
export const WEEKLY_PERIOD_ID: PeriodId = "weekly";
export const ROLLING_30D_ID: PeriodId = "rolling30d";

export type PeriodUnit = "pct" | "usd";

/** A trailing window. `scraped`: its reset comes off `/usage` (session, weekly);
 *  otherwise (`rolling30d`) it is a trailing sum with NO edge — `resetAt` null. */
export interface RollingPeriod {
  id: PeriodId;
  kind: "rolling";
  unit: PeriodUnit;
  lenMs: number;
  scraped: boolean;
}

/** A calendar period in an IANA zone. `month`: begins on `anchorDay` (1..31;
 *  31 clamps to a short month's last day). `week`: begins on `startDow`
 *  (0 = Sunday). `day`: begins at local midnight. Unit is always `usd`. */
export interface CalendarPeriod {
  id: PeriodId;
  kind: "calendar";
  unit: "usd";
  cycle: "month" | "week" | "day";
  anchorDay?: number;
  startDow?: number;
  tz: string;
}

/** A fixed span, `from` inclusive to `to` exclusive (epoch ms). */
export interface SpanPeriod {
  id: PeriodId;
  kind: "span";
  unit: "usd";
  from: number;
  to: number;
}

export type BudgetPeriod = RollingPeriod | CalendarPeriod | SpanPeriod;

const H = 3_600_000;
const D = 24 * H;

export const SESSION_PERIOD: RollingPeriod = { id: SESSION_PERIOD_ID, kind: "rolling", unit: "pct", lenMs: 5 * H, scraped: true };
export const WEEKLY_PERIOD: RollingPeriod = { id: WEEKLY_PERIOD_ID, kind: "rolling", unit: "pct", lenMs: 7 * D, scraped: true };
export const ROLLING_30D_PERIOD: RollingPeriod = { id: ROLLING_30D_ID, kind: "rolling", unit: "usd", lenMs: 30 * D, scraped: false };

/** The periods every host has without configuring anything. */
export const BUILTIN_PERIODS: readonly BudgetPeriod[] = [SESSION_PERIOD, WEEKLY_PERIOD];

export interface PeriodBounds {
  /** Epoch ms the period (to date) started. */
  start: number;
  /** When it ends and the next begins, or null: no edge (a trailing window, or
   *  a scraped one nobody has read yet, or a span already over). */
  resetAt: number | null;
  /** False for a span before its `from` or after its `to`: nothing is being
   *  measured, so no ceiling on it can be over. Always true otherwise. */
  active: boolean;
}

/** What a scraped window may be told: its reset, if the host has read one. */
export interface KnownReset {
  resetAt?: number | null;
}

const daysIn = (y: number, mo: number): number => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

/** y/mo normalised (mo may overflow either way). */
function ym(y: number, mo: number): { y: number; mo: number } {
  const t = new Date(Date.UTC(y, mo, 1));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() };
}

/** Local midnight of the `anchorDay` of month (y, mo), the day clamped. */
function monthEdge(y: number, mo: number, anchorDay: number, tz: string): number {
  const n = ym(y, mo);
  return wallClockToEpoch(n.y, n.mo, Math.min(anchorDay, daysIn(n.y, n.mo)), 0, 0, tz);
}

function calendarBounds(p: CalendarPeriod, now: number): PeriodBounds {
  const { y, mo, d } = zoneDate(p.tz, now);
  let edge: (k: number) => number; // k-th period relative to the one the date falls in
  let k0 = 0;
  if (p.cycle === "month") {
    const a = Math.min(31, Math.max(1, Math.trunc(p.anchorDay ?? 1)));
    // The month whose anchor is the latest one not after today.
    k0 = d >= Math.min(a, daysIn(y, mo)) ? 0 : -1;
    edge = (k) => monthEdge(y, mo + k0 + k, a, p.tz);
  } else if (p.cycle === "week") {
    const dow = new Date(Date.UTC(y, mo, d)).getUTCDay();
    const sd = Math.min(6, Math.max(0, Math.trunc(p.startDow ?? 0)));
    const back = (dow - sd + 7) % 7;
    edge = (k) => wallClockToEpoch(y, mo, d - back + 7 * k, 0, 0, p.tz);
  } else {
    edge = (k) => wallClockToEpoch(y, mo, d + k, 0, 0, p.tz);
  }
  // The date arithmetic above can be one off exactly at a DST edge where local
  // midnight does not exist or repeats; the instants are the truth, so settle
  // against them.
  let k = 0;
  for (let i = 0; i < 3 && now < edge(k); i++) k--;
  for (let i = 0; i < 3 && now >= edge(k + 1); i++) k++;
  return { start: edge(k), resetAt: edge(k + 1), active: true };
}

/**
 * The start and the reset of `period` as of `now`. THE one reading of an edge.
 *
 * - `calendar`: computed in the period's zone, DST-safe (a month that contains
 *   a clock change is 1 h longer or shorter in milliseconds and still ends at
 *   local midnight of its anchor day).
 * - `rolling` and scraped: `resetAt` is whatever the host read (`known`), else
 *   null; `start` is `resetAt - len` when known, else `now - len`.
 * - `rolling` and not scraped: a trailing window, `start = now - len`,
 *   `resetAt = null` — there is no edge to wait for.
 * - `span`: `[from, to)`; outside it `active` is false.
 */
export function periodBounds(period: BudgetPeriod, now: number, known?: KnownReset): PeriodBounds {
  if (period.kind === "calendar") return calendarBounds(period, now);
  if (period.kind === "span") {
    if (now < period.from) return { start: period.from, resetAt: period.to, active: false };
    if (now >= period.to) return { start: period.from, resetAt: null, active: false };
    return { start: period.from, resetAt: period.to, active: true };
  }
  if (!period.scraped) return { start: now - period.lenMs, resetAt: null, active: true };
  const r = known?.resetAt;
  const resetAt = typeof r === "number" && Number.isFinite(r) && r > now ? r : null;
  return { start: resetAt != null ? resetAt - period.lenMs : now - period.lenMs, resetAt, active: true };
}

/** Does this period have a reset edge a `window` schedule rule could anchor to?
 *  A trailing sum does not; nor does a span (it ends once, for good). */
export function periodHasEdge(period: BudgetPeriod): boolean {
  return period.kind === "calendar" || period.kind === "span" || period.scraped;
}

/**
 * Why a `window` schedule rule may not anchor to this period, or null when it
 * may. A rolling period has no edge: "before it resets" names no instant, and a
 * rule that waited for one would wait for ever under a calm sentence. Unknown
 * id ⇒ refused too (the period was removed). `session`/`weekly` always pass.
 */
export function windowRuleRefusal(periodId: PeriodId | undefined, periods: readonly BudgetPeriod[] | undefined): string | null {
  if (periodId == null || periodId === SESSION_PERIOD_ID || periodId === WEEKLY_PERIOD_ID) return null;
  const p = periods?.find((x) => x.id === periodId);
  if (!p) return `there is no budget period "${periodId}" to time work against`;
  if (!periodHasEdge(p)) return `the ${p.id === ROLLING_30D_ID ? "rolling 30 days" : p.id} period is a trailing total with no reset time, so there is nothing to start before or after - pick a month, week or day period, or a clock time`;
  if (p.kind === "span" && periodBounds(p, Date.now()).resetAt == null) return "that span has already ended";
  return null;
}

/** A period as the wire carries it: the definition and where it stands now. */
export interface PeriodState {
  period: BudgetPeriod;
  start: number;
  resetAt: number | null;
  active: boolean;
  /** Period-to-date spend in USD from the local ledger, when it has one. Absent
   *  means nobody measured - never 0. */
  spentUsd?: number | null;
}

/** Fold the definitions into `PeriodState`s at `now` (spend filled by the caller). */
export function periodStates(periods: readonly BudgetPeriod[], now: number, known?: Record<PeriodId, KnownReset>): PeriodState[] {
  return periods.map((period) => ({ period, ...periodBounds(period, now, known?.[period.id]) }));
}

/** Keep only well-formed periods off disk or the wire; drop the rest, never repair. */
export function cleanPeriods(raw: unknown): BudgetPeriod[] {
  if (!Array.isArray(raw)) return [];
  const out: BudgetPeriod[] = [];
  const seen = new Set<string>([SESSION_PERIOD_ID, WEEKLY_PERIOD_ID]);
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    let p: BudgetPeriod | null = null;
    if (r.kind === "rolling" && r.id === ROLLING_30D_ID) p = ROLLING_30D_PERIOD;
    else if (r.kind === "calendar" && typeof r.tz === "string" && r.tz && validZone(r.tz)) {
      if (r.cycle === "month") {
        const a = Number(r.anchorDay);
        if (Number.isInteger(a) && a >= 1 && a <= 31) p = { id: r.id, kind: "calendar", unit: "usd", cycle: "month", anchorDay: a, tz: r.tz };
      } else if (r.cycle === "week") {
        const s = Number(r.startDow);
        if (Number.isInteger(s) && s >= 0 && s <= 6) p = { id: r.id, kind: "calendar", unit: "usd", cycle: "week", startDow: s, tz: r.tz };
      } else if (r.cycle === "day") p = { id: r.id, kind: "calendar", unit: "usd", cycle: "day", tz: r.tz };
    } else if (r.kind === "span" && typeof r.from === "number" && typeof r.to === "number" && Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from) {
      p = { id: r.id, kind: "span", unit: "usd", from: r.from, to: r.to };
    }
    if (p) { seen.add(p.id); out.push(p); }
  }
  return out;
}

// ── Pacing ───────────────────────────────────────────────────────────────────
// Straight-line maths over a period's spend. All of it answers null when an
// input is missing or the question has no sense (no edge, no elapsed time).

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Sum of the samples in `[start, now]`. `undefined` samples ⇒ null (nobody
 *  measured); an empty list is a true 0. */
export function spent(samples: readonly { at: number; usd: number }[] | null | undefined, start: number, now: number): number | null {
  if (!samples) return null;
  let t = 0;
  for (const s of samples) {
    if (!num(s.at) || !num(s.usd)) return null;
    if (s.at >= start && s.at <= now) t += s.usd;
  }
  return t;
}

/** Where a straight line from 0 at `start` to `max` at `resetAt` stands at
 *  `now` - what an even spend would have reached. null with no edge. */
export function linearPace(max: number, start: number, resetAt: number | null, now: number): number | null {
  if (!num(max) || !num(start) || !num(now) || !num(resetAt) || resetAt <= start) return null;
  const f = Math.min(1, Math.max(0, (now - start) / (resetAt - start)));
  return max * f;
}

/** What may still be spent per day until the reset (0 once over). The last day
 *  is not divided finer: with 3 h left it is the whole remainder, not 8x it. */
export function perDayLeft(max: number, spentUsd: number | null, resetAt: number | null, now: number): number | null {
  if (!num(max) || !num(spentUsd) || !num(resetAt) || !num(now) || resetAt <= now) return null;
  const left = Math.max(0, max - spentUsd);
  return left / Math.max(1, (resetAt - now) / D);
}

/** Spend at the reset if the rate so far holds. null until a tenth of the
 *  period has elapsed (a first-hour burst extrapolates to nonsense) or with no edge. */
export function projectedEnd(spentUsd: number | null, start: number, resetAt: number | null, now: number): number | null {
  if (!num(spentUsd) || !num(start) || !num(resetAt) || !num(now) || resetAt <= start) return null;
  const total = resetAt - start;
  const elapsed = now - start;
  if (elapsed < total * 0.1 || elapsed > total) return null;
  return spentUsd * (total / elapsed);
}
