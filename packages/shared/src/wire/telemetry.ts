/** Metering, feature usage, scraped Claude Code usage, and the desktop's own load. */

import type { CostBreakdown } from "../pricing.js";
import type { ColdStarts } from "../sessioncost.js";

/**
 * One metered LLM call waterplane itself made (a plugin's model calls).
 * Token counts come from the provider response; cost from a per-model price table.
 */
export interface MeterEvent {
  /** Epoch ms. */
  ts: number;
  /** Provider, e.g. "gemini". */
  service: string;
  /** Full model id. */
  model: string;
  /** What the call was for, e.g. "plugin:<id>". */
  kind: string;
  /** Input (prompt) tokens. */
  inTok: number;
  /** Output (completion) tokens. */
  outTok: number;
  /** Estimated USD cost. */
  costUsd: number;
}

/** Per-model rollup of metered calls. */
export interface MeterModelStat {
  model: string;
  calls: number;
  inTok: number;
  outTok: number;
  costUsd: number;
}

/** Aggregated metering for display — all-time totals, today, and per-model. */
export interface MeterSummary {
  calls: number;
  inTok: number;
  outTok: number;
  costUsd: number;
  /** Same totals but only for the current local day. */
  today: { calls: number; inTok: number; outTok: number; costUsd: number };
  /** Per-model breakdown, highest cost first. */
  byModel: MeterModelStat[];
  /** When the meter last recorded a call (epoch ms), or 0 if none. */
  lastAt: number;
}

/** How often one UI feature was used (host-side, aggregated over all devices). */
export interface UiFeatureStat {
  count: number;
  /** First and last invocation, epoch ms. */
  first: number;
  last: number;
}

/** The whole feature-usage document (<STATE_DIR>/ui-usage.json). */
export interface UiUsageDoc {
  /** Last time any counter moved, epoch ms (0 = never). */
  updatedAt: number;
  /** When counting started (file creation / last reset), epoch ms. */
  since: number;
  /** Keyed by feature id — "toolbar:diff", "overlay:gallery", "action:send". */
  features: Record<string, UiFeatureStat>;
}

/** Claude Code usage snapshot (scraped from `/usage`; best-effort). */
export interface UsageInfo {
  /** True if at least one percentage parsed. */
  ok: boolean;
  /** Current 5-hour session usage, 0..100, or null if unknown. */
  sessionPct: number | null;
  /** Current week (all models) usage, 0..100, or null if unknown. */
  weeklyPct: number | null;
  /**
   * Epoch ms when the 5-hour session window resets, or null when the screen
   * didn't say. A percentage without this is only half the answer: 90% used is
   * a problem if it resets tomorrow and a non-event if it resets in ten minutes.
   */
  sessionResetAt: number | null;
  /**
   * Epoch ms when the weekly window resets, or null. Only accepted when the
   * screen names a DATE — the weekly window resets days out, so a bare
   * wall-clock time would land on the wrong day (same reason `limit.ts` flags a
   * weekly banner). Null is honest; a wrong day gets planned around.
   */
  weeklyResetAt: number | null;
  /** Epoch ms of the scrape. */
  checkedAt: number;
  /**
   * True when this reading was not probed by THIS process — it was re-offered
   * at boot out of `usagelog.ts`, because the daemon restarting is not a fact
   * about the account's limits and blanking the phone's gauge every time the
   * web bundle is rebuilt taught the reader to distrust it.
   *
   * It is only ever offered for a window whose reset instant is still in the
   * FUTURE: once the window it belongs to has rolled over, the percentage
   * describes a window that no longer exists, and that is the wrong-number
   * failure this whole file refuses. `checkedAt` stays the instant of the
   * original probe, so every reader that already asks how old a reading is —
   * `budget.ts`'s staleness gate, the phone's "checked 12m ago" — keeps
   * working with no second rule. Absent means probed.
   */
  remembered?: boolean;
}

