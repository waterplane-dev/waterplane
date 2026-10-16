/**
 * The one contract between the extension's data layer, its host side and its webview.
 * Data layer produces the docs; extension.ts posts them as ToWebview; the webview answers with
 * ToExtension. Every reading degrades to absent: a doc is null with a `why` sentence, a cost is
 * null (never $0) when nothing could be priced.
 */
import type {
  ColdStarts, CompactionLedger, ContextEvent, ContextSample, ContextWindowSource, CostBreakdown,
  CostConvo, CostWindowDoc, SkillWeight, ContextWeightReading, TokenStatsDoc, TokenTotals,
} from "@waterplane/shared";
import type { AgentRun, HealthIndexResponse, RepoHealthMeasure, RepoHealthOutcome, RepoHealthPlot, RepoHealthSeries } from "@waterplane/shared";

export type TabId = "session" | "all" | "always-on" | "health" | "prompts";

export interface SessionRow { id: string; path: string; mtime: number; size: number }

export interface TurnCost {
  /** 1-based prompt index in the log; 0 = records before the first prompt. */
  n: number;
  /** The user record's timestamp (ms). */
  at: number;
  /** First 120 chars of the prompt, one line. */
  prompt: string;
  /** Assistant records attributed (deduped, non-synthetic). */
  requests: number;
  /** This turn's split (turns = requests). */
  kinds: TokenTotals;
  /** Null when ANY request of the turn was unpriced. */
  costUsd: number | null;
  unpricedTok: number;
  /** Context the LAST request carried (input + cacheRead + cacheWrite). */
  ctxTok: number | null;
  /** Running total through this turn; null once an unpriced record was seen. */
  cumCostUsd: number | null;
  /**
   * Set on the LAST turn only, when the log ends mid-turn (an unanswered prompt, or a reply that is
   * not a final stop). Log shape alone: whether it is still RUNNING also needs the log to be fresh
   * (`data/running.ts`), which changes without the log changing.
   */
  open?: boolean;
}

/** What the sessions list left out of the folder's logs. */
export interface SessionCut { older: number; capped: number; automated: number }

/** One listed conversation, slim: what a row of the sessions list prints, none of the chart data. */
export interface SessionSummary {
  id: string; path: string;
  /** The log's last write (ms): its age, and the clock the LIVE / running rules read. */
  mtime: number;
  /** `sessionTotal`'s dollars; null = no figure, and `costNote` says which kind of nothing. */
  costUsd: number | null;
  costNote: "withheld" | "no price" | null;
  /** The latest context reading and its window, for `contextPct`; either may be null. */
  lastTok: number | null; windowTok: number | null;
  /** Typed prompts (turn 0 excluded) and the last one's text, one line; "" = none yet. */
  prompts: number; lastPrompt: string;
  /** The last turn is open (`TurnCost.open`). */
  open: boolean;
  /** The last turn's `at`, for the running clock; 0 when undated. */
  openAt: number;
}

export interface SessionDoc {
  folder: string; id: string; path: string; updatedAt: number;
  /** For the chart only: DOWNSAMPLED (min/max per bucket), so its last point is not the latest reading. */
  samples: ContextSample[]; events: ContextEvent[]; models: string[];
  /** The latest context reading off the RAW series, and when; null before the first request. */
  lastTok: number | null; lastAt: number | null;
  windowTok: number | null; windowFrom: ContextWindowSource; model: string | null;
  autoCompactTok: number | null; truncated: boolean;
  turns: number; usageTok: number; split: TokenTotals; cost: CostBreakdown | null; unpricedTok: number;
  compaction: CompactionLedger; coldStarts: ColdStarts;
  /**
   * Null = the session has no subagents dir, or it holds no logs — or the dir could not be read
   * (then `agentsUnread` says so). Read by the host's own
   * `ctxagents.ts` (bundled): `runs[i].model` is an INDEX into this doc's `models`; `cum` is the
   * agents' cumulative tokens over time, for the spend chart.
   */
  agents: {
    logs: number; tok: number; split: TokenTotals; cost: CostBreakdown | null; unpricedTok: number;
    runs: AgentRun[]; cum: [number, number][] | null;
  } | null;
  /**
   * The sentence when the subagents dir exists but could not be read (anything but ENOENT): the
   * host's rule is NO total rather than one the agents are missing from, so `sessionTotal`
   * withholds the dollar figure and every screen says this instead. Null when they were read.
   */
  agentsUnread: string | null;
  turnCosts: TurnCost[];
  pricesAsOf: string;
}

/**
 * The phone's `TokenStatsDoc`, folded here off the same per-file summaries (`data/corpus.ts`), so
 * the token-stats web cards read it unchanged. `top` is the host's `foldCostWindow` rows (a
 * superset of `TokenConvo`). `week` is that fold again over the last seven CALENDAR days (today
 * included, the headline's span) to the scan — never the account's weekly-limit window: no reset
 * instant is read on this side. `spans` is the fold again per calendar span of the span filter
 * (keyed by day count, from local midnight n-1 days back), so the repo bars and costliest list
 * under 30 or 90 days are cost inside the span.
 */
