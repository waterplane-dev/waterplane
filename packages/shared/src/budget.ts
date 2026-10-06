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
}

export const DEFAULT_USAGE_BUDGET: UsageBudget = { enabled: true, sessionMax: 90, weeklyMax: null };

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
  which?: "session" | "weekly";
  /** The reading and the ceiling behind the verdict, for the UI's sentence. */
  pct?: number;
  max?: number;
  /**
   * When this block is expected to clear, if the reading said. Advisory: the
   * verdict is re-asked, never scheduled — nothing fires ON this instant.
   */
  resumeAt?: number | null;
}

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
  which: "session" | "weekly";
  pct: number;
  max: number;
  resetAt: number | null;
}

/**
 * Every ceiling at or over its max right now, session first. `[]` when the
 * budget is off, unset, unreadable or stale, or simply under — the same
 * fail-open reading `budgetVerdict` makes, because `budgetVerdict`'s `over`
 * branch IS this list's first entry.
 */
export function budgetCeilings(cfg: UsageBudget, usage: UsageInfo | null | undefined, now: number): BudgetCeiling[] {
  if (!cfg.enabled) return [];
  const watchSession = cfg.sessionMax > 0 && cfg.sessionMax < 100;
  const watchWeekly = cfg.weeklyMax != null && cfg.weeklyMax > 0 && cfg.weeklyMax < 100;
  if (!watchSession && !watchWeekly) return [];
  if (!usage || !usage.ok || !usage.checkedAt || now - usage.checkedAt > BUDGET_STALE_MS) return [];

  const over = (pct: number | null, max: number | null, resetAt: number | null): boolean => {
    if (pct == null || max == null) return false;
    // Past the reset the cached percentage is about a window that has ENDED.
    // This is the whole auto-continue: no fresh scrape has to land, no event has
    // to be delivered, and a reset that happened while the host was asleep is
    // resolved by the first tick after it wakes.
    if (resetAt != null && now >= resetAt) return false;
    return pct >= max;
  };

  const out: BudgetCeiling[] = [];
  if (watchSession && over(usage.sessionPct, cfg.sessionMax, usage.sessionResetAt)) {
    out.push({ which: "session", pct: usage.sessionPct!, max: cfg.sessionMax, resetAt: usage.sessionResetAt ?? null });
  }
  if (watchWeekly && over(usage.weeklyPct, cfg.weeklyMax, usage.weeklyResetAt)) {
    out.push({ which: "weekly", pct: usage.weeklyPct!, max: cfg.weeklyMax!, resetAt: usage.weeklyResetAt ?? null });
  }
  return out;
}

/**
 * Should automatic work start right now?
 *
 * The session ceiling is checked first because it is the one that clears
 * soonest: if both are over, the sentence a human wants is "back in 40
 * minutes", not "back on Thursday".
 */
export function budgetVerdict(cfg: UsageBudget, usage: UsageInfo | null | undefined, now: number): BudgetVerdict {
  if (!cfg.enabled) return { blocked: false, state: "off" };
  const watchSession = cfg.sessionMax > 0 && cfg.sessionMax < 100;
  const watchWeekly = cfg.weeklyMax != null && cfg.weeklyMax > 0 && cfg.weeklyMax < 100;
  if (!watchSession && !watchWeekly) return { blocked: false, state: "unset" };
  if (!usage || !usage.ok || !usage.checkedAt || now - usage.checkedAt > BUDGET_STALE_MS) {
    return { blocked: false, state: "unknown" };
  }

  // One computation of "over", shared with the ladder's per-window reading.
  const first = budgetCeilings(cfg, usage, now)[0];
  if (first) {
    return { blocked: true, state: "over", which: first.which, pct: first.pct, max: first.max, resumeAt: first.resetAt };
  }

  // Under the ceiling — name the one with the least headroom, so the UI can say
  // how much room is left without deciding which number matters itself.
  const room: { which: "session" | "weekly"; pct: number; max: number }[] = [];
  if (watchSession && usage.sessionPct != null) room.push({ which: "session", pct: usage.sessionPct, max: cfg.sessionMax });
  if (watchWeekly && usage.weeklyPct != null) room.push({ which: "weekly", pct: usage.weeklyPct, max: cfg.weeklyMax! });
  const tightest = room.sort((a, b) => (b.pct / b.max) - (a.pct / a.max))[0];
  return tightest
    ? { blocked: false, state: "ok", which: tightest.which, pct: tightest.pct, max: tightest.max }
    : { blocked: false, state: "unknown" };
}

/**
 * One sentence for a verdict. Lives here so the queue sheet, the backlog's
 * `waiting()` and the usage sheet all say the same thing about the same fact —
 * the rule this file exists to keep (see `blockedReasonText`).
 */
export function budgetReasonText(v: BudgetVerdict): string {
  const window = v.which === "weekly" ? "weekly" : "session";
  switch (v.state) {
    case "off": return "usage budget is off";
    case "unset": return "usage budget is on, but no ceiling is set";
    case "unknown": return "usage could not be read — the budget is not holding anything back";
    case "ok": return v.pct != null ? `${v.pct}% of the ${window} window used (budget ${v.max}%)` : "under the usage budget";
    case "over": return `paused — ${v.pct}% of the ${window} window used, over the ${v.max}% budget`;
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

/** The sentence a budget-held row wears for one tripped ceiling — the `over`
 *  wording plus when it lifts. One of the three wordings of a budget hold. */
export function budgetHoldText(c: BudgetCeiling, now: number): string {
  return budgetReasonText({ blocked: true, state: "over", which: c.which, pct: c.pct, max: c.max, resumeAt: c.resetAt })
    + budgetResumesText(c.resetAt, now);
}

/** A row timed BEFORE a reset its pass covers this ceiling for, and not yet at
 *  its time: held now, and told it will not be held then. `passWindow` is the
 *  window the row is timed ahead of — a weekly pass also covers the session cap. */
export function budgetPassPendingText(c: BudgetCeiling, now: number, passWindow: "session" | "weekly" = c.which): string {
  const which = passWindow === c.which ? "that window" : `the ${passWindow} window`;
  return `${budgetHoldText(c, now)} · lifted for this row at its time — it is timed before ${which} resets, and a ceiling only saves allowance for later in the window; there is no later`;
}

/** A row exempt from ONE window's ceiling, held by the OTHER window's. */
export function budgetOtherCapText(c: BudgetCeiling, passWindow: "session" | "weekly", now: number): string {
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
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_USAGE_BUDGET.enabled,
    sessionMax: pct(r.sessionMax, DEFAULT_USAGE_BUDGET.sessionMax),
    weeklyMax: r.weeklyMax == null ? null : pct(r.weeklyMax, 100),
  };
}