/**
 * One kept `/usage` reading — the history behind the two live windows.
 *
 * `UsageInfo` is a point in time with no memory, which is enough to answer "can
 * I run something now" and cannot answer "how fast am I burning it". The host
 * keeps the readings it takes so the second question has a shape; nothing new
 * is scraped for it.
 *
 * Deliberately narrower than `UsageInfo`: only readings that PARSED are kept
 * (`ok`), so a null here means the screen genuinely did not print that window,
 * never that the probe failed.
 */
export interface UsageSample {
  /** Epoch ms of the reading (`UsageInfo.checkedAt`). */
  t: number;
  /** 0..100, or null when that window was not on the screen. */
  s: number | null;
  w: number | null;
  /**
   * The reset instants in force AT THE READING. These are what make the
   * history legible: the 5-hour figure sawtooths, and the only honest way to
   * know a drop is a window rolling over rather than usage being refunded is
   * that the reset instant the screen named CHANGED.
   */
  sr: number | null;
  wr: number | null;
}

/**
 * The kept readings, newest last.
 *
 * **A gap is a gap.** Readings are taken when something asks for one — the
 * auto-fire gate polls, a phone opening the sheet forces one — so the series is
 * irregular by construction and must never be resampled or interpolated into
 * looking like a feed. `everyMs` is the poll period when polling is on, carried
 * so a chart can say what "dense" would have looked like.
 */
export interface UsageHistoryDoc {
  samples: UsageSample[];
  /** Epoch ms of the oldest reading still kept, or null when there are none.
   *  Older ones were compacted away — stated, so an empty left edge reads as
   *  retention rather than as a quiet week. */
  keptFrom: number | null;
  /** How many readings are retained at most, and for how long. */
  cap: number;
  retainMs: number;
  /** The polling period, ms. Readings are NOT guaranteed at this rate — see
   *  the interface note. */
  everyMs: number;
}

/**
 * Which account a usage reading is about: `"claude"`, `"copilot"`,
 * `"<plugin>:<provider>"`, or a plugin's own id. Short, lowercase,
 * `[a-z0-9:_-]` (`isUsageSourceId` in `usagesources.ts`).
 */
export type UsageSourceId = string;

/**
 * One rate-limit window of one source. `pct` is USED (0..100), like
 * `UsageInfo`'s two percentages.
 */
export interface UsageWindow {
  /** Stable per source: claude `"session"` | `"week"`; copilot `"chat"` | `"premium"`. */
  id: string;
  /** At most 3 chars, TEXT for the chip: `"5h"`, `"wk"`, `"mo"`. */
  unit: string;
  /** 0..100 used, or null when the source did not print it — then `used`/`limit` must be present. */
  pct: number | null;
  /** The count form, when the source bills in units: 9 / 200 "credits". Absent = percent only. */
  used?: number;
  limit?: number;
  unitName?: string;
  /** Epoch ms, null = the source named none. `UsageInfo`'s rule: a wrong day is worse than null. */
  resetAt: number | null;
}

/**
 * One source's reading, as the meter draws it. Additive beside `UsageInfo`:
 * claude's reading is DERIVED from it (`claudeReading`), never a second scrape,
 * so every host consumer of `UsageInfo` keeps its object.
 *
 * A source with nothing to say is ABSENT from the list — never a reading of
 * empty windows, never a `pct: null` placeholder.
 */
export interface UsageReading {
  source: UsageSourceId;
  /** As drawn: `"Claude"`, `"Copilot"`. */
  label: string;
  /** Backend id this source is the account of (claude → `"claude"`). Absent = account-only. */
  backend?: string;
  /** Epoch ms of the probe. */
  checkedAt: number;
  /** `UsageInfo.remembered`'s rule, per source: re-offered from disk at boot, not probed. */
  remembered?: boolean;
  /** Natural order short → long. Empty and no `usd` ⇒ the host must not send the reading at all. */
  windows: UsageWindow[];
  /** A dollar period instead of / beside windows (a future api-billed provider). */
  usd?: { periodId: string; label: string; spentUsd: number; capUsd: number | null; resetAt: number | null };
}

