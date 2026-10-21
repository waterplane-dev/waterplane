/**
 * The half of this tool a person actually reads.
 *
 * ── Why this is not a dashboard ────────────────────────────────────────────
 *
 * The reader is the sole author of this repo. They know every file in it
 * intimately, they read this on a phone, and they already know that `App.tsx`
 * is long. A dashboard tells them that again every day; a scoreboard tells
 * them a number they would have to re-derive an opinion from. Neither is worth
 * a screen. What is worth a screen is the one thing they cannot get by
 * knowing the code — what MOVED since the last time they looked — which is a
 * colleague who reads `git log` so they do not have to.
 *
 * So the whole module is built out of four rules, and every one of them is a
 * repo rule or a decision that was argued out before a line was written:
 *
 *  1. **Silence is a reading.** No unseen event ⇒ the file is not written, not
 *     appended to, not even touched. A tool that says "no change" every day
 *     trains the reader to stop opening it, and then the day it says something
 *     is the day it is skipped. An mtime is a notification here — the phone's
 *     gallery sorts on it — so a no-op that "only" restats the file is a false
 *     alarm, which is why `narrate()` short-circuits before `mkdirSync`.
 *
 *  2. **Nothing is said twice.** `<state dir>/repohealth-reported.json` is the
 *     memory, keyed on an event id of `kind:subject:DAY`. The day, never the
 *     sha: `perDay` picks the LAST commit of a day, so an evening commit
 *     re-keys every event the morning already reported and the reader sees the
 *     whole day again. That is the most common cadence there is in this repo,
 *     and it was the single largest source of repetition in this file.
 *
 *  3. **Every number is printed beside the number it is read against.** "1,412"
 *     is unreadable; "p95 1,412 lines, was 1,396 on 2026-09-20 — 92nd
 *     percentile of the last 22 readings" is a sentence.
 *
 *  4. **No threshold, no verdict.** A reading is a value, its comparator, its
 *     percentile rank and a slope sign, and every GATE in this file is
 *     definitional — a transition happened or it did not. There is no cutoff
 *     here and no word in the output that ranks the repo on a scale.
 *
 * And the repo's own: **nothing applies itself.** Everything here returns
 * sentences. It never edits a source file, never refuses a run, and never
 * exits non-zero on a reading it dislikes.
 *
 * ── What a series is, and how one is read, are not here ────────────────────
 *
 * `readings.mjs` holds `SERIES` (which series exist), `reading` (a value
 * against its own past), the detail sentences a rate may not travel without,
 * and the number formatting. That is the vocabulary `plot.mjs` needs as much
 * as this file does, and a second copy of either question's answer is a
 * definition `constants.mjs` does not version — which it once was, on two
 * incompatible scales, for the life of the tool. Its header argues that out.
 *
 * What stays here is what it costs to say a thing: which transitions are worth
 * a sentence and how the sentence is built (`events.mjs`), and the ledger that
 * stops it being said twice (this file).
 *
 * ── Every sentence says "readings", not days ───────────────────────────────
 *
 * `RANK_WINDOW_DAYS` is a count of day-ROWS, and this repo has a 57-day hole
 * in it: the "last 22 days" of this series spans 95 calendar days.
 * `series.mjs` argues out why the repair is the wording rather than a calendar
 * cut. This side keeps its half of that bargain: every sentence says
 * "readings" and names the day the window starts, which puts the gap in front
 * of the reader at the point of the claim.
 *
 * ── What is deliberately NOT narrated, and why ─────────────────────────────
 *
 *  • **`cochange`.** It is in every row and it has no sentence here. Two
 *    reasons, both definitional. Hotspot MEMBERSHIP is a fact about where a
 *    top-`HOTSPOT_N` cut falls, not about the code — the same objection that
 *    deleted the re-touch `offenders` event. And the hotspot MEDIANS moved on
 *    16 of the 22 day-rows when this was measured, almost always by one file,
 *    so "median 3, was 2" would be a line most mornings naming no transition;
 *    and calling some of those moves big enough to print would be inventing
 *    the cutoff this tool refuses. The row keeps the reading as evidence a person
 *    can open; it is the payload of nothing. Its absence and its return are
 *    still reported, because those ARE transitions.
 *
 *  • **`size.max` as a ranked series.** The `maxfile` event already says when
 *    the crown changes hands, with both files and both lengths in it. Ranking
 *    the number as well would report the same fact twice in different units.
 *
 *  • **`dups.pairsPerKloc`.** With a numerator of 0 to 2 the quantity is
 *    `1/LOC`, so its slope reads "falling" whenever the repo grows and says
 *    nothing whatever about duplication. It produced the one slope line this
 *    file ever printed, and that line was an artifact. Named pair events
 *    replace it: a pair appearing or disappearing has a subject, two blocks to
 *    go and look at, and needs no threshold.
 *
 *  • **A module LEAVING the untested list.** Indistinguishable, from a row
 *    alone, from a module being deleted. "Gained a first mention in a test"
 *    was therefore a claim the data does not support, and the honest half of
 *    that event is the other one.
 *
 *  • **`dead-export` tripwires.** The measurement moved out of `tripwires` and
 *    into a per-row `deadExports` list, narrated in `events.mjs` as `orphan`. Rows
 *    measured under an older `PREREG_VERSION` still carry the old tripwire,
 *    and re-narrating it would print the same names under two kinds.
 *
 * ── Costs nothing ──────────────────────────────────────────────────────────
 *
 * No model, no network, no subprocess. Arithmetic and string building.
 * The one place in this tool allowed to spend a token is `judge.mjs`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { nf } from "./readings.mjs";
import { events } from "./events.mjs";
import { stateFile } from "./statefile.mjs";

/** The detection half lives in `events.mjs`; re-exported so callers keep one entry point. */
export { events };

