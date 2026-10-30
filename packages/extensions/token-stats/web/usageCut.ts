/**
 * The two LIVE rate-limit windows, as a cut of the token ledger.
 *
 * ── The question this exists to answer ──────────────────────────────────────
 *
 * `LimitWindows` says `1% used` and `50% used`. Both are scraped percentages
 * with a clock on them, and neither can say what they are a percentage OF: how
 * many tokens went into this window, which models carried them, what the same
 * traffic would have cost at list prices. Every one of those answers is already
 * on the screen — for ALL TIME. So the cut is the missing half, and it is the
 * same cut twice: a window is an instant it opened and a clock it resets on.
 *
 * ── Why the HOURS and not the days ──────────────────────────────────────────
 *
 * Neither window is a calendar day. The session window is a rolling five hours
 * that can open at 01:59; the weekly one resets on, say, a Thursday at 18:59.
 * `TokenDay` cannot express either. `TokenHour` can — the host keeps a bounded
 * recent window of them (`hoursFrom`), with a cost and, since this change, a
 * model split.
 *
 * ── What that costs in precision, and why it is stated rather than hidden ───
 *
 * An hour bucket is the finest thing on record, so a window that opened at
 * 01:59 cannot be cut at 01:59. The honest move is not to fudge the edge but to
 * MOVE IT and say where it went: the cut starts at the NEAREST hour boundary to
 * the instant the window opened (`windowStartHour`, shared — the one rule the
 * heat grid, the week card and the host's cost window use too), and every
 * readout built on it names that instant. The number is then exact for the span
 * it states — off the window by at most half an hour — instead of being
 * approximately right about the window. Always the FLOOR counted the whole
 * opening hour: a week resetting at 18:59 carried 59 minutes of last week's
 * spend, ≈ 4 points against a 35% meter. `WindowCut.leadMs` is the difference,
 * signed, so the caller can say which way.
 *
 * Every refusal here is a REASON, never a zero: a window with no reset instant,
 * a reading old enough that the window has already rolled over, and an hour
 * record that does not reach back far enough are three different facts and
 * three different sentences.
 */
import {
  addCost, addTotals, hourKeyMs, normalizeModel, tokenTotal, undatedSince, undatedText, undatedWhy, windowStartHour, zeroCost, zeroTotals,
  type CostBreakdown, type ModelSlice, type TokenGroup, type TokenHour, type TokenStatsDoc,
  type TokenTotals, type TokenWindowsDoc, type TokenWindowSeries, type UsageInfo,
} from "@waterplane/shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type LiveWindowId = "session" | "week";

/**
 * The two windows, and the only place their LENGTHS are written down.
 *
 * The length is what turns a reset instant into a span, and it is a property of
 * the plan rather than of anything the screen can measure — which is exactly
 * why it belongs in one table with the name of the window beside it, and not
 * inline at the one call site that happens to need it today.
 */
export const LIVE_WINDOWS: {
  id: LiveWindowId;
  /** What the chip says. */
  label: string;
  /** What the scope line says, in a sentence. */
  long: string;
  lenMs: number;
  resetOf: (u: UsageInfo) => number | null;
  pctOf: (u: UsageInfo) => number | null;
}[] = [
  {
    id: "session",
    label: "This 5h window",
    long: "the five-hour session window running now",
    lenMs: 5 * HOUR_MS,
    resetOf: (u) => u.sessionResetAt,
    pctOf: (u) => u.sessionPct,
  },
  {
    id: "week",
    label: "This week window",
    long: "the weekly window running now",
    lenMs: 7 * DAY_MS,
    resetOf: (u) => u.weeklyResetAt,
    pctOf: (u) => u.weeklyPct,
  },
];

/** Why a window has no cut. Each one is a different sentence on screen, which
 *  is why this is a union and not a boolean. */
