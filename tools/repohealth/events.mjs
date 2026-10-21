/**
 * Which transitions in the repo-health series are worth a sentence, and the
 * sentence each one becomes. `narrate.mjs` is the writer that puts them in
 * `.claude/outbox/repohealth.md`; its header argues out what is narrated and
 * what deliberately is not. This file answers only "what moved".
 *
 * ── Why events need an existence oracle ────────────────────────────────────
 *
 * Two of the transitions below — a name losing its last caller, a module
 * losing its last mention in a test — are only events if the file was ALREADY
 * THERE yesterday. On a file's first day both are false: nothing lost
 * anything, the file simply arrived. That case was 74 of the false positives
 * this file used to print.
 *
 * A `Row` carries no file list, so `knownPaths()` unions every path a row
 * happens to name — its untested list, its orphan list, its tape, its
 * hotspots, its offenders, its longest file, its duplicate pairs, its tripwire
 * subjects. That is a ONE-SIDED oracle: presence proves the file existed,
 * absence proves nothing. The asymmetry is the right way round — it can only
 * ever cost an event, never invent one — which is this repo's rule for a
 * heuristic, applied to a gate instead of to a number.
 *
 * Pure. No model, no network, no subprocess, no IO, no clock.
 */

import { FAMILIES, SERIES, nf, numbersIn, ordinal, pct, plural, quartile, reading } from "./readings.mjs";
import { readRank as seriesReadRank } from "./series.mjs";

// ── the sentence a reading becomes ─────────────────────────────────────────

/** Up to three names, then a count. A phone screen holds three paths. */
const list3 = (xs) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${nf(xs.length - 3)} more`);

const withUnit = (v, unit) => (unit ? `${nf(v)} ${unit}` : nf(v));

/**
 * The rank half of a sentence. Under `RANK_MIN_POINTS` it says how short the
 * history is — never a rank of 0, which is the opposite claim and would read
 * as "lowest value ever recorded" on the second day of the series.
 *
 * "of the last N readings" is the window ACTUALLY available, not the
 * configured 60, and the day it starts is named because N readings and N days
 * are not the same span in this history.
 */
function rankPhrase(rd) {
  if (rd.rank === null) return rd.reason;
  return `${ordinal(pct(rd.rank))} percentile of the last ${nf(rd.n)} readings back to ${rd.from}${
    rd.slope ? `, ${rd.slope}` : ""
  }`;
}

/**
 * Order within a day: the loudest first, the bookkeeping last.
 *
 * A tripwire's own kind IS the event kind — `file-crossed-lines`, not
 * `tripwire:file-crossed-lines` — which keeps every event id parseable as
 * three colon-separated fields and is what lets `judge.mjs` recover a real
 * path from a subject. A tripwire kind added later and not listed here sorts
 * last within its day; that is a display nit and not a dropped event.
 */
const KIND_ORDER = [
  "file-crossed-lines",
  "hatch-kind-appeared",
  "maxfile",
  "orphan",
  "pair-appeared",
  "pair-gone",
  "untested",
  "rank",
  "slope",
  "absent",
  "present",
];
const kindWeight = (kind) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};

// ── events ─────────────────────────────────────────────────────────────────

/**
 * The ledger key. `kind:subject:DAY` — see rule 2 in the header for why the
 * day and not the sha, which is the difference between a second commit adding
 * a line and a second commit reprinting the morning.
 */
const mk = (kind, subject, row, text) => ({
  id: `${kind}:${subject}:${row.day}`,
  day: row.day,
  sha: row.sha,
  kind,
  text,
});

/**
 * Every path a day-row happens to name. The one-sided existence oracle from
 * the header: in the set ⇒ the file was in the tree on that day-row; not in
 * the set ⇒ unknown, and the caller must therefore stay quiet.
 */
function knownPaths(row) {
  const out = new Set();
  const add = (p) => {
    if (typeof p === "string" && p.includes("/")) out.add(p.split("#")[0]);
  };
  for (const p of row?.untested?.value ?? []) add(p);
  for (const p of row?.untested?.unnamed ?? []) add(p);
  for (const e of deadExportEntries(row) ?? []) add(e);
  for (const t of row?.classics?.value?.tape ?? []) add(t?.path);
  for (const h of row?.cochange?.value?.hotspots ?? []) add(h?.path);
  for (const o of row?.retouch?.value?.offenders ?? []) add(o?.path);
  for (const p of row?.dups?.value?.pairs ?? []) {
    add(p?.a);
    add(p?.b);
  }
  for (const t of row?.tripwires ?? []) add(t?.subject);
  add(row?.size?.value?.maxPath);
  return out;
}

/**
 * The orphan list of a row, `path#name` entries, or `null` where the row does
 * not carry one at all.
 *
 * Read through both shapes — a bare array and a `Measured` — because the
 * metric side of this is being reshaped and a narrative that throws on the
 * older of the two shapes takes the whole file down with it. A row without the
 * field narrates no orphans, which is the correct absence.
 */
