/**
 * What a series IS, and how one reading of it is taken.
 *
 * ── Why this is not part of the narrative ──────────────────────────────────
 *
 * Two things read this repo's history out loud. `narrate.mjs` turns a reading
 * into a sentence; `plot.mjs` ships the same reading to a phone that draws it.
 * Neither is allowed its own answer to "which series exist" or to "what does
 * this value say about its own past", because a second answer to either is a
 * definition that `constants.mjs` does not version and `fixture.json` does not
 * pin — the same argument the CLI's header makes about itself, applied one
 * level down. So the vocabulary lives here and both sides import it.
 *
 * Everything here is a value, its comparator, its percentile rank and a slope
 * sign. There is no threshold in this file, no cutoff, and no word in anything
 * it returns that ranks the repo on a scale.
 *
 * ── One rank, one scale ────────────────────────────────────────────────────
 *
 * **A rank is a FRACTION in [0,1], exactly as `series.mjs`'s `readRank`
 * returns it, and it is multiplied by 100 in exactly one place — `pct()`.**
 *
 * The narrative used to carry its own copy of `readRank` on a 0–100 scale,
 * kept "so the module stays pure". The rationale was wrong twice over:
 * `readRank` IS pure (only `load`/`append` touch the filesystem), and the two
 * copies did not agree. Production injects `series.mjs`'s, so `rankPhrase`
 * divided a fraction into percentile buckets and printed `0th percentile` —
 * not a rounding artifact but `Math.round(0.02)` — while every quartile
 * comparison collapsed into bucket 1 and produced zero rank events for the
 * life of the tool. The two also disagreed on the flat band (`<=` against
 * `<`), so they did not even count slope flips the same. Meanwhile the test
 * injects nothing, so every narrative test ran on the scale production never
 * used.
 *
 * Hence: one implementation, imported. The injection point survives because
 * the CLI cuts the window before ranking and `reading` would otherwise cut it
 * twice, but the DEFAULT is the real one and an injected function whose answer
 * is not on [0,1] is refused and replaced with it — that being the exact
 * failure this paragraph exists about.
 *
 * ── The window counts READINGS, not calendar days ──────────────────────────
 *
 * `RANK_WINDOW_DAYS` is a count of day-ROWS, and the OLS slope runs over
 * position in that list. Those are the same thing only in a repo committed to
 * every day, and this one has a 57-day hole in it: the "last 22 days" of this
 * series spans 95 calendar days. `series.mjs` argues out why the repair is the
 * wording rather than a calendar cut — the days are gone by the time a window
 * reaches `readRank`. So a `Reading` carries `n` and `from`: how many readings
 * the window actually held, and the day it opens. Both sides say "readings"
 * because that is what was counted, and naming the first day puts the gap in
 * front of the reader at the point of the claim.
 *
 * ── Costs nothing ──────────────────────────────────────────────────────────
 *
 * No model, no network, no subprocess. Arithmetic and string building, like
 * every module in this tool but `judge.mjs`.
 */

import { readRank as seriesReadRank } from "./series.mjs";

// ── formatting ─────────────────────────────────────────────────────────────

/**
 * Thousands-grouped, at most two decimals, built by hand rather than through
 * `toLocaleString`. ICU's grouping character depends on the machine's locale,
 * and a document that is diffed against yesterday's copy must not change
 * because the daemon restarted somewhere else.
 */