/** One kept reading of a non-claude source (claude keeps `UsageSample` / usagelog.jsonl verbatim). */
export interface UsageSourceSample {
  t: number;
  w: { id: string; pct: number | null; resetAt: number | null }[];
}

/** `GET /api/usagelog/<source>` — `UsageHistoryDoc`'s posture for one non-claude source. */
export interface UsageSourceHistoryDoc {
  source: UsageSourceId;
  samples: UsageSourceSample[];
  keptFrom: number | null;
  cap: number;
  retainMs: number;
}

/** Resource snapshot of the desktop host running the daemon. */
export interface HostStat {
  platform: string;
  hostname: string;
  /** Logical CPU count. */
  cores: number;
  /** 1/5/15-minute load averages (all 0 where unsupported, e.g. Windows). */
  loadavg: [number, number, number];
  /** 1-min load as a percent of cores (loadavg[0] / cores * 100), rounded. */
  cpuPct: number;
  /** Total / free physical memory, bytes. */
  memTotal: number;
  memFree: number;
  /** System uptime, seconds. */
  uptime: number;
  /** Epoch ms of the sample. */
  checkedAt: number;
}

// ── Token usage across every conversation on disk ─────────────────────────

/**
 * The four numbers the API reports for a request, kept apart for the whole
 * length of this feature.
 *
 * They are NOT interchangeable and summing them without saying so is the one
 * way this readout can mislead: measured on a real machine, cache reads were
 * 96% of the total. A single "tokens used" figure is therefore mostly the
 * conversation being re-read from cache each turn, which is not what anyone
 * means by the phrase in a billing sense — so every surface shows the split.
 */
export interface TokenTotals {
  /** Fresh prompt tokens the request paid full price for. */
  input: number;
  /** Everything the model generated. */
  output: number;
  /** Context served out of the prompt cache. The big one. */
  cacheRead: number;
  /** Context written INTO the cache, BOTH tiers. */
  cacheWrite: number;
  /**
   * The portion of `cacheWrite` written at the 1-hour TTL rather than the
   * 5-minute one — a SUBSET of it, never additional to it.
   *
   * Carried only so the cost estimate can be right: a 1-hour write is 2× the
   * input rate against 1.25× for a 5-minute one, and measured here 84% of all
   * writes were 1-hour. Pricing them flat understates that line by ~60%. It is
   * deliberately not a fifth token KIND — `tokenTotal` must not add it, and the
   * composition strip stays four segments on a validated four-slot palette.
   */
  cacheWrite1h: number;
  /** Assistant turns counted — the denominator for every per-turn figure. */
  turns: number;
}

/** One day's usage. `day` is `YYYY-MM-DD` in the HOST's local zone, because
 *  that is the day the person was working, not the day UTC happened to be in. */