function deadExportEntries(row) {
  const raw = row?.deadExports;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.value)) return raw.value;
  return null;
}

/**
 * The day-reduced series, diffed.
 *
 * `prevDays` is history: it supplies the rank windows and the row a reported
 * day is compared against, and it produces no sentences of its own. `nextDays`
 * is what is being reported on. Both are oldest-first, one row per day —
 * `series.mjs`'s `perDay`, not the per-commit rows: a day with nine commits is
 * one day of news, and diffing commits would narrate a rebase.
 *
 * Only a TRANSITION is an event. A day with no predecessor says nothing at all
 * — including the first day of a backfill, which has no yesterday to have
 * moved from. That is also what makes the degenerate case degenerate: two
 * identical day-rows produce `[]`.
 *
 * Pure. No IO, no clock, no `process`.
 *
 * @param {import("./types.mjs").Row[]} prevDays
 * @param {import("./types.mjs").Row[]} nextDays
 * @param {typeof import("./constants.mjs").PREREG} prereg
 * @param {{readRank?: (values: number[], prereg: object) => object}} [deps]
 * @returns {import("./types.mjs").Event[]}
 */
export function events(prevDays, nextDays, prereg, deps = {}) {
  const readRank = typeof deps.readRank === "function" ? deps.readRank : seriesReadRank;
  const prev = Array.isArray(prevDays) ? prevDays : [];
  const next = Array.isArray(nextDays) ? nextDays : [];
  if (!next.length) return [];

  // Merge on day, newer wins. A day supplied by both sides is the same day
  // measured twice, not two days; taking `next`'s row keeps a re-run over an
  // extended day honest without inventing a second point in the window.
  const byDay = new Map();
  for (const r of prev) if (r && r.day) byDay.set(r.day, r);
  const reported = new Set();
  for (const r of next) {
    if (!r || !r.day) continue;
    const before = byDay.get(r.day);
    if (!before || before.sha !== r.sha) reported.add(r.day);
    byDay.set(r.day, r);
  }
  const timeline = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  /** `{day, v}` for every reading of one series up to and including index i. */
  const windowFor = (get, i) => {
    const out = [];
    for (let k = 0; k <= i; k += 1) {
      const v = get(timeline[k]);
      if (typeof v === "number" && Number.isFinite(v)) out.push({ day: timeline[k].day, v });
    }
    return out;
  };

  const out = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const b = timeline[i];
    if (!reported.has(b.day)) continue;
    const a = timeline[i - 1];

    out.push(...tripwireEvents(a, b));
    out.push(...maxFileEvents(a, b));
    out.push(...orphanEvents(a, b));
    out.push(...pairEvents(a, b, prereg));
    out.push(...untestedEvents(a, b));
    out.push(...seriesEvents(a, b, i, windowFor, readRank, prereg));
    out.push(...presenceEvents(a, b, i, timeline));
  }

  out.sort((x, y) =>
    x.day < y.day ? -1 : x.day > y.day ? 1 : kindWeight(x.kind) - kindWeight(y.kind) || (x.id < y.id ? -1 : 1),
  );
  return out;
}

/**
 * A tripwire is news the day it appears and never again.
 *
 * The event kind is the tripwire's own kind and the subject is the tripwire's
 * own subject — no wrapper, so the id stays three fields and `judge.mjs` can
 * read a path out of the middle one. There is no "N tripwires standing today"
 * suffix: a tripwire is an event, nothing stands, and the `detail` the metric
 * wrote already carries the crossing and the line it crossed.
 *
 * The one exception is `dead-export`, which has left this list and is narrated
 * as `orphan` below; rows measured under an older `PREREG_VERSION` still carry
 * it and must not print the same names twice under two kinds.
 *
 * ── Why these are NOT grouped per day, when orphans are ───────────────────
 *
 * Measured over this history, a day-row fires more than one tripwire of the
 * same kind twice: three files crossed 2,000 lines on 2026-09-18 and three
 * hatch kinds first appeared on 2026-08-30. Against 15 day-rows of orphans and
 * up to seven at a time, that is not the same problem.
 *
 * And the fix would not fit. An orphan's payload is a NAME, so seven of them
 * are a list; a tripwire's payload is the `detail` the metric wrote, and each
 * one carries its own two numbers — `1,707 → 2,251 lines`, `0 → 6
 * occurrences`. Three of those on one bullet is three sentences on one line:
 * no screen saved, and the per-file numbers pushed out of the position the
 * eye reads first. The repeated tail those three lines share
 * ("7 of 9 hatch kinds are now in use") is the metric's wording inside a
 * string this module is not allowed to parse, not a granularity this module
 * chose.
 */
