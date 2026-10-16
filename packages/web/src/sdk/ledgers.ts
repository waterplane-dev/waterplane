/**
 * The token ledgers, read-only, for the extension that draws them (token statistics).
 *
 * Module-level and NOT on `CoreApi`: nothing here is core state, it is the host reads, the phone's own
 * IndexedDB copy of claude's and of each contributed view's document, and the one write the screen
 * makes — asking the desktop to re-scrape `/usage`. `toCache` writes the PHONE's copy, never the
 * ledger. The live `/usage` reading itself is `useCore().world.usage`.
 *
 * `views()` is the ledger views other extensions contribute (`FeatureManifest.ledgerViews`). Bound by
 * `core/extensionPoints.ts` — the one registry reader — rather than imported here, because the
 * registry imports every extension and every extension imports this SDK: built at module load that
 * is a cycle reading an undefined list.
 */
import type { BackendTokensDoc, CostWindowDoc, LocalUsageDoc, PeerJobLedgerRow, TokenStatsDoc, TokenWindowsDoc, UsageHistoryDoc, UsageSourceHistoryDoc } from "@waterplane/shared";
import { api } from "../api";
import { core } from "../core/api";
import { getLedgerDocAt, getTokenStatsAt, putLedgerDoc, putTokenStats } from "../offlineCache";
import type { LedgerViewDef } from "./types.ts";

let viewSource: () => readonly LedgerViewDef<any>[] = () => [];

/** `core/extensionPoints.ts`'s, once: where `ledgers.views()` reads the contributed views from. */
export function bindLedgerViews(source: () => readonly LedgerViewDef<any>[]): void {
  viewSource = source;
}

export interface CachedRead<T> {
  read(fresh: boolean): Promise<T>;
  fromCache(): Promise<{ value: T; savedAt: number } | null>;
  toCache(v: T): Promise<void>;
}

export const ledgers: {
  tokenStats: CachedRead<TokenStatsDoc>;
  /** The ledger views extensions contribute, registry order — `[]` where none is installed. */
  views(): readonly LedgerViewDef<any>[];
  /** A contributed view's document: `GET /api/tokenstats/<def.id>`, cached under that id in the view's shape. */
  viewDoc<D>(def: LedgerViewDef<D>): CachedRead<D>;
  backendTokens(id: string, fresh?: boolean): Promise<BackendTokensDoc>;
  /** The local runner's own ledger — compute time, tokens, memory per model per day. */
  localUsage(): Promise<LocalUsageDoc>;
  usageLog(hours: number): Promise<UsageHistoryDoc>;
  /** A non-claude source's kept readings, or null on any failure (older host, no route, bad shape) — absent, never a guess. */
  sourceHistory(source: string): Promise<UsageSourceHistoryDoc | null>;
  tokenWindows(specs: { id: string; anchor: number; lenMs: number }[], fresh?: boolean): Promise<TokenWindowsDoc>;
  /** The cost window over `[from, to)`: conversations by hour, repo and launch (`GET /api/costwindow`). Uncached — an older host 404s. */
  costWindow(from: number, to: number, fresh?: boolean): Promise<CostWindowDoc>;
  /** What this desktop handed to peer desktops, with each job's cost there (`GET /api/peerjobs`). */
  peerJobs(): Promise<PeerJobLedgerRow[]>;
  refreshUsage(quiet?: boolean): void;
} = {
  peerJobs: () => api.peerJobs(),
  tokenStats: { read: (fresh) => api.tokenStats(fresh), fromCache: getTokenStatsAt, toCache: putTokenStats },
  views: () => viewSource(),
  viewDoc: <D>(def: LedgerViewDef<D>): CachedRead<D> => ({
    read: (fresh) => api.backendTokens<D>(def.id, fresh),
    fromCache: () => getLedgerDocAt<D>(def.id, def.cache.shape, def.cache.usable),
    toCache: (v) => putLedgerDoc(def.id, def.cache.shape, v),
  }),
  backendTokens: (id, fresh) => api.backendTokens(id, fresh),
  localUsage: () => api.localUsage(),
  usageLog: (hours) => api.usageLog(hours),
  sourceHistory: async (source) => {
    try {
      const d = await api.usageLogSource(source);
      return d && Array.isArray(d.samples) ? d : null;
    } catch { return null; }
  },
  tokenWindows: (specs, fresh) => api.tokenWindows(specs, fresh),
  costWindow: (from, to, fresh) => api.costWindow(from, to, fresh),
  /**
   * Re-scrape `/usage` on the desktop.
   *
   * `quiet` is for the automatic refresh `TokenStatsSheet` does when it opens
   * on a stale reading: nobody tapped anything, so nobody is owed a receipt.
   * A hand-tapped one goes through `liveAsk`, which is what says the question
   * could not be asked at all — the case that otherwise looks exactly like a
   * scrape that returned the same numbers.
   */
  refreshUsage(quiet?: boolean): void {
    const c = core();
    if (quiet) { if (c.conn.status === "open") c.conn.send({ t: "usage.refresh" }); return; }
    c.conn.liveAsk({ t: "usage.refresh" }, "no connection — usage is scraped on the desktop");
  },
};