export type CutRefusal =
  /** The `/usage` screen named no reset instant for this window. */
  | { why: "no-reset" }
  /** The scrape is old enough that the window it described has already rolled
   *  over, so its own start is no longer the one running. */
  | { why: "rolled"; resetAt: number }
  /** The host's hour record does not reach back to the start of the window. */
  | { why: "short"; fromHour: number; hoursFrom: number | null }
  /** The ledger holds records with no readable hour (`TokenStatsDoc.undated`): any cut is a floor. */
  | { why: "undated"; undated: unknown };

export interface WindowCut {
  id: LiveWindowId;
  label: string;
  long: string;
  /**
   * How many whole windows back this one is: 0 is the window running now, 1 the
   * one before it.
   *
   * On the type rather than only in the caller because every sentence about a
   * cut changes with it — a past window does not "reset in 40 minutes", it
   * closed, and the tiles, the span line and the scope chip all have to know
   * which they are describing.
   */
  back: number;
  /** When the limit window itself opened — `resetAt - lenMs`. */
  openedAt: number;
  /** Where the CUT starts: the hour boundary nearest `openedAt`
   *  (`windowStartHour`) — up to half an hour either side of it. */
  fromHour: number;
  /** `openedAt - fromHour`, SIGNED: positive when the cut starts earlier than
   *  the window (the first hour is counted whole), negative when later (the
   *  window's first minutes fall before the first bucket and are left out).
   *  Zero only when the window opened exactly on the hour. */
  leadMs: number;
  resetAt: number;
  /**
   * The hour buckets in the cut, ascending — only where this side had them.
   *
   * The live window is cut out of the fortnight of hours the document carries;
   * an older one is folded by the HOST, which keeps every hour it ever saw and
   * sends the fold rather than a megabyte of buckets. So absent means "this
   * side never saw the buckets", never "there were none in it" — which is why
   * the tile that counts them is drawn only where they are here.
   */
  hours?: TokenHour[];
  totals: TokenTotals;
  cost: CostBreakdown;
  /**
   * The models that ran in the cut, as bar rows — descending by tokens, folded
   * on the RAW logged id exactly as `TokenStatsDoc.models` is, and labelled
   * through the same `normalizeModel`.
   */
  models: TokenGroup[];
  /**
   * Whether the split above is a reading at all. False on a host that has not
   * rescanned since hours carried a model split: the hours are still counted,
   * so the tokens and the money are right and only the split is unknown —
   * which is a sentence, not an empty chart.
   */
  modelSplit: boolean;
}

/**
 * The cut for one window, or the reason there is none.
 *
 * `now` is a parameter so the rollover test is testable and so one render
 * cannot compare two windows against two different instants.
 */
export function windowCut(
  spec: (typeof LIVE_WINDOWS)[number],
  doc: Pick<TokenStatsDoc, "hours" | "hoursFrom" | "models" | "undated" | "undatedUntil" | "undatedLogs"> | null,
  usage: UsageInfo | null,
  now: number,
): WindowCut | CutRefusal {
  const resetAt = usage ? spec.resetOf(usage) : null;
  if (resetAt == null) return { why: "no-reset" };
  // A scrape whose reset instant has passed described the PREVIOUS window. Its
  // start is not the start of the one running now, and a cut taken from it
  // would be a confident answer about the wrong five hours.
  if (resetAt <= now) return { why: "rolled", resetAt };

  const openedAt = resetAt - spec.lenMs;
  const fromHour = windowStartHour(openedAt);
  // Only an undated record whose log was written since the cut's first hour can be in it.
  const undated = undatedSince(doc, fromHour);
  if (undatedWhy(undated)) return { why: "undated", undated };
  const hoursFrom = doc?.hoursFrom ?? null;
  // `hoursFrom` is local midnight of the first day on the wire. The record
  // reaching back further than the cut is the whole condition — an empty
  // `hours` list with a null `hoursFrom` is "no hourly detail", which is the
  // same refusal worded from the same field.
  if (hoursFrom == null || hoursFrom > fromHour) return { why: "short", fromHour, hoursFrom };

  const hours = (doc?.hours ?? []).filter((h) => hourKeyMs(h.hour) >= fromHour);
  const totals = hours.reduce<TokenTotals>((acc, h) => addTotals(acc, h), zeroTotals());
  const cost = hours.reduce<CostBreakdown>((acc, h) => addCost(acc, h.cost), zeroCost());

  // Absent ⇒ an older host. An hour that genuinely ran nothing has an EMPTY
  // array, so "some hour in the cut carries a split" is the test, not "every
  // hour does" — one quiet hour must not read as an old daemon.
  const modelSplit = hours.some((h) => Array.isArray(h.byModel));

  return {
    id: spec.id,
    label: spec.label,
    long: spec.long,
    back: 0,
    openedAt,
    fromHour,
    leadMs: openedAt - fromHour,
    resetAt,
    hours,
    totals,
    cost,
    models: modelSplit ? foldModels(hours, doc?.models ?? []) : [],
    modelSplit,
  };
}