function tripwireEvents(a, b) {
  const key = (t) => `${t.kind}/${t.subject}`;
  const before = new Set((a.tripwires || []).map(key));
  const na = (a.tripwires || []).length;
  const nb = (b.tripwires || []).length;
  return (b.tripwires || [])
    .filter((t) => t.kind !== "dead-export" && !before.has(key(t)))
    .map((t) => {
      // The invariant is two numbers per sentence and the detail is written by
      // a metric module, which cannot be assumed to carry them. No tripwire
      // kind in the tool needs this today; it is here so that one added later
      // degrades to a wordier sentence rather than to a failing test.
      const thin = numbersIn(t.detail).length < 2 ? ` (${plural(nb, "tripwire")} fired on this day-row, ${nf(na)} on ${a.day})` : "";
      return mk(t.kind, t.subject, b, `${t.subject}: ${t.detail}.${thin}`);
    });
}

/** The longest file changing hands is the one size event worth a name in it. */
function maxFileEvents(a, b) {
  const av = a.size?.value;
  const bv = b.size?.value;
  if (!av || !bv || !bv.maxPath || av.maxPath === bv.maxPath) return [];
  return [
    mk(
      "maxfile",
      bv.maxPath,
      b,
      `${bv.maxPath} is now the longest file at ${nf(bv.max)} lines, past ${av.maxPath} at ${nf(av.max)} on ${a.day}; p95 ${nf(bv.p95)}.`,
    ),
  ];
}

/**
 * The names that lost their last caller, as ONE line for the day.
 *
 * The transition, and nothing else: a name that IS on today's orphan list, was
 * NOT on the previous day-row's, and whose file the previous day-row already
 * knew about. All three clauses are definitional. The third is the one that
 * matters — without it every export of every new file fires on the day the
 * file lands, which was 74 of the false positives this event replaces, and
 * "a file arrived" is not "a name was orphaned".
 *
 * ── Why the day, and not the name or the file ─────────────────────────────
 *
 * Per name this fired 41 times over 15 day-rows, up to 7 on one morning, and
 * the seven were seven near-identical sentences ending in the same pair of
 * numbers — two of them repeated "17 orphaned names in the tree, 6 on
 * 2026-06-25" word for word. Names that orphan on the same day almost always
 * share ONE cause: a refactor took the last caller away. The reader wants that
 * cause once and the names beside it, which is what the `untested` line
 * already does and what a phone screen has room for.
 *
 * This is a GROUPING and not a threshold. Every orphan is still reported;
 * nothing is suppressed for being small or for failing to clear a bar. How
 * many names are spelt out before "and N more" is a rendering choice — the
 * same one `list3` makes everywhere else — and it changes nothing about which
 * transitions fire.
 *
 * ── Why the subject is still the names ────────────────────────────────────
 *
 * The obvious id for a once-per-day event is `orphan:<day>:<day>`, and it is
 * the wrong one here for two reasons, both of which cost more than the
 * redundancy it would save. `judge.mjs` recovers its evidence from the
 * subject and from nothing else, so a subject with no path in it makes the
 * single most judge-worthy event in the tool — "is this name really unreached,
 * or only unreachable to a text scan" — unbuyable. And a day-keyed id is
 * FROZEN once reported: an evening commit that orphans an eighth name would
 * find the day already in the ledger and the eighth name would never be
 * printed at all, which is the one thing worse than printing a day twice.
 *
 * So the subject is the sorted `path#name` list, exactly as `untested` keys on
 * its sorted paths. A second commit that orphans a new name re-keys the day
 * and reprints one line carrying the fuller list, which is a repeat the reader
 * can see through — and it is a bounded one, one line rather than the seven
 * this event used to be.
 */
