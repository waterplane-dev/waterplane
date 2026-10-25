/**
 * The week-end burn's plumbing: the weekly pick on disk, the observer that
 * posts one small backlog package per picked repo while the week has budget
 * left, and the once-a-week nudge.
 *
 * Every rule (when to start, when to stop, whether to nudge, what the agent is
 * told) is `shared/weekburn.ts`, so the phone's sheet and this observer cannot
 * word it two ways. This module only reads the reading, asks those functions,
 * posts, remembers.
 *
 * - **The pick is the approval.** Nothing posts without `pickedFor(prefs,
 *   weeklyResetAt)`: a pick bound to THIS week. `recurring` only re-asks.
 * - **Lazily, one at a time.** At most ONE live (`queued`/`blocked`/
 *   `starting`/`running`) row per picked repo carries a `weekburn:` origin; the
 *   next is posted only after it settles, and never more than
 *   `WATERPLANE_WEEKBURN_MAX_PER_REPO` (6) a week per repo. The count is
 *   written BEFORE the post: a crash between the two loses a package, never
 *   doubles one.
 * - **Ordinary backlog rows** (`BacklogManager.add`): `auto`, serial per repo,
 *   the slot cap and halt apply. Their own fresh session, closed when done, and
 *   a weekly `budgetPass` up to the reset — the weekly ceiling is lifted for
 *   these rows only (`shared/intent/budgetpass.ts`).
 * - **No timers.** `UsageChecker`'s callback drives `observe` (like
 *   `burnwatch.ts`), and `armed()` is what `main.ts`'s `syncUsagePolling` asks.
 *   A missing or stale reading posts nothing (`weekBurnStopText`).
 */
import { join } from "node:path";
import {
  cleanWeekBurnPrefs, envName, healthCapWords, pickedFor, weekBurnItemPrompt, weekBurnNudge, weekBurnPlan, weekBurnStopText,
  RESET_MATCH_MS, WEEKBURN_MEASURE_MS,
  type BudgetPass, type Intent, type NotificationKind, type NotifyOpen, type RepoHealthIndex, type UsageHistoryDoc, type UsageInfo,
  type WeekBurnPrefs, type WeekBurnStatus,
} from "@waterplane/shared";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** Origin prefix every row this module posts carries: `weekburn:<weekOf>`. */
export const WEEKBURN_ORIGIN = "weekburn:";
export const WEEKBURN_DEFAULT_MAX_PER_REPO = 6;
const LIVE: ReadonlySet<Intent["state"]> = new Set(["queued", "blocked", "starting", "running"]);
/** The plan's measurement looks back 14 days; a day of slack for the week's pace. */
const SAMPLES_LOOKBACK_MS = WEEKBURN_MEASURE_MS + 24 * 3_600_000;

export interface WeekBurnStore {
  prefs: WeekBurnPrefs;
  /** The weekly reset the last nudge was sent for (once per week). */
  nudgedWeekOf: number | null;
  /** Packages posted per repo, for the week `weekOf` names. */
  posted: Record<string, { weekOf: number; count: number }>;
}

export interface WeekBurnPostedItem { id: string; status: string; error?: string }

export interface WeekBurnDeps {
  stateDir: string;
  /** The checker's cached reading (`UsageChecker.get`). */
  usage(): UsageInfo;
  usageLog: { read(sinceMs?: number): UsageHistoryDoc };
  /** The account has the scraped windows (`hasScrapedWindows(billing profile)`). */
  subscription(): boolean;
  /** Every intent row (`IntentManager.list`). */
  rows(): readonly Intent[];
  /** The discovered repos (`discoverTargets`) — a pick naming anything else is dropped. */
  repos(): Promise<readonly { worktreePath: string; repoName: string }[]>;
  /** `BacklogManager.add`, narrowed to what a burn package sets. */
  add(text: string, repoDir: string, label: string, opts: { origin: string; closeWhenDone: true; budgetPass: BudgetPass }): WeekBurnPostedItem;
  /** The latest repo-health summary for a worktree, if the host has one (`HealthWatch.summaryFor`). */
  health?(repoDir: string): RepoHealthIndex | undefined;
  notify(kind: NotificationKind, p: { title: string; body: string; tag?: string; open?: NotifyOpen }): void;
  /** Whether the `weekburn` notification kind is on. */
  notifyOn(): boolean;
  /** Something `armed()` depends on moved — `syncUsagePolling`. */
  changed?(): void;
  now?: () => number;
  /** Env `WATERPLANE_WEEKBURN_MAX_PER_REPO`. */
  maxPerRepo?: number;
}

export interface WeekBurnPostBody { repos?: unknown; recurring?: unknown; stopPct?: unknown; sameAsLast?: unknown }

