/**
 * The pure half of the week-share calibration (`actions.ts`'s `calibrateWeek`).
 */
import { WEEK_CAL_MIN_PCT, claudeReading, hasScrapedWindows, usageWindowPct, type BillingStatus, type PeriodState, type UsageBudget, type UsageInfo, type UsageReading } from "@waterplane/shared";
import { periodCap, periodChip, primaryUsdPeriod, type PeriodChip } from "../../periodWords.ts";

export const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The identity of a `/usage` reading a week share can be calibrated off, or
 * null: no weekly figure, one too small to divide by (`WEEK_CAL_MIN_PCT`), a
 * window that has rolled (the figure describes a week that is over), or a week
 * under an hour old. A new scrape is a new key and nothing else is.
 */
export function weekCalKey(u: UsageInfo | null, now: number): string | null {
  if (!u || u.weeklyPct == null || u.weeklyResetAt == null) return null;
  if (u.weeklyPct < WEEK_CAL_MIN_PCT) return null;
  if (u.weeklyResetAt <= now) return null;
  if (u.checkedAt - (u.weeklyResetAt - WEEK_MS) < HOUR_MS) return null;
  return `${u.weeklyResetAt}:${u.checkedAt}:${u.weeklyPct}`;
}

/**
 * What the usage chip draws:
 *  - `windows` — the 5-hour and weekly percentages (subscription, unknown, an old host).
 *  - `usd` — the primary dollar period, on an account with no scraped windows.
 *  - `door` — such an account with no measured dollar period: the gauge alone,
 *    a door into token statistics, never a `?`.
 */
export type UsageFace =
  | { kind: "windows" }
  | { kind: "usd"; chip: PeriodChip }
  | { kind: "door" };

export function usageFace(status: BillingStatus | null, view: { budget: UsageBudget; periods?: PeriodState[] } | null, now: number): UsageFace {
  if (hasScrapedWindows(status?.profile)) return { kind: "windows" };
  const s = primaryUsdPeriod(view?.periods, view?.budget, now);
  const chip = s ? periodChip(s, periodCap(view?.budget, s.period.id), now) : null;
  return chip ? { kind: "usd", chip } : { kind: "door" };
}

/**
 * The readings the phone holds for one `usage.status`: the host's list, or — an
 * older host sends none — claude's own derived from the scrape. `claudeReading`
 * is null for a failed scrape, and then the list is EMPTY (a source with no
 * reading draws nothing).
 */
export function readingsOf(listed: readonly UsageReading[] | undefined, u: UsageInfo | null): UsageReading[] {
  if (listed) return [...listed];
  const c = claudeReading(u);
  return c ? [c] : [];
}

/**
 * Which readings a SESSION's strip may draw: the ones that are this backend's
 * account; failing that, account-only readings (no `backend`). Never another
 * backend's quota — two percentages that belong to a different binary's quota
 * are a wrong number, not a spare one (SessionHeader).
 */
export function headerReadings(readings: readonly UsageReading[], backend: string | null | undefined): UsageReading[] {
  const own = backend ? readings.filter((r) => r.backend === backend) : [];
  return own.length ? own : readings.filter((r) => r.backend == null);
}

/**
 * Which readings the LAUNCHER's chip draws: claude's and account-only ones always;
 * another backend's account (Copilot) only while a session of that backend is
 * running. A quota for a binary nobody is driving was a tile of width spent on
 * a number nobody acts on; the token statistics still hold it.
 */
export function launcherReadings(readings: readonly UsageReading[], sessions: readonly { backend?: string; running: boolean }[]): UsageReading[] {
  const live = new Set(sessions.filter((s) => s.running).map((s) => s.backend ?? "claude"));
  return readings.filter((r) => r.source === "claude" || r.backend == null || r.backend === "claude" || live.has(r.backend));
}

/** The figures claude's segment prints; `null` = the CLI printed none (drawn `?`, as ever). */
export interface ClaudeFigures { sess: number | null; sessResetAt: number | null; wk: number | null }

export function claudeFigures(r: UsageReading): ClaudeFigures {
  const w = (id: string) => r.windows.find((x) => x.id === id);
  const s = w("session"), k = w("week");
  return { sess: s ? usageWindowPct(s) : null, sessResetAt: s?.resetAt ?? null, wk: k ? usageWindowPct(k) : null };
}

/** The scrape itself as figures — the chip's fallback while no reading exists. */
export const infoFigures = (u: UsageInfo | null): ClaudeFigures =>
  ({ sess: u?.sessionPct ?? null, sessResetAt: u?.sessionResetAt ?? null, wk: u?.weeklyPct ?? null });

/**
 * What claude's segment prints: the scrape itself when the phone holds one (it
 * keeps a reset clock beside a `?` percentage, which a reading drops with its
 * empty window), else the reading's own windows. The same scrape either way.
 */
export const claudeSegmentFigures = (r: UsageReading, u: UsageInfo | null): ClaudeFigures =>
  u?.ok ? infoFigures(u) : claudeFigures(r);

/** Danger for claude's chip: either window at or past 80 (the rule it has always had). */
export const figuresHot = (f: ClaudeFigures): boolean => (f.sess ?? 0) >= 80 || (f.wk ?? 0) >= 80;

/**
 * Which source a tap on a segment opens the token statistics ON. Claude's is the sheet's default
 * view, so its tap sets no filter and the sheet opens as it always has, with no "opened on" line
 * (the line's `all` would lead back to the same screen); any other source is a filter.
 */
export const tokensOpenSource = (source: string): string | null => (source !== "claude" ? source : null);

/**
 * Whether the launcher draws claude's `?/? wk` door BESIDE other sources' segments: the phone holds
 * claude's scrape, no claude reading came of it (a failed scrape, both windows rolled), and another
 * source has one. With nothing at all to draw the door is alone, as ever (not this predicate).
 */
export function claudeDoorBeside(segments: readonly { source: string }[], usage: UsageInfo | null): boolean {
  return !!usage && segments.length > 0 && !segments.some((s) => s.source === "claude");
}

/** The long-press tail naming sources cut past the chip's room. */
export const hiddenNote = (hidden: readonly string[] | undefined): string =>
  hidden?.length ? `\n+ ${hidden.join(", ")} not shown here` : "";