/** Whether a `windowCut` answer is a cut.
 *
 *  Keyed on `openedAt`, which every cut has and no refusal does — `hours` used
 *  to be that field and stopped being it the moment a window folded by the host
 *  could arrive without buckets. */
export function isCut(x: WindowCut | CutRefusal): x is WindowCut {
  return (x as WindowCut).openedAt !== undefined;
}

/**
 * The hours' model slices folded into bar rows.
 *
 * `priced` is carried over from the all-time row for the same key rather than
 * inferred from a zero cost: "ran on a model with no published rate" and "ran
 * almost nothing" are indistinguishable in a number and must not read the same.
 * A model the all-time list does not name leaves the flag absent, which is the
 * one honest third answer.
 */
export function foldModels(hours: readonly { byModel?: ModelSlice[] }[], all: TokenGroup[]): TokenGroup[] {
  const totals = new Map<string, TokenTotals>();
  const costs = new Map<string, CostBreakdown>();
  for (const h of hours) {
    for (const m of h.byModel ?? []) {
      addTotals(totals.get(m.model) ?? totals.set(m.model, zeroTotals()).get(m.model)!, m.totals);
      addCost(costs.get(m.model) ?? costs.set(m.model, zeroCost()).get(m.model)!, m.cost);
    }
  }
  const priced = new Map(all.map((g) => [g.key, g.priced]));
  return [...totals.entries()]
    .map(([key, t]) => ({
      key,
      label: normalizeModel(key) ?? key,
      ...t,
      cost: costs.get(key) ?? zeroCost(),
      ...(priced.has(key) ? { priced: priced.get(key) } : {}),
    }))
    .sort((a, b) => tokenTotal(b) - tokenTotal(a));
}

/**
 * What the cut covers, as a sentence — the one place the hour-edge caveat is
 * worded, so the readout under the limit bar and the scope line under the hero
 * cannot describe the same cut two different ways.
 */
export function cutSpan(cut: WindowCut, now: number): string {
  const at = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const wide = cut.resetAt - cut.fromHour > 26 * HOUR_MS;
  const from = wide ? `${day(cut.fromHour)}, ${at(cut.fromHour)}` : at(cut.fromHour);
  const lead = leadWords(cut.leadMs, at(cut.openedAt));
  // A window that has CLOSED ran to its own reset instant, not to now. Saying
  // "to now" about last Tuesday would put four days nobody counted inside a
  // span the sentence claims to state exactly. Its cut ends where the NEXT
  // window's starts (`windowStartHour(resetAt)`), so neighbours never share an
  // hour — and the sentence prints that hour, the span actually counted.
  if (cut.back > 0) {
    const toHour = windowStartHour(cut.resetAt);
    const to = wide ? `${day(toHour)}, ${at(toHour)}` : at(toHour);
    return `Counted from ${from} to ${to}, ${hoursWord(toHour - cut.fromHour)} of hour buckets.${lead}`;
  }
  return `Counted from ${from} to now, ${hoursWord(now - cut.fromHour)} of hour buckets.${lead}`;
}

