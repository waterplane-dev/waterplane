/**
 * The demo's repo-health series: one fictional, self-consistent `RepoHealthView` per demo repo.
 *
 * Pure and deterministic — no DOM, no clock but the `now` it is handed (reduced to the LOCAL DAY, so
 * the document does not change within a day), no randomness. Every figure is a fold of ONE underlying
 * model per repo, so the tiles and the table cannot disagree:
 *   - the longest file, the tape and p95 are all read off the same top-12 file list (p95 is the file
 *     at nearest-rank 95 of that day's file count, so it is always one of the tape's entries);
 *   - source lines are the sum of the groups, and the file TYPES re-cut the same total;
 *   - a rate carries the two integers it came from (re-touches/touches, hatches/lines, untested/files).
 * `parseRepoHealthPlot` accepts the plot (the real host's reader), which the tests assert.
 */
import type {
  RepoHealthPlot, RepoHealthPlotSeries, RepoHealthPoint, RepoHealthReading, RepoHealthView,
} from "@waterplane/shared";

const DAY = 86_400_000;
const WINDOW_READINGS = 60;
const MIN_READINGS = 14;
const RETOUCH_WINDOW_DAYS = 14;
const SPAN_DAYS = 27;

interface FileSpec { path: string; start: number; end: number }
interface Profile {
  name: string;
  groups: { pkg: string; start: number; end: number }[];
  /** File types as a share of the lines; the last takes the remainder. */
  types: { ext: string; pack: string | null; share: number }[];
  files: [number, number];
  deps: [number, number];
  top: FileSpec[];
  hatches: [number, number];
  claudeMd: [number, number];
  desc: [number, number];
  skills: [number, number];
  untested: [number, number];
  retouch: [number, number];
  touches: [number, number];
  offenders: { path: string; n: number }[];
  commits: number;
}

