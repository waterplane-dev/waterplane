/**
 * What this particular repo is made of, and the effective configuration that
 * falls out of it.
 *
 * ── The two halves of a definition, and why only one of them is pinned ──────
 *
 * `constants.mjs` holds the METHOD: the rank window, the minimum number of
 * readings, the slope flatness, the LOC convention, the re-touch clocks, the
 * batch cutoff, the LSH parameters. Those are what make two readings the same
 * kind of reading, and they are identical in every repo — which is exactly why
 * they are frozen in one block, committed, and versioned by hand.
 *
 * This module supplies the other half: the SHAPE of the tree in front of it.
 * Which extensions are source, which files are tests, which escape hatches can
 * even exist. That half cannot be pinned, because it is not the same anywhere:
 * `SRC_EXT: [".ts", ".tsx"]` is a true statement about waterplane and a false one
 * about the five Kotlin repos next to it, and a constant that is false
 * somewhere is worse than a derived value, because it looks decided.
 *
 * The split is what makes a cross-repo comparison meaningful at all. Two repos
 * measured by this engine agree on HOW a value is read against its own past —
 * same window, same minimum, same flatness, same day boundary — and disagree
 * only about which files were read, which is a fact about them and not about
 * the measurement. Merging the two halves in either direction breaks that:
 * pin the shape and you measure the wrong files, derive the method and you get
 * two series that are each internally consistent and cannot be put side by
 * side.
 *
 * ── Why the version string has two halves too ───────────────────────────────
 *
 * Every row on disk carries `prereg: <string>`, and `series.mjs`'s
 * `preregVersions`, `warnMixed` and `refuseMixedPrereg` compare it to decide
 * whether two rows were computed under the same definitions. One string had to
 * carry both halves or the comparison would go blind to one of them.
 *
 * So `VERSION` is `<PREREG_VERSION>+<hash8>`: the left half is the method, the
 * right half is a hash of the ACTIVE packs and their versions. An engine bump
 * moves the left half in every repo at once, which is right — the method
 * changed everywhere. A pack bump, or a pack activating because somebody
 * committed the first `.ts` file into a Python repo, moves the right half and
 * only where it applies. A reader looking at a mixed series can then see which
 * kind of change happened without opening the code.
 *
 * ── Why nothing else HEAD-derived is in the hash ────────────────────────────
 *
 * Only the pack list. Not the source groups, not the areas, not the skill
 * names — those are derived PER SNAPSHOT, from the tree at each sha, so a row
 * stays reproducible from its own sha and needs no help from the version
 * string. Putting them in the hash would also make the hash move for reasons
 * that are not definition changes: renaming a skill would re-cut the version
 * and `refuseMixedPrereg` would throw out the whole series. That is not
 * hypothetical — four skills were renamed on 2026-09-21 alone.
 *
 * ── Why the tree is read with `ls-tree` and never `ls-files` ────────────────
 *
 * `git.mjs`'s header states the rule this module is the newest reader of:
 * every reader here addresses a COMMITTED OBJECT and never the index, HEAD's
 * worktree, or a file on disk. The tree is shared with other sessions and is
 * dirty at all times — two dozen modified files at any moment — so
 * `git ls-files` would activate a pack on a file somebody else was halfway
 * through writing, and deactivate one on a deletion nobody has committed. The
 * pack list would then depend on when the tool happened to run. `git.mjs` is
 * also the only module allowed to spawn a process, so the reader lives there
 * and this module receives it.
 */
import { createHash } from "node:crypto";
import { PREREG, PREREG_VERSION } from "./constants.mjs";
import { PACKS } from "./packs/index.mjs";
// The routing rule, borrowed rather than copied: `files` below has to count a
// path for the same pack a parser would be handed it for, and two
// implementations of "which pack owns this extension" is two answers.
import { packFor } from "./metrics/route.mjs";
import { inExcludedDir, isSource } from "./source.mjs";

/**
 * The directory names no pack's language owns — build output and vendored
 * code — read from the packs that are active in EVERY repo.
 *
 * The list itself lives in `packs/common.mjs`, with the argument for each name
 * on it. It moved there because a definition that changes what is measured has
 * to be inside something the version string covers: as a constant in this file
 * it was in neither `PREREG` nor the pack hash, so adding a name silently
 * re-cut every repo's series and left `warnMixed` comparing two vintages that
 * carry the same string. `common` is active everywhere and its version is
 * hashed, so now the string moves with the list.
 *
 * Read from the ALWAYS-ON packs and refused from any other, because this list
 * is needed BEFORE the tree is scanned — the scan is what decides which
 * language packs are active — and a list that arrived with activation could
 * not have filtered the scan that produced it. A language pack that wants a
 * directory of its own excluded is therefore a change of shape here and not a
 * key it can quietly add; the refusal says so rather than letting the
 * activation pass and the source pass disagree about what is vendored.
 */
