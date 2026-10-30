/**
 * The usage BUDGET — "stop starting new work once the account is this close to
 * its limit, and start again when the window resets."
 *
 * `limit.ts` handles the WALL: the CLI printed a usage-limit banner, the turn
 * is already dead, and the only thing left to do is wait for the reset and
 * resurrect. That is recovery, and it is always too late — a queue that drained
 * into the last 10% of a session window spends the reserve on whatever happened
 * to be next in line, and the one prompt you actually wanted to run is the one
 * that hits the banner.
 *
 * This is the other half: a ceiling you set BEFORE the wall, checked by the two
 * things that start work without a human present — the send queue draining and
 * the backlog auto-firing. Neither is a decision anybody is making at the time;
 * both are a decision made earlier, arriving now.
 *
 * Three properties, all deliberate:
 *
 *   • **Nothing is armed with a timer.** The verdict is a pure function of the
 *     usage reading and the clock, re-asked by every pass that would fire —
 *     exactly like `schedule.ts` and `launch.ts`. So a host restart, a laptop
 *     sleep and a reset that lands while the phone is off all resolve
 *     themselves on the next tick rather than needing an event nobody was
 *     awake for.
 *   • **It FAILS OPEN.** An unreadable or stale usage scrape does not block.
 *     The reading comes from screen-scraping `/usage` out of a short-lived
 *     `claude` PTY (`host/usage.ts`), which is fragile by construction: an
 *     upstream TUI change would otherwise silently freeze every queue and every
 *     backlog on every host, for ever, with the CLI itself perfectly willing to
 *     run. A budget that fails closed on a parse bug is worse than no budget —
 *     and the wall is still there underneath, which is the safety net that lets
 *     this one be optimistic.
 *   • **Resume needs no observation.** Past a known reset instant the verdict
 *     clears on the clock alone, without waiting for a fresh scrape to confirm
 *     the percentage dropped. The cached number describes a window that has
 *     ended; holding work back on it is holding it back on a fact that is no
 *     longer true.
 *
 * Pure and DOM-free like everything else here, so `shared/dist` runs under node
 * and `npm run test:unit` can pin the rule with no host to boot.
 */
import type { UsageInfo } from "./index.js";
import { cleanPeriods, periodBounds, ROLLING_30D_ID, SESSION_PERIOD_ID, WEEKLY_PERIOD_ID, type BudgetPeriod, type PeriodId, type PeriodUnit } from "./period.js";

/**
 * One ceiling: `max` of `unit` on the period `periodId`. `pct` is percent of a
 * scraped window (`session`, `weekly`); `usd` is period-to-date dollars from the
 * local ledger. The list on `UsageBudget.ceilings` is the truth; `sessionMax` /
 * `weeklyMax` are its mirrors for readers that predate periods (see `budgetLimits`).
 */
export interface BudgetLimit {
  periodId: PeriodId;
  max: number;
  unit: PeriodUnit;
}

/** Period-to-date USD spend by period id, supplied by the caller (the host's
 *  ledger fold). A missing or null entry is "nobody measured": never a trip, never 0. */
export type BudgetSpend = Record<PeriodId, number | null | undefined>;

