/**
 * Reading what the repo-health engine printed — the only place either end does.
 *
 * `repohealth.ts` says what the series and the plot ARE: the constants both
 * ends name, the shapes they agree on, and the sentences for the states where
 * there is nothing to draw. This module is the other half of that file: it
 * turns one run's stdout, stderr and exit code into those shapes, and it is
 * split out because the two halves fail differently and are read by different
 * people. A reader asking "what does the phone show when there is no chart"
 * wants the words; a reader asking "why did this field arrive undefined" wants
 * this file, and putting both in one module put the second reader 480 lines
 * from the answer — and the file at the lint cap, where the next field could
 * not be added without this split anyway.
 *
 * ── Why the parsers are here and not in the host ────────────────────────────
 *
 * The host runs the tool and the phone reads what came back, so "what did that
 * line mean" is asked on both ends. Two readings of one line are two opinions
 * about whether the series is current, and the one that is wrong is invisible:
 * it prints a number. One module, imported by both, is what makes that
 * impossible — and a parser with no daemon, no repo and no clock in it is
 * exactly the thing `node --test` can pin (`test/repohealth.test.mjs`).
 *
 * ── A zero and an absence are opposite claims ───────────────────────────────
 *
 * Every reading here degrades to `null`. A `status` line that is garbage, or
 * truncated, or missing one field yields NO series — never a series with 0 rows
 * and an empty sha, which is the wire spelling of "this repo has been measured
 * and has nothing in it". The same holds field by field: a whole object is
 * accepted or none of it is, because a partial row would be drawn on a plot
 * beside real ones with nothing marking it as a guess.
 *
 * ── EVERY FIELD IS NAMED, AND THAT IS THE STANDING BUG HERE ────────────────
 *
 * These parsers rebuild their result from the fields they list, so a field
 * nobody listed is dropped in silence: the tool emits it, the host relays it,
 * the phone reads `undefined`, and nothing anywhere fails. That has now
 * happened three times on one wire — `longest`, then `rank`, then
 * `context.areasAbsent` and a per-area `reason` together. Naming a field in
 * `parseRepoHealthPlot` is therefore not the whole job:
 * `test/repohealth.test.mjs` runs the REAL engine's `plot` and asserts that
 * every key path it emits survives this parse, with an allow-list for the ones
 * deliberately dropped. Add a field to the tool ⇒ that test goes red until it
 * is named here.
 *
 * ── Exit 3 is a refusal, and its words are the product ──────────────────────
 *
 * The tool refuses to append when the file on disk holds rows measured under
 * two `PREREG_VERSION`s: appending would put two definitions of one metric on
 * one plot, and every row would still be individually correct. It says so on
 * stderr and names the one command that re-cuts the history — a command that
 * DELETES the series. That text is carried verbatim: a paraphrase of a
 * destructive remedy is worse than no remedy, and a truncated one is worse
 * still. `classifyExit` is where "the tool ran and said no" stops looking like
 * "the tool broke", which is the difference between a sentence a person acts on
 * and a red box they retry.
 *
 * Nothing here applies itself: it parses, classifies and hands back facts. The
 * refresh, the write and the refusal to overwrite are the host's.
 */

import {
  REPOHEALTH_ENGINE,
  type RepoHealthArea,
  type RepoHealthLongest,
  type RepoHealthMeasure,
  type RepoHealthOutcome,
  type RepoHealthPack,
  type RepoHealthPlot,
  type RepoHealthPlotClassics,
  type RepoHealthPlotContext,
  type RepoHealthPlotSeries,
  type RepoHealthPoint,
  type RepoHealthReading,
  type RepoHealthSeries,
} from "./repohealth.js";

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
const isTs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The JSON line a `status` read prints, as a series — or null.
 *
 * The LAST line that parses as an object is the reading: `status` prints its
 * JSON last, and a stderr warning or a stray log line before it must not be
 * mistaken for the answer. Then it is validated WHOLE. A missing field fails
 * the object, not just itself, because the alternative is a series that reports
 * `0 days` for a field nobody sent.
 *
 * An empty series has no last commit to name and therefore reads as absent,
 * which is exactly what `RepoHealthView.series: null` says: nothing measured
 * yet. That is a state with a next action ("refresh"), not a measurement.
 */
/**
 * Git's seconds to the wire's milliseconds.
 *
 * Kept as a named function rather than an inline `* 1000` so the one place
 * this conversion happens is greppable: the tool reports `%ct`/`%ci`, every
 * other instant on this wire is `Date.now()`, and mixing them silently
 * produces a plausible-looking age that is 56 years wrong.
 */