function orphanEvents(a, b) {
  const before = deadExportEntries(a);
  const now = deadExportEntries(b);
  if (!before || !now) return [];
  const had = new Set(before);
  const known = knownPaths(a);

  const lost = [];
  for (const entry of now) {
    if (typeof entry !== "string" || had.has(entry)) continue;
    const hash = entry.indexOf("#");
    if (hash <= 0) continue;
    if (!known.has(entry.slice(0, hash))) continue;
    lost.push(entry);
  }
  if (!lost.length) return [];
  lost.sort();

  const tail = `${plural(now.length, "orphaned name")} in the tree, ${nf(before.length)} on ${a.day}.`;
  const text =
    lost.length === 1
      ? `${lost[0]} lost its last caller, which named it on ${a.day} — ${tail}`
      : `${plural(lost.length, "name")} lost their last caller: ${list3(lost)} — ${tail}`;
  return [mk("orphan", lost.join("|"), b, text)];
}

/**
 * A near-duplicate pair appearing or disappearing.
 *
 * This replaces ranking `pairsPerKloc`, which with a numerator of 0 to 2 was a
 * plot of `1/LOC`. A pair has two names, two files to open and a similarity,
 * so it needs no threshold to be worth a line — the threshold is already
 * pre-registered in how a pair is found at all.
 *
 * Identity strips the `@line` suffix `dups.mjs` writes. A line number is where
 * a block is, not which block it is: without stripping, the one pair in this
 * history "disappeared and reappeared" on 2026-09-11 because 29 lines were
 * added above it.
 *
 * With ONE exception, and it is a real pair in this history rather than a
 * hypothetical: `dups.mjs` names a block it cannot name `(anonymous)`, and
 * `QuestionsSheet.tsx` pairs two of them against each other. Stripped, both
 * members become the same string, so the pair's id would be `X|X` and any
 * second anonymous pair in the same parent would land on that id too and be
 * silently swallowed. A block with no name has no handle except where it is,
 * so those keep their line numbers and churn when the file moves above them.
 * Churn prints a pair twice; a collision loses one, and losing one is worse.
 *
 * The TEXT always carries the line numbers, named or not. "Which block" is a
 * question the reader answers by opening the file, and `Oracle.ask` without a
 * line is findable while `(anonymous)` without one is not.
 *
 * One line per pair, not per day, and unlike the orphans that needs no
 * argument: no day-row in this history has ever appeared or lost more than one
 * pair, and a pair's whole payload is the two blocks it names.
 */
function pairEvents(a, b, prereg) {
  const av = a.dups?.value;
  const bv = b.dups?.value;
  if (!av || !bv) return [];
  const site = (s) => String(s ?? "").replace(/@\d+$/, "");
  const idOf = (p) => {
    const a = site(p?.a);
    const b = site(p?.b);
    // Two unnameable blocks in one parent strip to the same string; see above.
    if (a === b) return [String(p?.a), String(p?.b)].sort().join("|");
    return [a, b].sort().join("|");
  };
  const index = (v) => new Map((v.pairs || []).map((p) => [idOf(p), p]));
  const before = index(av);
  const now = index(bv);
  const na = before.size;
  const nb = now.size;
  const out = [];

  for (const [id, p] of now) {
    if (before.has(id)) continue;
    out.push(
      mk(
        "pair-appeared",
        id,
        b,
        `${p.a} and ${p.b} are a new near-duplicate pair at ${nf(p.sim)} similarity over blocks of at ` +
          `least ${nf(prereg.DUP_MIN_LINES)} lines — ${plural(nb, "pair")} in the tree, ${nf(na)} on ${a.day}.`,
      ),
    );
  }
  for (const [id, p] of before) {
    if (now.has(id)) continue;
    out.push(
      mk(
        "pair-gone",
        id,
        b,
        `${p.a} and ${p.b} no longer pair; they read ${nf(p.sim)} similar on ${a.day} — ` +
          `${plural(nb, "pair")} in the tree, ${nf(na)} on ${a.day}.`,
      ),
    );
  }
  return out;
}

/**
 * A module that a test used to reach and none reaches today.
 *
 * The old sentence was "N modules no test names any more", and it was false on
 * nearly every line it printed: those modules were new files nothing had ever
 * named. Arriving untested and losing your only test are opposite facts and
 * only the second is a transition.
 *
 * So all three clauses again: in today's list, not in the previous day-row's,
 * and the previous day-row already knew the file. The other direction — a
 * module LEAVING the list — is not reported at all, because from a row alone
 * "a test now names it" and "somebody deleted it" look identical, and the
 * cheerful reading of the two is the wrong one to guess.
 */
function untestedEvents(a, b) {
  const av = a.untested?.value;
  const bv = b.untested?.value;
  if (!Array.isArray(av) || !Array.isArray(bv)) return [];
  const had = new Set(av);
  const known = knownPaths(a);
  const lost = bv.filter((p) => !had.has(p) && known.has(p));
  if (!lost.length) return [];
  const files = b.classics?.value?.files;
  const denominator = typeof files === "number" ? ` of ${nf(files)}` : "";
  return [
    mk(
      "untested",
      lost.join("|"),
      b,
      `${list3(lost)} ${lost.length === 1 ? "was" : "were"} reached by a test on ${a.day} and ${
        lost.length === 1 ? "is" : "are"
      } reached by none today — ${nf(bv.length)}${denominator} modules are unreached, ${nf(av.length)} on ${a.day}.`,
    ),
  ];
}

