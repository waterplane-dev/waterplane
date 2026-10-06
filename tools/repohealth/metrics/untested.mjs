/**
 * Which modules no test names — as a LIST, not a ratio.
 *
 * ── Why a list and not a percentage ─────────────────────────────────────────
 *
 * "73% of modules are mentioned by a test" is a number that goes up when you
 * add a tested feature and down when you add an untested one, and it is
 * therefore mostly a plot of how fast the repo is growing. It also cannot be
 * acted on: nobody can write a test for 27%. The list can be read, diffed, and
 * closed one line at a time, and the interesting event — "a module that used
 * to be named by a test no longer is" — is a line disappearing from it, which
 * a ratio would hide behind two other modules arriving.
 *
 * The list is sorted, like everything else here, because the row is compared
 * to a committed fixture with `deepEqual` and an unsorted list fails on
 * nothing at all.
 *
 * ── What counts as "a test mentions it" ─────────────────────────────────────
 *
 * A PATH reference, never a bare identifier. `PREREG` spells out why, and it
 * is the half of the definition that survives translation: `git`, `api`,
 * `echo` and `context` are all module basenames here AND ordinary English in
 * the prose of half these test files, so an identifier match would mark most
 * of the tree tested on the strength of comments.
 *
 * What a reference LOOKS like is a language's business and lives in the pack.
 * `packs/typescript.mjs`'s `mentions()` and `keysFor()` hold the accepted
 * forms (`NAME.ts`, `NAME.tsx`, `NAME.js` for the host tests that import
 * compiled output, or the closing quote of an extensionless specifier), the
 * two boundaries that keep `.json` from marking `notify.ts` and
 * `smartpickstore.js` from naming `store`, and the `src` → `dist` mirror. The
 * whole argument for each of them moved there with the code; this module is
 * what asks the question and what refuses to answer it when no active pack
 * can.
 *
 * ── A language with no mention rule is an absence, never a list ────────────
 *
 * A pack declares `mentions`/`keysFor` or declares them `null`. Where NO
 * active pack supplies them the metric is `{value: null, reason}`: "every
 * module in this repo is untested" is what a Kotlin tree would otherwise
 * report, on the strength of nothing having been read at all, and it is the
 * single loudest wrong number this engine could print. Where SOME pack
 * supplies them, the list covers the files that pack owns and silently covers
 * no others — a file whose language cannot be read contributes no line in
 * either direction, because it is not evidence.
 *
 * ── Why a bare basename is not enough (PREREG.UNTESTED_REQUIRE_DIR_SEGMENT) ──
 *
 * This matched on BASENAME alone and was wrong in both directions at once.
 *
 * It claimed coverage from strings that name no module. `"/api/repos"` marked
 * `repos.ts` tested; `"/repo"` marked `wire/repo.ts`; `".claude/outbox"`
 * marked `outbox.ts`; `".claude/outbox/link"` marked `link.ts`;
 * `"packages/web"` marked `capture/web.ts`. Five modules at HEAD were
 * "mentioned" by a URL or a directory literal.
 *
 * And it collided: 28 basenames exist more than once in this tree (`api`,
 * and `index`, `settings`, `screenlog` three times each), so one test naming
 * `git.js` marked every `git.ts` in every package — up to ~34 files falsely
 * covered by 26 of those names.
 *
 * So a mention must carry the module's own DIRECTORY CONTEXT: the directory
 * part of the reference, after the normalisation below, must be a suffix of
 * the module's own directory. `web/src/link`, `packages/web/src/link.ts` and
 * `./link` from a test inside `packages/web/src/` are all mentions of
 * `packages/web/src/link.ts` and none of them is a mention of a `link.ts` in
 * another package; a bare `link` is a mention of nothing.
 *
 * The three normalisations that make that rule true of the references a repo
 * actually writes — a relative specifier joined to the file that wrote it,
 * the compiled mirror counted as the module's own directory, a leading `/`
 * read as repo-relative because that shape is a URL — are all statements
 * about one language's import syntax, so they are the pack's and the
 * reasoning for each moved there with the code. Every one of them is pure
 * string work: nothing here or there resolves a module, reads a file, or
 * needs a build.
 *
 * The rule still under-reports rather than over-reports: a reference whose
 * directory context is genuinely ambiguous (`src/api.ts`, naming no package)
 * marks both copies, and this row measures whether a test NAMES a module, not
 * whether it exercises one. `App.tsx` and `main.tsx` are "mentioned" because
 * `packages/web/src/createOp.test.mjs` `readFileSync`s `./App.tsx` and
 * `scripts/e2e-gallery.mjs` reads `packages/web/src/main.tsx` — true, and a
 * weaker claim than coverage. This row is evidence, not an accusation.
 *
 * ── Why the corpus is tokenised once ────────────────────────────────────────
 *
 * The obvious loop is 325 candidate regexes over ~100 test files, per commit,
 * over 157 commits — hundreds of gigabytes scanned to answer a set-membership
 * question. Instead every reference in the corpus is extracted in one pass
 * into a Set of `dir/name` keys, and each candidate module asks the Set about
 * the handful of keys its own path could answer to. Same answer, one scan.
 */
