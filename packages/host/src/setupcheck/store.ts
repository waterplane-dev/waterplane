/**
 * The Setup check's cache and its live wiring. The route never runs the sweep in the request: it
 * answers the last document at once (stale-while-revalidate), and a first sweep that outlasts
 * `SETUP_CHECK_WAIT_MS` answers `pending` and carries on in the background, as `agentreadings.ts`
 * does. No model call and no engine run happens here; every source is a cache or a file read.
 */
import { DEFAULT_CONTEXT_LIMITS, instructionInventory, type ComplianceCheck, type SeriesPoint } from "@waterplane/shared";
import { agentPointsFor, agentReadingsStore } from "../agentreadings.js";
import { desktopInstructionRows, worktreeFs } from "../alwayson.js";
import { backendInfos } from "../backends/index.js";
import { claudeBinResolution } from "../claudebin.js";
import { claudeSignInState } from "../doctorclaude.js";
import { contextLimitsFor, inspectRepoAsync } from "../compliance.js";
import { repoOfWorktree } from "../costwindow.js";
import { contributedFindings, hostChecks } from "../plugins/setupcontrib.js";
import { buildInventory } from "../skills/skillinventory.js";
import { autoCompactDefault, waivedFindings } from "../setupprefs.js";
import type { TokenStatsStore } from "../tokenstats.js";
import type { UsageInfo, BillingProfile, PeriodState, UsageReading } from "@waterplane/shared";
import { claudeCliRow, autoCompactFor, autoCompactMachineFor, copilotFact, healthFact, periodFact } from "./readers.js";
import { efficiencyFact } from "../efficiencywrite.js";
import { findingSeenLedger } from "./seen.js";
import { runSetupCheck, sweepRepos, type CollectDeps, type RepoOutcome, type SetupCheckDoc, type SweepRepo } from "./collect.js";

export const SETUP_CHECK_WAIT_MS = 8_000;
export const SETUP_CHECK_FRESH_MS = 60_000;

export interface LiveSources {
  root: string;
  tokenStats: Pick<TokenStatsStore, "read">;
  usage(): UsageInfo | null;
  billing(): BillingProfile;
  /** The repo-health response for a worktree (`healthwatch.respond`). */
  health?(wt: string): { series: { points: readonly { alerts: readonly { level: "warn" | "severe"; subject: string; text: string }[] }[] } | null };
  periods?(now: number): { states: PeriodState[]; ceilings: { periodId: string; max: number; unit: string }[] | undefined };
  usageReadings?(): UsageReading[];
  claudeBin?: () => string;
}

/** The real sources, wired from the daemon's own caches. */
export function liveDeps(s: LiveSources): CollectDeps {
  return {
    now: () => Date.now(),
    repoKey: repoOfWorktree,
    inspect: (wt) => inspectRepoAsync(wt),
    hostChecks: () => hostChecks(s.root),
    claudeCli: async (): Promise<ComplianceCheck | null> => {
      const res = claudeBinResolution();
      if (res.missing) return claudeCliRow(res, null);
      return claudeCliRow(res, await claudeSignInState(s.claudeBin?.() ?? res.bin));
    },
    instructions: (wt) => {
      const inv = instructionInventory(worktreeFs(wt));
      return { files: inv.files, overlaps: inv.overlaps, desktop: desktopInstructionRows(wt).rows };
    },
    warn: (wt) => {
      const v = contextLimitsFor(wt);
      return { warnChars: v.effective.maxChars, warnSource: (v.source.maxChars ?? "default") as "repo" | "env" | "default", globalWarnChars: DEFAULT_CONTEXT_LIMITS.maxChars };
    },
    points: async (): Promise<SeriesPoint[]> => {
      const { discoverTargets } = await import("../repos.js");
      const targets = await discoverTargets(s.root);
      const r = await agentPointsFor(agentReadingsStore(s.root), targets.map((t) => t.worktreePath));
      if (!r.ok) throw new Error(r.error);
      return r.points;
    },
    // A very large max age: the ledger's own store is read as it stands, no directory walk.
    ledger: () => s.tokenStats.read(Number.MAX_SAFE_INTEGER),
    skills: async (wt) => (await buildInventory({ worktree: wt })).doc.rows,
    autoCompact: (wt) => autoCompactFor(wt),
    autoCompactMachine: () => autoCompactMachineFor(),
    autoCompactDefault: () => autoCompactDefault(),
    usage: s.usage,
    billing: s.billing,
    ...(s.health ? { health: (wt: string) => healthFact(s.health!(wt)) } : {}),
    ...(s.periods ? { period: (now: number) => { const p = s.periods!(now); return periodFact(p.states, p.ceilings, now); } } : {}),
    ...(s.usageReadings ? { copilot: (now: number) => copilotFact(s.usageReadings!(), now) } : {}),
    backends: () => backendInfos(),
    waived: waivedFindings,
    efficiency: (wt) => efficiencyFact(wt),
    contributed: (wt) => contributedFindings(wt),
    seen: (findings, now) => findingSeenLedger(s.root).stamp(findings, now),
  };
}

