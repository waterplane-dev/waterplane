/**
 * ONE JSON document holding every series as POINTS, for a client that can draw.
 *
 * ── Why this exists next to `narrate` and `html` ───────────────────────────
 *
 * The phone was given the rendered markdown and no rows, deliberately: a
 * reader needs sentences, and sentences are cheaper than a chart. What that
 * cost is a time axis — "p95 is in the 86th percentile" says nothing about the
 * shape it got there by. `html` draws that shape, but it draws it into a file
 * on this desktop, and the phone cannot plot a page it can only open.
 *
 * ── Why it is a module and not the CLI's `plot` branch ─────────────────────
 *
 * It was the CLI's `plot` branch, and it was the largest counter-example to
 * that file's own header — "everything below is argument parsing, a loop, and
 * printing", under 200 lines of shaping. The rule there is not style: the CLI
 * is the file anybody reaches for to make the tool say something slightly
 * different, and shaping that lives there is shaping no test imports and no
 * second caller can reuse. So the CLI reads the day-rows and prints the line;
 * the document between those two is here.
 *
 * ── The boundary: this states, the client draws ────────────────────────────
 *
 * Every comparator is computed here: the rank, the slope, how many readings
 * the window actually held, the day it opens, the reason an absence exists,
 * the detail sentence with the numbers a rate may not travel without. The
 * client turns days and values into pixels and computes nothing else.
 *
 * That is not tidiness. The READING — a percentile within a trailing window
 * plus the sign of a slope — is defined exactly once, beside a frozen
 * constants block whose changes are made loud by a committed fixture. A
 * second definition living on the drawing end would sit outside that
 * mechanism entirely: it would agree on the day it was written and drift the
 * first time `RANK_WINDOW_DAYS` moved, with every past day silently re-read
 * and nothing saying so. So `SERIES` (which series exist) and `reading` (how
 * one is read) are imported from `readings.mjs` rather than re-derived, and
 * `windowReadings`/`minReadings` ride along so no client hardcodes 60 and 14.
 *
 * ── This shapes; it does not define ────────────────────────────────────────
 *
 * Nothing below decides what anything MEANS. It reads fields the metrics
 * wrote, hands the values to `reading`, and shapes the result. No threshold,
 * no cutoff, no second arithmetic — a definition that landed here would be one
 * `fixture.json` does not pin, and there is none.
 *
 * Read-only in the strongest sense available: it takes rows and returns an
 * object. It opens nothing, writes nothing, and prints nothing.
 *
 * ── No `ts` on a point ─────────────────────────────────────────────────────
 *
 * The day string is the x label and there is no instant anywhere in here. Git
 * speaks seconds, this wire speaks milliseconds, and the last time the two met
 * unconverted a 2026 commit reached the phone as "690mo ago". `lastTs` on
 * `status` is converted at the shared boundary; a point carrying a raw `ts`
 * would re-open that trap on a field nothing needs.
 */

import { tapeLines, tapePaths } from "./metrics/classics.mjs";
import { SERIES, reading } from "./readings.mjs";
import { readRank } from "./series.mjs";
import { OWN_FILE } from "./own.mjs";
import { UNITS } from "./central.mjs";

/**
 * Which plotted series each index entry is drawn as — the tiles a repo's
 * `central` disable or override (`central.mjs`) is written on. `context` is
 * two series and the index reads their sum, so both carry the variant.
 */
const ENTRY_OF_SERIES = Object.freeze({
  "size.p95": "size",
  "retouch.rate": "retouch",
  "hatches.perKloc": "hatches",
  "context.claudeMdChars": "context",
  "context.descChars": "context",
  "untested.count": "untested",
});

/**
 * The latest row's disable or override of the entry a series draws, as the
 * series' `variant`. An override carries its OWN points, index for index with
 * the series', non-null only on rows that ran the same argv as the latest —
 * a row that ran a different command, or none (anything before the override
 * was first measured), is a cut, never the central value under another name.
 */
