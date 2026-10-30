/**
 * Every shape of the token screens' documents a desktop can still send (`/api/tokenwindows`,
 * `/api/costwindow`, `/api/tokenstats`), replayed through today's phone readers.
 *
 *     node --test packages/extensions/token-stats/web/wirecorpus.test.mjs
 *
 * The corpus (`packages/shared/test/wire-corpus/`, written by its `capture.mjs`) is one captured
 * document per route (`base/`) and, per generation, the fields that generation's host added
 * (`generations.json`): the last release and each shape `undated` went through.
 * The web bundle reaches the phone over the air while a host changes only on a restart, so NEW
 * PHONE + OLDER HOST is the normal state — and every "absent = older host" branch was written by
 * hand and never shown an older document. The middle generation (`undated`, nothing to date it
 * by) striped every past-window box, and a dated one still striped every box older than the log
 * holding the records; this is the test that would have shown both.
 *
 * Two passes, the same assertions: the corpus as captured (old host → new phone), and the newest
 * generation with one value no build knows yet in every string slot a reader switches on, plus an
 * unknown field on every object (new host → this phone, the cheap stand-in for an old bundle).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldLaunches, LAUNCH_KIND_WORD, rankRepos, undatedText, weekCut } from "@waterplane/shared";
import { cutRefusalText, heatGrid, isCut, LIVE_WINDOWS, seriesCut, windowCut, windowGrids, windowWhen } from "./usageCut.ts";
import { docFor, foldStateText, hourText, weekCaption } from "./weekBands.ts";
import { allTimeUndatedText, calendarFrom, spanUndatedText, trendWithoutUndated } from "./span.ts";
import { statsInsights } from "./statsInsights.ts";
import { claudeCard } from "./overview.ts";
import { splitLocal } from "./localSplit.ts";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../../shared/test/wire-corpus");
const read = (f) => JSON.parse(readFileSync(join(CORPUS, f), "utf8"));
const GENERATIONS = read("generations.json");
/** Oldest first — the order the shapes shipped in (`capture.mjs`). */
const ORDER = ["0.1.11", "f99f4328", "52f2fadb", "e976a22d"];
const DOCS = ["tokenwindows", "costwindow", "tokenstats"];
const BASE = Object.fromEntries(DOCS.map((d) => [d, read(`base/${d}.json`)]));
/** One route's answer from one generation's host: the captured document with that host's fields. */
const load = (gen, doc) => ({ ...structuredClone(BASE[doc]), ...GENERATIONS[gen][doc] });
/** The instant the corpus was captured at — every reader that asks for a clock gets this one. */
const NOW = BASE.costwindow.to;