function excludeDirsOf(packs) {
  const always = packs.filter((p) => p.always === true);
  const claimed = packs.filter((p) => p.always !== true && (p.excludeDirs?.length ?? 0) > 0);
  if (claimed.length) {
    throw new Error(
      `the ${claimed.map((p) => p.name).join(", ")} pack declares excludeDirs, and only an always-on ` +
        `pack may. The list is applied to the tree scan that decides which language packs are active, ` +
        `so a pack that has to be activated first cannot contribute to it — the two passes would then ` +
        `disagree about which files are vendored. Put the name in packs/common.mjs.`,
    );
  }
  const out = new Set();
  for (const p of always) for (const d of p.excludeDirs ?? []) out.add(d);
  return Object.freeze([...out]);
}

/**
 * Which packs the tree at HEAD activates, with the file count that activated
 * each.
 *
 * A pack is active when at least ONE file at HEAD carries one of its
 * extensions — one, not a proportion and not a threshold. A threshold would be
 * a pinned judgment about how much of a language counts as "written in" it,
 * chosen after seeing the fleet, and it would make the pack list flicker as a
 * repo's mix drifts across it. One file is a fact.
 *
 * `extFiles` is how many files did activate it. It is the activation evidence
 * and nothing else: an extension count outside the excluded directories,
 * before the test globs and the excluded suffixes have had a say.
 *
 * `common` carries `always: true` and activates with `extFiles: 0`, which is
 * the literal truth — it claims no extensions, so no file activated it. It is
 * there so the pack list is never empty and `HATCH_KINDS` always has a shape.
 */
function activate(paths, packs, excludeDirs) {
  const counts = new Map(packs.map((p) => [p.name, 0]));
  for (const path of paths) {
    if (inExcludedDir(path, excludeDirs)) continue;
    for (const p of packs) {
      if (p.exts.length && p.exts.some((e) => path.endsWith(e))) counts.set(p.name, counts.get(p.name) + 1);
    }
  }
  return packs
    .filter((p) => p.always === true || counts.get(p.name) > 0)
    .map((p) => ({ name: p.name, version: p.version, extFiles: counts.get(p.name), pack: p }));
}

/**
 * `files` per pack: the MEASURED population, which is the only count that can
 * be called a denominator.
 *
 * `metrics/route.mjs` prints this beside an absence — "(kotlin, 176 files at
 * HEAD)" — as the size of the thing the silence is about. It used to print
 * the activation count, which applies the excluded directories and nothing
 * else, so the number beside the absence was not the number the metrics ran
 * over. Measured at HEAD: `Tiptoi`'s Kotlin read 242 against a population of
 * 176, its Python 140 against 79, and this repo's TypeScript 646 against 385.
 * A denominator that is not the denominator is worse than none, because it is
 * checkable and wrong.
 *
 * So the count is `isSource` — the same predicate every metric filters
 * against — plus `packFor`, the same routing rule the parsers use, so a file
 * is counted for exactly one pack and for the pack that would read it. The
 * two numbers are then different questions with different answers, and both
 * are published: `extFiles` says what made this pack active, `files` says how
 * much of the tree it accounts for. A pack whose every file is a test or is
 * vendored is active with `files: 0`, which is the true statement — the pack
 * is on because the language is in the tree, and none of it is in the
 * measured population.
 */
function countSource(paths, active, cfg) {
  const counts = new Map(active.map((a) => [a.name, 0]));
  for (const path of paths) {
    if (!isSource(path, cfg)) continue;
    const owner = packFor(path, cfg);
    if (owner) counts.set(owner.name, counts.get(owner.name) + 1);
  }
  return active.map((a) => Object.freeze({ ...a, files: counts.get(a.name) }));
}

/**
 * The hatch kinds of every active pack, merged — and a thrown error rather
 * than a silent shadow when two packs claim one name.
 *
 * The `hatches` row is `Record<kind, number>` and the "a new kind of escape
 * hatch appeared" tripwire fires on a kind NAME. If two packs both defined
 * `todo`, one of them would win the merge, the row would carry a single count
 * that is neither pack's, and the tripwire would fire — or fail to — on a
 * number nobody can trace to a pattern. There is no correct silent resolution,
 * so there is no silent resolution: the engine refuses to run.
 */
function mergeHatchKinds(active) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const a of active) {
    for (const [kind, src] of Object.entries(a.pack.hatchKinds ?? {})) {
      if (owner.has(kind)) {
        throw new Error(
          `hatch kind "${kind}" is claimed by both the ${owner.get(kind)} and ${a.name} packs. ` +
            `A kind name is what the new-hatch tripwire fires on, so one shadowing the other ` +
            `would report a count that belongs to neither. Rename one of them.`,
        );
      }
      owner.set(kind, a.name);
      out[kind] = src;
    }
  }
  // Sorted, like every other key order in this tool: the row is written by
  // `JSON.stringify` and a merge order change would rewrite bytes on disk
  // without changing a single count.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return Object.freeze(sorted);
}