function variantOf(rows, key) {
  const entry = ENTRY_OF_SERIES[key];
  const cen = rows[rows.length - 1]?.central;
  if (!entry || !cen || typeof cen !== "object") return undefined;
  const dis = cen.disabled?.[entry];
  if (dis && typeof dis.why === "string") return { kind: "disabled", why: dis.why };
  const ov = cen.override?.[entry];
  if (!ov || typeof ov.why !== "string") return undefined;
  const argv = JSON.stringify(ov.run ?? null);
  const pts = rows.map((r) => {
    const o = r?.central?.override?.[entry];
    return { day: r.day, sha7: short(r.sha), v: o && JSON.stringify(o.run ?? null) === argv ? num(o.value) : null };
  });
  const first = pts.find((p) => p.v !== null);
  return {
    kind: "override",
    why: ov.why,
    means: typeof ov.means === "string" ? ov.means : "",
    unit: UNITS[entry],
    points: pts,
    last: pts.length ? pts[pts.length - 1].v : null,
    since: first ? first.day : null,
    ...(num(ov.value) === null ? { absent: typeof ov.reason === "string" && ov.reason ? ov.reason : "the override printed no number" } : {}),
  };
}

/** Seven characters of sha beside every point. The CLI shortens its own for
 *  `status`; neither spelling is a definition anything else reads back. */
const short = (sha) => sha.slice(0, 7);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Why a family has no reading today, in the metric's own words.
 *
 * `undefined` when it HAS one — the field then never reaches the JSON, and a
 * present-but-empty reason is exactly the shape a client would print as a
 * blank excuse. A reading that is absent for no stated reason still says so.
 */
function absenceOf(row, family) {
  const rec = row?.[family];
  if (rec && rec.value !== null && rec.value !== undefined) return undefined;
  return (rec && typeof rec.reason === "string" && rec.reason) || "no reason given";
}

/**
 * The day-rows, shaped. `preregVersion` is the fallback the document reports
 * when the latest row does not carry one of its own.
 */