export interface WeekBurn {
  observe(u: UsageInfo): Promise<string[]>;
  armed(): boolean;
  status(): WeekBurnStatus;
  /** The sheet's one write. `error` = refused in words, nothing changed. */
  update(body: WeekBurnPostBody): Promise<{ status: WeekBurnStatus } | { error: string }>;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Hand-editable file: anything off-shape falls back field by field. */
export function cleanWeekBurnStore(x: unknown): WeekBurnStore {
  const o = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  const posted: WeekBurnStore["posted"] = {};
  if (o.posted && typeof o.posted === "object" && !Array.isArray(o.posted)) {
    for (const [k, v] of Object.entries(o.posted as Record<string, unknown>)) {
      const r = v as { weekOf?: unknown; count?: unknown } | null;
      if (r && typeof r.weekOf === "number" && Number.isFinite(r.weekOf) && typeof r.count === "number" && Number.isInteger(r.count) && r.count >= 0) {
        posted[k] = { weekOf: r.weekOf, count: r.count };
      }
    }
  }
  const n = o.nudgedWeekOf;
  return { prefs: cleanWeekBurnPrefs(o.prefs), nudgedWeekOf: typeof n === "number" && Number.isFinite(n) ? n : null, posted };
}

/** The repo-health summary as lines for the agent's prompt; null when there is none. */
export function healthSummaryText(s: RepoHealthIndex | undefined | null): string | null {
  if (!s || !Number.isFinite(s.value)) return null;
  const lines = [`Health index ${Math.round(s.value)}/100 (week of ${s.week}${s.deltaWeek != null ? `, ${s.deltaWeek >= 0 ? "+" : ""}${Math.round(s.deltaWeek)} on the week` : ""}).`];
  if (s.mean != null && s.cappedBy !== undefined) {
    const cap = healthCapWords({ value: s.value, mean: s.mean, cappedBy: s.cappedBy });
    if (cap) lines.push(cap);
  }
  if (s.alertText) lines.push(s.alertText);
  return lines.join("\n");
}

const sameWeek = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a != null && b != null && Math.abs(a - b) <= RESET_MATCH_MS;

export function createWeekBurn(deps: WeekBurnDeps): WeekBurn {
  const now = deps.now ?? Date.now;
  const maxPerRepo = deps.maxPerRepo ?? envInt(envName("WEEKBURN_MAX_PER_REPO"), WEEKBURN_DEFAULT_MAX_PER_REPO);
  const file = join(deps.stateDir, "weekburn.json");
  let store: WeekBurnStore = cleanWeekBurnStore(readJsonGuarded<unknown>(file, {}));
  let inFlight: Promise<string[]> | null = null;

  const save = (): void => {
    try { writeJsonAtomic(file, store); } catch { /* an unwritable state dir keeps the in-memory copy */ }
  };

  /** Live burn rows by repo dir (any week's: a row still running after a cancel is still running). */
  function liveByRepo(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of deps.rows()) {
      if (r.origin?.startsWith(WEEKBURN_ORIGIN) && LIVE.has(r.state) && !out.has(r.cwd)) out.set(r.cwd, r.id);
    }
    return out;
  }

  const countFor = (repo: string, weekOf: number): number => {
    const p = store.posted[repo];
    return p && sameWeek(p.weekOf, weekOf) ? p.count : 0;
  };

  const readingAt = (u: UsageInfo): number | null => (u.ok && u.checkedAt > 0 ? u.checkedAt : null);

  async function run(u: UsageInfo): Promise<string[]> {
    const t = now();
    const subscription = deps.subscription();
    const { prefs } = store;
    const samples = deps.usageLog.read(SAMPLES_LOOKBACK_MS).samples;
    const at = readingAt(u);

    // The nudge: words only, once per week, never while a pick for this week exists.
    if (deps.notifyOn()) {
      const words = weekBurnNudge({
        samples, prefs, weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, readingAt: at, subscription, nudgedWeekOf: store.nudgedWeekOf, now: t,
      });
      if (words && u.weeklyResetAt != null) {
        store.nudgedWeekOf = u.weeklyResetAt;
        save(); // before the push: lose one, never repeat one
        // No `open`: the phone maps the `weekburn` kind to its sheet (notifications `notifTarget`).
        deps.notify("weekburn", { ...words, tag: "weekburn" });
        deps.changed?.();
      }
    }

    if (!subscription || !pickedFor(prefs, u.weeklyResetAt) || prefs.weekOf == null || u.weeklyResetAt == null) return [];
    const plan = weekBurnPlan({ samples, weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, stopPct: prefs.stopPct, now: t });
    if (!plan || t < plan.startAt) return [];
    if (weekBurnStopText({ weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, stopPct: prefs.stopPct, now: t, readingAt: at }) !== null) return [];

    let known: readonly { worktreePath: string; repoName: string }[];
    try { known = await deps.repos(); } catch { return []; }
    const live = liveByRepo();
    const weekOf = prefs.weekOf;
    const posted: string[] = [];
    for (const repo of prefs.repos) {
      if (live.has(repo)) continue;
      const count = countFor(repo, weekOf);
      if (count >= maxPerRepo) continue;
      const target = known.find((k) => k.worktreePath === repo);
      if (!target) continue; // gone from the discovered list: never a cwd
      store.posted[repo] = { weekOf, count: count + 1 };
      save(); // before the post: at-most-once matters more than the count
      const text = weekBurnItemPrompt({ repoName: target.repoName, healthSummary: healthSummaryText(deps.health?.(repo)) });
      const item = deps.add(text, repo, "week-end burn", {
        origin: `${WEEKBURN_ORIGIN}${weekOf}`, closeWhenDone: true,
        budgetPass: { window: "weekly", from: t, until: u.weeklyResetAt },
      });
      if (item.status !== "failed") posted.push(item.id);
    }
    return posted;
  }

