/**
 * The series on disk, and the two ways a value in it is allowed to be read.
 *
 * ── Why the store is append-only JSONL ──────────────────────────────────────
 *
 * A row is a measurement of a commit, and a commit never changes. Rewriting
 * the file would make it possible — quietly, on any run — for yesterday's
 * numbers to come out different from what yesterday's narrative said about
 * them, which is the one failure that would make the whole series worthless:
 * a history you cannot trust is worse than no history, because it still
 * produces confident sentences. So rows are appended, never edited, and the
 * only thing that legitimately rewrites the past is a `PREREG_VERSION` bump,
 * which is loud by construction. `missingShas` is what makes a re-run a no-op
 * rather than a second copy of every row.
 *
 * ── The two ways an append-only file stops meaning one thing ────────────────
 *
 * Append-only protects the rows it already has. It does not protect what they
 * mean together, and there are exactly two ways a file of honest rows becomes
 * a dishonest series. `preregVersions` and `staleRows` are the readings that
 * make each of them visible; neither of them fixes anything, because the fix
 * is a decision — delete the file, or rewrite the branch back — and nothing in
 * this tool applies itself.
 *
 *   - **Mixed definitions.** Every row records the `PREREG_VERSION` it was
 *     measured under, and `missingShas` deliberately never recomputes a sha
 *     that already has a row. Both are right on their own and together they
 *     mean that the first `update` after a version bump appends today's rows
 *     under the new definition next to a year of rows under the old one, and
 *     the plot then draws one line through two different measurements.
 *     Nothing says so, because every individual row is correct.
 *   - **Shas that left the history.** A rebase, an amend or a dropped commit
 *     takes a sha off first-parent, and its row stays in the file forever —
 *     in `perDay`, in the narrative, in the fixture. It is a measurement of a
 *     commit that is no longer in this repo's history, which is not a reading
 *     of anything. So reads are filtered against the live commit list and the
 *     count of what was dropped is printed rather than swallowed.
 *
 * ── Why key order and sorting are enforced when writing ─────────────────────
 *
 * `fixture.json` is committed and re-derived by a test with `deepEqual`. An
 * object whose keys arrive in insertion order and a list nobody sorted will
 * both compare unequal on another machine, in another node version, or simply
 * after an unrelated edit reorders a `Object.entries` loop upstream — a test
 * that fails for no reason gets deleted, and with it the guarantee it was
 * there to give. So the writer imposes the `Row` key order from `types.mjs`
 * and sorts every nested object's keys.
 *
 * ── Why the rank window counts READINGS and not days ────────────────────────
 *
 * `RANK_WINDOW_DAYS` is 60 and the window is the last 60 entries of the
 * per-day series, which is 60 days only if this repo committed on 60
 * consecutive days. It did not: the 22 rows that existed when this was
 * measured span 95 calendar days and contain a 57-day hole (2026-06-25 to
 * 2026-08-16), so "the last 60 days" named a window reaching back to the
 * repo's first week. The phrasing was false and the arithmetic was fine.
 *
 * Of the two available repairs — cut the window by calendar day, or say
 * READINGS and mean it — this is the second, and the reason is that the first
 * one cannot be honest through this seam. A caller hands in the values of ONE
 * series with its absences already dropped (`events.mjs`'s `windowFor` filters
 * non-numbers), so the days are gone before the window is cut and no function
 * here can recover them. A calendar cut would have to be re-implemented by
 * every caller, which is the second definition this module exists to prevent.
 * `RANK_MIN_POINTS` was always counted in readings; now both halves are.
 *
 * The constant keeps its name, which is the one surface that still says
 * "days": `constants.mjs` is frozen, and renaming a pre-registered key is a
 * definition change that rewrites the history it names. Read it as "the
 * window, in readings".
 *
 * This function also cuts the window itself rather than trusting the caller
 * to have done it. Slicing an already-cut window is a no-op, so no existing
 * result moves; what it buys is that a caller who forgets cannot silently
 * rank today against the whole history — the single authority for "where does
 * today sit" is here, and that has to include how far back "recent" reaches.
 *
 * ── Why a reading is a rank and a sign, and never a grade ───────────────────
 *
 * This repo went from 2.8k to 143k lines in 95 days. Any absolute threshold
 * picked in July is nonsense in September, and any threshold picked today was
 * picked after seeing the plot it is supposed to judge. A value is therefore
 * only ever compared against its own recent past. Under `RANK_MIN_POINTS`
 * there is NO rank — `{rank: null, reason}`, never 0. A rank of 0 says "the
 * lowest this has ever been"; an absence says "I do not know". Reporting the
 * first when you mean the second is the exact failure this repo's rule about
 * heuristics degrading to null, never to a wrong number, exists to prevent.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The `Row` key order of `types.mjs`, which is the on-disk order. Changing
 * this changes every future line's bytes without changing any value, so it is
 * written out once here rather than derived from whatever built the row.
 */