export interface TokenDay extends TokenTotals {
  day: string;
  /** List-price cost for the day, summed over the models that actually ran in
   *  it — which is why the host crosses day×model before pricing anything. */
  cost: CostBreakdown;
  /**
   * The day split by MODEL, descending by tokens.
   *
   * The host already crosses hour×model to price anything at all, so this costs
   * a projection and no rescan. It is what lets the per-day chart stack by
   * model as well as by kind: "which model am I actually spending on, and since
   * when" is a question the model BARS answer for all time and cannot answer
   * over time, and a migration between two models is invisible in a total.
   *
   * Absent on a host that has not rescanned since it existed, and then the
   * chart offers only its kinds.
   */
  byModel?: ModelSlice[];
  /**
   * Subagents LAUNCHED on this day, by the model that ran them.
   *
   * A count of events, not a slice of tokens — `subagents` already carries the
   * spend. A log's launch is the earliest hour bucket it has, and its model is
   * the one that ran in that bucket, so this needs nothing the store was not
   * already keeping.
   *
   * Absent means an older host; an EMPTY array means a day on which none ran,
   * which is a reading and is drawn as one.
   */
  agents?: TokenDayAgents[];
  /**
   * The day split by REPO, as the three figures a price-per-request needs and
   * nothing more — descending by cost.
   *
   * The repo rows carry an all-time cost per repo and cannot say whether one
   * got dearer per request last week; this is the same cross the loop is
   * already reading (a file's repo × its hour buckets), so it costs no rescan.
   * Deliberately NOT a `TokenTotals` per repo: a day × repo × four kinds would
   * multiply the document for a question that is only ever a ratio.
   *
   * Absent on an older host.
   */
  byRepo?: RepoDaySlice[];
}

/**
 * One repo's requests and money on one day.
 *
 * `pricedTurns` is the denominator of a price per request: a turn on a model
 * with no list price adds a request and no dollars, and dividing by all of
 * them would make an unpriced model look like a cheap one. `turns` is every
 * request, kept so the screen can SAY how many it left out.
 */
export interface RepoDaySlice {
  /** The absolute worktree path — `TokenGroup.key` on the repo rows. */
  repo: string;
  turns: number;
  pricedTurns: number;
  /** List-price cost, the same counterfactual as every other figure here. */
  usd: number;
  /** Input + cache read + cache write over `turns`: the context those requests
   *  sent (`shared/healthspend.ts`). Absent on an older host. */
  ctxTok?: number;
}

/**
 * One model's share of something — a day, or a repo.
 *
 * `model` is the RAW logged id; every screen labels it through `normalizeModel`
 * exactly as `TokenGroup` does, so a dated snapshot and its alias cannot end up
 * as two bands that look like a migration nobody performed.
 *
 * The cost rides along rather than being derived from the totals, for the
 * reason it does everywhere else here: a rate belongs to a model and a day, and
 * a cost recomputed from a tally has already lost both.
 */
export interface ModelSlice {
  model: string;
  totals: TokenTotals;
  cost: CostBreakdown;
}

/** Subagents started on one day under one model. */
export interface TokenDayAgents {
  model: string;
  count: number;
}

/**
 * One HOUR's usage. `hour` is `YYYY-MM-DDTHH` in the host's local zone — the
 * same zone and the same reason as `TokenDay`, of which it is a refinement: a
 * day key is this key's first ten characters, so the two can never disagree
 * about which day an 01:30 turn belongs to.
 *
 * Carried for a BOUNDED recent window only (`hoursFrom`), because the hours are
 * ~24× the rows of the days and the whole document is fetched over HTTP and
 * cached on a phone. A screen that needs the shape of a single old day asks the
 * host for it; a document that shipped every hour since May would be measured
 * in megabytes to answer a question about this week.
 */
export interface TokenHour extends TokenTotals {
  hour: string;
  /** List-price cost for the hour, summed over the models that ran in it. */
  cost: CostBreakdown;
  /**
   * The hour split by MODEL, descending by tokens — the same projection
   * `TokenDay.byModel` is, one level down.
   *
   * It exists because the two LIVE rate-limit windows are not calendar days:
   * a rolling five-hour window and a week that resets on a Thursday evening
   * can only be cut out of the hours, and "which model am I spending this
   * window on" is the question a percentage raises and cannot answer.
   *
   * Absent on a host that has not rescanned since it existed, and then the
   * window readout says the split is unknown rather than showing one model.
   */
  byModel?: ModelSlice[];
}

/**
 * One slot of the 24-hour clock, folded over every day on record.
 *
 * A separate type from `TokenHour` on purpose: that one is an INSTANT and its
 * key sorts as a date, this one is a POSITION on a clock face and its key is
 * `0..23`. Reusing the same shape for both is how a chart ends up plotting
 * "hour 14" on a time axis.
 */
