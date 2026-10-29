import { SLOW_OP_TIMEOUT_MS } from "@waterplane/shared";
import type { BackendTokensDoc, CostWindowDoc, LocalUsageDoc, TokenStatsDoc, TokenWindowsDoc, UsageHistoryDoc, UsageSourceHistoryDoc, PeerJobLedgerRow, WeekBurnStatus } from "@waterplane/shared";
import { jget, jpostOk } from "./webapiFetch";

/** Token, usage and cost readings. One slice of `api` (see api.ts). */
export const statsApi = {
  /**
   * Token usage across every conversation log on this desktop.
   *
   * `fresh` forces the host past its own "scanned recently enough" shortcut —
   * the sheet's re-read button. A cold scan is seconds (the host walks ~10k
   * logs), so this takes the slow-op fuse rather than the default one, and it
   * IS counted in the activity bar: it runs on a tap and a silent ten-second
   * wait is indistinguishable from a dead button.
   */
  tokenStats: (fresh = false) =>
    jget<TokenStatsDoc>(`/api/tokenstats${fresh ? "?fresh=1" : ""}`, SLOW_OP_TIMEOUT_MS),


  /** The local runner's own ledger (`LocalUsageDoc`): compute, tokens, memory per model. An
   *  older host answers 404, which the view treats as "no such ledger here". */
  /** The week-end burn (`weekburn.ts`): this week's pick and plan; the POST answers the new status. */
  getWeekBurn: () => jget<WeekBurnStatus>("/api/weekburn"),
  postWeekBurn: (b: { repos?: string[]; recurring?: boolean; stopPct?: number; sameAsLast?: true; task?: string; notes?: Record<string, string> }) => jpostOk<WeekBurnStatus>("/api/weekburn", b),
  localUsage: () => jget<LocalUsageDoc>("/api/localusage"),
  /** What THIS desktop has handed to peer desktops (`host/peers/routes.ts`, trusted path, read-only). */
  peerJobs: () => jget<{ ok: boolean; jobs: PeerJobLedgerRow[] }>("/api/peerjobs").then((d) => (Array.isArray(d?.jobs) ? d.jobs : [])),

  /** Any backend's own ledger (`BackendTokensDoc`, or the document type `D` of the extension view that
   *  draws it — `LedgerViewDef`) — `available:false` with a sentence at 200 when it keeps none; an older
   *  host 404s, which `useRemoteResource` reports as `error`. The slow-op fuse: `fresh=1` re-reads the store. */
  backendTokens: <D = BackendTokensDoc>(id: string, fresh = false) =>
    jget<D>(`/api/tokenstats/${encodeURIComponent(id)}${fresh ? "?fresh=1" : ""}`, SLOW_OP_TIMEOUT_MS),

  /**
   * The `/usage` readings the host has kept — the history behind the two live
   * limit windows.
   *
   * A separate read from `tokenStats` on purpose, and not because of size: that
   * document is derived from the CLI's conversation logs and says the same
   * thing on every device, while this is a log of what one daemon happened to
   * observe. Folding them into one document would put two very different
   * provenances behind one "last updated".
   */
  usageLog: (hours = 0) =>
    jget<UsageHistoryDoc>(`/api/usagelog${hours > 0 ? `?hours=${hours}` : ""}`),

  /** One non-claude source's kept readings (`GET /api/usagelog/<source>`); an older host 404s. */
  usageLogSource: (source: string) =>
    jget<UsageSourceHistoryDoc>(`/api/usagelog/${encodeURIComponent(source)}`),

  /**
   * The same ledger folded into PAST rate-limit windows — one grid per spec.
   *
   * A separate read from `tokenStats` because that document cannot answer it:
   * it carries a bounded fortnight of hour buckets, so the window running now
   * can be cut on this side and nothing older can. The host keeps every hour it
   * ever saw and sends one small row per window that had something in it.
   *
   * The GRID goes UP rather than coming down — the reset instants are the
   * phone's (off `UsageInfo`) and the lengths are `LIVE_WINDOWS`', so the two
   * windows' semantics stay in one place here and the host asserts nothing
   * about what it is folding.
   *
   * Takes the slow-op fuse for the same reason as its twin: a cold host walks
   * every log before it can fold anything.
   */
  tokenWindows: (specs: { id: string; anchor: number; lenMs: number }[], fresh = false) =>
    jget<TokenWindowsDoc>(
      `/api/tokenwindows?${specs.map((s) => `w=${encodeURIComponent(`${s.id}:${Math.round(s.anchor)}:${Math.round(s.lenMs)}`)}`).join("&")}${fresh ? "&fresh=1" : ""}`,
      SLOW_OP_TIMEOUT_MS,
    ),

  /**
   * Every conversation with a turn inside `[from, to)`, by hour, repo and launch — the cost
   * window (`CostWindowDoc`). The host folds it out of the same ledger `tokenStats` reads, joined
   * with the titles and launches it holds; an hour is the finest bucket, so the answer starts at
   * the top of the hour `from` falls in and says so (`fromHour`).
   *
   * No offline cache on purpose: an older host has no route and answers 404, which the caller
   * says in words rather than showing a stale window. Slow-op fuse: a cold host walks every log.
   */
  costWindow: (from: number, to: number, fresh = false) =>
    jget<CostWindowDoc>(`/api/costwindow?from=${Math.round(from)}&to=${Math.round(to)}${fresh ? "&fresh=1" : ""}`, SLOW_OP_TIMEOUT_MS),
};