/** The all-repos sweep: the last complete map, the one being built, and the sweep in flight. */
interface AllEntry { done: Map<string, RepoOutcome> | null; building: Map<string, RepoOutcome> | null; total: number; at: number; flight: Promise<void> | null; gen: number }
export interface AllReposView { outcomes: ReadonlyMap<string, RepoOutcome>; total: number; done: number; pending: boolean; at: number }

interface Entry { doc: SetupCheckDoc | null; flight: Promise<SetupCheckDoc> | null; gen: number }

export class SetupCheckStore {
  private entries = new Map<string, Entry>();
  private all: AllEntry = { done: null, building: null, total: 0, at: 0, flight: null, gen: 0 };
  constructor(private deps: () => CollectDeps, private o: { waitMs?: number; freshMs?: number; now?: () => number; sweep?: { concurrency?: number; timeoutMs?: number } } = {}) {}

  private start(wt: string): Promise<SetupCheckDoc> {
    const e = this.entries.get(wt) ?? { doc: null, flight: null, gen: 0 };
    this.entries.set(wt, e);
    if (!e.flight) {
      const gen = e.gen;
      const f: Promise<SetupCheckDoc> = runSetupCheck(this.deps(), wt)
        .then((d) => { if (e.gen === gen) e.doc = d; return d; })
        .finally(() => { if (e.flight === f) e.flight = null; });
      e.flight = f;
    }
    e.flight.catch(() => undefined);
    return e.flight;
  }

  /** The last document (re-run in the background once stale), or a first one within the wait, else pending. */
  async get(wt: string): Promise<{ doc: SetupCheckDoc } | { pending: true }> {
    const now = (this.o.now ?? Date.now)();
    const e = this.entries.get(wt);
    if (e?.doc) {
      if (now - e.doc.at > (this.o.freshMs ?? SETUP_CHECK_FRESH_MS)) void this.start(wt);
      return { doc: e.doc };
    }
    const flight = this.start(wt);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), this.o.waitMs ?? SETUP_CHECK_WAIT_MS); });
    try {
      const doc = await Promise.race([flight, late]);
      return doc ? { doc } : { pending: true };
    } catch { return { pending: true }; } finally { clearTimeout(timer); }
  }

  /**
   * Something a person changed: the cached document is DROPPED, so the next read waits for a fresh
   * run (a stale one would answer with the finding still listed). A run already in flight started
   * before the change; its answer is discarded.
   */
  invalidate(): void {
    for (const e of this.entries.values()) { e.doc = null; e.flight = null; e.gen++; }
    this.all = { done: null, building: null, total: 0, at: 0, flight: null, gen: this.all.gen + 1 };
  }

  private startAll(repos: readonly SweepRepo[]): Promise<void> {
    const a = this.all;
    if (a.flight) return a.flight;
    const gen = a.gen, building = new Map<string, RepoOutcome>();
    a.building = building; a.total = repos.length;
    const f: Promise<void> = sweepRepos(this.deps(), repos, building, this.o.sweep)
      .then(() => { if (this.all.gen === gen) { a.done = building; a.building = null; a.at = (this.o.now ?? Date.now)(); } })
      .catch(() => undefined)
      .finally(() => { if (a.flight === f) a.flight = null; });
    a.flight = f;
    return f;
  }

  /**
   * Every repo's outcome, stale-while-revalidate like `get`: a complete map answers at once (re-run in
   * the background once stale); a first sweep that outlasts the wait answers what is in so far, `pending`.
   */
  async getAll(repos: readonly SweepRepo[]): Promise<AllReposView> {
    const now = (this.o.now ?? Date.now)();
    const a = this.all;
    const view = (pending: boolean): AllReposView => {
      const m = a.done ?? a.building ?? new Map<string, RepoOutcome>();
      return { outcomes: m, total: repos.length, done: repos.filter((r) => m.has(r.id)).length, pending, at: a.at };
    };
    if (a.done) {
      if (now - a.at > (this.o.freshMs ?? SETUP_CHECK_FRESH_MS) || repos.some((r) => !a.done!.has(r.id))) void this.startAll(repos);
      return view(false);
    }
    const flight = this.startAll(repos);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((r) => { timer = setTimeout(r, this.o.waitMs ?? SETUP_CHECK_WAIT_MS); });
    try { await Promise.race([flight, late]); } finally { clearTimeout(timer); }
    return view(!this.all.done);
  }
}

let shared: SetupCheckStore | null = null;
export function setupCheckStore(make: () => CollectDeps): SetupCheckStore { return (shared ??= new SetupCheckStore(make)); }
export function resetSetupCheckStore(): void { shared = null; }
/** A person changed something this check reads: re-run on the next read. A no-op before the first read. */
export function invalidateSetupCheck(): void { shared?.invalidate(); }