export function secondsToMs(sec: number): number {
  return Math.round(sec * 1000);
}

/**
 * The LAST line that parses as an object — the tool prints its JSON last, and
 * a warning or a log line before it must not be mistaken for the answer. One
 * implementation, because `status` and `plot` are read off the same kind of
 * stdout and two scanners would drift on the first tool that logs.
 */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  if (typeof stdout !== "string") return null;
  let raw: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch {
      /* not the line, keep looking */
    }
  }
  return raw;
}

export function parseRepoHealthStatus(stdout: string): RepoHealthSeries | null {
  const o = lastJsonObject(stdout);
  if (!o) return null;

  if (!isStr(o.preregVersion) || !isStr(o.lastSha) || !isStr(o.lastDay)) return null;
  if (!isCount(o.rows) || !isCount(o.days) || !isCount(o.staleRows)) return null;
  if (!isTs(o.lastTs)) return null;
  if (!Array.isArray(o.versions)) return null;

  const versions: { version: string; rows: number }[] = [];
  for (const v of o.versions) {
    const e = v as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || !isStr(e.version) || !isCount(e.rows)) return null;
    versions.push({ version: e.version, rows: e.rows });
  }

  return {
    preregVersion: o.preregVersion,
    rows: o.rows,
    days: o.days,
    lastSha: o.lastSha,
    lastDay: o.lastDay,
    lastTs: secondsToMs(o.lastTs),
    versions,
    staleRows: o.staleRows,
  };
}

/**
 * The same `status` line, read for what it says about the ENGINE — and read
 * LENIENTLY, which is the opposite of every other parser in this file.
 *
 * `parseRepoHealthStatus` is whole-or-nothing because a partial SERIES is a
 * measurement with a hole in it, drawn beside real ones. These five are not a
 * measurement of the repo's history: they are the engine describing itself and
 * the tree it was pointed at, they arrived one release after the rest, and a
 * repo carrying its own older copy of the tool prints none of them. Refusing
 * the object over a missing `recut` would take the pack list away from every
 * repo whose engine is a version behind, for no gain — so each field stands or
 * falls on its own and a bad one is DROPPED, never repaired.
 *
 * `null` means the engine said nothing about itself at all — no line, or not
 * one of these five survived. That is a different fact from an engine that
 * activated no packs, and the caller must be able to tell them apart.
 *
 * Field by field on purpose, and never by copying what is left of the object:
 * `parseRepoHealthPlot` rebuilds its result from the fields it names, so a
 * field nobody named is dropped in silence — the tool emitted it, the host
 * relayed it, the phone got `undefined`, and no test anywhere failed. Anything
 * added here is added in this function AND in `repohealth.test.mjs`, through
 * the real parse.
 */
export function parseRepoHealthMeasure(stdout: string): RepoHealthMeasure | null {
  const o = lastJsonObject(stdout);
  if (!o) return null;

  const commits = isCount(o.commits) ? o.commits : null;
  const engineVersion = isStr(o.engineVersion) ? o.engineVersion : null;
  const recut = isStr(o.recut) ? o.recut : null;

  // A pack the census could not describe is dropped from the list rather than
  // voiding it: one unreadable entry must not hide the four that read fine.
  // `files` degrades on its own — a pack with no count still names a language.
  let packs: RepoHealthPack[] | null = null;
  if (Array.isArray(o.packs)) {
    packs = [];
    for (const raw of o.packs) {
      const p = raw as Record<string, unknown> | null;
      if (!p || typeof p !== "object" || !isStr(p.name)) continue;
      packs.push({
        name: p.name,
        version: isStr(p.version) ? p.version : "",
        files: isCount(p.files) ? p.files : null,
      });
    }
  }

  // Groups are path prefixes and `"."` is one of them, so the test is "a
  // string", not "a non-empty path". An entry that is not a string is dropped.
  let groups: string[] | null = null;
  if (Array.isArray(o.groups)) groups = o.groups.filter((g): g is string => typeof g === "string");

  if (commits === null && engineVersion === null && recut === null && packs === null && groups === null
      && o.scope === undefined) {
    return null;
  }
  // Absent and null are DIFFERENT here — see `RepoHealthMeasure.scope`. An
  // engine with no scopes sends no key and this stays undefined; a current one
  // always echoes, `null` for the whole repo.
  const scope = o.scope === undefined ? undefined : isStr(o.scope) ? o.scope : null;
  return { commits, packs, groups, engineVersion, recut, ...(scope === undefined ? {} : { scope }) };
}