export function buildPlot({ rows, prereg, preregVersion, scope = null, ownDeclared = false }) {
  const last = rows[rows.length - 1];

  // One point per day-row for every series, absences included as `v: null`:
  // the client cuts the line there and never interpolates, and every series
  // shares one x axis because every series has the same days in it.
  const points = (get) => rows.map((r) => ({ day: r.day, sha7: short(r.sha), v: num(get(r)) }));

  const series = SERIES.map((s) => {
    const pts = points(s.get);
    const family = s.key.split(".")[0];
    // TWO absences, and the second one shipped as nothing at all.
    //
    // The family-level one is "this metric read nothing today". Under it sits
    // a narrower case: the family WAS read and one of its series has no value
    // — the skill counts in a tree with no `.claude/skills`, which is most of
    // this fleet. `metrics/context.mjs` writes the reason for exactly that
    // beside the nulls, and this document dropped it, so the phone fell back
    // to its own "no reading in the whole series" over two series whose
    // reason the row had been carrying all along. A null is a CUT here and an
    // absence needs a REASON everywhere else; a series-level null with no
    // sentence was the one place this tool broke its own rule.
    //
    // The family reason wins where both exist: "the context reading was not
    // taken" is the larger fact, and a series-level sentence under it would
    // explain a number nothing tried to read.
    const own = s.absentOf && pts[pts.length - 1]?.v == null ? s.absentOf(last) : null;
    const absent = absenceOf(last, family) ?? own ?? undefined;
    // The window is the READINGS, not the calendar days: the absences are
    // dropped before `reading` cuts to `RANK_WINDOW_DAYS`, exactly as
    // `events.mjs` does it, because that is the same function.
    // The series DEFINITION goes in with the points: a `plain` one comes
    // back unranked with the tool's own reason, decided in `readings.mjs`
    // beside the rest of the reading rather than subtracted here.
    const read = reading(
      readRank,
      pts.filter((p) => p.v !== null).map((p) => ({ day: p.day, v: p.v })),
      prereg,
      s,
    );
    // The row the window opens on, handed to `detail` so a sentence that
    // reports a level can also say what moved it across exactly the window
    // the rank was read over — "since 2026-06-18" names the same day `from`
    // does, never a second one.
    const opens = read.from ? rows.find((r) => r.day === read.from) ?? null : null;
    return {
      key: s.key,
      // Every series in this list is waterplane's: the same definition in
      // every repo, the ones the index is built from. A repo's own readings
      // are `own.series` below and say `repo`.
      source: "central",
      label: s.label,
      unit: s.unit,
      points: pts,
      last: pts.length ? pts[pts.length - 1].v : null,
      reading: read,
      detail: (s.detail ? s.detail(last, prereg, opens) : "").trim(),
      ...(absent === undefined ? {} : { absent }),
      ...(variantOf(rows, s.key) ? { variant: variantOf(rows, s.key) } : {}),
    };
  });

  const areas = last?.context?.value?.areas;
  const context = {
    areas: {},
    ...(absenceOf(last, "context") === undefined ? {} : { absent: absenceOf(last, "context") }),
    // Why there are no areas, when the row said so. An empty object and "this
    // repo has no router convention" read identically on a chart, and the row
    // already knows which one it is — `metrics/context.mjs` argues it out.
    // Carried beside `areas` rather than folded into `absent`, which is about
    // the whole family: the repo-wide always-on weight is a reading even where
    // the per-area numbers are not.
    ...(typeof last?.context?.value?.areasReason === "string"
      ? { areasAbsent: last.context.value.areasReason }
      : {}),
  };
  if (areas && typeof areas === "object") {
    for (const [key, a] of Object.entries(areas)) {
      context.areas[key] = {
        expected: num(a?.expected),
        ceiling: num(a?.ceiling),
        p90: num(a?.p90),
        commits: num(a?.commits),
        subs: num(a?.subs),
        // An area that exists and cannot be attributed to any commit — its
        // router names no source group. `ceiling` is still a number, the
        // other three are null, and this is the sentence that says which of
        // the two kinds of null they are.
        ...(typeof a?.reason === "string" ? { reason: a.reason } : {}),
      };
    }
  }

  const classicsOf = (r) => r?.classics?.value ?? null;
  const pkgsOf = (r) => {
    const v = classicsOf(r)?.packages;
    return Array.isArray(v) ? v : [];
  };
  // The packages of the LATEST day, in the metric's own NAME order — a
  // package that has since left the tree is not a line on today's chart, and
  // its history is still in the row it was measured in.
  //
  // This used to be sorted largest-first, which put a package's COLOUR under
  // the control of its size on the day you happened to look: the phone hands
  // out palette slots by position, so the morning `host` overtook `web` the
  // two would swap blue and orange mid-curve and every earlier reading would
  // appear to change hands. A colour has to follow the entity. Name order is
  // stable for as long as a package keeps its name, which is the only thing
  // about it that should decide its hue.
  //
  // That left one thing unsent, and this is the commit where it stopped being
  // hypothetical. The phone folds everything past its palette into one hueless
  // band, and with name order alone the bands it KEEPS are the first few
  // alphabetically. This repo's groups are now `.`, `deploy`, `packages/app`,
  // `packages/host`, `packages/shared`, `packages/web`, `scripts`, `tools` —
  // so the chart drew `.` at 158 lines, `deploy` at 122 and `packages/app` at
  // 140, and folded `packages/web` (80,062) and `packages/host` (47,084) into
  // the rest. Three slivers and one bar: a chart of the tree's smallest
  // corners, drawn with the same confidence as one of its largest.
  //
  // So `rank` rides along: 0 is the largest group on the latest day. The
  // choice of WHICH to keep is a fact about the tree and belongs here; how
  // many fit is a fact about the palette and stays on the phone. Order is
  // still by name, and a slot is still assigned by name among the kept, so a
  // colour follows an entity and not its size this morning — the rank decides
  // membership of the fold and never the hue.
  const pkgSizes = new Map();
  for (const p of pkgsOf(last)) {
    if (typeof p?.pkg === "string") pkgSizes.set(p.pkg, typeof p.loc === "number" ? p.loc : 0);
  }
  const bySize = [...pkgSizes.entries()]
    // Ties by name, so the rank of two equal groups does not depend on the
    // order the metric happened to emit them in.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([pkg]) => pkg);
  const rankOf = new Map(bySize.map((pkg, i) => [pkg, i]));
  const pkgNames = pkgsOf(last)
    .map((p) => p?.pkg)
    .filter((p) => typeof p === "string");
  // `{path, loc}` per file, biggest first and already capped by the metric.
  // The line counts are the distribution; the paths ride BESIDE them as a
  // parallel list, because a bar a reader can tap but not name is a number
  // nobody can open. ~2 KB for 50 paths.
  // Through the metric's own reader, not a second copy of the conversion.
  // The second copy is what this had, and `html.mjs` — which had none —
  // rendered an empty chart for it.
  // The same tree cut by WHAT the code is, beside the cut by where it lives.
  // Shaped exactly like `packages` — name order for the colour, a `rank` for
  // which ones survive the fold — because the two charts are the same picture
  // of two different questions and a reader moving between them should not
  // have to re-learn what a band is.
  //
  // A row measured before this field existed carries no `types` at all, and
  // that is a null and not a row of zeros: the day is unread, not empty. The
  // engine bumped `PREREG_VERSION` for exactly this, so a series holding both
  // kinds of row is refused rather than drawn with a silent floor.
  const typesOf = (r) => {
    const v = classicsOf(r)?.types;
    return Array.isArray(v) ? v : null;
  };
  const typeSizes = new Map();
  for (const t of typesOf(last) ?? []) {
    if (typeof t?.ext === "string") typeSizes.set(t.ext, typeof t.loc === "number" ? t.loc : 0);
  }
  const typeRank = new Map(
    [...typeSizes.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([ext], i) => [ext, i]),
  );
  const types = (typesOf(last) ?? [])
    .filter((t) => typeof t?.ext === "string")
    .map((t) => ({
      ext: t.ext,
      // The pack that claims the extension, so the filter on the phone can
      // speak in languages as well as in suffixes — and `null` where no
      // active pack claims it, which is a fact and not a blank.
      pack: typeof t.pack === "string" ? t.pack : null,
      rank: typeRank.get(t.ext) ?? 0,
      files: num(t.files),
      points: points((r) => {
        const ts = typesOf(r);
        if (!ts) return null;
        const hit = ts.find((x) => x?.ext === t.ext);
        return hit ? hit.loc : 0;
      }),
    }));

  const tape = tapeLines(classicsOf(last)?.tape);
  const tapeNames = tapePaths(classicsOf(last)?.tape);
  // The longest file, by day and by NAME.
  //
  // It is not one of the `SERIES` — those are pre-registered and each one is
  // a narrative subject, and this is neither: it is the one figure the drawn
  // HTML page carried that the phone could not, which made the sheet's claim
  // to hold every card on that page false by one number and one string.
  //
  // The path comes off the LATEST row only, and travels with the day it was
  // read on: "the biggest file grew 400 lines" and "a different file took the
  // crown" are opposite events with the same number, so a path with no day
  // beside it is the half of the pair that can mislead.
  const longest = {
    points: points((r) => r?.size?.value?.max),
    // The name on EVERY reading, index for index with `points`, so a chart can
    // mark the day the crown changed hands — the one event a length alone
    // cannot show, since the new holder can be the same size as the old.
    paths: rows.map((r) => (typeof r?.size?.value?.maxPath === "string" ? r.size.value.maxPath : null)),
    path: typeof last?.size?.value?.maxPath === "string" ? last.size.value.maxPath : null,
    day: last?.day ?? null,
  };
  const classics = {
    loc: points((r) => classicsOf(r)?.loc),
    files: points((r) => classicsOf(r)?.files),
    // Production dependencies only. `devDeps` is counted separately by the
    // metric and never summed into this — see `metrics/classics.mjs`.
    deps: points((r) => classicsOf(r)?.deps?.deps),
    packages: pkgNames.map((pkg) => ({
      pkg,
      rank: rankOf.get(pkg) ?? 0,
      // A package with no entry on a day the classics WERE measured had no
      // source files then — that is a measured zero, not an unread day. Sent
      // as null it becomes a hole, and because a stack column is
      // all-or-nothing, one package arriving late would blank every band for
      // every day before it: the history the chart exists to show. The
      // distinction is the row's own: no `classics` value at all is still
      // null, because then nothing was counted.
      points: points((r) => {
        const pkgs = pkgsOf(r);
        const hit = pkgs.find((p) => p?.pkg === pkg);
        if (hit) return hit.loc;
        return classicsOf(r) && pkgs.length ? 0 : null;
      }),
    })),
    types,
    tape: tape.length ? tape : null,
    ...(tape.length && tapeNames.some((p) => p != null) ? { tapePaths: tapeNames } : {}),
    ...(absenceOf(last, "classics") === undefined ? {} : { absent: absenceOf(last, "classics") }),
  };

  // The declaration's own complaints, and the overrides a backfill could not
  // run — once for the document, beside the variants they explain.
  const cen = last?.central;
  const central = !scope && cen && typeof cen === "object"
    ? {
        file: typeof cen.file === "string" ? cen.file : OWN_FILE,
        ...(Array.isArray(cen.problems) && cen.problems.length ? { problems: cen.problems.filter((p) => typeof p === "string") } : {}),
      }
    : null;

  return {
    ...(scope ? {} : { own: buildOwn(rows, prereg, ownDeclared) }),
    ...(central ? { central } : {}),
    // The subtree these rows are about, or null for the whole repo. It travels
    // because every PATH below is relative to it — a scoped row's longest file
    // is `src/App.tsx` and the repo's is `apps/ba3-web/src/App.tsx`, and a
    // reader handed the first with no scope beside it has a path that does not
    // exist.
    scope,
    preregVersion: last?.prereg ?? preregVersion,
    // So nothing on the drawing end hardcodes 60 and 14: the window a rank
    // was taken in, and the shortest history that gets one at all.
    windowReadings: prereg.RANK_WINDOW_DAYS,
    minReadings: prereg.RANK_MIN_POINTS,
    days: rows.length,
    series,
    context,
    classics,
    longest,
  };
}