import { packFor, packsWith, reasonFor } from "./route.mjs";

/**
 * Every `dir/name` key one test corpus names, unioned over the active packs
 * that have a rule for it.
 *
 * A union and not a per-language partition: a test written in one language
 * can name a module written in another (a shell script or an e2e harness
 * naming a source file by path), and a key is only ever a string. Two packs
 * producing the same key is the same claim twice, which a Set already
 * handles.
 */
function mentionsOf(tests, packs, requireDir) {
  const out = new Set();
  for (const t of tests) {
    for (const p of packs) {
      for (const key of p.pack.mentions(t.text, t.path ?? "", { requireDir })) out.add(key);
    }
  }
  return out;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} history
 * @param {number} index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<string[]>}
 */
export function measureUntested(snapshot, history, index, prereg) {
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files at this commit" };

  const tests = snapshot.tests ?? [];
  // Not an empty list: with no tests in the tree, "every module is untested"
  // is arithmetically true and completely uninformative, and it would draw a
  // cliff on the day the first test landed rather than on the day coverage
  // actually changed.
  if (tests.length === 0) return { value: null, reason: "no tests at this commit" };

  // The same absence one level up: with no pack able to read a reference,
  // every module would be reported untested on the strength of nothing having
  // been read. The reason names the packs, so the reader can tell "no test
  // names these" from "nothing opened these".
  const speakers = packsWith(prereg, "mentions").filter((p) => typeof p.pack.keysFor === "function");
  if (speakers.length === 0) {
    return {
      value: null,
      reason: reasonFor(prereg, (p) =>
        typeof p.pack.mentions === "function" && typeof p.pack.keysFor === "function"
          ? null
          : "no rule for how a test names a module in this language",
      ),
    };
  }

  const requireDir = prereg.UNTESTED_REQUIRE_DIR_SEGMENT !== false;
  const mentioned = mentionsOf(tests, speakers, requireDir);
  const speaks = new Set(speakers.map((p) => p.name));

  const out = [];
  let read = 0;
  for (const f of files) {
    // Each file is asked of the ONE pack that owns its extension: a module's
    // keys are its own language's, and a file no pack can read is not a
    // module no test names — it is a file nothing opened. It contributes no
    // line in either direction.
    const owner = packFor(f.path, prereg);
    if (!owner || !speaks.has(owner.name)) continue;
    read++;
    const keys = owner.pack.keysFor(f.path);
    // `requireDir` off is the bare-basename rule `UNTESTED_REQUIRE_DIR_SEGMENT`
    // restores, and the pack's mention set then holds bare names. Every key a
    // module answers to ends in that same basename, so the fallback is read
    // off the keys rather than re-derived here — one definition of what a
    // module is called, and it is the language's.
    const hit = requireDir
      ? keys.some((k) => mentioned.has(k))
      : keys.some((k) => mentioned.has(k.slice(k.lastIndexOf("/") + 1)));
    if (!hit) out.push(f.path);
  }

  // Every source file belonged to a pack that cannot read a mention. The list
  // would be empty, and an empty list here reads as "every module is named by
  // a test" — the opposite of what happened.
  if (read === 0) {
    return {
      value: null,
      reason: reasonFor(prereg, (p) =>
        speaks.has(p.name) ? null : "no rule for how a test names a module in this language",
      ),
    };
  }

  out.sort();
  return { value: out };
}