/**
 * A quartile move or a slope flip, per tracked scalar.
 *
 * Quartiles rather than raw rank: a series that drifts one percentile a day is
 * not saying anything new each morning, and reporting a rank CHANGE would make
 * the narrative fire every day for ever. A quartile boundary is crossed rarely
 * and means something when it is.
 */
function seriesEvents(a, b, i, windowFor, readRank, prereg) {
  const out = [];
  for (const s of SERIES) {
    // A plain series is plotted and never spoken about: both sentences below
    // are comparisons against its own past, which is the reading it does not
    // have. Skipped here rather than filtered afterwards, so there is no
    // moment at which the text exists.
    if (s.plain) continue;
    const bv = s.get(b);
    const av = s.get(a);
    if (typeof bv !== "number" || !Number.isFinite(bv)) continue;
    const rb = reading(readRank, windowFor(s.get, i), prereg, s);
    const ra = reading(readRank, windowFor(s.get, i - 1), prereg, s);
    const neighbour =
      typeof av === "number" && Number.isFinite(av)
        ? `was ${withUnit(av, s.unit)} on ${a.day}`
        : `no reading on ${a.day}, so ${nf(rb.n)} of the last ${nf(prereg.RANK_WINDOW_DAYS)} readings carry one`;
    const detail = s.detail ? s.detail(b, prereg, a) : "";

    const qb = quartile(rb.rank);
    const qa = quartile(ra.rank);
    if (qb !== null && qa !== null && qb !== qa) {
      out.push(
        mk(
          "rank",
          s.key,
          b,
          `${s.label} is ${withUnit(bv, s.unit)}, ${neighbour} — ${rankPhrase(rb)}; quartile ${nf(qa)} to ${nf(qb)}.${detail}`,
        ),
      );
      continue;
    }
    if (rb.slope && ra.slope && rb.slope !== ra.slope) {
      out.push(
        mk(
          "slope",
          s.key,
          b,
          `${s.label} has turned ${rb.slope} — ${withUnit(bv, s.unit)}, ${neighbour}; ${rankPhrase(rb)}, and it was ${ra.slope} a reading ago.${detail}`,
        ),
      );
    }
  }
  return out;
}

/**
 * A reading going absent, or coming back.
 *
 * Absence is a fact about the tool, not about the repo — `typescript` stopped
 * importing, `.claude/skills` is not there yet — and it is worth exactly one
 * sentence with its reason in it, once. Without this the metric simply stops
 * appearing and the reader concludes nothing changed, which is the single
 * worst thing a narrative can let them conclude.
 *
 * This is also the whole of `cochange`'s narration, deliberately: see the
 * header for why its medians are evidence and not news.
 */
function presenceEvents(a, b, i, timeline) {
  const out = [];
  for (const [family, label] of FAMILIES) {
    const av = a[family];
    const bv = b[family];
    if (!av || !bv) continue;
    const had = av.value !== null && av.value !== undefined;
    const has = bv.value !== null && bv.value !== undefined;
    if (had && !has) {
      let streak = 0;
      for (let k = i - 1; k >= 0; k -= 1) {
        const v = timeline[k][family];
        if (!v || v.value === null || v.value === undefined) break;
        streak += 1;
      }
      out.push(
        mk(
          "absent",
          family,
          b,
          // Two numbers even here, where the value itself is gone: the run of
          // readings that DID read, against the length of the series it sits
          // in. "it stopped reading" and "it never read in 22 readings" are
          // different facts and the reader should not have to ask which.
          `${label} has none today: ${bv.reason || "no reason given"}. It read on ${a.day}, the last of ${plural(streak, "reading")} carrying one out of ${plural(i + 1, "reading")} in the series.`,
        ),
      );
    } else if (!had && has) {
      let gap = 0;
      for (let k = i - 1; k >= 0; k -= 1) {
        const v = timeline[k][family];
        if (v && v.value !== null && v.value !== undefined) break;
        gap += 1;
      }
      out.push(
        mk(
          "present",
          family,
          b,
          `${label} is back after ${plural(gap, "reading")} without one, out of ${plural(i + 1, "reading")} in the series so far.`,
        ),
      );
    }
  }
  return out;
}