/** The two ceilings, and the switch. Persisted host-side (`.waterplane/budget.json`). */
export interface UsageBudget {
  /** Master switch. Off ⇒ `budgetVerdict` never blocks anything. */
  enabled: boolean;
  /**
   * Percent of the 5-hour SESSION window at which automatic work stops, 1..100.
   * 100 disables this ceiling without turning the whole budget off.
   *
   * The session window is the one worth defending: it refills in hours, so a
   * pause is a pause. Default 90 — enough headroom that a turn already running
   * can finish, and that a human who picks up the phone can still send
   * something by hand (an explicit send always overrides this).
   */
  sessionMax: number;
  /**
   * The same ceiling for the WEEKLY window, or null for "don't watch it".
   *
   * Off by default, and deliberately so: the weekly window resets days out, so
   * a budget that trips on it stops automation until the weekend. That is a
   * choice worth making explicitly, never one to inherit from a default.
   */
  weeklyMax: number | null;
  /**
   * The LEFTOVER ceiling, percent of the NEW weekly window, or null for off.
   *
   * A row let past last week's ceiling — timed before the weekly reset
   * (`BudgetPass`) or waived by a person while the weekly cap held it — exists
   * to spend allowance that would otherwise be thrown away at the reset. One
   * that did not get to start before the reset (serial, slots)
   * would otherwise fall to the ordinary ceilings, and a week that has just
   * reset reads 0%: every leftover runs at once, spending the new week on work
   * that was only ever worth the old week's spare. Such a row (`leftoverOf` in
   * `intent.ts`) starts only while the week is under THIS, and otherwise waits
   * for the next week's start or the next before-reset lift.
   *
   * Measured against the whole week's reading — a person's own sends count —
   * because that is the number on the usage screen, and a person working by
   * hand is the work the new week is for. Default 20.
   */
  leftoverMax: number | null;
  /**
   * The ceilings as a list over periods - the canonical shape. Absent on a
   * budget written before periods existed; `cleanBudget` fills it from
   * `sessionMax`/`weeklyMax` and writes BOTH shapes, so an older reader keeps
   * working. Use `budgetLimits` to read it, `withLimit`/`withoutLimit` to edit it.
   */
  ceilings?: BudgetLimit[];
  /** Configured periods beyond the built-in `session`/`weekly` (month, week,
   *  day, rolling30d, span). The definitions `ceilings` refer to by id. */
  periods?: BudgetPeriod[];
}

export const DEFAULT_USAGE_BUDGET: UsageBudget = { enabled: true, sessionMax: 90, weeklyMax: null, leftoverMax: 20 };

/**
 * How old a usage reading may be and still be acted on.
 *
 * `UsageChecker` refreshes every 8 minutes while polling. Twenty-five is three
 * missed polls: long enough that a slow scrape or a host that was busy doesn't
 * flip the gate open, short enough that a reading from before a reset can never
 * hold work back for a whole window.
 */
export const BUDGET_STALE_MS = 25 * 60_000;

/** Why a budget verdict says what it says. A code, not a sentence — the UI owns
 *  the wording (`budgetReasonText`), the same split as `SendBlockReason`. */
export type BudgetState =
  /** The switch is off. */
  | "off"
  /** Both ceilings are set to 100 — enabled, but watching nothing. */
  | "unset"
  /** No usable reading (never scraped, `ok:false`, or older than
   *  `BUDGET_STALE_MS`). Work proceeds — see "fails open" above. */
  | "unknown"
  /** Under the ceiling. */
  | "ok"
  /** At or over a ceiling. This is the only state that blocks. */
  | "over";

export interface BudgetVerdict {
  /** The one thing callers act on. True only in state `over`. */
  blocked: boolean;
  state: BudgetState;
  /** Which ceiling was tripped, or which one is closest when `ok`. */
  which?: PeriodId;
  /** Unit of `pct`/`max`: absent = percent of a scraped window. */
  unit?: PeriodUnit;
  /** The reading and the ceiling behind the verdict, for the UI's sentence
   *  (`pct` holds dollars when `unit` is `usd`). */
  pct?: number;
  max?: number;
  /**
   * When this block is expected to clear, if the reading said. Advisory: the
   * verdict is re-asked, never scheduled — nothing fires ON this instant.
   */
  resumeAt?: number | null;
  /** With `state: "unknown"`, the cause a dollar ceiling's figure is missing for, as the
   *  caller worded it (`BudgetSpendWhy`) — so the sentence names it instead of guessing. */
  why?: string;
}

/** Why a dollar period has no figure, by period id, when the ledger SAID (e.g. claude's
 *  `undatedClause`). Missing = nobody said; the figure is then just "could not be read". */
export type BudgetSpendWhy = Partial<Record<PeriodId, string>>;

/**
 * One tripped ceiling: which window, the reading, the line it crossed, and when
 * that window resets (if the reading said).
 *
 * A separate shape from `BudgetVerdict` because the verdict names only the
 * FIRST ceiling over — which is the right sentence for a person, and the wrong
 * fact for the ladder: a row exempt from the session ceiling must still be held
 * by a weekly one that is also over (`intent.ts`'s `budgetHold`).
 */
export interface BudgetCeiling {
  which: PeriodId;
  /** The reading, in `unit` (percent used, or dollars spent). */
  pct: number;
  max: number;
  resetAt: number | null;
  /** Absent = percent of a scraped window (every ceiling before periods). */
  unit?: PeriodUnit;
}