/** A word a reader printed because it read a field that was not there. */
const LEAK = /undefined|NaN|null|\[object/;

/** Every string anywhere in what a reader returned — a field read off a missing value leaks into
 *  whichever string it reaches, not only the headline sentence. */
function strings(x, out = [], seen = new Set()) {
  if (typeof x === "string") out.push(x);
  else if (x && typeof x === "object" && !seen.has(x)) {
    seen.add(x);
    for (const v of Object.values(x)) strings(v, out, seen);
  }
  return out;
}

function noLeak(words, at) {
  for (const w of strings(words)) assert.doesNotMatch(w, LEAK, `${at}: ${w}`);
}

/** Every sentence the past-window readers print for one document, plus the "entirely refused" check. */
function replayWindows(doc, label) {
  const grids = windowGrids(doc);
  assert.ok(grids.size > 0, `${label}: the grids are read at all`);
  for (const spec of LIVE_WINDOWS) {
    const series = grids.get(spec.id);
    if (!series) continue;
    const at = `${label} ${spec.id}`;
    const h = heatGrid(series);
    // No drawn box is striped: the run of windows an undated record could fall in is ONE sentence
    // (`heatGrid`), whether it is the whole grid or the oldest part of it.
    const striped = h.cells.filter((c) => c.refused).length;
    assert.equal(striped, 0, `${at}: ${striped} of ${h.cells.length} boxes striped`);
    const words = [h.refused, ...h.cells.flatMap((c) => [c.refused, windowWhen(c.openedAt, c.resetAt)])];
    for (const c of h.cells) {
      const r = seriesCut(spec, series, c.back, []);
      if (isCut(r)) words.push(r.long, r.label);
      else words.push(cutRefusalText(spec, r));
    }
    for (const w of words.filter((x) => x != null)) {
      assert.equal(typeof w, "string", `${at}: a sentence that is not text`);
      assert.doesNotMatch(w, LEAK, `${at}: ${w}`);
    }
  }
}

/** The week card's readers (`WeekCard.tsx`): the document is drawn, or refused in ONE sentence. */
function replayCost(doc, label) {
  const drawn = docFor(doc, doc.from);
  if (!drawn) {
    // Refused: the answer came, so the card says the ledger's own reason — never a state sentence.
    const said = foldStateText({ state: "ok", data: doc }, "week");
    assert.equal(said, undatedText(doc.undated), `${label}: a refused week says why`);
    noLeak([said], label);
    return;
  }
  const cut = weekCut(drawn);
  const words = [weekCaption(drawn, drawn.from, NOW), cut.filterText(null), cut.restText(null)];
  for (const b of cut.buckets) words.push(hourText(b), cut.filterText(b.hour), cut.restText(b.hour));
  words.push(rankRepos(drawn.convos, drawn.rest));
  for (const l of foldLaunches(drawn.convos, drawn.rest)) words.push(l.label, LAUNCH_KIND_WORD[l.kind] ?? l.kind);
  noLeak(words, label);
}

/** The all-time screen's readers over `/api/tokenstats`: the hero's split, insights, calendar spans,
 *  the live window cut and the trend. */
function replayStats(doc, label) {
  const words = [statsInsights(doc, NOW), allTimeUndatedText(doc), claudeCard(doc), splitLocal(doc)];
  for (const n of [1, 7, 30]) words.push(spanUndatedText(doc, calendarFrom(n, NOW)));
  const usage = { ok: true, sessionPct: 10, weeklyPct: 40, checkedAt: NOW,
    sessionResetAt: NOW + 2 * 3_600_000 + 59 * 60_000, weeklyResetAt: NOW + 3 * 86_400_000 + 59 * 60_000 };
  for (const spec of LIVE_WINDOWS) {
    const r = windowCut(spec, doc, usage, NOW);
    words.push(isCut(r) ? [r.long, r.label] : cutRefusalText(spec, r));
  }
  // The 7-day mean is cut point by point; a ledger whose undated records reach every point loses
  // the whole line, and that has to be the oldest-first run the rule implies, never a gap.
  const pts = doc.days.map((d) => ({ t: new Date(`${d.day}T00:00:00`).getTime() }));
  const kept = trendWithoutUndated(pts, doc);
  assert.deepEqual(kept, pts.slice(pts.length - kept.length), `${label}: the trend is cut from the oldest end`);
  noLeak(words, label);
}

test("the heatmap draws heatGrid's boxes, never windowGrid's (the readers above are what is on screen)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "WindowHeats.tsx"), "utf8");
  const heat = src.slice(src.indexOf("function WindowHeat("));
  assert.match(heat, /heatGrid\(grid\)/);
  assert.doesNotMatch(heat, /windowGrid\(/);
});

test("the corpus holds the last release and every undated generation", () => {
  assert.deepEqual(Object.keys(GENERATIONS), ORDER, "a new generation is named in ORDER too");
  for (const gen of ORDER) assert.deepEqual(Object.keys(GENERATIONS[gen]), DOCS, `${gen}: every route`);
});

for (const gen of ORDER) {
  test(`old host → this phone: tokenwindows from ${gen}`, () => replayWindows(load(gen, "tokenwindows"), gen));
  test(`old host → this phone: costwindow from ${gen}`, () => replayCost(load(gen, "costwindow"), gen));
  test(`old host → this phone: tokenstats from ${gen}`, () => replayStats(load(gen, "tokenstats"), gen));
}

/** The document with a value no build knows in each string slot a reader switches on, and an
 *  unknown field on every object — what a newer host adds before this bundle hears of it. */
function nextValue(doc) {
  const wrap = (v) => {
    if (Array.isArray(v)) return v.map(wrap);
    if (v && typeof v === "object") return { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrap(x)])), nextField: { nextValue: 1 } };
    return v;
  };
  const out = wrap(doc);
  const renameModels = (slices) => { for (const m of slices ?? []) m.model = `nextValue-${m.model}`; };
  // A grid kind this build does not draw rides beside the two it does.
  if (out.series) {
    out.series = [...out.series, { ...out.series[0], id: "nextValue" }];
    for (const s of out.series) for (const w of s.windows) renameModels(w.byModel);
  }
  // A launch kind this build has no word for (`CostLaunch.kind`), on the first conversation.
  if (out.convos?.length) {
    out.convos[0].launch = { kind: "nextValue", runId: "next-run", label: "a run this build never saw" };
    for (const c of out.convos) { renameModels(c.byModel); renameModels(c.agentByModel); }
  }
  if (out.models) renameModels(out.models);
  return out;
}

for (const gen of ORDER) {
  test(`new host → this phone: an unknown value and an unknown field change no sentence into a leak (${gen})`, () => {
    const windows = nextValue(load(gen, "tokenwindows"));
    replayWindows(windows, `nextValue(${gen})`);
    // The unknown grid kind is dropped, not drawn as a third grid.
    assert.deepEqual([...windowGrids(windows).keys()].sort(), ["session", "week"]);
    replayCost(nextValue(load(gen, "costwindow")), `nextValue(${gen}) costwindow`);
    replayStats(nextValue(load(gen, "tokenstats")), `nextValue(${gen}) tokenstats`);
  });
}