/**
 * Named by its FULL path everywhere it is mentioned — in the file's own header
 * line, in every string this module returns for a console, and in prose. A
 * CLAUDE.md rule: a bare filename does not resolve for the reader on the phone,
 * because what turns a path into the thing itself is the path.
 */
export const OUTBOX_MD = ".claude/outbox/repohealth.md";

/** The memory that stops an unchanged hotspot being news twice, under the
 *  repo's state dir (`statefile.mjs` says which). Gitignored. */
export const LEDGER_NAME = "repohealth-reported.json";
/** Where `root`'s ledger is read and written. */
export const ledgerFile = (root) => stateFile(root, LEDGER_NAME);

/**
 * Written once, when the file is created. Everything after it is merged in by
 * day (`mergeNarrative`), oldest first, so the reader scrolls to the bottom for
 * today and the top still says what the document is and — the rule — what its
 * own path is.
 */
export const HEADER = [
  `# Repo health — ${OUTBOX_MD}`,
  "",
  "A colleague who reads `git log` so you do not have to. One section per day,",
  "oldest first; a line is added under its day and never rewritten. A day on",
  "which nothing moved leaves no line here at all — the silence is the reading.",
  "",
  "Every entry is a value, the value it is read against, its percentile rank",
  "within its own trailing window, and a slope sign. A rank is a position among",
  "the READINGS in that window — day-rows, not calendar days, and a repo is not",
  "worked on every day — so each rank names the day its window starts, because",
  "a window of N readings and a window of N days are not the same span.",
  "There is no threshold in here and nothing in here applies itself.",
  "",
].join("\n");

// ── rendering ──────────────────────────────────────────────────────────────

/**
 * Events to markdown. Pure, and `[]` renders to the empty string rather than
 * to an empty section — the writer decides whether anything is written, and it
 * decides on this being falsy.
 *
 * @param {import("./types.mjs").Event[]} evs
 * @returns {string}
 */