export interface TokenHourSlot extends TokenTotals {
  /** 0..23, local. */
  hour: number;
  cost: CostBreakdown;
}

/** Usage attributed to one model, or one project directory. */
/** One conversation's spend, its subagents included — `TokenStatsDoc.top`. */
export interface TokenConvo {
  /** The CLI's conversation id: the log's file name, and what a live
   *  session's `claudeSessionId` is. */
  id: string;
  /** The worktree it ran in, with an agent worktree
   *  (`<repo>/.claude/worktrees/<name>`) folded into its repo. */
  repo: string;
  /** The repo's base name. */
  label: string;
  /** First and last hour with a turn in it, as local-midnight-free ms (hour
   *  resolution — the store keeps nothing finer). Null when no record parsed. */
  firstAt: number | null;
  lastAt: number | null;
  /** Everything, parent and agents. */
  totals: TokenTotals;
  cost: CostBreakdown;
  /** The agents' slice OF `totals`, never a second total. */
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  /** Subagent transcripts folded in. */
  agents: number;
  /** Tokens the parent log's FIRST answered request carried (input + cache
   *  read + cache write) — measured. Absent on an older host or a log with no
   *  answered request; agents' logs never feed it. */
  firstTok?: number;
  /** Premium over re-reading paid for expired-cache rebuilds, USD; absent when
   *  there were none. */
  coldUsd?: number;
  /** The agents' slice by model, descending by tokens. Absent on an older host. */
  agentByModel?: ModelSlice[];
}

export interface TokenGroup extends TokenTotals {
  /** The model id, or the absolute worktree path. */
  key: string;
  /** What to show: a repo's base name, or the model id unchanged. */
  label: string;
  /** List-price cost for this group. Zero when `priced` is false — which is
   *  why the flag travels with it: zero cost and "no published rate" look
   *  identical in a number and must not read the same on screen. */
  cost: CostBreakdown;
  /** Whether a list price exists for this row at all. Only meaningful on a
   *  MODEL group; a repo mixes models and is priced per model underneath. */
  priced?: boolean;
  /**
   * What this group was made of, BY MODEL — descending by tokens.
   *
   * On a REPO row this is the answer to the question the bar itself raises and
   * cannot answer: two repos with the same token count can differ several-fold
   * in cost, and the reason is never in the total — it is which model ran
   * there. Opus is 2.5× sonnet per token and 5× haiku, so "42% of the tokens,
   * 61% of the money" is a sentence about the model mix and about nothing else.
   *
   * Absent on a MODEL row, where it would be the row itself, and on a host that
   * has not rescanned since it existed.
   */
  byModel?: ModelSlice[];
}

/**
 * How many tokens every conversation on this desktop has ever used.
 *
 * Read out of the CLI's own conversation logs — the same files the transcript
 * and the context graph parse — so it needs no metering of our own and covers
 * sessions this app never drove. Scope is stated rather than implied: it is
 * every log CURRENTLY ON DISK, so a conversation deleted from the archive stops
 * counting. That is the only definition that can be checked against anything.
 */