export function nf(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const neg = n < 0;
  const r = Math.round(Math.abs(n) * 100) / 100;
  const [int, frac] = String(r).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** 1st, 2nd, 3rd, 11th, 21st, 100th. */
export function ordinal(n) {
  const v = Math.round(n);
  const tens = Math.abs(v) % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  return `${v}${["th", "st", "nd", "rd"][Math.abs(v) % 10] || "th"}`;
}

/**
 * The numbers a sentence actually states, for the invariant that no value is
 * ever reported without the value it is compared with.
 *
 * ISO days are stripped FIRST. "2026-09-20" is four digit-runs and would let a
 * sentence satisfy "at least two numbers" by naming a date twice, which is the
 * loophole the rule exists to close: the neighbour has to be a measurement.
 */
export function numbersIn(text) {
  const withoutDays = String(text).replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  return withoutDays.match(/\d[\d,]*(?:\.\d+)?/g) || [];
}

export const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many ?? `${one}s`}`;

// ── reading a value against its own past ───────────────────────────────────

/**
 * THE conversion from `readRank`'s fraction to the percentile a sentence
 * prints. One call site — `narrate.mjs`'s `rankPhrase` — so there is exactly
 * one place where the scale of a rank is decided. See the header for what two
 * of them cost.
 */
export const pct = (rank) => Math.round(rank * 100);

/** Quartile of a rank fraction, 1..4. A null rank has no quartile. */
export function quartile(rank) {
  return rank === null ? null : Math.min(4, Math.floor(rank * 4) + 1);
}

/**
 * What a `plain` series carries where a percentile would be.
 *
 * Exported so the phone's words and this tool's cannot drift apart into two
 * explanations of one silence, and worded without a verdict in it: it says
 * what was not done and why, and nothing about the value.
 */
export const PLAIN_REASON =
  "not ranked: plotted for its shape — the direction of this series carries no claim";

/**
 * One `Reading`, plus the shape of the window the sentence has to describe.
 *
 * `win` is `{day, v}` oldest-first: the values go to `readRank` and the first
 * day is what makes "the last 22 readings" locatable in calendar time.
 *
 * The cut to `RANK_WINDOW_DAYS` is repeated here even though `readRank` does
 * it too, because `n` and the day the window opens are what the SENTENCE says
 * and they have to describe the window that was actually read. Slicing an
 * already-short list is a no-op; getting this wrong would print "the last 95
 * readings back to 2026-06-18" over a rank computed from 60.
 *
 * An injected `readRank` that throws, answers a shape this does not recognise,
 * or answers OFF THE [0,1] SCALE is replaced by `series.mjs`'s. The last of
 * those three is not paranoia — it is the bug in the header, caught rather
 * than printed.
 *
 * Exported because the `plot` subcommand states the same reading for a phone
 * that draws it: the rank, the slope, the window's length and the day it opens
 * are computed HERE, once, and shipped. A second reading written against the
 * points on the other side of a wire is a second definition of the one thing
 * `constants.mjs` and `fixture.json` exist to pin, and it would agree today.
 *
 * `def` is the `SERIES` entry, and a `plain` one is returned UNRANKED with a
 * reason — the same `{rank: null, reason}` shape a short history produces, so
 * every reader that already handles an absence handles this one too and
 * nothing downstream needs to know the word "plain". It is a parameter of
 * this function rather than a subtraction the plot does afterwards for the
 * reason the paragraph above gives: the reading is defined once, here.
 */
export function reading(readRank, full, prereg, def) {
  const win = full.slice(-prereg.RANK_WINDOW_DAYS);
  if (def?.plain) {
    // No rank, and therefore no slope: a percentile and an arrow are the two
    // things that say "compared with its own past", which is the comparison
    // this series has no meaning under.
    return { rank: null, slope: null, n: win.length, from: win.length ? win[0].day : null, reason: PLAIN_REASON };
  }
  const values = win.map((p) => p.v);
  let out = null;
  try {
    out = readRank(values, prereg);
  } catch {
    out = null;
  }
  const offScale = out && typeof out.rank === "number" && (out.rank < 0 || out.rank > 1);
  if (!out || typeof out !== "object" || !("rank" in out) || offScale) out = seriesReadRank(values, prereg);
  const rank = typeof out.rank === "number" && Number.isFinite(out.rank) ? out.rank : null;
  return {
    rank,
    slope: rank === null ? null : out.slope ?? null,
    n: win.length,
    from: win.length ? win[0].day : null,
    reason:
      rank === null
        ? out.reason || `not enough history (${win.length} of ${prereg.RANK_MIN_POINTS} readings)`
        : undefined,
  };
}

// ── what is tracked ────────────────────────────────────────────────────────

const sumValues = (rec) => {
  if (!rec || typeof rec !== "object") return null;
  let t = 0;
  for (const v of Object.values(rec)) if (typeof v === "number") t += v;
  return t;
};

/**
 * Escape hatches PER kLOC, never as a total.
 *
 * The total went 13 → 149 across this history while the repo went 2.8k → 143k
 * lines: it tracks LOC, so its rank sits permanently near the top of its own
 * window and its slope is permanently rising. A series like that can only ever
 * fire on a pause in the work, which is a fact about the calendar. Divided by
 * the size of the thing being escaped from, it is a rate that can actually
 * move in either direction.
 *
 * Absent rather than 0 when either half is missing — a rate with no
 * denominator is not a small rate.
 */
function hatchesPerKloc(row) {
  const total = sumValues(row?.hatches?.value);
  const loc = row?.classics?.value?.loc;
  if (typeof total !== "number" || typeof loc !== "number" || !(loc > 0)) return null;
  return total / (loc / 1000);
}

/**
 * The re-touch offenders, folded into the re-touch sentence rather than given
 * an event of their own.
 *
 * A file entering a top-3 at n=2 re-touches is a fact about where the cut
 * falls, not about the code, and it fired 11 times here saying nothing. The
 * offenders are the PAYLOAD of this reading — the answer to "which files" —
 * so they belong in the sentence that reports the rate, next to the
 * denominator the rate is never allowed to travel without.
 */
function retouchDetail(row, prereg) {
  const v = row?.retouch?.value;
  if (!v) return "";
  const top = (v.offenders || []).slice(0, prereg.RETOUCH_OFFENDERS);
  const who = top.length
    ? ` The ${nf(top.length)} most re-touched: ${top
        .map((o) => `${o.path} at ${plural(o.n, "re-touch", "re-touches")}`)
        .join(", ")}.`
    : "";
  return ` ${plural(v.retouches, "re-touch", "re-touches")} out of ${plural(v.touches, "touch", "touches")} over ${nf(
    prereg.RETOUCH_WINDOW_DAYS,
  )} days.${who}`;
}

/** A rate needs the two numbers it came from, here as well. */
function hatchDetail(row) {
  const total = sumValues(row?.hatches?.value);
  const loc = row?.classics?.value?.loc;
  if (typeof total !== "number" || typeof loc !== "number") return "";
  return ` ${plural(total, "occurrence")} over ${plural(loc, "line")}.`;
}

/** A count of modules needs the module count it is a part of. */
function untestedDetail(row) {
  const files = row?.classics?.value?.files;
  const n = row?.untested?.value?.length;
  return typeof files === "number" && typeof n === "number" ? ` ${nf(n)} of ${plural(files, "module")} in the tree.` : "";
}

/**
 * The scalar series a quartile move or a slope flip is worth a sentence about.
 *
 * `label` is a noun phrase that reads as the subject of "…is now": the
 * sentences are built around it and a label that needs an article bolted on
 * later produces the kind of prose nobody re-reads.
 *
 * `unit` is appended to the value and to its neighbour, both, so a sentence
 * never has a bare magnitude in it. `detail` is a SECOND sentence carrying the
 * numbers behind the value — a rate's denominator, a rate's payload — and it
 * comes after the reading rather than inside it, because a clause spliced
 * between a value and its neighbour separates the two numbers every sentence
 * in this tool is required to print together.
 *
 * `plain: true` marks a series that is DRAWN and never read against its own
 * past: no percentile, no slope, and no rank or slope event, ever. It is for a
 * number whose direction carries no claim — one that can rise for the same
 * reason it can fall — where a quartile crossing would fire forever and every
 * sentence it produced would read as a verdict about a value nothing in this
 * tool has an opinion on. The reading it gets instead is `{rank: null,
 * reason}`, which is this repo's shape for "I do not know", and the reason
 * says which of the two kinds of not-knowing it is.
 *
 * What is not here is as deliberate as what is: see `narrate.mjs`'s header for
 * `size.max`, `dups.pairsPerKloc` and the total escape-hatch count.
 *
 * Exported for the same reason `reading` is: `plot` ships these series to a
 * phone, and a list of "which series exist" maintained on the drawing end is a
 * second list that goes stale the first time one is added here.
 */
export const SERIES = Object.freeze([
  { key: "size.p95", label: "p95 file length", unit: "lines", get: (r) => r.size?.value?.p95 ?? null },
  {
    key: "retouch.rate",
    label: "the re-touch rate",
    unit: "",
    get: (r) => r.retouch?.value?.rate ?? null,
    detail: retouchDetail,
  },
  { key: "hatches.perKloc", label: "escape hatches per kLOC", unit: "", get: hatchesPerKloc, detail: hatchDetail },
  { key: "context.claudeMdChars", label: "CLAUDE.md", unit: "chars", get: (r) => r.context?.value?.claudeMdChars ?? null },
  {
    key: "context.descChars",
    label: "the always-on skill descriptions",
    unit: "chars",
    get: (r) => r.context?.value?.descChars ?? null,
    // A family that WAS read, holding a series with no value — and the metric
    // already knows why. `metrics/context.mjs` writes `skillsReason` beside
    // the two nulls precisely so "no `.claude/skills` at this commit" and
    // "every skill here is generated and this engine does not count those"
    // are told apart; without this line the document carried neither, and the
    // phone printed its own "no reading in the whole series" over both. See
    // `absentOf` in `plot.mjs`.
    absentOf: (r) => r.context?.value?.skillsReason ?? null,
  },
  {
    // Plotted, never placed. A skill count rising while CLAUDE.md falls is
    // reference being moved out of the always-on file on purpose; the same
    // rise in a repo that has already done that is a split going too far. One
    // number, two readings, and no way for a percentile to tell them apart —
    // so this series is drawn and left unranked rather than quietly graded in
    // whichever direction the window happens to lean. See `plain` above.
    key: "context.skillCount",
    label: "the count of skills",
    unit: "",
    get: (r) => r.context?.value?.skillCount ?? null,
    plain: true,
    absentOf: (r) => r.context?.value?.skillsReason ?? null,
  },
  {
    key: "untested.count",
    label: "the count of modules no test names",
    unit: "",
    get: (r) => r.untested?.value?.length ?? null,
    detail: untestedDetail,
  },
]);

/** The families whose reading can go absent, and what to call one when it does. */
export const FAMILIES = Object.freeze([
  ["size", "the file-size reading"],
  ["retouch", "the re-touch reading"],
  ["hatches", "the escape-hatch reading"],
  ["dups", "the duplicate-block reading"],
  ["cochange", "the co-change reading"],
  ["context", "the always-on context reading"],
  ["untested", "the untested-module reading"],
  ["classics", "the classics reading"],
]);
