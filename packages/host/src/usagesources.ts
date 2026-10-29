/**
 * Usage readings PER SOURCE — the registry the phone's chip is drawn from.
 *
 * claude's `/usage` scrape stays `UsageChecker` (`usage.ts`, untouched): the
 * budget, the intent ladder's window conditions, the burn and session-budget
 * calibrators and the plugin API's `claudeUsage()` all read its `UsageInfo`.
 * This registry puts the LIST form beside it — `usage.status`'s `readings` —
 * with claude's adapted through `claudeReading()` FIRST, then one reading per
 * contributed probe (`api.usageProbe`: Copilot's quota, any plugin's).
 *
 * The rules, each because the alternative is a wrong number or a spent process:
 * - **ABSENT, never a guess.** A probe answering null drops its source; a
 *   reading the core cannot vouch for is vetted down window by window (a
 *   percentage outside 0..100, a count with no limit), and one with nothing
 *   left is absent, never `pct: null` with nothing beside it.
 * - **A throw keeps the last reading** until its windows reset
 *   (`readingAfterResets`, asked on every `readings()`), with one log line per
 *   source until it recovers — `UsageChecker`'s "last good reading" rule. A
 *   window that names NO reset is kept only `KEPT_UNNAMED_MAX_MS` (24 h) past
 *   its last successful probe (`readingAfterAge`): absent beats a stale figure.
 * - **One probe in flight per source**; a fresh ask (`refresh(_, maxAgeMs)`)
 *   answers from the kept reading while it is younger than the claude TTL, and
 *   a failure is not retried on every navigation (`failTtlMs`).
 * - **Polling is off by default** and on only while something gates on usage —
 *   `main.ts`'s `syncUsagePolling` predicate, the same one claude polls by.
 * - **Boot re-offers** each source's last kept row as `remembered` while a
 *   window's reset is still ahead (`seed`), so a restart does not blank a
 *   segment nothing about the account has changed.
 */
import {
  claudeReading, isUsageSourceId, readingAfterResets, usageWindowPct, PLUGIN_USAGE_PROBE_TIMEOUT_MS,
  logTag, type HostMessage, type PluginUsageProbe, type UsageInfo, type UsageReading, type UsageSourceHistoryDoc, type UsageSourceId, type UsageWindow,
} from "@waterplane/shared";
import { sourceLogOpener, type SourceUsageRow } from "./usagesourcelog.js";
import { USAGE_POLL_MS } from "./usage.js";
import { derive } from "./backends/derive.js";
import { BACKENDS, onBackendsChanged } from "./backends/registry.js";
import type { BackendDescriptor } from "./backends/types.js";

type DescriptorFacts = Pick<BackendDescriptor, "caps" | "facts" | "sources" | "forkVia">;

/**
 * Does this backend have an ACCOUNT limit at all — some `limits` provider that can answer
 * (claude's `{screen:"limit-ts"}`, or a `{source:true}` whose `sources.usage.wall` exists)?
 * The one gate for whether a session carries a `SessionLimit` (`sessions.ts` create,
 * `tmux.ts` re-attach): none ⇒ the field is ABSENT, never an unblocked one.
 */
export function hasAccountLimit(b: DescriptorFacts): boolean {
  try { return derive(b).has("limits"); } catch { return false; }
}

/**
 * A backend's `sources.usage` (contract 2.0) as the registry's probe, or null when the backend
 * lists no `{source:true}` usage provider or has no such slot. claude is not asked here — its
 * `{screen:"usage-probe"}` is `UsageChecker`, adapted by `claudeReading()` in `readings()`.
 * `windows()` answering null ⇒ absent; an empty list ⇒ no reading sent (`vetReading` drops a
 * reading with nothing in it). Identity stays the source's: the registry refuses `"claude"`.
 */
export function backendUsageProbe(b: BackendDescriptor): UsageProbeDef | null {
  let usage;
  try {
    if (!derive(b).askSource("usage")) return null;
    usage = b.sources?.usage;
  } catch { return null; }
  if (!usage || typeof usage.windows !== "function") return null;
  const src = usage;
  return {
    source: src.source, label: src.label, backend: b.id,
    ...(src.everyMs != null ? { everyMs: src.everyMs } : {}),
    probe: async () => {
      const windows = await src.windows();
      return windows == null ? null : { source: src.source, label: src.label, checkedAt: Date.now(), windows };
    },
  };
}

