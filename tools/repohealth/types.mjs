/**
 * The shared contract of the repo-health series. JSDoc only — this module has
 * no runtime code and importing it costs nothing.
 *
 * It exists so the metric modules can be written against a fixed shape
 * without any of them reaching into git, the filesystem, or each other. Every
 * `measure*` function is pure: a snapshot and a history in, a value or `null`
 * out. That is what makes them testable on hand-built literals with no repo
 * present, and it is what lets the rows be recomputed identically on another
 * machine years later — the property the fixture depends on.
 *
 * Two rules bind every implementation of these types:
 *
 *   1. **Absent is `null` with a reason, never 0.** No AGENTS.md, no skills
 *      yet, `typescript` not importable, fewer than 14 days of history — each
 *      is a `{ value: null, reason }`, because a zero and an absence are
 *      opposite claims and only one of them is true.
 *   2. **Everything is ordered.** Fixed key order in every row, sorted paths,
 *      sorted pairs, sorted offenders. A row is compared to a committed
 *      fixture with `deepEqual`; an unordered list would make that comparison
 *      fail on nothing at all.
 */

/**
 * A language pack, active at this repo's HEAD.
 *
 * @typedef {object} ActivePack
 * @property {string} name        `common`, `typescript`, …
 * @property {string} version     Bumped when the pack changes what it
 *                                measures. It is hashed into `EffectivePrereg.VERSION`,
 *                                so a bump re-cuts the series of every repo
 *                                this pack is active in and of no other.
 * @property {number} extFiles    How many files at HEAD carry one of its
 *                                extensions, outside the excluded
 *                                directories: the activation evidence, before
 *                                test globs and excluded suffixes have had a
 *                                say. `0` for `common`, which claims no
 *                                extensions and is active anyway.
 * @property {number} files       How many of those are in the MEASURED
 *                                population — `isSource`, routed to this pack
 *                                — which is the denominator that says whether
 *                                a reading covers the project or just its
 *                                build scripts, and the one
 *                                `metrics/route.mjs` prints beside an
 *                                absence. Lower than `extFiles` wherever a
 *                                pack's files are tests or vendored, and `0`
 *                                for a pack all of whose files are.
 * @property {object} pack        The pack module itself. It travels because
 *                                two metrics need BEHAVIOUR and not just
 *                                data: `dups`/`deadExports` need the pack's
 *                                `analyzer()`, `untested` needs its
 *                                `mentions`/`keysFor`/`imports`, and routing a file to
 *                                the pack that can read it needs its `exts`.
 */

/**
 * What every `measure*` receives as `prereg`: the pre-registered METHOD, plus
 * everything about this repo's SHAPE that `census.mjs` derived from the tree
 * at HEAD. `constants.mjs` argues the split; this is the result.
 *
 * @typedef {typeof import("./constants.mjs").PREREG & {
 *   PACKS: ActivePack[],
 *   SRC: {exts: string[], excludeSuffixes: string[], excludeDirs: string[], testGlobs: string[]},
 *   HATCH_KINDS: Record<string, string>,
 *   VERSION: string,
 * }} EffectivePrereg
 *
 * `SRC.exts` is `[]` in a repo no pack claims — `isSource` then answers false
 * for everything and every metric over that population reports absent with a
 * reason. That is the designed state, not a failure: a 0 over a language
 * nothing could parse is the exact wrong number the packs exist to prevent.
 *
 * `VERSION` is `<PREREG_VERSION>+<hash8 of the sorted name@version pairs>`, and
 * it is what a `Row.prereg` records. The two halves move independently: an
 * engine bump moves the left half in every repo at once, a pack change moves
 * the right half only where that pack is active.
 */

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {number} ts           Unix seconds, committer time.
 * @property {string} day          `YYYY-MM-DD` in the COMMIT's own offset.
 * @property {string} subject
 * @property {string[]} filesTouched  Sorted, rename-free (`diff.renames=false`).
 * @property {boolean} batch       `filesTouched.length >= PREREG.BATCH_FILES`.
 */

/**
 * @typedef {object} SrcFile
 * @property {string} path         Repo-relative, e.g. `packages/web/src/App.tsx`.
 *                                 Whatever an active pack calls source, at any
 *                                 depth — never assumed to sit under a
 *                                 particular directory.
 * @property {string} oid          Blob sha. THE memoisation key — 157 trees
 *                                 share 2,071 unique blobs under `packages/`,
 *                                 so per-oid caching is a 25x saving and the
 *                                 difference between a backfill in seconds and
 *                                 one in minutes.
 * @property {string} text
 * @property {number} loc
 */

