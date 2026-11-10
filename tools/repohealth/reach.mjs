/**
 * What the active packs could READ, per language — the row's `reach` field.
 *
 * ── Why the row needs it ───────────────────────────────────────────────────
 *
 * A metric that runs over a mixed tree reads only the files whose pack has
 * the rule it needs, and its VALUE does not say so. `untested` lists the
 * modules no test reaches among the files whose pack has a mention rule; a
 * Dart file (no rule) is skipped — neither listed nor counted as reached —
 * while the index divides by EVERY source file (`classics.files`). In
 * picture-app (2026-11-08: 391 of 537 source files Dart) that read 66 untested
 * of 537, 12%, under the good line, and the health index said 100 with most
 * of the code never opened. The skip was honest inside the metric; the number
 * built on it was not.
 *
 * So the row states, per active source pack, how many files it holds and
 * which index dimensions it can read. The index
 * (`packages/shared/src/healthindex/coverage.ts`) turns that into "measured" or
 * "unknown" per dimension and caps the headline by the share measured. This
 * file DESCRIBES the packs and judges nothing.
 *
 * ── What "reads" means, per dimension ──────────────────────────────────────
 *
 *   - `untested`: the pack has BOTH `mentions` and `keysFor` — exactly the
 *     test `metrics/untested.mjs` applies before it reads a file at all.
 *   - `hatches`: the pack contributes at least one escape-hatch kind of its
 *     own. `common`'s TODO/FIXME are counted in every language, but a language
 *     whose own escapes (Dart's `// ignore:`, `!`, `dynamic`) are not
 *     recognised is not measured for escape hatches by TODO counts alone.
 *
 *   - `dups`, `deadExports`: the pack's `analyzer()` returns a parser — the
 *     test `metrics/route.mjs` `analyzers()` applies.
 *   - `cycles`: the pack has the import-graph rule `metrics/graph.mjs` needs
 *     (`graphImports`, `keysFor`, `graphKeysFor`).
 *
 * Later index entries (analyzer findings) add their own rule here when they
 * join the index; until then they are not named. The git-only entries
 * (co-change, fixes after a change, tests changed with code) read any tree
 * and are never listed. `files` is the pack's source-file count IN THE COMMIT'S OWN TREE
 * (`snap.files`, routed by `packFor`, the rule the parsers use), so a week from
 * before a language arrived says that language held no file then. Which packs
 * exist, and what each reads, is the active config's (HEAD's); only the
 * counts are per commit. Without a snapshot (a caller with only a config) the
 * census count (`pack.files`, HEAD) stands in.
 */
import { packFor } from "./metrics/route.mjs";

/** Which index dimensions this pack can read. Sorted, so a row is stable. */
export function readsOf(pack) {
  const out = [];
  if (pack?.hatchKinds && typeof pack.hatchKinds === "object" && Object.keys(pack.hatchKinds).length > 0) out.push("hatches");
  if (typeof pack?.mentions === "function" && typeof pack?.keysFor === "function") out.push("untested");
  if (analyzerLoads(pack)) out.push("deadExports", "dups");
  if (typeof pack?.graphImports === "function" && typeof pack?.keysFor === "function" && typeof pack?.graphKeysFor === "function") out.push("cycles");
  return out.sort();
}

/**
 * Whether the pack's parser is there: `analyzer()` returns one, the exact test
 * `metrics/route.mjs` `analyzers()` applies before `dups`/`deadExports` read a
 * file. Called, not just looked up — the TypeScript pack's `analyzer()` is null
 * where `typescript` is not installed, and a pack that cannot parse here does
 * not read the code here. The pack memoises the load; a throw is "cannot".
 */
function analyzerLoads(pack) {
  if (typeof pack?.analyzer !== "function") return false;
  try {
    return Boolean(pack.analyzer());
  } catch {
    return false;
  }
}

/**
 * The row's `reach`: `{ value: { packs: [{ name, files, reads }] } }` over the
 * active SOURCE packs (a pack with no extensions — `common` — holds no file
 * and is left out). Never throws.
 *
 * @param {import("./types.mjs").EffectivePrereg} prereg
 * @param {{ files?: { path: string }[] } | null} [snap] the commit's snapshot: counts are of ITS source files
 */
export function measureReach(prereg, snap = null) {
  const own = Array.isArray(snap?.files) ? new Map() : null;
  if (own) {
    for (const f of snap.files) {
      const owner = packFor(f.path, prereg)?.name;
      if (owner) own.set(owner, (own.get(owner) ?? 0) + 1);
    }
  }
  const packs = (prereg?.PACKS ?? [])
    .filter((p) => (p?.pack?.exts?.length ?? 0) > 0)
    .map((p) => {
      const n = own ? (own.get(p.name) ?? 0) : p.files;
      return { name: p.name, files: Number.isFinite(n) ? n : 0, reads: readsOf(p.pack) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { value: { packs } };
}