export interface CorpusDoc extends TokenStatsDoc {
  top: CostConvo[];
  coldStarts?: ColdStarts;
  week: CostWindowDoc;
  spans: Partial<Record<number, CostWindowDoc>>;
}

export interface WeightDoc { folder: string; claudeMdChars: number; skills: SkillWeight[]; reading: ContextWeightReading }

export type PromptId =
  | "groom-claudemd" | "shrink-skill-descs" | "handoff-fresh-session" | "explain-turn"
  | "split-longest-file" | "explain-rising-metric";

export interface PromptDef { id: PromptId; title: string; needs: ("session" | "weight" | "turn" | "health")[] }

export interface HealthDoc {
  folder: string;
  /** What the series file holds; null when the engine read none (readError says why, or nothing has been measured yet). */
  series: RepoHealthSeries | null;
  measure: RepoHealthMeasure | null;
  head: { sha: string; ts: number } | null;
  /** First-parent commits after the last measured one; null = could not tell, never 0. */
  behind: number | null;
  plot: RepoHealthPlot | null;
  /** Why `plot` is null when the ENGINE is the reason; null otherwise. */
  plotError: string | null;
  /**
   * The chained weekly index over the whole-repo series that was read (`healthindexdoc.ts`), as the
   * phone draws it above the readings; null for a scope (the index is the repo's) or before a read.
   */
  index: HealthIndexResponse | null;
  /** The engine's own sentence when `status` could not be read; null when it could. */
  readError: string | null;
  /** How the last refresh ended; null when none ran this window. */
  last: RepoHealthOutcome | null;
  /** `.git/shallow` exists; null when it could not be told (a linked worktree). */
  shallow: boolean | null;
  /** The series file that was read: the extension's own (global storage) or, for `source: "repo"`, the folder's `.waterplane` one. */
  seriesFile: string;
  /** Whose series this is: "own" = measured by this extension, "repo" = by the waterplane desktop app, read-only here. */
  source: "own" | "repo";
  /** The scope read (repo source only); null = the whole repo. */
  scope: string | null;
  /** Scopes the folder lists that have a series to read; [] = none, no switcher. */
  scopes: string[];
  /** The folder's whole-repo series file when it has one, whichever source is shown; null otherwise. */
  repoFile: string | null;
  /** Set when the series' last row was cut off by a stopped run and dropped before reading; null otherwise. */
  tailNote: string | null;
  stepMs: number;
  readAt: number;
}

export interface HealthRunState { step: "update" | "status" | "plot"; startedAt: number; note: string | null }

export type ToWebview =
  /** `following` = no session is pinned for this folder; the newest one is shown and followed. */
  | { t: "session"; folder: string; doc: SessionDoc | null; why?: string; following: boolean }
  /** The folder's recently active sessions, newest write first; `older` = logs outside the recent window, `capped` = recent ones cut by the row cap, `automated` = unattended `claude -p` runs left out. `selected` = the drilled-in one. */
  | { t: "sessions"; folder: string; rows: SessionSummary[]; selected: string | null; older: number; capped: number; automated: number; following: boolean }
  | { t: "corpus"; doc: CorpusDoc | null; why?: string; scanning?: { done: number; total: number } }
  | { t: "weight"; doc: WeightDoc | null; why?: string }
  /** `terminal` = the active terminal's name, or null when there is none. */
  | { t: "prompts"; list: PromptDef[]; terminal: string | null }
  | { t: "folders"; list: string[]; active: string }
  /** What actually happened to a [Copy] / [Type into terminal] tap, posted after acting. */
  | { t: "receipt"; text: string; tap?: number }
  | { t: "health"; folder: string; doc: HealthDoc | null; why?: string; run: HealthRunState | null }
  /** Which tab the panel should show (sent on `ready` after an openPanel request). */
  | { t: "tab"; id: TabId };

export type ToExtension =
  | { t: "ready" }
  | { t: "rescan" }
  | { t: "pickFolder"; folder: string }
  /** `id: null` = follow the newest session again (un-pin). */
  | { t: "pickSession"; folder: string; id: string | null }
  /** `tap` = the webview's id for this tap, echoed on the `receipt` so the right button shows it. */
  | { t: "prompt"; id: PromptId; how: "copy" | "terminal"; turn?: number; tap?: number }
  /** Only BRAND.domain / marketplace URLs; the extension validates. */
  | { t: "open"; url: string }
  /** The Health view came on screen: read status+plot (cached 60 s). Never runs `update`. */
  | { t: "healthRead"; folder: string }
  /** Show one of the folder's scopes (null = the whole repo). Read-only, like `healthRead`. */
  | { t: "healthScope"; folder: string; scope: string | null }
  | { t: "healthRefresh"; folder: string }
  | { t: "healthForget"; folder: string }
  | { t: "healthCancel"; folder: string }
  /** Open a file named by the plot (relative to the folder); the extension contains it to the folder. */
  | { t: "openFile"; folder: string; path: string }
  /** From a link inside the panel: switch it to another view. */
  | { t: "openPanel"; tab: TabId };
