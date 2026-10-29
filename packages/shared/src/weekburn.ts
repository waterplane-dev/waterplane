/**
 * The week-end burn: spending what is left of a subscription week on small
 * repo improvements, in the repos the person picked FOR THIS WEEK.
 *
 * Pure, no clock (callers pass `now`), shared by the host's observer and the
 * phone's sheet so both print the same sentence. Every reading that cannot be
 * made is null or a refusal in words — never a guessed number, and never a
 * mutation: the pick is the approval, these functions only say when, whether
 * and what to tell the person.
 */
import type { UsageSample } from "./wire/telemetry.js";
import { usageStretches } from "./burn.js";
import { BUDGET_STALE_MS } from "./budget.js";
import { RESET_MATCH_MS } from "./intent.js";

const HOUR = 3_600_000;
const MIN = 60_000;

export const WEEKBURN_DEFAULT_STOP_PCT = 95;
/** One 5-hour session window. */
export const WEEKBURN_WINDOW_MS = 5 * HOUR;
/** A full window is a session stretch that reached this percent. */
export const WEEKBURN_FULL_WINDOW_PCT = 80;
/** How far back a measured window may be. */
export const WEEKBURN_MEASURE_MS = 14 * 24 * HOUR;
/** Nothing new is posted this close to the weekly reset. */
export const WEEKBURN_STOP_BEFORE_RESET_MS = 20 * MIN;
/** Margin before the computed windows, and the fallback lead when none is measured. */
export const WEEKBURN_MARGIN_MS = HOUR;
export const WEEKBURN_FALLBACK_LEAD_MS = 24 * HOUR;
/** The nudge goes out this long before the planned start. */
export const WEEKBURN_NUDGE_LEAD_MS = 24 * HOUR;
/** On pace to leave at least this many points under the stop line ⇒ offer the burn. */
export const WEEKBURN_NUDGE_GAP_PCT = 20;
const MAX_REPOS = 50;
/** The person's own words for what a burn session works on, and per repo; longer is cut. */
export const WEEKBURN_TASK_MAX = 2000;
export const WEEKBURN_NOTE_MAX = 1000;
const MIN_RATE_SPAN_MS = 6 * HOUR;

export interface WeekBurnPrefs {
  /** Repos picked for the week `weekOf` names. */
  repos: string[];
  /** The weekly reset instant the pick was made for; null = no pick. */
  weekOf: number | null;
  /** "Ask me again each week" — never runs last week's repos by itself. */
  recurring: boolean;
  /** Last week's pick, for the one-tap "same as last week". */
  lastRepos: string[];
  stopPct: number;
  /** What every session works on, in the person's words; "" = the weakest health reading. */
  task: string;
  /** One extra line per repo folder, added to that repo's prompt only. */
  notes: Record<string, string>;
}

export interface WeekBurnPlan {
  startAt: number;
  windows: number | null;
  ptsPerWindow: number | null;
  /** One sentence; host and phone print the same one. */
  reasonText: string;
  /** Weekly percent at the reset if the week keeps its pace; null = cannot say. */
  projectedPct: number | null;
}

export interface WeekBurnStatus {
  prefs: WeekBurnPrefs;
  available: boolean;
  unavailableText?: string;
  weeklyPct: number | null;
  weeklyResetAt: number | null;
  plan: WeekBurnPlan | null;
  pickedThisWeek: boolean;
  running: { repoDir: string; posted: number; live: string | null; stoppedText?: string }[];
  stoppedText?: string;
  /** Most packages one repo gets in a week. */
  maxPerRepo?: number;
  /** The latest health summary per repo folder, as the prompt quotes it; absent = none on file. */
  readings?: Record<string, string>;
}

function cleanText(x: unknown, max: number): string {
  return typeof x === "string" ? x.trim().slice(0, max) : "";
}

function cleanNotes(x: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const t = cleanText(v, WEEKBURN_NOTE_MAX);
    if (k.trim() && t) out[k] = t;
    if (Object.keys(out).length >= MAX_REPOS) break;
  }
  return out;
}

function cleanRepos(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const r of x) {
    if (typeof r === "string" && r.trim() && !out.includes(r)) out.push(r);
    if (out.length >= MAX_REPOS) break;
  }
  return out;
}

/** Hand-editable file: anything that is not the right shape falls back to the default for that field. */
export function cleanWeekBurnPrefs(x: unknown): WeekBurnPrefs {
  const o = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  const stop = typeof o.stopPct === "number" && Number.isFinite(o.stopPct) ? Math.min(100, Math.max(50, Math.round(o.stopPct))) : WEEKBURN_DEFAULT_STOP_PCT;
  const weekOf = typeof o.weekOf === "number" && Number.isFinite(o.weekOf) && o.weekOf > 0 ? o.weekOf : null;
  return { repos: cleanRepos(o.repos), weekOf, recurring: o.recurring === true, lastRepos: cleanRepos(o.lastRepos), stopPct: stop,
    task: cleanText(o.task, WEEKBURN_TASK_MAX), notes: cleanNotes(o.notes) };
}