const PROFILES: Profile[] = [
  {
    name: "todo-garden",
    groups: [{ pkg: "app", start: 2_950, end: 4_380 }, { pkg: "lib", start: 710, end: 1_090 }, { pkg: ".", start: 64, end: 72 }],
    types: [{ ext: ".tsx", pack: "TypeScript", share: 0.46 }, { ext: ".ts", pack: "TypeScript", share: 0.44 }, { ext: ".mjs", pack: "JavaScript", share: 0.1 }],
    files: [34, 47], deps: [6, 8], hatches: [9, 12], claudeMd: [2_150, 3_240], desc: [640, 990], skills: [2, 4],
    untested: [11, 8], retouch: [0.31, 0.22], touches: [38, 52], commits: 211,
    top: [
      { path: "app/store.ts", start: 292, end: 318 }, { path: "app/GardenView.tsx", start: 140, end: 344 },
      { path: "app/PlantSheet.tsx", start: 168, end: 281 }, { path: "lib/watering.ts", start: 150, end: 236 },
      { path: "app/App.tsx", start: 122, end: 214 }, { path: "lib/schedule.ts", start: 118, end: 187 },
      { path: "app/Reminders.tsx", start: 71, end: 171 }, { path: "app/sync.ts", start: 104, end: 152 },
      { path: "lib/seasons.ts", start: 96, end: 131 }, { path: "app/theme.ts", start: 88, end: 119 },
      { path: "app/Settings.tsx", start: 52, end: 108 }, { path: "lib/format.ts", start: 70, end: 94 },
    ],
    offenders: [{ path: "app/GardenView.tsx", n: 6 }, { path: "app/store.ts", n: 4 }, { path: "app/PlantSheet.tsx", n: 3 }],
  },
  {
    name: "pocket-notes",
    groups: [{ pkg: "src", start: 4_620, end: 6_240 }, { pkg: "server", start: 1_380, end: 2_110 }, { pkg: "shared", start: 360, end: 520 }],
    types: [{ ext: ".tsx", pack: "TypeScript", share: 0.38 }, { ext: ".ts", pack: "TypeScript", share: 0.55 }, { ext: ".css", pack: null, share: 0.07 }],
    files: [52, 71], deps: [11, 14], hatches: [18, 17], claudeMd: [3_050, 3_960], desc: [1_120, 1_480], skills: [4, 6],
    untested: [19, 15], retouch: [0.27, 0.19], touches: [51, 66], commits: 342,
    top: [
      { path: "src/Editor.tsx", start: 310, end: 402 }, { path: "server/search.ts", start: 228, end: 361 },
      { path: "src/NoteList.tsx", start: 204, end: 296 }, { path: "server/sync.ts", start: 180, end: 274 },
      { path: "src/markdown.ts", start: 166, end: 232 }, { path: "src/App.tsx", start: 150, end: 211 },
      { path: "server/db.ts", start: 122, end: 198 }, { path: "src/Tags.tsx", start: 90, end: 177 },
      { path: "shared/types.ts", start: 118, end: 160 }, { path: "src/offline.ts", start: 80, end: 148 },
      { path: "src/Toolbar.tsx", start: 76, end: 126 }, { path: "server/auth.ts", start: 60, end: 109 },
    ],
    offenders: [{ path: "src/Editor.tsx", n: 7 }, { path: "server/search.ts", n: 5 }, { path: "src/NoteList.tsx", n: 3 }],
  },
  {
    name: "trail-log",
    groups: [{ pkg: "app", start: 1_840, end: 2_760 }, { pkg: "tools", start: 240, end: 310 }],
    types: [{ ext: ".ts", pack: "TypeScript", share: 0.58 }, { ext: ".tsx", pack: "TypeScript", share: 0.34 }, { ext: ".mjs", pack: "JavaScript", share: 0.08 }],
    files: [22, 29], deps: [4, 5], hatches: [5, 4], claudeMd: [1_480, 2_020], desc: [380, 520], skills: [1, 2],
    untested: [6, 4], retouch: [0.36, 0.28], touches: [25, 33], commits: 118,
    top: [
      { path: "app/MapScreen.tsx", start: 176, end: 262 }, { path: "app/gpx.ts", start: 188, end: 241 },
      { path: "app/TrackStore.ts", start: 130, end: 205 }, { path: "app/elevation.ts", start: 92, end: 166 },
      { path: "app/App.tsx", start: 84, end: 138 }, { path: "app/Stats.tsx", start: 40, end: 124 },
      { path: "tools/export.mjs", start: 70, end: 98 }, { path: "app/units.ts", start: 58, end: 82 },
      { path: "app/Photos.tsx", start: 30, end: 77 }, { path: "app/theme.ts", start: 44, end: 61 },
      { path: "app/Settings.tsx", start: 26, end: 54 }, { path: "app/format.ts", start: 30, end: 41 },
    ],
    offenders: [{ path: "app/MapScreen.tsx", n: 5 }, { path: "app/gpx.ts", n: 4 }, { path: "app/TrackStore.ts", n: 2 }],
  },
];

/** A stable 32-bit hash to [0,1). */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const hex7 = (seed: string) => Array.from({ length: 7 }, (_, i) => "0123456789abcdef"[Math.floor(unit(`${seed}:${i}`) * 16)]).join("");
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function hasDemoRepoHealth(repoName: string): boolean {
  return PROFILES.some((p) => p.name === repoName);
}