/**
 * The one wording of a window's left edge against the hour its cut starts on — the live cut's
 * span line and the week card's caption both say it, so it is worded once. `leadMs` is SIGNED
 * (`WindowCut.leadMs`): positive, the first hour is counted whole and the cut is wider than the
 * window; negative, the window's first minutes fall before the cut and are left out. Null on the
 * hour. `before` names what they fall before — a column on the week card, a bucket elsewhere.
 */
export function leadClause(leadMs: number, what: "window" | "week", before: string): string | null {
  const min = Math.round(Math.abs(leadMs) / 60_000);
  if (!min) return null;
  if (leadMs > 0) return `the first hour is counted whole, ${min} min wider than the ${what}`;
  return min === 1
    ? `the first minute of the ${what} falls before ${before} and is left out`
    : `the first ${min} minutes of the ${what} fall before ${before} and are left out`;
}

/** `leadClause` as a sentence after the span line, naming the instant the window opened. */
function leadWords(leadMs: number, openedClock: string): string {
  const clause = leadClause(leadMs, "window", "the first hour bucket");
  return clause
    ? ` The window itself opened at ${openedClock}; the finest bucket on record is an hour, so the cut starts at the nearest hour: ${clause}.`
    : "";
}

function hoursWord(ms: number): string {
  const h = Math.max(0, Math.round(ms / HOUR_MS));
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${Math.round(h / 24)} days`;
}

/** The refusal as the sentence the screen prints. One wording per reason. */
export function cutRefusalText(spec: (typeof LIVE_WINDOWS)[number], r: CutRefusal): string {
  if (r.why === "no-reset") {
    return `The /usage screen did not name a reset time for ${spec.long}, so there is no instant to count from.`;
  }
  if (r.why === "undated") return undatedText(r.undated) ?? "";
  if (r.why === "rolled") {
    return `The last /usage reading described a window that has since reset, so the one running now has no known start. Re-read it above.`;
  }
  return r.hoursFrom == null
    ? `No hourly detail on this desktop yet — the host records it from the next scan of the conversation logs onward, and ${spec.long} can only be cut out of hours.`
    : `Hourly detail is kept from ${new Date(r.hoursFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })} onward, which does not reach back to the start of ${spec.long}.`;
}

// ── the windows BEFORE this one ────────────────────────────────────────────
//
// Everything above answers "what is in the window running now". The rest of
// this file answers the same question about the ones before it, off a grid the
// HOST folds (`host/tokenstats.ts`'s `windowSeries`) because the document ships
// a bounded fortnight of hour buckets and a weekly window from July is four
// months back in a record the wire does not carry.
//
// The grid is defined HERE and sent up: `anchor` is the live reset instant off
// `/usage` and `lenMs` is `LIVE_WINDOWS`', so the two windows' semantics stay
// in the one table at the top of this file and the host asserts nothing about
// what it is folding.

/** What the phone asks the host to fold — one grid per live window. */
export function windowSpecs(usage: UsageInfo | null): { id: LiveWindowId; anchor: number; lenMs: number }[] {
  if (!usage) return [];
  return LIVE_WINDOWS
    .map((w) => ({ id: w.id, anchor: w.resetOf(usage) ?? 0, lenMs: w.lenMs }))
    // A window whose reset instant the screen never named has no grid, for the
    // same reason it has no cut: there is no instant to count back from, and a
    // grid anchored on a guess would be a picture of an invented history.
    .filter((sp) => sp.anchor > 0);
}

/**
 * One box in a heatmap: a window, and what fell in it.
 *
 * `totals` is NULL for a window the ledger cannot speak about — one that ended
 * before the oldest hour on record. That is not the same fact as a window with
 * nothing in it, which is a reading and is a real zero, and the two must never
 * be drawn the same way.
 */
export interface WindowCell {
  back: number;
  openedAt: number;
  resetAt: number;
  totals: TokenTotals | null;
  cost: CostBreakdown | null;
  /** Set when records the ledger could not date could fall in this window (shared
   *  `undatedSince` from its first hour): the sentence it shows INSTEAD of a figure, and
   *  `totals`/`cost` are null. A third state beside a reading and "outside the record". */
  refused?: string;
}

/** A host grid with the ledger's undated fields riding on it (`windowGrids`), so each box can
 *  be asked on its own whether a record with no date could fall in it. */
export type GridSeries = TokenWindowSeries & { undated?: number; undatedUntil?: number; undatedLogs?: Array<[number, number]> };

/** How many boxes a grid may draw at most. Four months of five-hour windows is
 *  ~570, which is a legible heatmap on a phone; the cap is the guard against a
 *  clock skew or a bad anchor asking for a hundred thousand of them, and what
 *  it cut is said on screen rather than silently dropped. */
export const MAX_CELLS = 800;

/**
 * The grid for one window kind, newest LAST — the shape a heatmap is drawn in.
 *
 * It stops at the record, not at the cap: the oldest cell is the last one whose
 * window ran at all after the oldest hour bucket the host holds. Everything
 * before that is not a quiet night, it is a period nobody has a ledger for, and
 * an empty box there would be a claim.
 */
export function windowGrid(series: GridSeries | null): WindowCell[] {
  if (!series || !(series.lenMs > 0) || !(series.anchor > 0)) return [];
  const rows = new Map(series.windows.map((w) => [w.back, w]));
  const out: WindowCell[] = [];
  for (let back = 0; back < MAX_CELLS; back++) {
    const resetAt = series.anchor - back * series.lenMs;
    const openedAt = resetAt - series.lenMs;
    // A window entirely before the oldest hour on record cannot be spoken
    // about, and neither can any window older than it — so this is where the
    // grid ends rather than a cell it draws as unknown.
    if (series.oldestHour == null || resetAt <= series.oldestHour) break;
    const row = rows.get(back);
    // A window the record only PARTLY covers is left unknown rather than
    // counted: half a window drawn as a whole one is the box that reads
    // quietest on the heatmap and is the one with the least behind it.
    const covered = series.oldestHour <= windowStartHour(openedAt);
    // Covered, but a record with no date could be in it: the box refuses on its own, and its
    // neighbours that no such record can reach keep their numbers.
    const refused = covered ? undatedText(undatedSince(series, windowStartHour(openedAt))) : null;
    const counted = covered && !refused;
    out.push({
      back,
      openedAt,
      resetAt,
      totals: counted ? (row ? cellTotals(row) : zeroTotals()) : null,
      cost: counted ? (row?.cost ?? zeroCost()) : null,
      ...(refused ? { refused } : {}),
    });
  }
  // Ascending in TIME: oldest first, the window running now last, which is the
  // direction a reader scans a history in.
  return out.reverse();
}

/**
 * The grid as a heatmap DRAWS it: the boxes no undated record can fall in, and ONE sentence
 * (`refused`) for the windows before them that it could — never a striped box per window.
 *
 * A wall of identical stripes says one thing N times and looks like N findings. A record is never
 * later than its log's mtime, so the windows it could fall in are always the OLDEST run of the grid
 * (`undatedSince` only shrinks as a window opens later): every window up to the one its newest
 * log was written in. A host from before the per-log dates (`undatedUntil`/`undatedLogs`,
 * f99f4328 → e976a22d) sends a bare `undated`, which makes that run the whole grid; so does a log
 * written inside the window running now. The sentence is the oldest box's (the largest count).
 * Only where the desktop sent no dates at all does it mention the host's age, and only as an if:
 * today's host sends the same bare shape when it cannot read a log's mtime. The windows in the run
 * stay reachable from the stepper (`seriesCut` refuses each in the same words); outlined boxes the
 * record does not reach are older still and go with the run.
 */
export function heatGrid(series: GridSeries | null): { cells: WindowCell[]; refused: string | null } {
  const cells = windowGrid(series);
  let last = -1;
  cells.forEach((c, i) => { if (c.refused) last = i; });
  if (last < 0) return { cells, refused: null };
  const run = cells.slice(0, last + 1).filter((c) => c.refused);
  const n = run.length;
  const lead = last === cells.length - 1
    ? "No past window has a figure."
    : `${n === 1 ? "The window" : `The ${n} windows`} before these boxes ${n === 1 ? "has" : "have"} no figure.`;
  const noDates = series?.undatedUntil == null && series?.undatedLogs == null;
  return {
    cells: cells.slice(last + 1),
    refused: `${lead} ${run[0].refused}` + (noDates
      ? " The desktop sent no date for the logs holding them, so no window can be told from another."
        + " A host older than this phone never sends one: if this desktop's is older, restarting it there lets each window answer on its own."
      : ""),
  };
}

/** A `TokenWindow` back to plain totals. The row spreads `TokenTotals` inline
 *  the way every bucket on the wire does, so this is the one place that names
 *  the fields and the rest of the file never has to. */
function cellTotals(w: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; turns: number }): TokenTotals {
  return {
    input: w.input, output: w.output, cacheRead: w.cacheRead,
    cacheWrite: w.cacheWrite, cacheWrite1h: w.cacheWrite1h, turns: w.turns,
  };
}

/**
 * The host's past-window grids by id, each carrying the ledger's undated fields so a box an
 * undated record could fall in refuses on its OWN (`windowGrid`, `seriesCut`) — never the whole
 * grid blanked for one record somewhere.
 */
export function windowGrids(doc: TokenWindowsDoc | null | undefined): Map<LiveWindowId, GridSeries> {
  if (!doc) return new Map();
  const u = {
    ...(doc.undated != null ? { undated: doc.undated } : {}),
    ...(doc.undatedUntil != null ? { undatedUntil: doc.undatedUntil } : {}),
    ...(doc.undatedLogs != null ? { undatedLogs: doc.undatedLogs } : {}),
  };
  return new Map((doc.series ?? [])
    .filter((se): se is TokenWindowSeries & { id: LiveWindowId } => se.id === "session" || se.id === "week")
    .map((se) => [se.id, { ...se, ...u }]));
}

/**
 * The cut for ONE past window — the same `WindowCut` the live one produces, so
 * every readout under it is drawn by the same components and no screen has a
 * second idea of what a window is.
 *
 * `back: 0` is answered from the series too, and deliberately: the host folds
 * it under exactly the rule `windowCut` applies here (`windowCells`), so the
 * two agree by construction, and a screen that took the live box from one and
 * every other box from the other would have two answers for the box they
 * overlap on.
 */
export function seriesCut(
  spec: (typeof LIVE_WINDOWS)[number],
  series: GridSeries | null,
  back: number,
  all: TokenGroup[],
): WindowCut | CutRefusal {
  if (!series || !(series.anchor > 0)) return { why: "no-reset" };
  const resetAt = series.anchor - back * series.lenMs;
  const openedAt = resetAt - series.lenMs;
  const fromHour = windowStartHour(openedAt);
  if (series.oldestHour == null || series.oldestHour > fromHour) {
    return { why: "short", fromHour, hoursFrom: series.oldestHour };
  }
  // The box's own refusal (`windowGrid`): the same count, the same words as the live cut's.
  const undated = undatedSince(series, fromHour);
  if (undatedWhy(undated)) return { why: "undated", undated };
  const row = series.windows.find((w) => w.back === back);
  const totals = row ? cellTotals(row) : zeroTotals();
  // Absent ⇒ an older host that folds no split. An EMPTY array is a window that
  // ran nothing, which is a reading — the same distinction the live cut makes
  // one bucket down.
  const modelSplit = !!row?.byModel || !row;
  return {
    id: spec.id,
    label: spec.label,
    long: back === 0 ? spec.long : pastWindowLong(spec, openedAt, resetAt),
    back,
    openedAt,
    fromHour,
    leadMs: openedAt - fromHour,
    resetAt,
    totals,
    cost: row?.cost ?? zeroCost(),
    models: row?.byModel ? foldSlices(row.byModel, all) : [],
    modelSplit,
  };
}

/** What a PAST window is called in a sentence — the counterpart of
 *  `LIVE_WINDOWS.long`, which can only ever say "running now". */
function pastWindowLong(spec: (typeof LIVE_WINDOWS)[number], openedAt: number, resetAt: number): string {
  const kind = spec.id === "session" ? "five-hour session window" : "weekly window";
  return `the ${kind} that ran ${windowWhen(openedAt, resetAt)}`;
}

/**
 * When a window ran, as a label — for a heat box, a stepper and a sentence.
 *
 * A five-hour window is named by its day and its clock times; a week is named
 * by the two dates, because "18:59 to 18:59" over seven days tells a reader
 * nothing they can place.
 */
export function windowWhen(openedAt: number, resetAt: number): string {
  const at = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (resetAt - openedAt > 26 * HOUR_MS) return `${day(openedAt)} – ${day(resetAt)}`;
  const sameDay = new Date(openedAt).toDateString() === new Date(resetAt).toDateString();
  return sameDay
    ? `${day(openedAt)}, ${at(openedAt)}–${at(resetAt)}`
    : `${day(openedAt)} ${at(openedAt)} – ${day(resetAt)} ${at(resetAt)}`;
}

/** The host's model slices as bar rows — `foldModels`' other half, for a fold
 *  that has already happened on the far side. `priced` is carried over from the
 *  all-time row rather than inferred from a zero cost, for the reason stated
 *  there: "no published rate" and "ran almost nothing" must not read the same. */
function foldSlices(slices: ModelSlice[], all: TokenGroup[]): TokenGroup[] {
  const priced = new Map(all.map((g) => [g.key, g.priced]));
  return slices
    .map((m) => ({
      key: m.model,
      label: normalizeModel(m.model) ?? m.model,
      ...m.totals,
      cost: m.cost,
      ...(priced.has(m.model) ? { priced: priced.get(m.model) } : {}),
    }))
    .sort((a, b) => tokenTotal(b) - tokenTotal(a));
}

/**
 * What a heat box is worth, 0..1, against the busiest box in its own grid.
 *
 * Against its OWN grid and never against both: a weekly window holds ~34 times
 * a five-hour one, so one shared scale would paint every five-hour box at the
 * bottom of the ramp and say nothing about which of them was busy. The two
 * heatmaps are two questions and each carries its own maximum in its legend.
 *
 * Square-rooted, because the distribution is what it is: one all-nighter is
 * twenty times a quiet window, and on a linear ramp that one box is the only
 * one with any colour in it. The legend says the scale is not linear rather
 * than leaving a reader to infer proportions that are not there.
 */
export function heatFrac(v: number, max: number): number {
  if (!(max > 0) || !(v > 0)) return 0;
  return Math.min(1, Math.sqrt(v / max));
}

/** Which step of the ramp a box lands on, `0..steps-1`. A box with something in
 *  it is never step 0 — the palest step still has to read as "some", or a real
 *  reading is drawn as the empty box beside it. */
export function heatStep(frac: number, steps: number): number {
  if (!(frac > 0)) return 0;
  return Math.max(1, Math.min(steps - 1, Math.ceil(frac * (steps - 1))));
}
