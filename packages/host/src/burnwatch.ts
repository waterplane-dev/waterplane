/**
 * The burn-rate push: one notification when the WEEKLY figure climbs faster than
 * a threshold over the last stretch of readings, naming what spent it.
 *
 * The rule (reset-cut stretch, rate, cooldown, "already told", the words) is
 * `shared/burn.ts`, so the phone and this watcher cannot word it two ways. This
 * module is only the plumbing: read the kept readings, ask the verdict, look up
 * the dearest launch in the stretch from the cost fold, notify, remember.
 *
 * Words only. The push never pauses, holds, refuses or answers anything, and a
 * failed cost fold only costs the push its "dearest in it" line — the warning
 * itself is the point and is never skipped for a ledger hiccup. No timers here:
 * `UsageChecker`'s callback drives `observe`. That callback only fires while
 * something polls `/usage`, so `armed()` is what `main.ts`'s
 * `syncUsagePolling` asks: while the threshold is above zero and the `burn`
 * kind is on, the poll stays on — a screen read of `/usage` every
 * `USAGE_POLL_MS`, no model call. Without it the push needed a plugin, an armed
 * budget or a %-budget session to be polling for it, and was silent otherwise.
 */
import { join } from "node:path";
import {
  BURN_DEFAULT_COOLDOWN_MS, BURN_DEFAULT_PTS_PER_HOUR,
  SOURCE_BURN_UNITS, burnPushText, burnStretch, sourceBurnPushText, sourceBurnSamples, burnVerdict, envName, fmtUsd, foldLaunches, projectedEnd, ptsCalibration, ptsText,
  type BurnState, type CostWindowDoc, type UsageHistoryDoc, type UsageInfo, type UsageReading, type UsageSourceSample,
} from "@waterplane/shared";
import { writeJsonAtomic, readJsonGuarded } from "./jsonstore.js";
import type { Notify } from "./notifytypes.js";

const HOUR = 3_600_000;
/** The week-long readings the points calibration is checked against. */
const CAL_LOOKBACK_MS = 8 * 24 * HOUR;

export interface BurnWatchDeps {
  usageLog: { read(sinceMs?: number): UsageHistoryDoc };
  /** The fold over `[from, to)`; may reject (a ledger that cannot be read). */
  costWindow(from: number, to: number): Promise<CostWindowDoc>;
  notify: Notify;
  /** `hostStateDir(root)`; `burnwatch.json` lives here. */
  stateDir: string;
  now?: () => number;
  /** Points per hour; 0 (or less) = off. Env `WATERPLANE_BURN_PTS_PER_HOUR`. */
  thresholdPtsPerHour?: number;
  /** Env `WATERPLANE_BURN_COOLDOWN_MS`. */
  cooldownMs?: number;
}