/**
 * Keep one registered probe per backend whose `sources.usage` answers — registered when the
 * backend appears (its plugin switched on), unregistered when it leaves (switched off, the
 * channel's owner gone). Idempotent: call it on every `onBackendsChanged`. Registered as
 * `yields`: a probe already holding the same source id for the same backend is that backend's
 * reading, never doubled (and one registered later takes over). A registration the
 * registry refuses (a taken or malformed id, `"claude"`) is logged once and skipped, never fatal.
 */
export function syncBackendUsage(reg: Pick<UsageSourceRegistry, "register">, backends: readonly BackendDescriptor[], held: Map<string, { usage: unknown; off: () => void }>, log?: (m: string) => void): void {
  const want = new Map<string, BackendDescriptor>();
  for (const b of backends) {
    let usage: unknown;
    try { usage = backendUsageProbe(b) ? b.sources?.usage : null; } catch { usage = null; }
    if (usage) want.set(b.id, b);
  }
  for (const [id, h] of [...held]) {
    const b = want.get(id);
    let same = false;
    try { same = !!b && b.sources?.usage === h.usage; } catch { same = false; }
    if (!same) { try { h.off(); } catch { /* already gone */ } held.delete(id); }
  }
  for (const [id, b] of want) {
    if (held.has(id)) continue;
    const def = backendUsageProbe(b);
    if (!def) continue;
    try {
      const off = reg.register(def, { yields: true });
      held.set(id, { usage: b.sources?.usage, off });
    } catch (e) {
      log?.(`backend ${id}: its usage source was not registered — ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
}

/** The probe seam — `PluginUsageProbe`, the shape `api.usageProbe` takes. */
export type UsageProbeDef = PluginUsageProbe;

/** What the registry needs of a source's history (`SourceUsageLog`). */
export interface UsageSourceLogLike {
  note(r: UsageReading): void;
  last(): SourceUsageRow | null;
  read(sinceMs?: number): UsageSourceHistoryDoc;
  flush(): void;
}

export interface UsageSourceRegistryOpts {
  /** claude's reading, as `UsageChecker.get()` answers it. */
  claude: () => UsageInfo | null;
  /** A source's reading changed (null = it is gone). `main.ts` broadcasts `usage.status`. */
  onUpdate?: (source: UsageSourceId, reading: UsageReading | null) => void;
  /** A source's log; `mustExist` ⇒ null unless one was ever written. Absent ⇒ no history. */
  openLog?: (source: UsageSourceId, mustExist: boolean) => UsageSourceLogLike | null;
  now?: () => number;
  /** A fresh ask is answered from a kept reading younger than this (claude's TTL). */
  ttlMs?: number;
  /** A failed probe is not retried by a fresh ask within this. */
  failTtlMs?: number;
  /** A probe slower than this counts as a throw. */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Test seam over the poll timers. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

export const DEFAULT_PROBE_EVERY_MS = 15 * 60_000;
export const MIN_PROBE_EVERY_MS = 60_000;

interface SourceState {
  def: UsageProbeDef;
  everyMs: number;
  reading: UsageReading | null;
  inflight: Promise<void> | null;
  failedAt: number;
  /** When the last probe answered null — a fresh ask waits `failTtlMs` before asking again. */
  emptyAt: number;
  warned: boolean;
  timer: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const shortStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** One window the core can vouch for, or null. */
function vetWindow(o: unknown): UsageWindow | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (!shortStr(r.id, 32) || !shortStr(r.unit, 3)) return null;
  const w: UsageWindow = {
    id: r.id, unit: r.unit,
    pct: finite(r.pct) && r.pct >= 0 && r.pct <= 100 ? r.pct : null,
    resetAt: finite(r.resetAt) && r.resetAt > 0 ? r.resetAt : null,
  };
  if (finite(r.used) && finite(r.limit) && r.used >= 0 && r.limit > 0) { w.used = r.used; w.limit = r.limit; }
  if (shortStr(r.unitName, 24)) w.unitName = r.unitName;
  return usageWindowPct(w) != null ? w : null;
}

/**
 * A probe's answer as a reading the core will send, or null (ABSENT). The
 * identity (`source`, `label`, `backend`) is the DEFINITION's, never the
 * answer's — a probe cannot speak for another source.
 */
export function vetReading(def: UsageProbeDef, raw: unknown, now: number): UsageReading | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const windows = Array.isArray(o.windows) ? o.windows.map(vetWindow).filter((w): w is UsageWindow => !!w) : [];
  const r: UsageReading = {
    source: def.source, label: def.label,
    checkedAt: finite(o.checkedAt) && o.checkedAt > 0 && o.checkedAt <= now + 60_000 ? o.checkedAt : now,
    windows,
  };
  if (def.backend) r.backend = def.backend;
  if (o.remembered === true) r.remembered = true;
  const u = o.usd as Record<string, unknown> | undefined;
  if (u && typeof u === "object" && shortStr(u.periodId, 32) && shortStr(u.label, 40) && finite(u.spentUsd) && u.spentUsd >= 0) {
    r.usd = {
      periodId: u.periodId, label: u.label, spentUsd: u.spentUsd,
      capUsd: finite(u.capUsd) && u.capUsd > 0 ? u.capUsd : null,
      resetAt: finite(u.resetAt) && u.resetAt > 0 ? u.resetAt : null,
    };
  }
  return readingAfterResets(r, now);
}

/**
 * How long a kept window that names NO reset may outlive its last successful
 * probe. A window with a named reset ends at that reset (`readingAfterResets`);
 * one without could have rolled over unseen, and a probe failing for days (gh
 * signed out, a token revoked) would otherwise draw a three-day-old percentage
 * as if it were today's. Absent beats that. Claude's reading is not asked —
 * `UsageChecker` keeps its own posture and its readers have `BUDGET_STALE_MS`.
 */
export const KEPT_UNNAMED_MAX_MS = 24 * 3_600_000;

/**
 * A contributed source's reading with every window (and dollar period) that
 * names no reset dropped once `now − checkedAt` reaches `maxAgeMs`; the SAME
 * object when nothing goes, null when nothing is left.
 */
export function readingAfterAge(r: UsageReading | null, now: number, maxAgeMs = KEPT_UNNAMED_MAX_MS): UsageReading | null {
  if (!r || now - r.checkedAt < maxAgeMs) return r;
  const unnamed = (at: number | null | undefined) => at == null;
  const usdGone = !!r.usd && unnamed(r.usd.resetAt);
  if (!r.windows.some((w) => unnamed(w.resetAt)) && !usdGone) return r;
  const next: UsageReading = { ...r, windows: r.windows.filter((w) => !unnamed(w.resetAt)) };
  if (usdGone) delete next.usd;
  return readingAfterResets(next, now);
}

const sameReading = (a: UsageReading | null, b: UsageReading | null): boolean =>
  a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

export class UsageSourceRegistry {
  private readonly states = new Map<UsageSourceId, SourceState>();
  private readonly logs = new Map<UsageSourceId, UsageSourceLogLike>();
  /** Sources held by a backend's own `sources.usage` — they give way to a probe for the same backend. */
  private readonly yielding = new Set<UsageSourceId>();
  private polling = false;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failTtlMs: number;
  private readonly timeoutMs: number;
  private readonly timers: NonNullable<UsageSourceRegistryOpts["timers"]>;

  constructor(private readonly opts: UsageSourceRegistryOpts) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 8 * 60_000;
    this.failTtlMs = opts.failTtlMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? PLUGIN_USAGE_PROBE_TIMEOUT_MS;
    this.timers = opts.timers ?? {
      set: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
      clear: (h) => clearInterval(h as NodeJS.Timeout),
    };
  }

  /** The probes registered, by source id, in registration order. */
  sources(): UsageSourceId[] { return [...this.states.keys()]; }

  /**
   * Add a probe. Throws naming the problem: a malformed or taken id (`claude`
   * is core's), no label, no probe function. Re-offers the source's last kept
   * row (`seed`) and arms its poll when polling is on. Returns an unregister.
   */
  register(def: UsageProbeDef, opts?: { yields?: boolean }): () => void {
    if (!def || typeof def !== "object") throw new Error("usageProbe needs a definition");
    if (!isUsageSourceId(def.source)) throw new Error(`usage source id ${JSON.stringify(def.source)} is not short lowercase [a-z0-9:_-]`);
    if (def.source === "claude") throw new Error("usage source \"claude\" is core's own reading");
    // One account, one reading: a backend's own `sources.usage` (`yields`) naming a source another
    // probe already registered FOR THAT BACKEND is that reading — not a second one; and such a probe
    // registered later replaces the backend's (Copilot: the copilot-usage extension's "copilot").
    const held = this.states.get(def.source);
    if (held) {
      const sameBackend = !!def.backend && held.def.backend === def.backend;
      if (sameBackend && opts?.yields) return () => {};
      if (sameBackend && this.yielding.has(def.source)) this.unregister(def.source, held);
      else throw new Error(`usage source "${def.source}" is already registered`);
    }
    if (!shortStr(def.label, 24)) throw new Error(`usage source "${def.source}" needs a label of 1-24 characters`);
    if (typeof def.probe !== "function") throw new Error(`usage source "${def.source}" needs a probe() function`);
    const asked = Number(def.everyMs);
    const st: SourceState = {
      def: { ...def }, everyMs: Number.isFinite(asked) && asked > 0 ? Math.max(MIN_PROBE_EVERY_MS, asked) : DEFAULT_PROBE_EVERY_MS,
      reading: null, inflight: null, failedAt: 0, emptyAt: 0, warned: false, timer: null,
    };
    this.states.set(def.source, st);
    if (opts?.yields) this.yielding.add(def.source); else this.yielding.delete(def.source);
    const row = this.logFor(def.source, false)?.last();
    if (row) this.seed(def.source, row);
    if (this.polling) this.arm(st);
    return () => this.unregister(def.source, st);
  }

  private unregister(source: UsageSourceId, st: SourceState): void {
    if (this.states.get(source) !== st) return;
    this.disarm(st);
    this.states.delete(source);
    this.yielding.delete(source);
    if (st.reading) this.opts.onUpdate?.(source, null);
  }

  /**
   * Re-offer a kept row as a `remembered` reading — boot only, never over a
   * reading this process took. Only windows whose NAMED reset is still ahead
   * are claimed (a window that named none could have rolled over unseen), and
   * the row's own instant stays its `checkedAt`.
   */
  seed(source: UsageSourceId, row: SourceUsageRow | null | undefined): void {
    const st = this.states.get(source);
    if (!st || st.reading || !row) return;
    const now = this.now();
    const windows = row.w.filter((w) => w.resetAt != null && w.resetAt > now && w.unit);
    const r = vetReading(st.def, { checkedAt: row.t, remembered: true, windows }, now);
    if (!r) return;
    st.reading = r;
    this.opts.onUpdate?.(source, r);
  }

  /** claude's reading FIRST (when it has one), then each probe's kept reading after resets. */
  readings(now = this.now()): UsageReading[] {
    const out: UsageReading[] = [];
    const cr = claudeReading(this.opts.claude());
    const c = cr && readingAfterResets(cr, now);
    if (c) out.push(c);
    for (const st of this.states.values()) {
      const kept = readingAfterAge(st.reading, now);
      const r = kept && readingAfterResets(kept, now);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Probe `source` (or every source). With `maxAgeMs`, a kept reading younger
   * than that — or a failure younger than `failTtlMs` — is answer enough and
   * nothing runs: what a phone's "tell me the figure" asks. One probe in flight
   * per source; a second ask joins it.
   */
  async refresh(source?: UsageSourceId, maxAgeMs?: number): Promise<void> {
    const targets = source ? [this.states.get(source)].filter((s): s is SourceState => !!s) : [...this.states.values()];
    await Promise.all(targets.map((st) => this.refreshOne(st, maxAgeMs)));
  }

  /** `refresh()` behind claude's TTL — the `usage.refresh` route's ask. */
  refreshFresh(): Promise<void> { return this.refresh(undefined, this.ttlMs); }

  private refreshOne(st: SourceState, maxAgeMs?: number): Promise<void> {
    if (st.inflight) return st.inflight;
    const now = this.now();
    if (maxAgeMs != null) {
      if (st.reading && !st.reading.remembered && now - st.reading.checkedAt < maxAgeMs) return Promise.resolve();
      if (st.failedAt && now - st.failedAt < this.failTtlMs) return Promise.resolve();
      if (st.emptyAt && now - st.emptyAt < this.failTtlMs) return Promise.resolve();
    }
    const run = (async () => {
      let raw: UsageReading | null;
      try {
        raw = await this.within(st.def.probe());
      } catch (e) {
        if (this.states.get(st.def.source) !== st) return;
        st.failedAt = this.now();
        if (!st.warned) {
          st.warned = true;
          this.opts.log?.(`usage source ${st.def.source}: probe failed (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}) — keeping the last reading until its reset`);
        }
        // Past the age a window with no named reset may be kept: drop it now and SAY so (the phone
        // holds what it was last sent, so a silent prune would leave the stale figure drawn).
        const aged = readingAfterAge(st.reading, st.failedAt);
        if (aged !== st.reading) { st.reading = aged; this.opts.onUpdate?.(st.def.source, aged); }
        return;
      }
      if (this.states.get(st.def.source) !== st) return; // unregistered while asking
      st.failedAt = 0; st.warned = false;
      const at = this.now();
      const next = raw == null ? null : vetReading(st.def, { ...raw, remembered: false }, at);
      st.emptyAt = next ? 0 : at;
      const prev = st.reading;
      st.reading = next;
      if (next) this.logFor(st.def.source, false)?.note(next);
      if (!sameReading(prev, next)) this.opts.onUpdate?.(st.def.source, next);
    })().finally(() => { st.inflight = null; });
    st.inflight = run;
    return run;
  }

  private within<T>(p: Promise<T>): Promise<T> {
    let t: NodeJS.Timeout | undefined;
    const clock = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer within ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs); });
    return Promise.race([Promise.resolve(p), clock]).finally(() => clearTimeout(t));
  }

  /** Per-probe poll timers; off by default. Turning on asks each source once (behind its period). */
  setPolling(on: boolean): void {
    if (on === this.polling) return;
    this.polling = on;
    for (const st of this.states.values()) {
      if (on) this.arm(st); else this.disarm(st);
    }
  }

  isPolling(): boolean { return this.polling; }

  private arm(st: SourceState): void {
    if (st.timer != null) return;
    void this.refreshOne(st, st.everyMs);
    st.timer = this.timers.set(() => void this.refreshOne(st), st.everyMs);
  }

  private disarm(st: SourceState): void {
    if (st.timer != null) this.timers.clear(st.timer);
    st.timer = null;
  }

  private logFor(source: UsageSourceId, mustExist: boolean): UsageSourceLogLike | null {
    const have = this.logs.get(source);
    if (have) return have;
    let log: UsageSourceLogLike | null = null;
    try { log = this.opts.openLog?.(source, mustExist) ?? null; } catch { log = null; }
    if (log) this.logs.set(source, log);
    return log;
  }

  /** A source's kept history (`GET /api/usagelog/:source`), or null when it has none. */
  history(source: UsageSourceId, sinceMs?: number): UsageSourceHistoryDoc | null {
    if (!isUsageSourceId(source) || source === "claude") return null;
    return this.logFor(source, !this.states.has(source))?.read(sinceMs) ?? null;
  }

  /** Write every log's retention rewrite — SIGTERM. */
  flush(): void {
    for (const l of this.logs.values()) { try { l.flush(); } catch { /* shutdown must never throw */ } }
  }
}

/** The daemon's registry, as `main.ts` builds it, with ONE `usage.status` publisher (`publish`)
 *  that claude's checker callback and every source's change both call — so two publishes in one
 *  tick both carry the whole list, and the phone's last write wins. */
export function createUsageSources(root: string, claude: () => UsageInfo, broadcast: (msg: HostMessage) => void, onReading?: (r: UsageReading) => void): UsageSourceRegistry & { publish(): void } {
  const publish = () => broadcast({ t: "usage.status", usage: claude(), readings: reg.readings() });
  const log = (m: string) => console.log(`${logTag} ${m}`);
  const reg = new UsageSourceRegistry({ claude, onUpdate: (_s, r) => { publish(); if (r) { try { onReading?.(r); } catch { /* a watcher never breaks the publisher */ } } }, openLog: sourceLogOpener(root), ttlMs: USAGE_POLL_MS, log });
  // Every backend's own `sources.usage` (contract 2.0) beside `api.usageProbe`'s: the same
  // registry, one probe per backend, following the backend list.
  const held = new Map<string, { usage: unknown; off: () => void }>();
  const sync = () => syncBackendUsage(reg, BACKENDS, held, log);
  sync();
  onBackendsChanged(sync);
  return Object.assign(reg, { publish });
}