/** The reading of a series: percentile as a fraction among the trailing readings, and the slope's sign. */
function readingOf(vals: number[], plain: boolean): RepoHealthReading {
  const have = vals.slice(-WINDOW_READINGS);
  const from = null;
  if (plain) return { rank: null, slope: null, n: have.length, from, reason: "a count whose direction carries no claim, so it is drawn and not ranked" };
  if (have.length < MIN_READINGS) return { rank: null, slope: null, n: have.length, from, reason: `only ${have.length} readings; a rank needs ${MIN_READINGS}` };
  const last = have[have.length - 1];
  const rank = have.filter((v) => v <= last).length / have.length;
  const delta = last - have[0];
  const scale = Math.max(Math.abs(have[0]), Math.abs(last), 1e-9);
  const slope = Math.abs(delta) / scale < 0.02 ? "flat" : delta > 0 ? "rising" : "falling";
  return { rank: Math.round(rank * 100) / 100, slope, n: have.length, from };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function demoRepoHealth(repoName: string, now: number): RepoHealthView | null {
  const p = PROFILES.find((x) => x.name === repoName);
  if (!p) return null;

  const today = new Date(now); today.setHours(12, 0, 0, 0);
  // About one reading a day over four weeks, with a few days nothing was committed.
  const offsets: number[] = [];
  for (let k = SPAN_DAYS; k >= 0; k--) if (k === 0 || (k * 5 + p.name.length) % 7 !== 2) offsets.push(k);
  const n = offsets.length;
  const days = offsets.map((k) => dayOf(today.getTime() - k * DAY));
  const sha = days.map((d) => hex7(`${p.name}:${d}`));
  const T = offsets.map((_, i) => (n === 1 ? 1 : i / (n - 1)));
  // Growth is slightly front-loaded and carries a little stable wobble (none on the last day).
  const g = (i: number) => Math.pow(T[i], 0.85);
  const wob = (i: number, tag: string, amp: number) => (unit(`${p.name}:${tag}:${i}`) - 0.5) * 2 * amp * (i === n - 1 ? 0 : 1);
  const mix = (a: number, b: number, i: number, tag: string, amp = 0) => lerp(a, b, g(i)) + wob(i, tag, amp);
  const pts = (f: (i: number) => number | null): RepoHealthPoint[] => days.map((day, i) => ({ day, sha7: sha[i], v: f(i) }));

  // Lines, by group and by type: both cut the same total.
  const groupLoc = p.groups.map((gr) => offsets.map((_, i) => Math.round(mix(gr.start, gr.end, i, `g:${gr.pkg}`, gr.end * 0.004))));
  const loc = offsets.map((_, i) => groupLoc.reduce((s, a) => s + a[i], 0));
  const files = offsets.map((_, i) => Math.round(lerp(p.files[0], p.files[1], g(i))));
  const lastT = p.types.length - 1;
  const typeLoc = p.types.map((ty, ti) => offsets.map((_, i) => (ti === lastT ? 0 : Math.round(loc[i] * ty.share))));
  for (let i = 0; i < n; i++) typeLoc[lastT][i] = loc[i] - typeLoc.reduce((s, a, ti) => (ti === lastT ? s : s + a[i]), 0);
  const typeFiles = p.types.map((ty, ti) => (ti === lastT ? 0 : Math.round(files[n - 1] * ty.share)));
  typeFiles[lastT] = files[n - 1] - typeFiles.reduce((s, x, ti) => (ti === lastT ? s : s + x), 0);

  // File lengths: tape, longest and p95 from one list.
  const lensAt = (i: number) => p.top
    .map((f) => ({ path: f.path, len: Math.round(lerp(f.start, f.end, Math.pow(T[i], 0.8))) }))
    .sort((a, b) => b.len - a.len || (a.path < b.path ? -1 : 1));
  const p95At = (i: number) => lensAt(i)[Math.max(0, Math.ceil(0.05 * files[i]) - 1)].len;
  const tape = lensAt(n - 1);

  // Rates carry the integers they came from.
  const touches = offsets.map((_, i) => Math.round(mix(p.touches[0], p.touches[1], i, "touch", 3)));
  const retouches = touches.map((t, i) => Math.round(t * mix(p.retouch[0], p.retouch[1], i, "rt", 0.025)));
  const rate = touches.map((t, i) => Math.round((retouches[i] / t) * 100) / 100);
  const hatches = offsets.map((_, i) => Math.max(1, Math.round(mix(p.hatches[0], p.hatches[1], i, "hatch", 0.8))));
  const perKloc = hatches.map((h, i) => Math.round((h / (loc[i] / 1000)) * 10) / 10);
  const untested = offsets.map((_, i) => Math.min(files[i], Math.max(0, Math.round(mix(p.untested[0], p.untested[1], i, "unt", 0.7)))));
  const claudeMd = offsets.map((_, i) => Math.round(mix(p.claudeMd[0], p.claudeMd[1], i, "cmd", 40)));
  const desc = offsets.map((_, i) => Math.round(mix(p.desc[0], p.desc[1], i, "desc", 8)));
  const skills = offsets.map((_, i) => Math.round(lerp(p.skills[0], p.skills[1], T[i] < 0.5 ? T[i] * 0.6 : 0.3 + (T[i] - 0.5) * 1.4)));

  const last = n - 1;
  const mk = (key: string, label: string, unitName: string, vals: number[], detail: string, plain = false): RepoHealthPlotSeries => ({
    key, label, unit: unitName, points: pts((i) => vals[i]), last: vals[last], reading: readingOf(vals, plain), detail,
  });
  const retouchTop = p.offenders.map((o) => `${o.path} at ${plural(o.n, "re-touch", "re-touches")}`).join(", ");
  const series: RepoHealthPlotSeries[] = [
    mk("size.p95", "p95 file length", "lines", offsets.map((_, i) => p95At(i)), ""),
    mk("retouch.rate", "the re-touch rate", "", rate,
      ` ${plural(retouches[last], "re-touch", "re-touches")} out of ${plural(touches[last], "touch", "touches")} over ${RETOUCH_WINDOW_DAYS} days. The ${p.offenders.length} most re-touched: ${retouchTop}.`),
    mk("hatches.perKloc", "escape hatches per kLOC", "", perKloc,
      ` ${plural(hatches[last], "occurrence", "occurrences")} over ${plural(loc[last], "line", "lines")}.`),
    mk("context.claudeMdChars", "CLAUDE.md", "chars", claudeMd, ""),
    mk("context.descChars", "the always-on skill descriptions", "chars", desc, ""),
    mk("context.skillCount", "the count of skills", "", skills, "", true),
    mk("untested.count", "the count of modules no test names", "", untested,
      ` ${untested[last].toLocaleString("en-US")} of ${plural(files[last], "module", "modules")} in the tree.`),
  ];

  const holders = offsets.map((_, i) => lensAt(i)[0]);
  const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : 1);
  const packages = p.groups.map((gr, gi) => ({ name: gr.pkg, loc: groupLoc[gi][last], points: pts((i) => groupLoc[gi][i]) }));
  const ranked = [...packages].sort((a, b) => b.loc - a.loc || byName(a, b));
  const types = p.types.map((ty, ti) => ({ name: ty.ext, pack: ty.pack, files: typeFiles[ti], loc: typeLoc[ti][last], points: pts((i) => typeLoc[ti][i]) }));
  const rankedTypes = [...types].sort((a, b) => b.loc - a.loc || byName(a, b));

  const plot: RepoHealthPlot = {
    scope: null,
    preregVersion: "3",
    windowReadings: WINDOW_READINGS,
    minReadings: MIN_READINGS,
    days: n,
    series,
    context: {
      areas: {},
      areasAbsent: "No skill in this repo routes to another, so there are no areas to split the always-on weight by; the repo-wide weight above still stands.",
    },
    classics: {
      loc: pts((i) => loc[i]),
      files: pts((i) => files[i]),
      deps: pts((i) => Math.round(lerp(p.deps[0], p.deps[1], T[i] < 0.6 ? 0 : (T[i] - 0.6) / 0.4))),
      packages: [...packages].sort(byName).map((x) => ({ pkg: x.name, rank: ranked.findIndex((r) => r.name === x.name), points: x.points })),
      types: [...types].sort(byName).map((t) => ({ ext: t.name, pack: t.pack, rank: rankedTypes.findIndex((r) => r.name === t.name), files: t.files, points: t.points })),
      tape: tape.map((t) => t.len),
      tapePaths: tape.map((t) => t.path),
    },
    longest: {
      points: pts((i) => holders[i].len),
      paths: holders.map((h) => h.path),
      path: holders[last].path,
      day: days[last],
    },
  };

  const lastTs = today.getTime() - 40 * 60_000;
  const rows = Math.max(n, Math.round(p.commits * 0.4));
  return {
    scope: null,
    scopes: [],
    tool: true,
    engine: { kind: "bundled" },
    head: { sha: `${sha[last]}${hex7(`${p.name}:head`).slice(0, 5)}`, ts: lastTs },
    series: {
      preregVersion: "3", rows, days: n, lastSha: sha[last], lastDay: days[last], lastTs,
      versions: [{ version: "3", rows }], staleRows: 0,
    },
    measure: {
      commits: p.commits,
      packs: [{ name: "TypeScript", version: "2", files: types.reduce((s, t) => (t.pack === "TypeScript" ? s + t.files : s), 0) }],
      groups: p.groups.map((gr) => gr.pkg),
      engineVersion: "3",
      recut: null,
      scope: null,
    },
    readError: null,
    stepTimeoutMs: 120_000,
    behind: 0,
    narrative: null,
    page: null,
    run: null,
    last: null,
    plot,
    plotError: null,
    readAt: now,
  };
}