export const ROW_KEYS = Object.freeze([
  "sha",
  "day",
  "ts",
  "batch",
  "prereg",
  "size",
  "retouch",
  "hatches",
  "dups",
  "deadExports",
  "cochange",
  "context",
  "untested",
  "classics",
  "tripwires",
  // Not a measurement: the chain state `tripwires.mjs` needs to tell a
  // TRANSITION from a STATE. It lives on the row because it used to live in a
  // module-level memo, and a memo is empty in a fresh process — so a daily
  // `update` computed "nothing crossed anything" and the append-only log
  // recorded that forever. Carried here, a row can be recomputed from its
  // predecessor alone, which is the property the fixture rests on.
  "tripwireState",
]);

/**
 * Stable JSON for one row: the fixed order at the top level, sorted keys
 * everywhere below it. Arrays are left exactly as the metric produced them —
 * an offender list is ranked, not alphabetical, and re-sorting it here would
 * destroy the ordering the metric chose while looking like tidiness.
 */
export function stringifyRow(row) {
  return JSON.stringify(row, function (key, value) {
    if (key === "") {
      const out = {};
      for (const k of ROW_KEYS) if (value[k] !== undefined) out[k] = value[k];
      // Anything a metric added that the typedef does not name still gets
      // written, after the known keys, rather than silently dropped.
      for (const k of Object.keys(value).sort()) if (!ROW_KEYS.includes(k)) out[k] = value[k];
      return out;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = value[k];
      return out;
    }
    return value;
  });
}

/** @returns {import("./types.mjs").Row[]} in file order, i.e. first-parent order. */
export function load(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

/** Append rows, creating the state dir if it is not there. It is gitignored. */
export function append(path, rows) {
  if (!rows.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((r) => stringifyRow(r) + "\n").join(""), "utf8");
}

/** The same stable shape, for `fixture.json`. */
export function stringifyFixture(fixture) {
  const rows = fixture.rows.map((r) => JSON.parse(stringifyRow(r)));
  return JSON.stringify({ prereg: fixture.prereg, lastSha: fixture.lastSha, rows }, null, 2) + "\n";
}

export function writeFixture(path, fixture) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyFixture(fixture), "utf8");
}

/**
 * The shas in `commits` that have no row yet, in first-parent order.
 *
 * This is what makes `update` idempotent: a second run with nothing new
 * appends nothing and says so, instead of duplicating the tail every time the
 * command is typed twice.
 */
export function missingShas(rows, commits) {
  const have = new Set(rows.map((r) => r.sha));
  return commits.filter((c) => !have.has(c.sha)).map((c) => c.sha);
}

/** The label a row with no `prereg` key gets, so it can be named in a message. */
const UNVERSIONED = "(unversioned)";

/**
 * Which `PREREG_VERSION`s the file on disk holds, commonest first.
 *
 * One entry is the healthy case. Two or more means the series mixes rows
 * measured under different definitions of the same metric — see the header —
 * and the caller's job is to say so and stop, not to choose between them.
 *
 * @param {import("./types.mjs").Row[]} rows
 * @returns {{version: string, rows: number}[]}
 */
export function preregVersions(rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = typeof r.prereg === "string" && r.prereg ? r.prereg : UNVERSIONED;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, n]) => ({ version, rows: n }))
    .sort((a, b) => b.rows - a.rows || (a.version < b.version ? -1 : 1));
}

/**
 * The rows whose commit is still on first-parent, and how many were not.
 *
 * `commits` is the live history. A row for a sha that is no longer in it
 * measured a commit this repo no longer has — a rebase, an amend, a dropped
 * branch — and reading it would put a point on the plot that nothing in the
 * tree corresponds to. It is dropped from the READ and left in the file: the
 * file is append-only, and a rewritten branch is the user's to explain, not
 * this tool's to tidy away.
 *
 * @param {import("./types.mjs").Row[]} rows
 * @param {{sha: string}[]} commits
 * @returns {{rows: import("./types.mjs").Row[], stale: number}}
 */
export function staleRows(rows, commits) {
  const live = new Set(commits.map((c) => c.sha));
  const kept = rows.filter((r) => live.has(r.sha));
  return { rows: kept, stale: rows.length - kept.length };
}