/** The union of one field over the active packs, de-duplicated and sorted. */
function union(active, field) {
  const out = new Set();
  for (const a of active) for (const v of a.pack[field] ?? []) out.add(v);
  return Object.freeze([...out].sort());
}

/**
 * `<PREREG_VERSION>+<hash8>` — see the header for why it is two halves.
 *
 * The hash is over the canonical JSON of the sorted `name@version` list and
 * nothing else. Sorted so that reordering `packs/index.mjs` cannot re-cut a
 * history; JSON so the separator can never be confused with a character in a
 * name; sha1 truncated to 8 because this is an identity tag for a handful of
 * combinations, not a security boundary.
 */
function versionOf(active) {
  const ids = active.map((a) => `${a.name}@${a.version}`).sort();
  const hash = createHash("sha1").update(JSON.stringify(ids)).digest("hex").slice(0, 8);
  return `${PREREG_VERSION}+${hash}`;
}

/**
 * The effective configuration for one repo: `PREREG` plus everything derived
 * from what is actually in the tree.
 *
 * The result has the same shape every `measure*` already receives as `prereg`,
 * so no metric has to know that some of its configuration is derived. What it
 * adds:
 *
 *   - `PACKS`  the active packs, each with two counts and the pack module
 *              itself. `extFiles` is what activated it; `files` is how much of
 *              the MEASURED population it accounts for, which is the number
 *              `metrics/route.mjs` prints beside an absence. The module
 *              travels because two metrics need behaviour and not just data —
 *              `dups` and `deadExports` need a parser, `untested` needs the
 *              language's rule for how a test names a module — and routing a
 *              file to its pack needs the pack's own extension list.
 *   - `SRC`    the union of the active packs' source extensions, excluded
 *              suffixes and test globs, plus the excluded directories, which
 *              `packs/common.mjs` owns and which are therefore the same
 *              everywhere. `source.mjs` is the only reader.
 *   - `HATCH_KINDS`  merged, collision-checked, sorted.
 *   - `VERSION`      the two-part version string every row records.
 *
 * `SRC.exts` is EMPTY in a repo no pack claims, and that is the correct
 * intermediate state rather than a failure: `isSource` then answers false for
 * everything, the snapshot holds no source files, and every metric over that
 * population returns `{value: null, reason}`. A repo whose language this
 * engine cannot read says so, in every row, forever — which is the whole
 * reason the packs exist.
 *
 * @param {string} root  The repo to configure for. Never `process.cwd()`.
 * @param {typeof import("./git.mjs")} git  Injected so this module spawns
 *   nothing; `git.mjs` is the one place allowed to.
 * @param {readonly object[]} [packs]  The registry. A parameter only so a test
 *   can configure against a pack it built by hand.
 */
/** The head paths of one subtree, re-rooted — the same cut `scope.mjs` makes
 *  of a commit's tree, applied to the path list the census reads. */
function scopePaths(paths, scope) {
  if (!scope) return paths;
  const pre = `${scope}/`;
  return paths.filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length));
}

export function configure(root, git, packs = PACKS, scope = null) {
  // Under a SCOPE the census is of the subtree, not of the repo. It has to be:
  // activation is "which languages are in this tree", and a subtree of a
  // polyglot monorepo is a different answer — a Kotlin pack activated by an
  // app nobody asked about would report "no parser for kotlin" as the reason a
  // number is missing from a directory with no Kotlin in it. The counts beside
  // each pack are the denominators of every absence, so they follow too.
  const paths = scopePaths(git.listHeadPaths(root), scope);
  const excludeDirs = excludeDirsOf(packs);
  const active = activate(paths, packs, excludeDirs);

  // Built in two passes because the second needs the first: `isSource` is the
  // union of the ACTIVE packs' extensions, suffixes and test globs, so the
  // per-pack source count cannot exist until the config that defines source
  // does. The intermediate is never returned — `files` is missing from its
  // packs, and a config with a half-populated pack list escaping this
  // function is exactly how a denominator goes wrong twice.
  const config = {
    ...PREREG,
    PACKS: Object.freeze(active),
    SRC: Object.freeze({
      exts: union(active, "exts"),
      excludeSuffixes: union(active, "excludeSuffixes"),
      excludeDirs,
      testGlobs: union(active, "testGlobs"),
    }),
    HATCH_KINDS: mergeHatchKinds(active),
    VERSION: versionOf(active),
  };

  return Object.freeze({ ...config, PACKS: Object.freeze(countSource(paths, active, config)) });
}
