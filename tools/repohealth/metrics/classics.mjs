/**
 * The magnitude numbers: how much code there is, where it is, and how much of
 * other people's code it depends on.
 *
 * ── Why these are stored and not plotted ────────────────────────────────────
 *
 * Total lines, file count, lines per package, dependency counts. None of them
 * is a health signal — a repo that grew from 2.8k to 143k lines in 95 days did
 * that because it was being written, and a plot of it says "work happened".
 * They are kept because every other row in this series is a RATE or a RANK,
 * and a rate with no magnitude behind it is unreadable: "duplicate pairs per
 * kLOC rose 8%" means one thing in a 3k-line repo and something else in a
 * 143k-line one. So these travel in the JSONL alongside the readings and are
 * rendered only when asked for — the denominator, on demand.
 *
 * ── Why the tape is capped at 50 ────────────────────────────────────────────
 *
 * `tape` is the per-file LOC list, biggest first: the thing you actually want
 * when a size row moves and you need to know which file moved it. Untruncated
 * it is 325 `{path, loc}` objects per row, 157 rows, and the JSONL stops being
 * a file a person can open — tens of megabytes of mostly 40-line modules, to
 * answer a question that is always about the top of the list. 50 is past the
 * point where the tail is flat here (the 50th file is already an order of
 * magnitude below the first) and small enough that a row stays one screen of
 * JSON. Nothing is lost that the rest of this row does not carry: `loc` is the
 * true total over ALL files, not the sum of the tape, and `files` is the true
 * count — so the truncation can never be mistaken for the repo shrinking.
 *
 * ── Why the breakdown is by GROUP and not by package ────────────────────────
 *
 * `packages/<x>` was a regex here. It is a fact about one monorepo's directory
 * names, and in a repo laid out any other way it put every file in one
 * unnamed bucket. The unit is now `Snapshot.groups` — derived per commit by
 * `snapshot.mjs`, which argues the rule out — and `groupOf` is how a path is
 * asked which one it is in. On this repo that reproduces `packages/<x>`
 * exactly, and the keys are now the group's own path (`packages/web`, `tools`,
 * `.` for a file at the root) rather than a bare label, because a label is not
 * unique across depths and the bucket for everything else used to be `""`.
 *
 * ── Dependencies ────────────────────────────────────────────────────────────
 *
 * `deps` and `devDeps` are counted separately and never summed. They are
 * different liabilities: a runtime dependency ships, is in the attack surface,
 * and has to keep working on the phone; a dev dependency is a build-time cost
 * and can be swapped on a Tuesday. A single "47 dependencies" number hides the
 * only distinction that matters.
 *
 * WHICH files are manifests, and what counting one means, are a package
 * manager's business and therefore a pack's: `Snapshot.manifests` is what the
 * active packs read, each row carrying the pack that read it and the
 * manifest's own DIRECTORY. `packages/app` is in this count although it is
 * deliberately not an npm workspace (Capacitor deps stay out of every root
 * `npm install`): its `package.json` still declares dependencies that a build
 * installs, so it is measured, and the per-directory breakdown is what keeps
 * that legible instead of folding it into a root total.
 *
 * A tree with no manifest reports `deps: null`, not zeros: "this commit has no
 * manifest" and "this project depends on nothing" are opposite claims. So does
 * a repo where no active pack reads manifests at all — the same shape, a
 * different reason, and neither of them a row of zeros over a language whose
 * manifest nothing opened.
 */

import { groupOf } from "../snapshot.mjs";
import { packFor, packsWith, reasonFor } from "./route.mjs";

/** See the header: a cap on what is WRITTEN, never on what is counted. */
const TAPE_CAP = 50;

/**
 * Which extension a source file is counted under, and which pack owns it.
 *
 * The LONGEST matching extension from the active packs, never a split on the
 * last dot: `.d.ts` and `.ts` are both claimed, a dot-split would file
 * `types.d.ts` under `ts`, and `packages/host/src/index.spec.ts` under `spec`.
 * The union in `SRC.exts` is what made this file source in the first place, so
 * asking it again is the same question answered by the same list — a second
 * rule here would file a file under a type no pack claims.
 *
 * The fallback exists for one case: a pack whose extension list changed inside
 * one process, which cannot happen today. It is the file's own suffix, marked
 * so a reader can see it was not claimed rather than reading it as a language.
 */
function typeOf(path, prereg) {
  let ext = "";
  for (const e of prereg.SRC?.exts ?? []) {
    if (path.endsWith(e) && e.length > ext.length) ext = e;
  }
  if (!ext) {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    ext = dot > slash + 1 ? path.slice(dot) : "";
  }
  return { ext: ext || "(no extension)", pack: packFor(path, prereg)?.name ?? null };
}