/**
 * One row per day: the LAST commit of that day, carrying every tripwire the
 * day fired.
 *
 * Reading per commit would let a day with eleven commits outvote a day with
 * one, which would turn the whole series into a plot of how often this repo
 * was committed to. `ts` decides "last" rather than file position, so a commit
 * authored in another offset cannot reorder a day.
 *
 * ── Why tripwires are unioned and every other field is not ─────────────────
 *
 * The eight measured fields are STATES: the p95 at the end of the day is the
 * p95 of the day, and a state read at any other moment is simply an older
 * reading of the same thing. Taking the last commit is right for all of them.
 *
 * A tripwire is not a state, it is an EVENT — a file crossed 2,000 lines, a
 * kind of escape hatch was used for the first time, an export went dead. It
 * happens AT a commit and is gone from the next one, so keeping only the last
 * commit of the day throws away everything that fired before it. Measured on
 * this history, that was not a rounding error: the commit series fires 137
 * tripwire events and the last-commit reduction kept 18 of them. The 119 it
 * dropped included `App.tsx` crossing 2,000 lines on 2026-08-16, which is the
 * single largest structural event in this repo and never reached the page.
 *
 * So events union across the day, first occurrence wins, deduplicated on
 * kind+subject because one file may cross a line in one commit and be
 * re-reported by the next. They stay in the order they fired.
 */
export function perDay(rows) {
  const byDay = new Map();
  const eventsByDay = new Map();
  for (const r of rows) {
    const prev = byDay.get(r.day);
    if (!prev || r.ts >= prev.ts) byDay.set(r.day, r);

    let seen = eventsByDay.get(r.day);
    if (!seen) eventsByDay.set(r.day, (seen = new Map()));
    for (const tw of r.tripwires ?? []) {
      const key = `${tw.kind}\u0000${tw.subject}`;
      if (!seen.has(key)) seen.set(key, tw);
    }
  }
  return [...byDay.values()]
    .map((r) => ({ ...r, tripwires: [...(eventsByDay.get(r.day)?.values() ?? [])] }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.ts - b.ts));
}

/** Rounded so a fixture compares equal on a machine that prints one more digit. */
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Where today's value sits in its own trailing window, and which way the
 * window is leaning.
 *
 * `values` is ONE series, oldest first, the last entry being today. Only the
 * trailing `RANK_WINDOW_DAYS` READINGS of it are read — see the header for why
 * that is a count of readings and not of calendar days, and for why the cut
 * happens here rather than in each caller.
 *
 * Rank is the mid-rank percentile — everything strictly below, plus half of
 * the ties including today itself, over the window size. The half-tie is what
 * stops a series that sat flat at one value for a fortnight from reporting
 * either "an all-time low" or "an all-time high" for the same unchanged
 * number, depending only on which side of the comparison the equals landed.
 *
 * @param {(number|null|undefined)[]} values
 * @param {typeof import("./constants.mjs").PREREG} prereg
 * @returns {import("./types.mjs").Reading}
 */
export function readRank(values, prereg) {
  const min = prereg.RANK_MIN_POINTS;
  // Cut before filtering, so an absent day still occupies its place in the
  // window — a fortnight of nulls must shorten the window, not slide it back
  // over older readings that are no longer recent.
  const window = values.slice(-prereg.RANK_WINDOW_DAYS);
  const ys = window.filter((v) => typeof v === "number" && Number.isFinite(v));
  const today = window.length ? window[window.length - 1] : undefined;

  if (ys.length < min) {
    return {
      rank: null,
      slope: null,
      reason: `not enough history (${ys.length} of ${min} readings)`,
    };
  }
  // The window can be long enough while the newest day itself has no value —
  // a metric that returned `{value: null, reason}` today. There is a trend but
  // nothing to place in it, and placing the last value that DID exist would
  // report a stale day as today.
  if (typeof today !== "number" || !Number.isFinite(today)) {
    return { rank: null, slope: null, reason: "no value for the latest day" };
  }

  let below = 0;
  let equal = 0;
  for (const v of ys) {
    if (v < today) below++;
    else if (v === today) equal++;
  }
  const rank = round4((below + equal / 2) / ys.length);

  // OLS against position in the window. Reported as a sign only: the magnitude
  // of a slope is in units nobody can read, and a number invites a threshold.
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const beta = den === 0 ? 0 : num / den;
  const fitted = beta * (n - 1); // the fitted change across the whole window

  const sorted = [...ys].sort((a, b) => a - b);
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const flatBand = Math.abs(median) * prereg.SLOPE_FLAT_FRAC;

  const slope = Math.abs(fitted) <= flatBand ? "flat" : fitted > 0 ? "rising" : "falling";
  return { rank, slope };
}