/**
 * @typedef {object} SkillFile
 * @property {string} name
 * @property {number} descriptionChars  Frontmatter `description:` only — the
 *                                      always-on half.
 * @property {number} bodyChars         Everything after the frontmatter.
 * @property {boolean} generated        Written at runtime by
 *                                      `packages/host/src/visualskill.ts`.
 *                                      Counted anyway; see PREREG.
 * @property {string[]} headModules     Sorted basenames this skill claims —
 *                                      the modules named in the FIRST line of
 *                                      one of its bullets, by
 *                                      `tools/skillmap.mjs`'s rule and no
 *                                      other, over the ACTIVE packs'
 *                                      extensions. This is what lets `context`
 *                                      cost a commit: which sub-skills those
 *                                      files would have made an agent load.
 *                                      `[]` for a skill that claims nothing,
 *                                      which is a measured emptiness — a
 *                                      router carries a map, not bullets.
 */

/**
 * One area of a repo, derived from the tree — never typed out.
 *
 * A skill is a ROUTER when at least one skill named `<router>-*` exists at the
 * same sha. `snapshot.mjs`'s `deriveAreas` holds the whole argument; this is
 * only its shape.
 *
 * @typedef {object} Area
 * @property {string} router      The router skill's name, e.g. `web`.
 *                                This is also the area's identity: there is no
 *                                short label, because deriving `web` from
 *                                `web` would be a repo-specific naming
 *                                convention smuggled back in.
 * @property {string|null} src    The source GROUP whose path the router's
 *                                description names — a group name as
 *                                `Snapshot.groups` spells it, compared with
 *                                `groupOf`, NOT a prefix to `startsWith`.
 *                                `null` when the description names no group,
 *                                or names two equally specific ones: the area
 *                                still exists and still weighs what it weighs,
 *                                but no commit can be attributed to it, so the
 *                                per-commit reading is absent with a reason
 *                                and never 0.
 * @property {string[]} also      Sorted skill names the router's BODY writes
 *                                in backticks that exist at this sha and are
 *                                not its own `<router>-*` children — the ones
 *                                it routes to from outside its prefix.
 */

/**
 * One commit's tree, already read. No git handle, no paths to resolve.
 * @typedef {object} Snapshot
 * @property {string} sha
 * @property {SrcFile[]} files                Sorted by path.
 * @property {string[]} groups                Sorted source groups: the unit
 *                                            co-change stops at, `classics`
 *                                            breaks LOC down by, and an area's
 *                                            `src` names. A first path segment,
 *                                            or `first/second` where the first
 *                                            holds no source of its own and has
 *                                            two or more source-bearing
 *                                            children; `.` for root-level
 *                                            files. `[]` when no file in this
 *                                            tree is source — which is the
 *                                            state of a repo no language pack
 *                                            claims. Derived per snapshot, so
 *                                            a row stays reproducible from its
 *                                            own sha. `snapshot.mjs`'s
 *                                            `groupOf(path, groups)` is the
 *                                            only way to ask which group a
 *                                            path is in.
 * @property {number|null} claudeMdChars
 * @property {number|null} claudeMdLines
 * @property {number|null} agentsMdLines      `null` where the file does not
 *                                            exist — which is every sha so
 *                                            far. Not 0.
 * @property {SkillFile[]} skills             `[]` before `.claude/skills` existed.
 * @property {Area[]} areas                   Sorted by `router`. `[]` in a repo
 *                                            with no router convention at all,
 *                                            which is an emptiness and not a
 *                                            zero: the repo-wide always-on
 *                                            weight still reads, and the
 *                                            per-area numbers are absent.
 * @property {{path: string, text: string}[]} tests   Every file an active pack's
 *                                            `testGlobs` match, outside the
 *                                            excluded directories. The same
 *                                            list `source.mjs` uses to keep
 *                                            tests OUT of `files`, so a file
 *                                            is never both a module and the
 *                                            test that covers it.
 * @property {{pack: string, pkg: string, deps: number, devDeps: number}[]} manifests
 *   Dependency manifests, from the active packs' `manifests()`, sorted by
 *   `(pack, pkg)`. `pkg` is the manifest's DIRECTORY (`.` at the repo root),
 *   not a workspace label, because a label is not unique across depths. `[]`
 *   where the tree holds none — `classics.mjs` turns that into `deps: null`,
 *   since "no manifest" and "depends on nothing" are opposite claims.
 */

/**
 * @typedef {object} History
 * @property {Commit[]} commits            First-parent order, oldest first.
 * @property {Map<string, string[]>} touches   sha -> sorted paths.
 * @property {Set<string>} batch           Shas over the batch cutoff.
 */

/**
 * A measurement that knows when it has nothing to say.
 * @template T
 * @typedef {{ value: T, reason?: undefined } | { value: null, reason: string }} Measured
 */

/**
 * @typedef {object} Reading
 * @property {number|null} rank    Percentile within the trailing window.
 * @property {"rising"|"falling"|"flat"|null} slope
 * @property {string} [reason]     Why there is no rank. Present iff rank is null.
 */