/**
 * The one command that re-cuts this root, or null when nobody stated one.
 *
 * A getter rather than a field read, because the alternative every caller
 * reaches for is composing the string themselves out of a series path and a
 * tool path — which is right in the engine's own repo and wrong in every other
 * tree it measures, and which ends in `rm`. If the engine did not say it, the
 * answer is that nobody knows it, not a guess at it.
 */
export function recutCommandOf(measure: RepoHealthMeasure | null | undefined): string | null {
  return measure && isStr(measure.recut) ? measure.recut : null;
}

/**
 * The JSON line `plot` prints, as a plot — or null, WHOLE.
 *
 * Same rule as `parseRepoHealthStatus` and for a louder reason: a partial plot
 * drawn beside real tiles is a wrong number wearing a chart. A rank outside
 * [0,1] (the two-scale bug, arriving from a host that has it), a slope that is
 * not one of the three signs, a point with no day, a missing `windowReadings`
 * — any one of them voids the whole object, because the alternative is a
 * client that draws five honest series and one invented one with nothing on
 * screen marking which.
 *
 * Nothing is repaired and nothing is defaulted. `windowReadings` cannot be
 * filled in with 60 here: that constant lives in one place, the tool ships it,
 * and a client-side copy is exactly the second definition this whole design
 * refuses.
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const SLOPES = ["rising", "falling", "flat"];

function readPoints(v: unknown): RepoHealthPoint[] | null {
  if (!Array.isArray(v)) return null;
  const out: RepoHealthPoint[] = [];
  for (const raw of v) {
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return null;
    // A point with no day cannot be placed on an axis, and a point whose value
    // is neither a number nor an explicit null is not a reading.
    if (!isStr(p.day) || !isStr(p.sha7) || !isNumOrNull(p.v)) return null;
    out.push({ day: p.day, sha7: p.sha7, v: p.v });
  }
  return out;
}

function readReading(v: unknown): RepoHealthReading | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (!isCount(r.n)) return null;
  if (r.from !== null && !isStr(r.from)) return null;
  const hasRank = r.rank !== null;
  if (hasRank && (!isNum(r.rank) || r.rank < 0 || r.rank > 1)) return null;
  if (r.slope !== null && !(typeof r.slope === "string" && SLOPES.includes(r.slope))) return null;
  if (r.reason !== undefined && !isStr(r.reason)) return null;
  const out: RepoHealthReading = {
    rank: hasRank ? (r.rank as number) : null,
    slope: (r.slope ?? null) as RepoHealthReading["slope"],
    n: r.n,
    from: (r.from ?? null) as string | null,
  };
  if (isStr(r.reason)) out.reason = r.reason;
  return out;
}

function readArea(v: unknown): RepoHealthArea | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const keys = ["expected", "ceiling", "p90", "commits", "subs"] as const;
  const out = {} as RepoHealthArea;
  for (const k of keys) {
    if (!isNumOrNull(a[k])) return null;
    out[k] = a[k] as number | null;
  }
  // The WORDS beside the numbers, and the reason this reader was wrong for two
  // releases: five numeric keys were named and the sixth field was not, so an
  // area that can never be attributed a commit reached the phone looking
  // exactly like an area nobody has touched yet — and the phone said the
  // second sentence about the first case. Optional, because an area with its
  // readings carries none.
  if (a.reason !== undefined && !isStr(a.reason)) return null;
  if (isStr(a.reason)) out.reason = a.reason;
  return out;
}

export function parseRepoHealthPlot(stdout: string): RepoHealthPlot | null {
  const o = lastJsonObject(stdout);
  if (!o) return null;
  if (!isStr(o.preregVersion)) return null;
  if (!isCount(o.windowReadings) || !isCount(o.minReadings) || !isCount(o.days)) return null;
  if (!Array.isArray(o.series)) return null;

  const series: RepoHealthPlotSeries[] = [];
  for (const raw of o.series) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== "object") return null;
    if (!isStr(s.key) || !isStr(s.label) || typeof s.unit !== "string" || typeof s.detail !== "string") return null;
    if (!isNumOrNull(s.last)) return null;
    if (s.absent !== undefined && !isStr(s.absent)) return null;
    const points = readPoints(s.points);
    const reading = readReading(s.reading);
    if (!points || !reading) return null;
    const one: RepoHealthPlotSeries = {
      key: s.key,
      label: s.label,
      unit: s.unit,
      points,
      last: s.last,
      reading,
      detail: s.detail,
    };
    if (isStr(s.absent)) one.absent = s.absent;
    series.push(one);
  }

  const ctx = o.context as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== "object" || !ctx.areas || typeof ctx.areas !== "object") return null;
  if (ctx.absent !== undefined && !isStr(ctx.absent)) return null;
  if (ctx.areasAbsent !== undefined && !isStr(ctx.areasAbsent)) return null;
  const areas: Record<string, RepoHealthArea> = {};
  for (const [name, v] of Object.entries(ctx.areas as Record<string, unknown>)) {
    const area = readArea(v);
    if (!area) return null;
    areas[name] = area;
  }
  const context: RepoHealthPlotContext = { areas };
  if (isStr(ctx.absent)) context.absent = ctx.absent;
  // NAMED, for the same reason `rank` is: this reader rebuilds `context` out
  // of `areas` and `absent` and dropped everything else. Every repo on this
  // desktop without the router convention therefore arrived as `areas: {}`
  // with no sentence anywhere saying why, and the phone drew nothing at all.
  if (isStr(ctx.areasAbsent)) context.areasAbsent = ctx.areasAbsent;

  const cl = o.classics as Record<string, unknown> | null;
  if (!cl || typeof cl !== "object") return null;
  if (cl.absent !== undefined && !isStr(cl.absent)) return null;
  const loc = readPoints(cl.loc);
  const files = readPoints(cl.files);
  const deps = readPoints(cl.deps);
  if (!loc || !files || !deps || !Array.isArray(cl.packages)) return null;
  const packages: { pkg: string; rank?: number; points: RepoHealthPoint[] }[] = [];
  for (const raw of cl.packages) {
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || !isStr(p.pkg)) return null;
    const points = readPoints(p.points);
    if (!points) return null;
    // NAMED, like every field here: this reader rebuilds from the fields it
    // lists, so one it does not name is dropped with no error anywhere —
    // which is what `rank` did between the tool emitting it and this line.
    packages.push(isCount(p.rank) ? { pkg: p.pkg, rank: p.rank, points } : { pkg: p.pkg, points });
  }
  // OPTIONAL, and parsed the way `longest` is: an engine older than the field
  // sends no key, and a strict reader that voided the whole plot over one
  // section would blank every chart on a desktop running a version behind. A
  // key that IS there and malformed is dropped, never half-read.
  let types: RepoHealthPlotClassics["types"];
  if (Array.isArray(cl.types)) {
    const out: NonNullable<RepoHealthPlotClassics["types"]> = [];
    let ok = true;
    for (const raw of cl.types) {
      const t = raw as Record<string, unknown> | null;
      const points = t && typeof t === "object" ? readPoints(t.points) : null;
      if (!t || !isStr(t.ext) || !points || !isCount(t.rank)) { ok = false; break; }
      out.push({
        ext: t.ext,
        pack: isStr(t.pack) ? t.pack : null,
        rank: t.rank,
        files: isCount(t.files) ? t.files : null,
        points,
      });
    }
    if (ok) types = out;
  }
  let tape: number[] | null = null;
  if (cl.tape !== null && cl.tape !== undefined) {
    if (!Array.isArray(cl.tape)) return null;
    for (const v of cl.tape) if (!isNum(v)) return null;
    tape = cl.tape as number[];
  }
  const classics: RepoHealthPlotClassics = { loc, files, deps, packages, tape };
  if (types) classics.types = types;
  // OPTIONAL, and only kept when it lines up with the tape bar for bar: a
  // list of a different length would name the wrong file under the finger.
  if (tape && Array.isArray(cl.tapePaths) && cl.tapePaths.length === tape.length
    && cl.tapePaths.every((p) => p === null || isStr(p))) {
    classics.tapePaths = cl.tapePaths as (string | null)[];
  }
  if (isStr(cl.absent)) classics.absent = cl.absent;

  // `longest` is OPTIONAL and therefore parsed separately from the rest: an
  // older tool in a worktree sends no such key, and a strict reader that
  // refused the whole plot over it would blank every chart on a desktop
  // running one version behind. A key that IS there and is malformed is
  // dropped rather than accepted — the same rule the readers above follow,
  // one field down.
  let longest: RepoHealthLongest | undefined;
  const lg = o.longest as Record<string, unknown> | null | undefined;
  if (lg && typeof lg === "object") {
    const points = readPoints(lg.points);
    if (points) {
      longest = {
        points,
        path: isStr(lg.path) ? lg.path : null,
        day: isStr(lg.day) ? lg.day : null,
      };
      // Index for index or not at all: a list one short names every reading
      // after the gap with its neighbour's file.
      if (Array.isArray(lg.paths) && lg.paths.length === points.length) {
        longest.paths = lg.paths.map((x) => (isStr(x) ? x : null));
      }
    }
  }

  const plot: RepoHealthPlot = {
    // NAMED, like every other field here — this reader rebuilds from the
    // fields it lists. An engine with no scopes sends no key at all and this
    // stays absent; a repo-wide plot from a current engine sends `null`, and
    // that null is CARRIED rather than dropped, because "this engine cannot
    // scope" and "this is the whole repo" are the two answers a client has to
    // tell apart before it offers a subtree.
    ...(o.scope === undefined ? {} : { scope: isStr(o.scope) ? o.scope : null }),
    preregVersion: o.preregVersion,
    windowReadings: o.windowReadings,
    minReadings: o.minReadings,
    days: o.days,
    series,
    context,
    classics,
  };
  if (longest) plot.longest = longest;
  return plot;
}

/**
 * One stderr line of a cold backfill, as something to show — or null.
 *
 * The tool writes `  …25/158 commits` every 25 commits and nothing at all in
 * between, so this is the only sign of life a backfill has. A WARM run prints
 * none of these, and that silence is the normal case: absence of progress here
 * is never "stuck", and nothing may draw it as one.
 *
 * Both ellipsis spellings are accepted. The `…` is what the tool writes; the
 * three-dot form is what a pipe through a terminal that is not on a UTF-8
 * locale can leave behind, and a progress line that arrives mangled should
 * still count as progress.
 */
