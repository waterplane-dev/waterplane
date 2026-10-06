/**
 * The registry of language packs — which languages this engine claims to
 * understand.
 *
 * ── Why this is a typed-out list and never a directory scan ─────────────────
 *
 * `readdirSync("./packs")` would be shorter and it would make adding a
 * language a side effect of a file landing in a directory. Every pack changes
 * what the engine MEASURES: it adds source extensions, so files that were
 * invisible start counting toward LOC, duplicate rates and the untested list;
 * it adds hatch kinds, so a tripwire gains a name it can fire on; it may add
 * an analyzer, which turns two metrics from absent-with-a-reason into numbers.
 * That is a reviewable decision about the series, of exactly the kind
 * `constants.mjs` argues must be visible in a diff, and a scan makes it
 * invisible: a file appears in a pull request and the history of thirteen
 * repos re-cuts itself with nothing in the diff saying so.
 *
 * A list also fixes the ORDER, and order is not cosmetic here. `census.mjs`
 * hashes the sorted `name@version` pairs of the ACTIVE packs into the right
 * half of a row's version string, and it merges hatch kinds in this order,
 * refusing a collision rather than letting a later pack shadow an earlier one.
 * Both want a list that a person chose.
 *
 * ── The cost of NOT being here ──────────────────────────────────────────────
 *
 * A language with no pack is not measured wrongly; it is measured as absent.
 * Its files match no active pack's extensions, so they are not source, so
 * `size`, `dups`, `untested` and the rest report `{value: null, reason}`. The
 * repo-wide readings that need no source at all — CLAUDE.md's weight, the
 * always-on skill descriptions, the commit history — still work. That is the
 * designed degradation, and it is why shipping two packs was a usable state:
 * measured over `~/dev` on the day the pack system landed, the four repos that
 * are Kotlin and XML and nothing else (105, 85, 29 and 10 `.kt` files) and
 * `picture-app` (67 `.dart`, 52 `.py`) activated `common` alone, so their
 * `SRC.exts` was empty, every source-population metric reported absent with a
 * reason, and not one of them reported a confident 0.
 *
 * ── The five that were added next, and what each one cost ──────────────────
 *
 * Those five repos are the reason for `kotlin`, `python`, `dart`, `shell` and
 * `c`. Three of the five are size-only — extensions, and an explicit `null`
 * for every capability they decline — which is the smallest thing a pack can
 * be and is still the difference between "every reading absent" and "the
 * readings that need no parser are present". Each of their headers names what
 * it does not detect, so a reader who meets an absence in a row can find the
 * sentence that explains it.
 *
 * Registering a pack is a change of what is measured, and two of these changed
 * a repo that was already being measured:
 *
 *   - `shell` claims `.sh`, and waterplane commits six of them. This repo's own
 *     active pack list therefore gains an entry, its `VERSION` hash moves, and
 *     six files enter every source-population count. `packs/shell.mjs` names
 *     the six.
 *   - `python` and `c` join `typescript` in `Tiptoi`, and `python` joins it in
 *     `trading` and `personal-podcast-news`. Those rows were never wrong —
 *     they said "typescript, N files" — but they covered a front end and
 *     called it the repo.
 *
 * ── Order ──────────────────────────────────────────────────────────────────
 *
 * `common` first, then the packs that carry a parser or an import rule, then
 * the size-only ones, alphabetically within each group. Order decides which
 * pack `metrics/route.mjs` hands a file to when two claim one extension — none
 * do today — and `census.mjs` hashes the SORTED `name@version` pairs, so
 * reordering this list cannot silently re-cut a history.
 */
import common from "./common.mjs";
import kotlin from "./kotlin.mjs";
import python from "./python.mjs";
import typescript from "./typescript.mjs";
import c from "./c.mjs";
import dart from "./dart.mjs";
import shell from "./shell.mjs";

/**
 * Every pack this engine knows, in a fixed order. `common` is first because it
 * is the one that is always active, so a merged hatch-kind collision is always
 * reported against a language pack rather than against the floor.
 */
export const PACKS = Object.freeze([common, kotlin, python, typescript, c, dart, shell]);

export default PACKS;