export interface TokenStatsDoc {
  totals: TokenTotals;
  /** Ascending, and only days that had activity — a gap IS the weekend. */
  days: TokenDay[];
  /**
   * Ascending hours, and only hours that had activity, for the recent window
   * only — see `TokenHour`. Empty on a host that has not rescanned since the
   * hour buckets existed, which is why `hoursFrom` is separate: an empty list
   * and a window that starts today look identical otherwise.
   */
  hours: TokenHour[];
  /** Local midnight of the first day `hours` covers, epoch ms, or null when
   *  there are no hours at all. Everything before it is in `days` only —
   *  stated, so the intraday chart can say what it cannot show rather than
   *  drawing an empty week as a quiet one. */
  hoursFrom: number | null;
  /**
   * The all-time time-of-day profile: 24 entries, midnight-first, in the host's
   * local zone. Every hour bucket ever recorded folds into it, including the
   * ones older than `hoursFrom` — it is the one intraday reading that does not
   * need the raw hours on the wire, and the question it answers ("when do I
   * actually work") is about the whole corpus rather than this fortnight.
   */
  hourOfDay: TokenHourSlot[];
  /** Descending by total. */
  models: TokenGroup[];
  repos: TokenGroup[];
  /** Conversation logs that carried at least one counted turn. Top-level logs
   *  only — a subagent transcript is not a conversation somebody had. */
  conversations: number;
  /**
   * The slice of `totals` spent by SUBAGENTS (the Task tool), which the CLI
   * writes to `<conversation>/subagents/agent-*.jsonl`.
   *
   * Included in `totals`, not additional to it — they are real tokens on the
   * same bill. Broken out because it is the one part of the spend that has no
   * conversation you could open and read, and measured here it was a third of
   * everything: a total that quietly omitted it would be wrong by that much,
   * and one that hid it inside the headline would leave the biggest single
   * lever on the number invisible.
   */
  subagents: TokenTotals;
  /** Subagent transcripts counted, for the sentence that names the slice. */
  subagentLogs: number;

  // ── list-price cost ─────────────────────────────────────────────────────
  //
  // A COUNTERFACTUAL — what this traffic would have cost billed through the API
  // at published pay-as-you-go rates. Almost certainly not what anybody paid:
  // the CLI is usually run on a subscription, which is a flat fee. Every
  // surface showing these must say so (`shared/pricing.ts` has the argument).

  /** Whole-corpus list-price cost, by kind. */
  cost: CostBreakdown;
  /** The subagent slice of `cost` — part OF it, not additional to it. */
  subagentCost: CostBreakdown;
  /**
   * Tokens no list price could be found for, because the model is not in the
   * table. Counted so the screen can say "N% of this is unpriced" rather than
   * charging zero, which reads as free.
   */
  unpriced: TokenTotals;
  /**
   * Turns billed at a non-standard speed (fast mode), which costs roughly
   * double and is NOT modelled. Zero on every corpus seen so far; carried so a
   * future one that uses it produces a visible caveat instead of a silently
   * low number.
   */
  fastTurns: number;
  /** When the price table was taken (`YYYY-MM-DD`), so the screen can say how
   *  old it is rather than implying it is live. */
  /**
   * Every re-write of an EXPIRED prompt cache on this desktop — see
   * `ColdStarts`.
   *
   * The one line on this screen that is about a cost nobody chose. Every other
   * figure here answers "what did the work cost"; this one answers "what did
   * the GAPS cost" — a conversation resumed inside the hour re-reads its window
   * at a tenth of the write rate, and one resumed the next morning does not.
   * `count: 0` is the claim that it never happened; absent is an older host.
   */
  coldStarts?: ColdStarts;
  /**
   * The dearest conversations on this desktop, most expensive first — each one
   * a top-level log with its own subagent transcripts folded IN, because the
   * agents' spend is the conversation's spend (one measured session: 271k in
   * its window, 355M in 19 agents). Ranked by list-price cost, tokens where
   * nothing was priced. Bounded (`TOP_CONVOS` on the host). Absent on an older
   * host — never an empty list standing for one.
   */
  top?: TokenConvo[];

  pricesAsOf: string;
  /** First and last counted turn, epoch ms. Null when there is nothing. */
  firstAt: number | null;
  lastAt: number | null;
  /** When this was last brought up to date, and what it cost. */
  scannedAt: number;
  /** Logs examined on the last pass, and how many of them had to be re-read. */
  logs: number;
  reread: number;
}