/**
 * Every ceiling at or over its max right now, session first. `[]` when the
 * budget is off, unset, unreadable or stale, or simply under — the same
 * fail-open reading `budgetVerdict` makes, because `budgetVerdict`'s `over`
 * branch IS this list's first entry.
 */
export function budgetCeilings(cfg: UsageBudget, usage: UsageInfo | null | undefined, now: number, spend?: BudgetSpend): BudgetCeiling[] {
  if (!cfg.enabled) return [];
  const limits = activeLimits(cfg);
  if (!limits.length) return [];
  const usageOk = !!usage && usage.ok && !!usage.checkedAt && now - usage.checkedAt <= BUDGET_STALE_MS;

  const out: BudgetCeiling[] = [];
  for (const l of limits) {
    if (l.unit === "pct") {
      // Only the two scraped windows have a percentage; fails open on a stale reading.
      if (!usageOk || !usage) continue;
      const session = l.periodId === SESSION_PERIOD_ID;
      if (!session && l.periodId !== WEEKLY_PERIOD_ID) continue;
      const pct = session ? usage.sessionPct : usage.weeklyPct;
      const resetAt = (session ? usage.sessionResetAt : usage.weeklyResetAt) ?? null;
      if (pct == null) continue;
      // Past the reset the cached percentage is about a window that has ENDED.
      // This is the whole auto-continue: no fresh scrape has to land, no event has
      // to be delivered, and a reset that happened while the host was asleep is
      // resolved by the first tick after it wakes.
      if (resetAt != null && now >= resetAt) continue;
      if (pct >= l.max) out.push({ which: l.periodId, pct, max: l.max, resetAt });
    } else {
      const usd = spend?.[l.periodId];
      if (typeof usd !== "number" || !Number.isFinite(usd)) continue; // nobody measured: never a trip
      const period = periodOf(cfg, l.periodId);
      const bounds = period ? periodBounds(period, now) : null;
      if (period && bounds && !bounds.active) continue; // a span that is not running
      if (usd >= l.max) out.push({ which: l.periodId, pct: usd, max: l.max, resetAt: bounds?.resetAt ?? null, unit: "usd" });
    }
  }
  // The scraped windows first, session before weekly (the one that clears
  // soonest), then the rest in the order they were configured.
  const rank = (w: PeriodId): number => (w === SESSION_PERIOD_ID ? 0 : w === WEEKLY_PERIOD_ID ? 1 : 2);
  return out.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c.which) - rank(y.c.which) || x.i - y.i).map((x) => x.c);
}

const periodOf = (cfg: UsageBudget, id: PeriodId): BudgetPeriod | undefined => cfg.periods?.find((p) => p.id === id);

/**
 * The ceilings as a list, one reading. The `session`/`weekly` entries are built
 * from the mirrors `sessionMax`/`weeklyMax`, which are ALWAYS present and
 * therefore always the truth for those two: a reader that predates the list can
 * only edit the mirrors, and losing its edit to a stale list entry would be the
 * worse failure. Every other entry (the dollar ceilings) comes from `ceilings`.
 * Writers use `withLimit`/`withoutLimit`, which keep both shapes in step.
 */
export function budgetLimits(cfg: UsageBudget): BudgetLimit[] {
  const out: BudgetLimit[] = [{ periodId: SESSION_PERIOD_ID, max: cfg.sessionMax, unit: "pct" }];
  if (cfg.weeklyMax != null) out.push({ periodId: WEEKLY_PERIOD_ID, max: cfg.weeklyMax, unit: "pct" });
  for (const l of cfg.ceilings ?? []) if (l.periodId !== SESSION_PERIOD_ID && l.periodId !== WEEKLY_PERIOD_ID) out.push(l);
  return out;
}

/** The limits that watch anything: a percent strictly inside 1..99, a dollar cap above 0. */
function activeLimits(cfg: UsageBudget): BudgetLimit[] {
  return budgetLimits(cfg).filter((l) => (l.unit === "pct" ? l.max > 0 && l.max < 100 : l.max > 0 && Number.isFinite(l.max)));
}

