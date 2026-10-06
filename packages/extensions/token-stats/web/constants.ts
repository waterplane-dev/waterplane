/** The screen's shared constants: the chart frame, the calendar RANGES, the source ids and the usage-history windows. */


/** Older than this and opening the screen re-scrapes. Matches the host's own
 *  usage cache TTL (`WATERPLANE_USAGE_TTL_MS`, 8 min) — asking sooner only re-reads
 *  the same cached answer at the price of a PTY. */
export const USAGE_STALE_MS = 8 * 60 * 1000;

export const PAD = { top: 10, right: 10, bottom: 20, left: 46 };
export const CHART_H = 170;
/** The trend window. Seven days because the thing it exists to see through is
 *  the weekday/weekend cycle, and a mean shorter than the cycle it is smoothing
 *  is the cycle again with a lag. */
export const TREND_DAYS = 7;

/**
 * Windows the two time charts can be scoped to. The totals never move.
 *
 * `week` is the odd one and deliberately first: the other three all END AT
 * TODAY, so every one of them answers "how much lately" and none of them can
 * answer "what did last week look like". A week is a window you STEP through
 * (`WeekNav`), which is why it carries no day count — `weekAt` says where it is.
 */
export const RANGES = [
  { id: "week", label: "Week", days: 0 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: 0 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** Which ledger the screen is reading: `claude`, or a contributed view's id
 *  (`LedgerViewDef`). There is deliberately no "all sources" value: that chip
 *  would be the merge this screen exists to refuse. */
export type SourceId = string;

/** How far back the two charts look. A rolling five-hour window is the
 *  shorter of the two, so a day covers four whole windows of it and a useful
 *  slice of the week — and it bounds what a phone downloads. */
export const HISTORY_HOURS = 24;
/** What is fetched: enough for the WEEK chart, which spans the whole window
 *  the weekly reset closes (`usageSpan`), plus an hour so a reading taken just
 *  before that window opened is in hand. The five-hour chart clips to its day. */
export const FETCH_HOURS = 7 * 24 + 1;