/** A positive-or-zero finite number from an env string, else the fallback. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const isState = (v: unknown): boolean => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (s.lastAt === undefined || Number.isFinite(s.lastAt)) && (s.lastFrom === undefined || Number.isFinite(s.lastFrom));
};

export function createBurnWatch(deps: BurnWatchDeps): { observe(u: UsageInfo): Promise<boolean>; armed(): boolean } {
  const now = deps.now ?? Date.now;
  const threshold = deps.thresholdPtsPerHour ?? envNum(envName("BURN_PTS_PER_HOUR"), BURN_DEFAULT_PTS_PER_HOUR);
  const cooldown = deps.cooldownMs ?? envNum(envName("BURN_COOLDOWN_MS"), BURN_DEFAULT_COOLDOWN_MS);
  const file = join(deps.stateDir, "burnwatch.json");
  let state: BurnState = readJsonGuarded<BurnState>(file, {}, isState);
  let inFlight: Promise<boolean> | null = null;

  async function run(u: UsageInfo): Promise<boolean> {
    if (!u.ok || u.weeklyPct == null) return false;
    const t = now();
    const samples = deps.usageLog.read(CAL_LOOKBACK_MS).samples;
    const s = burnStretch(samples, t);
    const v = burnVerdict(s, threshold, state, t, cooldown);
    if (!v.fire || !s) return false;

    let top: { label: string; usd: number; share: number } | null = null;
    let pts: string | null = null;
    try {
      const doc = await deps.costWindow(s.from, t);
      // `rest` too: a run of many cheap sessions the cap folded is still one dear launch.
      const row = foldLaunches(doc.convos, doc.rest)[0];
      if (row && row.cost.total > 0) {
        top = { label: row.label, usd: row.cost.total, share: doc.cost.total > 0 ? row.cost.total / doc.cost.total : 0 };
        // Points are only worth saying when the week's own readings and ledger
        // agree on a rate (`ptsCalibration` refuses otherwise): a calibration
        // needs hours of cost across ≥ 6 h stretches, so it asks the week, not
        // this stretch. A refusal, or a week that cannot be read, is no clause.
        try {
          const week = await deps.costWindow(t - CAL_LOOKBACK_MS, t);
          pts = ptsText(row.cost.total, ptsCalibration(samples, week.hours, null));
        } catch { pts = null; }
      }
    } catch { top = null; pts = null; }

    // Remember BEFORE sending: a crash between the two must lose a push, never
    // repeat one (the same at-most-once stance as everything that notifies).
    state = { lastAt: t, lastFrom: s.from };
    try { writeJsonAtomic(file, state); } catch { /* an unwritable state dir leaves the in-memory cooldown */ }
    deps.notify("burn", { ...burnPushText(s, top, pts), tag: "burn", open: { to: "tokens" } });
    return true;
  }

  return {
    /** Whether a threshold is set at all — the half of "should `/usage` be polled for me" this
     *  module knows; whether the `burn` kind is muted is the caller's (`notifyPrefs`). */
    armed: () => threshold > 0,
    observe(u: UsageInfo): Promise<boolean> {
      if (inFlight) return Promise.resolve(false);
      inFlight = run(u).catch(() => false).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

// ── the same rule per non-claude source (c2 §3) ──────────────────────────────

export interface SourceBurnWatchDeps {
  /** A source's kept readings (`UsageSourceRegistry.history`); null = none kept. */
  history(source: string): UsageSourceSample[] | null;
  notify: Notify;
  /** `burnwatch-sources.json` lives here; claude's `burnwatch.json` is never touched. */
  stateDir: string;
  now?: () => number;
  thresholdPtsPerHour?: number;
  cooldownMs?: number;
}

/**
 * The burn push for each LONG window (`wk`, `mo`) of a non-claude source. One rule, one threshold,
 * one cooldown (`shared/burn.ts`); the latch is `{ "<source>:<window>": BurnState }`, written
 * BEFORE the push. Driven by a fresh, non-remembered reading — no timer. Claude is never asked here.
 */
export function createSourceBurnWatch(deps: SourceBurnWatchDeps): { observe(r: UsageReading): Promise<boolean>; armed(): boolean } {
  const now = deps.now ?? Date.now;
  const threshold = deps.thresholdPtsPerHour ?? envNum(envName("BURN_PTS_PER_HOUR"), BURN_DEFAULT_PTS_PER_HOUR);
  const cooldown = deps.cooldownMs ?? envNum(envName("BURN_COOLDOWN_MS"), BURN_DEFAULT_COOLDOWN_MS);
  const file = join(deps.stateDir, "burnwatch-sources.json");
  const state: Record<string, BurnState> = readJsonGuarded<Record<string, BurnState>>(
    file, {}, (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isState),
  );
  let inFlight: Promise<boolean> | null = null;

  async function run(r: UsageReading): Promise<boolean> {
    if (threshold <= 0 || r.source === "claude" || r.remembered) return false;
    let fired = false;
    for (const w of r.windows) {
      if (!SOURCE_BURN_UNITS.includes(w.unit)) continue;
      const samples = deps.history(r.source);
      if (!samples) continue;
      const t = now();
      const s = burnStretch(sourceBurnSamples(samples, w.id), t);
      const key = `${r.source}:${w.id}`;
      const v = burnVerdict(s, threshold, state[key] ?? {}, t, cooldown);
      if (!v.fire || !s) continue;
      state[key] = { lastAt: t, lastFrom: s.from };
      try { writeJsonAtomic(file, state); } catch { /* an unwritable state dir leaves the in-memory cooldown */ }
      deps.notify("burn", { ...sourceBurnPushText(r.label, w.unit, s), tag: `burn:${key}`, open: { to: "tokens" } });
      fired = true;
    }
    return fired;
  }

  return {
    armed: () => threshold > 0,
    observe(r: UsageReading): Promise<boolean> {
      if (inFlight) return Promise.resolve(false);
      inFlight = run(r).catch(() => false).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

// ── "$ vs pace": the same push for an account with no weekly window ──────────

export interface PaceWatchDeps {
  /** Each capped dollar period right now: where it stands, its cap, what is measured. Empty = nothing to judge. */
  paces(now: number): { id: string; label: string; start: number; resetAt: number | null; max: number; spentUsd: number | null }[];
  notify: Notify;
  stateDir: string;
  now?: () => number;
}

/**
 * The burn push for an api/cloud account: there is no weekly percentage to climb,
 * so the question is whether the period's spend, at the rate so far, ends past its
 * cap (`projectedEnd`, straight-line, silent in the first tenth of the period).
 * One push per period START - a month warns once, the next month again - written
 * BEFORE sending (lose one, never repeat one). Words only: it holds nothing (the
 * cap does that), and a period with no measured spend or no reset edge says nothing.
 */
export function createPaceWatch(deps: PaceWatchDeps): { check(): boolean } {
  const now = deps.now ?? Date.now;
  const file = join(deps.stateDir, "burnwatch-pace.json");
  const told: Record<string, number> = readJsonGuarded<Record<string, number>>(file, {}, (v) => !!v && typeof v === "object" && !Array.isArray(v));
  return {
    check(): boolean {
      const t = now();
      let sent = false;
      for (const p of deps.paces(t)) {
        if (p.spentUsd == null || p.spentUsd >= p.max || told[p.id] === p.start) continue;
        const end = projectedEnd(p.spentUsd, p.start, p.resetAt, t);
        if (end == null || end <= p.max) continue;
        told[p.id] = p.start;
        try { writeJsonAtomic(file, told); } catch { /* in-memory only until it can be written */ }
        deps.notify("burn", {
          title: `${p.label}: on pace to pass its cap`,
          body: `${fmtUsd(p.spentUsd)} spent so far; at this rate the period ends near ${fmtUsd(end)} against a ${fmtUsd(p.max)} cap. Automatic work will be held at the cap; this is this desktop at list price.`,
          tag: `pace:${p.id}`,
          open: { to: "tokens" },
        });
        sent = true;
      }
      return sent;
    },
  };
}