export function render(evs) {
  if (!Array.isArray(evs) || !evs.length) return "";
  const byDay = new Map();
  for (const e of evs) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const lines = [];
  for (const day of [...byDay.keys()].sort()) {
    lines.push(`## ${day}`, "");
    for (const e of byDay.get(day)) lines.push(`- ${e.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── the merge ──────────────────────────────────────────────────────────────

const DAY_HEAD = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/;

/**
 * Cut a narrative into its preamble and its `## YYYY-MM-DD` sections — the same
 * cut `packages/web/src/narrativeDays.ts` makes (`\n(?=## )`), so the tool and
 * the phone agree on where a day starts. A `## ` heading that is NOT a date is
 * somebody's hand edit: it stays glued to the chunk before it and travels with
 * that day, rather than being sorted as a day it is not.
 */
function cutDays(text) {
  const chunks = String(text ?? "").split(/\n(?=## )/);
  let preamble = "";
  const days = [];
  chunks.forEach((chunk, i) => {
    const m = DAY_HEAD.exec(chunk.split("\n", 1)[0]);
    if (m) {
      days.push({ day: m[1], chunk });
      return;
    }
    if (i === 0 || !days.length) preamble = preamble ? `${preamble}\n${chunk}` : chunk;
    else days[days.length - 1].chunk += `\n${chunk}`;
  });
  return { preamble, days };
}

/** A day's lines under its heading, blank edges trimmed; `""` for none. */
const dayContent = (chunk) => chunk.slice(chunk.indexOf("\n") + 1 || chunk.length).replace(/^\s*\n/, "").trimEnd();

/**
 * Merge freshly rendered sections into an existing narrative: ONE section per
 * day, in ascending date order.
 *
 * This used to be an append, and an append is only a sort while every run
 * reports days later than the file's last one. Two ordinary things break that:
 * an evening commit re-reads a day the morning already narrated (a new event
 * id on the same `DAY` — the ledger rightly lets it through), and a reading of
 * an OLDER day turns up late (a backfilled row, a series re-cut). Each landed
 * as a second `## <day>` at the bottom — out of order, and twice — and the
 * phone draws the file in its own order.
 *
 * So: a new line for a day that has a section goes at the END of that
 * section, below everything already said about it; a day with no section is
 * inserted where its date puts it. Existing lines are never reworded,
 * reordered within their day or dropped — sections already written twice are
 * folded into one, earlier copy first. The preamble and any non-date `## `
 * heading a person added are carried through untouched. Pure: text in, text
 * out, and `mergeNarrative(text, "")` is the repair for a file written by the
 * old appender.
 *
 * @param {string} existing  the file as it stands ("" when there is none)
 * @param {string} body      `render(unseen)` — may be ""
 * @returns {string}
 */
export function mergeNarrative(existing, body) {
  const old = cutDays(existing);
  const add = cutDays(body);
  const byDay = new Map();
  for (const { day, chunk } of [...old.days, ...add.days]) {
    const had = byDay.get(day);
    if (!had) {
      byDay.set(day, chunk.trimEnd());
      continue;
    }
    const more = dayContent(chunk);
    if (more) byDay.set(day, `${had}\n${more}`);
  }
  const days = [...byDay.keys()].sort().map((d) => `${byDay.get(d)}\n`);
  // The preamble's blank line before the first day is the one the old writer
  // put there (`${HEADER}\n${body}`); a preamble with none gets none added.
  const pre = old.preamble || add.preamble;
  return (pre ? [pre, ...days] : days).join("\n");
}

// ── the writer ─────────────────────────────────────────────────────────────

function readLedger(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(raw?.ids) ? raw.ids : []);
  } catch {
    // A missing or unparseable ledger means "nothing reported yet". It never
    // means "report nothing": losing the memory must cost a repeat, not a
    // silence, because a silence is indistinguishable from a quiet week.
    return new Set();
  }
}

/**
 * The ledger carries `PREREG_VERSION` for diagnosis only — it is NOT read back
 * as a cache key. A constant change rewrites what every past day meant, so the
 * honest response to a bumped version is a person regenerating the fixture and
 * deciding what to re-report, not this file silently replaying six weeks of
 * events under new arithmetic.
 */
function writeLedger(path, ids, preregVersion, now) {
  mkdirSync(dirname(path), { recursive: true });
  const body = { prereg: preregVersion ?? null, updated: now, ids: [...ids].sort() };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * The thin IO layer: ledger in, unseen events out, merge by day, remember.
 *
 * The early return is load-bearing and is the reason nothing above it touches
 * the filesystem. `mkdirSync` on an existing directory is harmless, but
 * rewriting the file with no new line in it is not: it moves the mtime, and the
 * phone's gallery reads the mtime as "there is something new here". A day on
 * which nothing moved must leave no trace at all, including that one.
 *
 * Every returned line names `.claude/outbox/repohealth.md` in full. The caller
 * prints them; printing here as well would double every line in the CLI.
 *
 * @param {{root?: string, prevDays?: object[], nextDays?: object[], prereg: object,
 *          preregVersion?: string, readRank?: Function, now?: string,
 *          log?: (line: string) => void}} opts
 */
export function narrate(opts) {
  const {
    root = process.cwd(),
    prevDays = [],
    nextDays = [],
    prereg,
    preregVersion,
    readRank,
    now = new Date().toISOString(),
    log,
  } = opts || {};

  const all = events(prevDays, nextDays, prereg, { readRank });
  const mdPath = join(root, OUTBOX_MD);
  const ledgerPath = ledgerFile(root);
  const seen = readLedger(ledgerPath);
  const unseen = all.filter((e) => !seen.has(e.id));
  const lines = [];

  if (!unseen.length) {
    lines.push(`nothing moved — ${OUTBOX_MD} left untouched (${nf(all.length)} event(s) already reported)`);
    if (log) for (const l of lines) log(l);
    return { events: all, unseen: [], written: false, path: mdPath, lines };
  }

  const body = render(unseen);
  mkdirSync(dirname(mdPath), { recursive: true });
  const fresh = !existsSync(mdPath);
  // Merged, not appended: a line for a day already in the file joins that
  // day's section, and an older day lands where its date puts it. Written to
  // a sibling and renamed, so a phone reading mid-write sees the old file or
  // the new one, never half of either.
  const text = fresh ? `${HEADER}\n${body}` : mergeNarrative(readFileSync(mdPath, "utf8"), body);
  const tmp = `${mdPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, mdPath);

  for (const e of unseen) seen.add(e.id);
  writeLedger(ledgerPath, seen, preregVersion, now);

  const days = new Set(unseen.map((e) => e.day)).size;
  lines.push(
    `${nf(unseen.length)} new reading(s) across ${nf(days)} day(s) ${fresh ? "written to" : "merged into"} ${OUTBOX_MD}`,
  );
  if (log) for (const l of lines) log(l);
  return { events: all, unseen, written: true, path: mdPath, lines };
}