/** Set (or replace) one ceiling, keeping the legacy mirrors in step. */
export function withLimit(cfg: UsageBudget, limit: BudgetLimit): UsageBudget {
  const rest = budgetLimits(cfg).filter((l) => l.periodId !== limit.periodId);
  const next = [...rest, limit];
  return mirrored(cfg, next);
}

/** Remove one ceiling (session: back to 100 = unwatched; weekly: null). */
export function withoutLimit(cfg: UsageBudget, periodId: PeriodId): UsageBudget {
  const next = budgetLimits(cfg).filter((l) => l.periodId !== periodId);
  return mirrored(cfg, periodId === SESSION_PERIOD_ID ? [...next, { periodId, max: 100, unit: "pct" }] : next);
}

function mirrored(cfg: UsageBudget, ceilings: BudgetLimit[]): UsageBudget {
  const s = ceilings.find((l) => l.periodId === SESSION_PERIOD_ID);
  const w = ceilings.find((l) => l.periodId === WEEKLY_PERIOD_ID);
  return { ...cfg, ceilings, sessionMax: s ? s.max : 100, weeklyMax: w ? w.max : null };
}

/**
 * The LEFTOVER ceiling, when it is tripped: the week's reading at or over
 * `leftoverMax`. `null` when it is off, the budget is off, the reading is
 * unreadable or stale, or the week has reset since the reading — the same
 * fail-open posture as `budgetCeilings`, and for the same reason: a row this
 * holds runs anyway under the wall, so a parse bug must not freeze it.
 *
 * Never part of `budgetCeilings`: it holds only rows `leftoverOf` names, so it
 * is not a reason for the account to read as paused.
 */
export function leftoverCeiling(cfg: UsageBudget, usage: UsageInfo | null | undefined, now: number): BudgetCeiling | null {
  if (!cfg.enabled || cfg.leftoverMax == null || !(cfg.leftoverMax > 0 && cfg.leftoverMax < 100)) return null;
  if (!usage || !usage.ok || !usage.checkedAt || now - usage.checkedAt > BUDGET_STALE_MS) return null;
  if (usage.weeklyPct == null) return null;
  const resetAt = usage.weeklyResetAt ?? null;
  if (resetAt != null && now >= resetAt) return null;
  return usage.weeklyPct >= cfg.leftoverMax ? { which: "weekly", pct: usage.weeklyPct, max: cfg.leftoverMax, resetAt } : null;
}

/** The sentence a leftover row wears while the leftover ceiling holds it. LEADS
 *  with why this row and not the rest: every other row is running under the
 *  ordinary ceilings, so a bare "paused" would read as the account's. */
export function budgetLeftoverText(c: BudgetCeiling, now: number, afterReset = false): string {
  const why = afterReset
    ? "timed for right after the weekly reset, so it starts only while the new week is under"
    : "leftover from a week that has reset — it was let past that week's budget and did not start in time, so it runs only while this week is under";
  return `${why} ${c.max}% (${c.pct}% used)`
    + budgetResumesText(c.resetAt, now).replace(" — resumes", " — next chance");
}

/**
 * Should automatic work start right now?
 *
 * The session ceiling is checked first because it is the one that clears
 * soonest: if both are over, the sentence a human wants is "back in 40
 * minutes", not "back on Thursday".
 */