const PROGRESS_RE = /^\s*(?:…|\.\.\.)\s*(\d+)\s*\/\s*(\d+)\s+commits\s*$/;

export function parseRepoHealthProgress(line: string): string | null {
  if (typeof line !== "string") return null;
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  return `${m[1]}/${m[2]} commits`;
}

/**
 * How many rows `update` appended, off its own summary line.
 *
 * `repohealth: +3 rows (…)` is three; `repohealth: nothing new — …` is zero,
 * and that zero is a measurement: the series is already current. Anything else
 * — a summary reworded, a run that died before printing one — is `null`, and
 * the difference between those two is the whole reason this returns a nullable
 * number instead of defaulting to 0.
 */
export function parseUpdateSummary(stdout: string): { added: number | null } {
  if (typeof stdout !== "string") return { added: null };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    const m = /^repohealth:\s*\+(\d+)\s+rows?\b/.exec(t);
    if (m) return { added: Number(m[1]) };
    if (/^repohealth:\s*nothing new\b/.test(t)) return { added: 0 };
  }
  return { added: null };
}

const firstLine = (s: string): string => {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
};

/**
 * What an exit code MEANS, which is not the same question as whether it is 0.
 *
 *  - **0** — neither a refusal nor an error. Say nothing.
 *  - **3** — a REFUSAL: the tool ran, read the series, and declined to append
 *    because it holds two `PREREG_VERSION`s. Its stderr is carried VERBATIM. It
 *    is not a stack trace, it is the argument plus the one command that re-cuts
 *    the history, and that command deletes `.waterplane/repohealth.jsonl`. Never
 *    paraphrase it, never trim it to fit a row: a remedy the reader retypes
 *    from a summary is a remedy typed wrong.
 *  - **2** — the judge's *declined*, and **it must never reach here**. The
 *    judge is the one command in that tool permitted to spend tokens, it runs
 *    only when a person names an event and confirms, and nothing this feature
 *    offers goes near it. A 2 arriving on this path therefore means the caller
 *    ran a subcommand the tool does not have (its other exit-2 case) — a bug in
 *    the caller, reported as an error that says so. It is never an `ok`, and
 *    never a refusal: a refusal prints a remedy, and there is nothing here for
 *    the reader to fix.
 *  - **1, anything else, or null** — an error, as ONE sentence. The first line
 *    of stderr is quoted and the rest is dropped, because unlike the refusal
 *    this text is a failure to explain, not an instruction to follow.
 */
export function classifyExit(
  code: number | null,
  stderr: string,
): Pick<RepoHealthOutcome, "refused" | "error"> {
  const err = typeof stderr === "string" ? stderr : "";
  if (code === 0) return { refused: null, error: null };
  if (code === 3) return { refused: { code: 3, text: err }, error: null };
  if (code === null) {
    const tail = firstLine(err);
    return {
      refused: null,
      error: `${REPOHEALTH_ENGINE} never exited — killed or never started${tail ? `: ${tail}` : ""}.`,
    };
  }
  if (code === 2) {
    return {
      refused: null,
      error: `${REPOHEALTH_ENGINE} exited 2, which only a subcommand it does not have can produce here — nothing on this path runs the judge.`,
    };
  }
  const tail = firstLine(err);
  return {
    refused: null,
    error: `${REPOHEALTH_ENGINE} exited ${code}${tail ? `: ${tail}` : " with nothing on stderr"}.`,
  };
}