/**
 * Weekly points one 5-hour session window can burn, measured: per session
 * stretch that reached `WEEKBURN_FULL_WINDOW_PCT` inside the last 14 days, the
 * weekly figure's climb during it; the MAX. Null when no stretch qualifies.
 */
export function ptsPerWindow(samples: readonly UsageSample[], now: number): number | null {
  let best: number | null = null;
  for (const seg of usageStretches(samples, "session")) {
    if (seg.pts.length < 2) continue;
    const from = seg.pts[0].t;
    const to = seg.pts[seg.pts.length - 1].t;
    if (to < now - WEEKBURN_MEASURE_MS || to > now) continue;
    if (!seg.pts.some((p) => p.v >= WEEKBURN_FULL_WINDOW_PCT)) continue;
    let first: number | null = null;
    let last: number | null = null;
    let fell = false;
    for (const r of samples) {
      if (r.w == null || r.t < from || r.t > to) continue;
      if (first == null) first = r.w;
      else if (last != null && r.w < last - 2) fell = true; // the week reset inside: not a measurement
      last = r.w;
    }
    if (first == null || last == null || fell) continue;
    const d = last - first;
    if (d > 0 && (best == null || d > best)) best = d;
  }
  return best;
}

/** `3 days`, `5 h`, `40 min`, rounded; the only clock wording here (relative, so no zone is needed). */
function inText(ms: number): string {
  const min = Math.max(0, Math.round(ms / MIN));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** The week's pace carried to the reset, linear over this week's readings; null under six hours of them. */
function projectedAtReset(samples: readonly UsageSample[], weeklyPct: number, weeklyResetAt: number, now: number): number | null {
  const segs = usageStretches(samples, "week");
  const last = segs[segs.length - 1];
  if (!last) return null;
  const pts = last.pts.filter((p) => p.t <= now);
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const span = b.t - a.t;
  if (span < MIN_RATE_SPAN_MS) return null;
  const rate = Math.max(0, b.v - a.v) / span; // points per ms
  const left = Math.max(0, weeklyResetAt - now);
  return Math.min(100, Math.round((weeklyPct + rate * left) * 10) / 10);
}

export function weekBurnPlan(a: {
  samples: readonly UsageSample[]; weeklyPct: number | null; weeklyResetAt: number | null; stopPct: number; now: number;
}): WeekBurnPlan | null {
  const { samples, weeklyPct, weeklyResetAt, stopPct, now } = a;
  if (weeklyPct == null || weeklyResetAt == null || !Number.isFinite(weeklyPct) || !Number.isFinite(weeklyResetAt)) return null;
  if (weeklyResetAt <= now) return null;
  const pts = ptsPerWindow(samples, now);
  const projectedPct = projectedAtReset(samples, weeklyPct, weeklyResetAt, now);
  const remaining = stopPct - weeklyPct;
  let windows: number | null = null;
  let raw: number;
  let basis: string;
  if (remaining <= 0) {
    windows = 0;
    raw = now;
    basis = `The week is already at ${Math.round(weeklyPct)}%`;
  } else if (pts != null) {
    windows = Math.ceil(remaining / pts);
    raw = weeklyResetAt - windows * WEEKBURN_WINDOW_MS - WEEKBURN_MARGIN_MS;
    basis = `${windows === 1 ? "One full 5 h window" : `${windows} full 5 h windows`} burn about ${Math.round(remaining)} points at the pace you measured (${Math.round(pts * 10) / 10} a window)`;
  } else {
    raw = weeklyResetAt - WEEKBURN_FALLBACK_LEAD_MS;
    basis = "No measured full window yet, so starting a day before reset";
  }
  const startAt = Math.max(now, Math.round(raw));
  const reasonText = startAt <= now
    ? `${basis}. Starting now.`
    : `${basis}. Starting in ${inText(startAt - now)}.`;
  return { startAt, windows, ptsPerWindow: pts, reasonText, projectedPct };
}

/** Whether the pick on file is for the week that resets at `weeklyResetAt` (RESET_MATCH_MS tolerance). */
export function pickedFor(prefs: WeekBurnPrefs, weeklyResetAt: number | null): boolean {
  if (prefs.weekOf == null || weeklyResetAt == null || prefs.repos.length === 0) return false;
  return Math.abs(prefs.weekOf - weeklyResetAt) <= RESET_MATCH_MS;
}

/**
 * Null = a new row may be posted. Otherwise the sentence for why not. A
 * missing or stale weekly reading never posts: `readingAt` is when the
 * reading was taken (null = nobody read it).
 */
export function weekBurnStopText(a: {
  weeklyPct: number | null; weeklyResetAt: number | null; stopPct: number; now: number; readingAt?: number | null;
}): string | null {
  const { weeklyPct, weeklyResetAt, stopPct, now } = a;
  if (weeklyPct == null || weeklyResetAt == null) return "Paused: no weekly reading yet.";
  if (a.readingAt == null || now - a.readingAt > BUDGET_STALE_MS) return "Paused: the weekly reading is out of date.";
  if (weeklyPct >= stopPct) return `Stopped: week at ${Math.round(weeklyPct)}%.`;
  if (now >= weeklyResetAt - WEEKBURN_STOP_BEFORE_RESET_MS) return "Stopped: the week resets within 20 min.";
  return null;
}

/**
 * The once-a-week push, or null. Words only: it asks, it starts nothing.
 * `nudgedWeekOf` is the reset the last nudge was sent for (once per week).
 */
export function weekBurnNudge(a: {
  samples: readonly UsageSample[]; prefs: WeekBurnPrefs; weeklyPct: number | null; weeklyResetAt: number | null;
  readingAt: number | null; subscription: boolean; nudgedWeekOf: number | null; now: number;
}): { title: string; body: string } | null {
  const { prefs, weeklyPct, weeklyResetAt, now } = a;
  if (!a.subscription || weeklyPct == null || weeklyResetAt == null) return null;
  if (a.readingAt == null || now - a.readingAt > BUDGET_STALE_MS) return null;
  if (pickedFor(prefs, weeklyResetAt)) return null;
  if (a.nudgedWeekOf != null && Math.abs(a.nudgedWeekOf - weeklyResetAt) <= RESET_MATCH_MS) return null;
  if (weeklyPct >= prefs.stopPct || weeklyResetAt <= now) return null;
  const plan = weekBurnPlan({ samples: a.samples, weeklyPct, weeklyResetAt, stopPct: prefs.stopPct, now });
  if (!plan || now < plan.startAt - WEEKBURN_NUDGE_LEAD_MS) return null;
  if (prefs.recurring) {
    return { title: "Pick this week's repos", body: `The week-end burn is on repeat, but each week needs its own pick. The week resets in ${inText(weeklyResetAt - now)}.` };
  }
  const p = plan.projectedPct;
  if (p == null || p >= prefs.stopPct - WEEKBURN_NUDGE_GAP_PCT) return null;
  const unused = Math.round(100 - p);
  return {
    title: "Budget left over this week",
    body: `On pace to leave ~${unused}% of this week unused (resets in ${inText(weeklyResetAt - now)}). Pick repos for the week-end burn?`,
  };
}

/** The task line when the person wrote none. */
export const WEEKBURN_DEFAULT_TASK = "Fix the repo's weakest health reading";

/** The lines every package is told whatever the person wrote: the safety rails, never editable. */
export const WEEKBURN_RULES: readonly string[] = [
  "Make ONE focused improvement. Run the repo's tests. Commit on the current branch only if they pass: stage explicit paths, never `git add -A`, never push, never stash or reset.",
  "If nothing worth doing is left, change nothing and say so in one line.",
];

/**
 * What an unattended burn package is told. One improvement, one commit,
 * nothing pushed. `task` (the person's words) replaces the default "weakest
 * reading" ask; `note` is added for this repo only. The phone builds its
 * preview with this same function, so what the sheet shows is what is sent.
 */
export function weekBurnItemPrompt(a: { repoName: string; healthSummary?: string | null; task?: string | null; note?: string | null }): string {
  const readings = a.healthSummary && a.healthSummary.trim() ? `Latest repo readings:\n${a.healthSummary.trim()}` : null;
  const task = a.task && a.task.trim();
  const ask = task
    ? [`What to work on (from the person who picked this repo):\n${task}`, ...(readings ? [readings] : [])]
    : readings
      ? [readings, "Pick the weakest reading."]
      : ["Look for the repo's own checks, tests and lint, and pick the weakest area."];
  const note = a.note && a.note.trim();
  return [
    `This is an unattended week-end burn package for ${a.repoName}. Nobody is watching, so keep it small.`,
    ...ask,
    ...(note ? [`For this repo:\n${note}`] : []),
    ...WEEKBURN_RULES,
  ].join("\n\n");
}

/** Origin prefix every row the week-end burn posts carries: `weekburn:<weekOf>`. */
export const WEEKBURN_ORIGIN = "weekburn:";

/** Did the week-end burn post this row? The ONE test, for the host's live-row map and the phone's chip and cut. */
export const isWeekBurnOrigin = (origin: string | undefined | null): boolean => !!origin?.startsWith(WEEKBURN_ORIGIN);

/** The backlog row's chip: what wrote it. */
export const FROM_WEEKBURN_WORDS = "from the week-end burn";

/** The repo bar's count, which opens exactly those rows (a count is a filter). */
export const weekBurnRowsLabel = (n: number): string => `${n} from the week-end burn`;