  function status(): WeekBurnStatus {
    const t = now();
    const u = deps.usage();
    const { prefs } = store;
    const subscription = deps.subscription();
    const hasReading = u.ok && u.weeklyPct != null && u.weeklyResetAt != null;
    const available = subscription && hasReading;
    const unavailableText = !subscription
      ? "The week-end burn needs a subscription account: this account has no weekly window to spend."
      : !hasReading ? "No weekly reading yet: the week-end burn waits for the /usage screen to name the week's percent and reset." : undefined;
    const plan = available
      ? weekBurnPlan({ samples: deps.usageLog.read(SAMPLES_LOOKBACK_MS).samples, weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, stopPct: prefs.stopPct, now: t })
      : null;
    const picked = pickedFor(prefs, u.weeklyResetAt);
    const live = liveByRepo();
    const dirs = [...(picked ? prefs.repos : []), ...[...live.keys()].filter((d) => !(picked && prefs.repos.includes(d)))];
    const running = dirs.map((repoDir) => {
      const posted = prefs.weekOf != null ? countFor(repoDir, prefs.weekOf) : 0;
      return {
        repoDir, posted, live: live.get(repoDir) ?? null,
        ...(posted >= maxPerRepo ? { stoppedText: `Done for the week: ${maxPerRepo} packages posted.` } : {}),
      };
    });
    const stop = picked ? weekBurnStopText({ weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, stopPct: prefs.stopPct, now: t, readingAt: readingAt(u) }) : null;
    return {
      prefs, available, ...(unavailableText ? { unavailableText } : {}),
      weeklyPct: u.weeklyPct, weeklyResetAt: u.weeklyResetAt, plan, pickedThisWeek: picked, running,
      ...(stop ? { stoppedText: stop } : {}),
    };
  }

  async function update(body: WeekBurnPostBody): Promise<{ status: WeekBurnStatus } | { error: string }> {
    const next: WeekBurnPrefs = { ...store.prefs };
    if (typeof body.recurring === "boolean") next.recurring = body.recurring;
    if (typeof body.stopPct === "number") next.stopPct = body.stopPct;
    const wanted: unknown = body.sameAsLast === true ? store.prefs.lastRepos : body.repos;
    if (wanted !== undefined) {
      if (!Array.isArray(wanted)) return { error: "repos must be a list of repo folders." };
      const asked = wanted.filter((d): d is string => typeof d === "string");
      let known: readonly { worktreePath: string }[] = [];
      if (asked.length) {
        try { known = await deps.repos(); } catch { known = []; }
      }
      const repos = [...new Set(asked)].filter((d) => known.some((k) => k.worktreePath === d)); // unknown dropped, never spawned
      if (repos.length) {
        const resetAt = deps.usage().weeklyResetAt;
        if (resetAt == null) return { error: "No weekly reset reading yet, so there is no week to bind the pick to. Try again once /usage has been read." };
        next.repos = repos; next.weekOf = resetAt; next.lastRepos = repos;
      } else {
        // Cancel this week: live rows finish, nothing new is posted.
        next.repos = []; next.weekOf = null;
      }
    }
    store = { ...store, prefs: cleanWeekBurnPrefs(next) };
    save();
    deps.changed?.();
    await api.observe(deps.usage()); // a pick at or after the start acts now, not on the next poll
    return { status: status() };
  }

  const api: WeekBurn = {
    observe(u: UsageInfo): Promise<string[]> {
      if (inFlight) return inFlight.then(() => []);
      inFlight = run(u).catch(() => [] as string[]).finally(() => { inFlight = null; });
      return inFlight;
    },
    armed(): boolean {
      if (!deps.subscription()) return false;
      const { prefs } = store;
      if (prefs.recurring) return true;
      const resetAt = deps.usage().weeklyResetAt;
      if (pickedFor(prefs, resetAt)) return true;
      // A nudge could still be due: the kind is on and this week's has not gone out.
      return deps.notifyOn() && !sameWeek(store.nudgedWeekOf, resetAt);
    },
    status,
    update,
  };
  return api;
}