/**
 * One row of the series. One per commit; `perDay` reduces to the last commit
 * of each day for reading.
 * @typedef {object} Row
 * @property {string} sha
 * @property {string} day
 * @property {number} ts
 * @property {boolean} batch
 * @property {string} prereg       `EffectivePrereg.VERSION` this row was
 *                                 computed under — the engine version and the
 *                                 active packs, so a mixed series says which
 *                                 of the two moved.
 * @property {Measured<{p95: number, max: number, maxPath: string, appTsx: number|null, nearMax?: number, lineMean?: number}>} size
 * @property {Measured<{rate: number, touches: number, retouches: number, offenders: {path: string, n: number}[]}>} retouch
 *   `rate` never travels without `touches`. A rate of 1.000 over 6 touches and
 *   one of 0.69 over 216 are different claims, and the bare proportion cannot
 *   tell them apart — four real rows in this history read exactly 1.000 off
 *   denominators of 6 to 13 while the series median is 117. Carrying the
 *   denominator is the deliberate alternative to a minimum-window cutoff: it
 *   makes a thin row self-describing instead of silently deleting it, and it
 *   needs no pinned constant, so no threshold had to be chosen after seeing
 *   which rows it would remove.
 * @property {Measured<Record<string, number>>} hatches
 * @property {Measured<{pairsPerKloc: number, pairs: {a: string, b: string, sim: number}[]}>} dups
 * @property {Measured<{hotspots: {path: string, median: number}[]}>} cochange
 * @property {Measured<{claudeMdChars: number, descChars: number|null, skillCount: number|null, skillsReason?: string, areas: Record<string, {ceiling: number, commits: number|null, expected: number|null, p90: number|null, subs: number, reason?: string}>, areasReason?: string}>} context
 *   `claudeMdChars` reads whenever the file is in the tree; the whole row is
 *   absent only when it is not. `descChars` and `skillCount` are `null` with
 *   `skillsReason` in a tree with no counted skills — together, never one of
 *   them, because they describe one set.
 *   `skillCount` is how many skills `descChars` is the description total OF —
 *   the same set both times, `PREREG.COUNT_GENERATED_SKILLS` deciding it once.
 *   It is plotted and never ranked (`plain` in `readings.mjs`'s `SERIES`): a
 *   count that rises as reference leaves CLAUDE.md and rises again when a
 *   split goes too far cannot be placed against its own past without the
 *   percentile making a claim nothing measured.
 *   `areas` is keyed by ROUTER NAME (`web`, not `web`) and its members
 *   are `Snapshot.areas`, derived from each commit's own tree rather than read
 *   off a pinned table — so an area appears in the row on the sha its first
 *   sub-skill landed and disappears on the sha its last one left, which is
 *   when it stopped being a router.
 *   Two numbers per area, because one can always be satisfied by moving bytes
 *   into another file. `expected` is the median load a real change in that
 *   area would carry — CLAUDE.md + every description + the router + the
 *   sub-skills that commit's own files claim — over the `commits` non-batch
 *   commits at or before this one, with `p90` beside it for the tail.
 *   `ceiling` is the same base plus the router plus EVERY one of the area's
 *   `subs` bodies. Re-partitioning moves `expected` and cannot move `ceiling`;
 *   deleting prose moves both. `expected` and `p90` are `null` with
 *   `commits: 0` where no commit has touched the area yet — never 0, which
 *   would read as an area that costs nothing to enter. Where the area's `src`
 *   is `null` no commit can be attributed to it AT ALL: `commits` is `null`
 *   too and the area carries a `reason`, because "no commit has touched this
 *   yet" and "nothing here could ever be counted" are different claims and
 *   only the first has a denominator. `ceiling` reports in both cases — it is
 *   a fact about the tree, not about the history.
 *   `areasReason` stands beside an EMPTY `areas` object and says which
 *   emptiness it is: a tree with no `<router>-*` convention, or routers this
 *   measurement could not cost. Almost every row of this repo's own history
 *   is the first of those, and on a chart `{}` alone is indistinguishable
 *   from a repo that does not work that way.
 * @property {Measured<string[]> & {unnamed?: string[]}} untested
 *   The modules no test NAMES and none REACHES through imports, over the
 *   files whose language an active pack can read a reference in; `unnamed`
 *   beside it is the ones reached and never named (absent on rows written
 *   before it existed). Absent with a reason where no pack can read a
 *   reference: "every module is untested" is what a tree nothing parsed
 *   would otherwise report.
 * @property {Measured<string[]>} deadExports
 *   `path#name` for every value export no other blob names, from the same
 *   per-pack analyzer `dups` uses, and absent with the same reason where no
 *   pack supplies one.
 * @property {Measured<object>} classics
 *   `deps` is `null` — never a row of zeros — both where the tree holds no
 *   dependency manifest and where no active pack reads one, with `depsReason`
 *   beside it saying which. `packages` is broken down by `Snapshot.groups`,
 *   so a key is a group's own path (`packages/web`, `.`) and not a label.
 * @property {{kind: string, subject: string, detail: string}[]} tripwires
 */

/**
 * A sentence the narrative may print, and the id that stops it printing twice.
 * @typedef {object} Event
 * @property {string} id      `kind:subject:sha`. The ledger key.
 * @property {string} day
 * @property {string} sha
 * @property {string} kind
 * @property {string} text    Must name at least two numbers: a value is never
 *                            reported without the number it is compared with.
 */

export {};