/**
 * The repo's OWN readings (`own.mjs`), shaped like the series above and
 * marked `source: "repo"`.
 *
 * Which readings exist is the NEWEST row carrying an `own` field: that is the
 * declaration as it last ran, and a key it no longer names is not a tile on
 * today's sheet (its history stays in the rows it was taken in). Each row
 * without that key — before it was declared, or measured before `own` existed
 * — is a hole, never a zero: nothing was run there.
 *
 * `declared` is whether HEAD's tree holds the file, read by the caller from the
 * commit — the one fact that tells "this repo declares nothing" (one line on
 * the phone saying how to) from "declared, not measured yet".
 *
 * Whole-tree only: a scope's plot carries no `own` key at all.
 */
function buildOwn(rows, prereg, declared) {
  let latest = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.own && typeof rows[i].own === "object") { latest = rows[i].own; break; }
  }
  const out = { file: OWN_FILE, declared: !!declared, series: [] };
  if (latest && typeof latest.refused === "string") {
    out.absent = latest.refused;
    return out;
  }
  const decls = Array.isArray(latest?.readings) ? latest.readings : [];
  const last = rows[rows.length - 1];
  for (const d of decls) {
    if (typeof d?.key !== "string") continue;
    const at = (r) => (Array.isArray(r?.own?.readings) ? r.own.readings.find((x) => x?.key === d.key) : undefined);
    const pts = rows.map((r) => ({ day: r.day, sha7: short(r.sha), v: num(at(r)?.value) }));
    const today = at(last);
    // The reason for TODAY's hole, in the reading's own words where it ran
    // and failed, else the plain fact that the latest row took none.
    const absent = pts.length && pts[pts.length - 1].v === null
      ? (typeof today?.reason === "string" && today.reason) || "not taken on the latest day"
      : undefined;
    const read = reading(readRank, pts.filter((p) => p.v !== null).map((p) => ({ day: p.day, v: p.v })), prereg, {});
    out.series.push({
      key: d.key,
      source: "repo",
      label: typeof d.name === "string" && d.name ? d.name : d.key,
      unit: typeof d.unit === "string" ? d.unit : "",
      means: typeof d.means === "string" ? d.means : "",
      better: d.better === "lower" || d.better === "higher" ? d.better : null,
      points: pts,
      last: pts.length ? pts[pts.length - 1].v : null,
      reading: read,
      detail: "",
      ...(absent === undefined ? {} : { absent }),
    });
  }
  if (Array.isArray(latest?.problems) && latest.problems.length) {
    out.problems = latest.problems.filter((p) => typeof p === "string");
  }
  if (declared && !latest) out.absent = "declared, not measured yet — the next refresh that measures a new commit takes the first reading";
  return out;
}