export function budgetVerdict(cfg: UsageBudget, usage: UsageInfo | null | undefined, now: number, spend?: BudgetSpend, spendWhy?: BudgetSpendWhy): BudgetVerdict {
  if (!cfg.enabled) return { blocked: false, state: "off" };
  const limits = activeLimits(cfg);
  if (!limits.length) return { blocked: false, state: "unset" };
  const usageOk = !!usage && usage.ok && !!usage.checkedAt && now - usage.checkedAt <= BUDGET_STALE_MS;
  const hasUsd = limits.some((l) => l.unit === "usd");
  if (!usageOk && !hasUsd) return { blocked: false, state: "unknown" };
  // The first dollar ceiling with no figure whose ledger said why — the unknown sentence's cause.
  // A percent ceiling with no usable reading is a second cause, and the sentence names both.
  const unread = limits.find((l) => l.unit === "usd" && typeof spend?.[l.periodId] !== "number" && spendWhy?.[l.periodId]);
  const pctUnread = !usageOk && limits.some((l) => l.unit !== "usd");
  const why = unread ? { why: `${pctUnread ? "usage could not be read, and " : ""}${spendWhy![unread.periodId]!}` } : {};

  // One computation of "over", shared with the ladder's per-window reading.
  const first = budgetCeilings(cfg, usage, now, spend)[0];
  if (first) {
    return {
      blocked: true, state: "over", which: first.which, pct: first.pct, max: first.max, resumeAt: first.resetAt,
      ...(first.unit ? { unit: first.unit } : {}),
    };
  }

  // Under the ceiling - name the one with the least headroom, so the UI can say
  // how much room is left without deciding which number matters itself.
  const room: { which: PeriodId; pct: number; max: number; unit?: PeriodUnit }[] = [];
  for (const l of limits) {
    if (l.unit === "pct") {
      if (!usageOk || !usage) continue;
      const v = l.periodId === SESSION_PERIOD_ID ? usage.sessionPct : l.periodId === WEEKLY_PERIOD_ID ? usage.weeklyPct : null;
      if (v != null) room.push({ which: l.periodId, pct: v, max: l.max });
    } else {
      const usd = spend?.[l.periodId];
      if (typeof usd === "number" && Number.isFinite(usd)) room.push({ which: l.periodId, pct: usd, max: l.max, unit: "usd" });
    }
  }
  const tightest = room.sort((a, b) => (b.pct / b.max) - (a.pct / a.max))[0];
  return tightest
    ? { blocked: false, state: "ok", which: tightest.which, pct: tightest.pct, max: tightest.max, ...(tightest.unit ? { unit: tightest.unit } : {}) }
    : { blocked: false, state: "unknown", ...why };
}

/**
 * One sentence for a verdict. Lives here so the queue sheet, the backlog's
 * `waiting()` and the usage sheet all say the same thing about the same fact —
 * the rule this file exists to keep (see `blockedReasonText`).
 */
/** The word a period goes by in a sentence. */
export function periodWord(id: PeriodId | undefined): string {
  return id === ROLLING_30D_ID ? "rolling 30 days" : id === WEEKLY_PERIOD_ID ? "weekly window" : !id || id === SESSION_PERIOD_ID ? "session window" : id;
}

const usd = (n: number | undefined): string => (n == null ? "?" : `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, "")}`);

export function budgetReasonText(v: BudgetVerdict): string {
  if (v.unit === "usd") {
    const w = periodWord(v.which);
    if (v.state === "ok") return v.pct != null ? `${usd(v.pct)} spent this ${w} (budget ${usd(v.max)})` : "under the usage budget";
    if (v.state === "over") return `paused - ${usd(v.pct)} spent this ${w}, over the ${usd(v.max)} budget`;
  }
  const window = v.which === "weekly" ? "weekly" : "session";
  switch (v.state) {
    case "off": return "usage budget is off";
    case "unset": return "usage budget is on, but no ceiling is set";
    case "unknown": return `${v.why ?? "usage could not be read"} — the budget is not holding anything back`;
    case "ok": return v.pct != null ? `${v.pct}% of the ${window} window used (budget ${v.max}%)` : "under the usage budget";
    case "over": return `paused — ${v.pct}% of the ${window} window used, over the ${v.max}% budget`;
    // `state` arrives in the host's `budget.state` message: a state a newer
    // host adds reaches an older phone with no case for it.
    default: return "the usage budget is in a state this app version cannot name";
  }
}

/**
 * The *resumes …* clause of a budget hold. Formatted on the HOST, in the host's
 * locale and zone, like the clause it replaces in `main.ts` — which printed a
 * bare time for a weekly reset days out, and a bare time reads as *today*. So a
 * reset on another local day names the day.
 */