/**
 * The tape as LINE COUNTS, from whatever shape the row on disk holds.
 *
 * The tape is written as `{path, loc}` objects, and two readers want only the
 * numbers. Both wrote their own conversion; one of them didn't. `html.mjs`
 * passed the objects straight into arithmetic, which is silent in JavaScript
 * in the worst possible way: `obj - obj` is `NaN`, so `sort` left the list
 * untouched, every bar height came out `NaN` and rendered as nothing, the
 * median printed as an em dash, and `findIndex(v => v >= 1352)` found no
 * object greater than a number and parked the p95 rule at the far right edge.
 * An empty chart with one rule against it, and no error anywhere.
 *
 * So the conversion lives HERE, next to the writer that chose the shape, and
 * both readers call it. It accepts a bare number too, because a future row
 * shape that drops the paths must not break the page that reads it.
 *
 * @param {unknown} raw
 * @returns {number[]} line counts in the tape's own order, holes dropped.
 */
export function tapeLines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const v = typeof t === "number" ? t : t && typeof t === "object" ? t.loc : null;
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * The tape's PATHS, one per entry `tapeLines` keeps and in the same order, so
 * index i of both names the same bar. A bare-number row (a shape with no
 * paths) gives null at that index: the bar is still drawn, it just cannot be
 * named or opened.
 *
 * @param {unknown} raw
 * @returns {(string|null)[]}
 */
export function tapePaths(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const v = typeof t === "number" ? t : t && typeof t === "object" ? t.loc : null;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push(t && typeof t === "object" && typeof t.path === "string" ? t.path : null);
  }
  return out;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} history
 * @param {number} index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<object>}
 */
export function measureClassics(snapshot, history, index, prereg) {
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files at this commit" };

  const groups = snapshot.groups ?? [];
  let loc = 0;
  /** @type {Map<string, {pkg: string, files: number, loc: number}>} */
  const byPkg = new Map();
  /** The same tree cut the other way — see `types` below. */
  const byType = new Map();
  for (const f of files) {
    loc += f.loc;
    const pkg = groupOf(f.path, groups);
    let row = byPkg.get(pkg);
    if (!row) byPkg.set(pkg, (row = { pkg, files: 0, loc: 0 }));
    row.files++;
    row.loc += f.loc;

    const { ext, pack } = typeOf(f.path, prereg);
    let t = byType.get(ext);
    if (!t) byType.set(ext, (t = { ext, pack, files: 0, loc: 0 }));
    t.files++;
    t.loc += f.loc;
  }

  // Descending by LOC, ties broken by path ascending — without the tie-break
  // two equally sized files can swap places between runs and fail the fixture
  // on a difference that is not one.
  const tape = files
    .map((f) => ({ path: f.path, loc: f.loc }))
    .sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, TAPE_CAP);

  const manifests = snapshot.manifests ?? [];
  const readers = packsWith(prereg, "manifests");
  // `deps: null` is the shape a tree with no manifest already had, and the
  // reason beside it is what tells the two absences apart: a repo that
  // declares nothing, and a repo whose manifest no active pack can read. A
  // reader who cannot tell those apart would go looking for a `package.json`
  // that was never going to be counted.
  let deps = null;
  let depsReason = "no dependency manifest in this tree";
  if (readers.length === 0) {
    depsReason = reasonFor(prereg, (p) =>
      typeof p.pack.manifests === "function" ? null : "no dependency manifest is defined for this language",
    );
  } else if (manifests.length > 0) {
    let total = 0;
    let totalDev = 0;
    // One row per MANIFEST, labelled by its directory. Two packs reading two
    // manifests in one directory (a `package.json` and some other language's
    // beside it) are two declarations and therefore two rows; they would
    // share a label, which is a display nit and not a lost count, and the
    // totals below are over the rows either way.
    const perPkg = manifests
      .map((m) => ({ pkg: m.pkg, deps: m.deps, devDeps: m.devDeps }))
      .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
    for (const m of perPkg) {
      total += m.deps;
      totalDev += m.devDeps;
    }
    deps = { deps: total, devDeps: totalDev, byPkg: perPkg };
  }

  return {
    value: {
      files: files.length,
      loc,
      packages: [...byPkg.values()].sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0)),
      // The same lines counted by WHAT they are rather than by where they
      // live. A group tells you which part of the tree grew; a type tells you
      // what grew in it, and in a monorepo those are different questions with
      // the same answer often enough that having only one of them is how a
      // reader concludes the wrong thing about the other. In name order, for
      // the reason `packages` is: a colour on the drawing end follows a key,
      // and a key whose position depends on its size this morning is a colour
      // that changes hands.
      types: [...byType.values()].sort((a, b) => (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0)),
      tape,
      tapeCap: TAPE_CAP,
      deps,
      // Present only where `deps` is null — an absence carries a reason, and a
      // reading does not need an excuse beside it.
      ...(deps === null ? { depsReason } : {}),
    },
  };
}