/**
 * One PAST rate-limit window, folded out of the hour ledger.
 *
 * The live window is cut on the PHONE (`web/usageCut.ts`, over the recent hours
 * the document already carries). This is the same cut for windows the wire
 * cannot reach: the host keeps every hour it ever saw and ships only a
 * fortnight of them, so a five-hour window from July, or the week before last,
 * can only be answered by the machine that holds the buckets.
 *
 * `back` is how many whole windows ago: 0 is the one running now, 1 the one
 * before it. The instants are NOT carried — they are `anchor - (back+1)*lenMs`
 * and `anchor - back*lenMs`, derived on both ends from the two fields the
 * series already states, so a row cannot disagree with the grid it is in.
 *
 * Only windows that had something in them are sent. A window with no row ran
 * nothing, which is a READING and is drawn as an empty box — the difference
 * between that and "the record does not reach back" is `oldestHour`, not the
 * absence of a row.
 */
export interface TokenWindow extends TokenTotals {
  back: number;
  /** List-price cost for the window, summed over the models that ran in it. */
  cost: CostBreakdown;
  /** The window split by MODEL, descending by tokens — the same projection
   *  `TokenHour.byModel` is, folded up. Absent on a host that has not
   *  rescanned since the hour×model cross existed. */
  byModel?: ModelSlice[];
}

/**
 * One window GRID: an anchor, a length, and what fell in each cell.
 *
 * The host is told the anchor and the length rather than knowing them — the
 * reset instants come off the CLI's own `/usage` screen and the lengths are a
 * property of the plan, neither of which is a fact about a ledger of hours. So
 * this module folds buckets into a grid somebody else defined and asserts
 * nothing about what the grid means.
 *
 * The hour is the finest bucket on record, so a cell counts from the TOP of the
 * hour its window opened in — the same rule the live cut states on screen, and
 * therefore the same numbers for `back: 0`. Two neighbouring cells can share
 * the hour a window opened in, which is the price of that rule and is said
 * where the grid is drawn.
 */
export interface TokenWindowSeries {
  /** Whatever the caller called this grid, echoed back — the caller asks for
   *  several at once and must not have to match them up by position. */
  id: string;
  /** The instant the CURRENT window resets: cell `back` runs
   *  `[anchor - (back+1)*lenMs, anchor - back*lenMs)`. */
  anchor: number;
  lenMs: number;
  /** Ascending by `back` — newest first is the order the grid is read in, so
   *  the rows are sent oldest-last and the drawing decides. */
  windows: TokenWindow[];
  /** Top of the OLDEST hour bucket on record, epoch ms, or null when there are
   *  none. Everything before it is outside the ledger, which a grid must draw
   *  as unknown rather than as a quiet night. */
  oldestHour: number | null;
  /** Top of the NEWEST hour bucket on record. A cell after it has not happened
   *  yet as far as the logs go. */
  newestHour: number | null;
}

/** The answer to one `/api/tokenwindows` read — one entry per grid asked for,
 *  in the order they were asked. */
export interface TokenWindowsDoc {
  series: TokenWindowSeries[];
  /** When the ledger behind this was last brought up to date (the same scan
   *  `TokenStatsDoc.scannedAt` reports), so a grid can say how old it is. */
  scannedAt: number;
}

/**
 * `GET /api/usagenow`: what the desktop pushes over the socket about the ACCOUNT — the `/usage`
 * reading and the other sources' (`usage.status`), the billing profile (`billing.status`), the
 * budget and its dollar periods (`budget.state`) and the backend list (`backends`) — as one read,
 * for a client with no socket (the VS Code panel drawing the phone's token screen). Each part is
 * exactly what its frame carries; nothing here is derived for this route.
 */
export interface UsageNowDoc {
  usage: UsageInfo | null;
  readings: UsageReading[];
  billing: import("../billing.js").BillingStatus;
  budget: import("../budget.js").UsageBudget | null;
  periods: import("../period.js").PeriodState[];
  backends: import("./backend.js").BackendInfo[];
}