export function budgetResumesText(resetAt: number | null | undefined, now: number): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return "";
  const at = new Date(resetAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay ? ` — resumes ${time}` : ` — resumes ${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

const ceilingVerdict = (c: BudgetCeiling): BudgetVerdict =>
  ({ blocked: true, state: "over", which: c.which, pct: c.pct, max: c.max, resumeAt: c.resetAt, ...(c.unit ? { unit: c.unit } : {}) });

/** The sentence a budget-held row wears for one tripped ceiling — the `over`
 *  wording plus when it lifts. One of the three wordings of a budget hold. */
export function budgetHoldText(c: BudgetCeiling, now: number): string {
  return budgetReasonText(ceilingVerdict(c)) + budgetResumesText(c.resetAt, now);
}

/** A row timed BEFORE a reset its pass covers this ceiling for, and not yet at
 *  its time: held now, and told it will not be held then. `passWindow` is the
 *  window the row is timed ahead of — a weekly pass also covers the session cap.
 *  LEADS with the lift and carries no *resumes …* clause: read on a phone, a
 *  sentence opening "paused … resumes Thu 18:59" said the row would wait for the
 *  reset, when it runs at its own time, BEFORE it. `now` is kept for the
 *  signature the other two wordings share. */
export function budgetPassPendingText(c: BudgetCeiling, _now: number, passWindow: PeriodId = c.which): string {
  const which = passWindow === c.which ? "that window" : `the ${passWindow} window`;
  const over = budgetReasonText(ceilingVerdict(c)).replace(/^paused — /, "");
  return `lifted for this row at its time — it is timed before ${which} resets, and a ceiling only saves allowance for later in the window; there is no later · held only until then: ${over}`;
}

/** A row exempt from ONE window's ceiling, held by the OTHER window's. */
export function budgetOtherCapText(c: BudgetCeiling, passWindow: PeriodId, now: number): string {
  return `${budgetHoldText(c, now)} · exempt from the ${passWindow} ceiling, not from this one`;
}

/**
 * Sanitize a budget that came off disk or off the wire.
 *
 * Same posture as `cleanIntentRow` in `intent.ts`: a stored file is not a trusted
 * value — a hand-edited `sessionMax: 0` would block every send for ever with no
 * way back through the UI, so the range is clamped rather than believed.
 */
export function cleanBudget(raw: unknown): UsageBudget {
  const r = (raw ?? {}) as Partial<UsageBudget>;
  const pct = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(1, Math.round(n)));
  };
  const periods = cleanPeriods(r.periods);
  // The list, read strictly: a known period and a sane number, or dropped.
  // A $ ceiling on a period nobody defines (or `session`/`weekly` in dollars) is dropped.
  const known = new Set(periods.map((p) => p.id));
  const fromList: BudgetLimit[] = [];
  if (Array.isArray(r.ceilings)) {
    for (const l of r.ceilings as Partial<BudgetLimit>[]) {
      if (!l || typeof l.periodId !== "string" || fromList.some((x) => x.periodId === l.periodId)) continue;
      const n = Number(l.max);
      if (!Number.isFinite(n)) continue;
      if (l.periodId === SESSION_PERIOD_ID || l.periodId === WEEKLY_PERIOD_ID) {
        if (l.unit === "pct") fromList.push({ periodId: l.periodId, max: pct(n, 100), unit: "pct" });
      } else if (l.unit === "usd" && known.has(l.periodId) && n > 0) {
        fromList.push({ periodId: l.periodId, max: Math.round(n * 100) / 100, unit: "usd" });
      }
    }
  }
  const sessionMax = pct(r.sessionMax, fromList.find((l) => l.periodId === SESSION_PERIOD_ID)?.max ?? DEFAULT_USAGE_BUDGET.sessionMax);
  const weeklyFromList = fromList.find((l) => l.periodId === WEEKLY_PERIOD_ID)?.max ?? null;
  const out: UsageBudget = {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_USAGE_BUDGET.enabled,
    sessionMax,
    weeklyMax: r.weeklyMax === undefined ? weeklyFromList : r.weeklyMax === null ? null : pct(r.weeklyMax, 100),
    // Absent is a file from before this existed => the default; an explicit
    // `null` is somebody switching it off, and stays off.
    leftoverMax: r.leftoverMax === undefined ? DEFAULT_USAGE_BUDGET.leftoverMax
      : r.leftoverMax === null ? null : pct(r.leftoverMax, DEFAULT_USAGE_BUDGET.leftoverMax ?? 20),
  };
  // Write the new shape too, with the mirrors reconciled by `budgetLimits`.
  const merged: UsageBudget = { ...out, ceilings: fromList, periods };
  return { ...out, ceilings: budgetLimits(merged), periods };
}
