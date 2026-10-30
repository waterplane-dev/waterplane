/**
 * The Python pack: the escape hatches, the test conventions and the two
 * dependency files this engine can read without guessing, and a plain list of
 * what it leaves absent.
 *
 * ── What this brings into view ──────────────────────────────────────────────
 *
 * Counted at HEAD with `git ls-tree -r --name-only`, outside the excluded
 * directories: `trading` 343 `.py`, `personal-podcast-news` 297, `Tiptoi` 140,
 * `picture-app` 52 — 832 files. Two of those repos already activated the
 * TypeScript pack on a front end (`trading` 128 `.tsx`, `personal-podcast-news`
 * 100), which is the case the pack list's per-pack file count exists for: the
 * row used to say "typescript, 150 files" over a project whose 343-file backend
 * no pack could see. Now both are counted and the row says which pack found
 * how much.
 *
 * Only `.py`. A `.pyi` is a stub describing code that lives somewhere else —
 * the same argument `packs/typescript.mjs` makes for excluding `.d.ts` — and
 * it is not claimed rather than claimed-and-excluded, because no repo in this
 * fleet commits one and a suffix exclusion that never fires is a rule nobody
 * can check.
 *
 * ── The escape hatches, and the near-misses each one had to survive ────────
 *
 * `# type: ignore` (60 in the fleet) and `# noqa` (514) are the two written
 * forms of "the checker is wrong here". Both are matched from the `#`, with
 * optional space, so a variable called `noqa` or the string `type: ignore` in
 * a docstring about suppressions does not count. Both accept the bracketed
 * forms — `# type: ignore[arg-type]`, `# noqa: E402` — because the pattern
 * stops at the word boundary and the specifier that follows is still the same
 * suppression.
 *
 * A bare `except:` catches `KeyboardInterrupt` and `SystemExit` along with
 * everything else, which is why every Python linter has a rule about it. It
 * is rare and its near-miss is not: measured over the four repos there are 6
 * bare handlers (all in `picture-app`) against 1,365 `except Foo:` lines. The
 * pattern must therefore be anchored to the start of a line and must refuse a
 * name after the keyword. It is anchored with `\n` and not with `^`, because
 * `hatches.mjs` compiles these with `g` and no `m` flag — `^` would mean the
 * start of the file. The cost of the `\n` anchor is one uncountable case: a
 * bare `except:` on the very first line of a file, which cannot occur, since
 * it has no `try` above it.
 *
 * `Any` is included, at the two annotation positions only, and this is a
 * deliberate undercount. Word-bounded `Any` appears 431 times in the fleet in
 * four shapes: after `->` or `:` (166), inside a container type such as
 * `Dict[str, Any]` (210), on the `from typing import Any` line itself (18),
 * and the rest. Only the first is an unambiguous "this value is untyped":
 * reaching the container form in a regex means accepting a comma or a bracket
 * before `Any`, and a comma also matches `from typing import Dict, Any`, which
 * declares nothing and would inflate the count by one per file that imports it.
 * The English word is not a risk at the position chosen: filtering the 166
 * annotation-position matches down to the lines that do not read as an obvious
 * signature leaves exactly one, `grants: Any`, and that is an annotation too.
 * So `pyAny` reads
 * `x: Any` and `-> Any` and says nothing about `Dict[str, Any]`; a repo that
 * writes only the container form will see this kind sit at 0, and 0 here means
 * "none in an annotation position", not "none anywhere".
 *
 * Every kind name is prefixed `py`. `census.mjs` throws when two packs claim
 * one name, and the "a new kind of escape hatch appeared" tripwire fires on
 * the NAME, so a collision is a count that belongs to neither pack.
 *
 * ── What this pack does NOT detect ──────────────────────────────────────────
 *
 *   - **Anything that needs a parser.** `analyzer()` returns `null` and
 *     `analyzerReason` says so, and `dups` and `deadExports` therefore report
 *     `{value: null, reason}` over a Python repo rather than zero duplicate
 *     pairs over 832 files nothing opened. Python ships a parser in its own
 *     standard library, but reaching it means spawning `python3`, and
 *     `git.mjs` is the only module in this tool allowed to spawn anything.
 *   - **`# pylint: disable` and `# mypy: disable-error-code`.** Not in the
 *     fleet; a kind that has never been seen is a pattern nobody has checked.
 *   - **`assert` used as a type narrowing.** It is also a test, also a runtime
 *     check, and telling the three apart needs the parser that is absent.
 *   - **Resolved, transitive, or installed dependencies.** `manifests` counts
 *     what a file DECLARES. No lock file is read, no version is compared, no
 *     marker or extra is evaluated: `uvicorn[standard]>=0.30` is one
 *     requirement, the same as `httpx`.
 *   - **`setup.py`, `setup.cfg`, `Pipfile`, `poetry.lock`, `environment.yml`.**
 *     A `setup.py` is a program, so its dependency list is whatever it computes
 *     at run time; the rest are formats no repo in this fleet commits.
 *   - **`[project.optional-dependencies]` and `[dependency-groups]`.** Read as
 *     dev dependencies they would be wrong — an extra is an optional runtime
 *     feature, not a build-time cost — and read as runtime they would be wrong
 *     too. `trading/backend/pyproject.toml` has one, and it is not counted.
 */

/**
 * `from a.b import X`, `from . import X`, `from ..pkg import X, Y`.
 *
 * Group 1 is the leading dots, group 2 the dotted path (empty for
 * `from . import x`), group 3 the rest of the line after `import`.
 *
 * `m` so `^` means the start of a LINE, and the leading `[ \t]*` so an import
 * inside a function body — which the fleet's tests use constantly to defer a
 * slow module — is read like any other. These are this module's own compiled
 * literals, unlike `hatchKinds`, which is regex SOURCE that `hatches.mjs`
 * compiles itself.
 */
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(.+)$/gm;

/** `import a.b`, `import a.b as c`, `import os, sys`. Group 1 is the list. */
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;

/** A bare identifier in an import list — the names after `import`. */
const PY_NAME = /[A-Za-z_]\w*/g;

/** `a/b/foo.py` -> `foo`. */
function basename(path) {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? file : file.slice(0, dot);
}

/** `a/b/foo.py` -> `["a", "b"]`. */
function dirSegments(path) {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/**
 * The directory a dotted import points at, as segments.
 *
 * `dots` is the leading-dot count of a relative import: one dot is the
 * importing file's own package, each further dot climbs one level. `base` is
 * the directory of the file that wrote the import and is consulted only when
 * there is at least one dot. Climbing above the root clamps rather than
 * escaping, so a malformed import degrades to a shorter path and never to a
 * key that could match anything.
 */
function resolveDots(dots, base) {
  if (dots === 0) return [];
  const out = [...base];
  for (let i = 1; i < dots; i++) out.pop();
  return out;
}

/** One requirements line -> is it a requirement at all? */
function isRequirement(line) {
  const s = line.trim();
  if (s.length === 0) return false;
  if (s.startsWith("#")) return false;
  // `-r other.txt`, `-e .`, `-c constraints.txt`, `--index-url …`: a directive
  // to the installer, not a package. `-r` in particular would double-count
  // every line of the file it names.
  if (s.startsWith("-")) return false;
  return true;
}

/**
 * The count of requirements in a `requirements*.txt`.
 *
 * Lines, not packages: a file that names one package twice declares two
 * requirement lines, and this reader does not resolve, dedupe or evaluate
 * environment markers.
 */
function countRequirements(text) {
  let n = 0;
  for (const line of text.split("\n")) if (isRequirement(line)) n++;
  return n;
}

/**
 * `[project] dependencies` of a `pyproject.toml`, or `null` when this reader
 * does not recognise the file.
 *
 * Deliberately small, and deliberately not a TOML parser. Adding a TOML
 * dependency to a tool whose whole claim is that it is free and local would be
 * the largest change in the tree for the smallest metric in it. What it does:
 * find the line that is exactly `[project]`, read until the next line that
 * starts a table, find `dependencies = [` inside it, and count the quoted
 * strings up to the closing bracket.
 *
 * `null` — not 0 — for every shape it does not recognise: no `[project]` table
 * (a Poetry-only or build-tool-only file), or `dynamic` naming `dependencies`,
 * which says the list is computed at build time and is not in this file at all.
 * A `[project]` table that genuinely declares no `dependencies` key returns 0,
 * because that is a reading and not an absence.
 *
 * @param {string} text
 * @returns {number | null}
 */
function projectDependencies(text) {
  const lines = text.split("\n");
  let i = lines.findIndex((l) => l.trim() === "[project]");
  if (i === -1) return null;

  const section = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("[")) break;
    section.push(lines[i]);
  }
  const body = section.join("\n");

  // `dynamic = ["dependencies", …]` means the list is not here. Anything else
  // in `dynamic` (a version, a description) is none of this reader's business.
  const dynamic = /^[ \t]*dynamic[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(body);
  if (dynamic && /["']dependencies["']/.test(dynamic[1])) return null;

  const start = /^[ \t]*dependencies[ \t]*=[ \t]*\[/m.exec(body);
  if (!start) return 0;

  const from = start.index + start[0].length;
  const end = body.indexOf("]", from);
  if (end === -1) return null; // Unterminated array: unreadable, not empty.
  const array = body.slice(from, end);

  // Count the string literals. A trailing comment inside the array (`"lxml",
  // # yfinance needs it`) contributes none, because a comment is not quoted —
  // unless it quotes something, which is why the count is of quoted RUNS and
  // the array is cut at the first `]`, before any nested structure could start.
  let n = 0;
  for (const _ of array.matchAll(/"[^"]*"|'[^']*'/g)) n++;
  return n;
}

/**
 * True when the manifest's own filename marks it as a development list.
 *
 * Filename and nothing else: `requirements-dev.txt` and
 * `requirements-test.txt` are a convention this fleet follows
 * (`Tiptoi/service/requirements-dev.txt`), and `requirements-viewer.txt` in
 * `personal-podcast-news` is correctly NOT one. The classification exists so
 * that neither number is ever a placeholder — a dev requirements file declares
 * a real 0 runtime dependencies, and a `requirements.txt` declares a real 0
 * development ones. Nothing here reports a zero that means "not read".
 */
function isDevList(path) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return /dev|test/i.test(file);
}

export default Object.freeze({
  name: "python",
  // 2: `imports` exists — the same import statements `mentions` reads, as
  // the edges `untested` follows from a test to what it runs.
  // 3: `hatchExplain` exists — which escapes carry their reason.
  version: "3",

  /** Activates when the tree at HEAD carries one of these. See the header. */
  exts: Object.freeze([".py"]),

  excludeSuffixes: Object.freeze([]),

  /**
   * The three conventions pytest and unittest discover by. `**​/` crosses
   * directories and plain `*` does not, which is why the third glob ends
   * `/**​/*` rather than `/**` — a trailing `**` with no slash after it is two
   * plain stars and would match only the files directly inside `tests/`.
   *
   * Measured at HEAD: 261 files under a `tests/` directory across the four
   * Python repos, and 242 files whose basename starts `test_`. `*_test.py`
   * matches nothing in this fleet and is kept because it is the other half of
   * the same convention and a glob that finds nothing costs nothing — unlike
   * `**​/*Test.kt`, which `packs/kotlin.mjs` leaves out for finding nothing AND
   * mislabelling three real modules.
   */
  testGlobs: Object.freeze(["**/test_*.py", "**/*_test.py", "**/tests/**/*"]),

  /**
   * Regex SOURCE, compiled by `hatches.mjs` per call with `g` and no other
   * flag — hence `\n` and not `^` for the bare-except anchor, and no stored
   * compiled regex, whose `lastIndex` would carry between calls.
   *
   * The header argues each pattern and the near-miss it had to survive.
   */
  hatchKinds: Object.freeze({
    pyTypeIgnore: "#\\s*type:\\s*ignore\\b",
    pyNoqa: "#\\s*noqa\\b",
    // Start of a line, and no name after the keyword: `except Foo:` must not
    // count, and it is 1,365 lines against 6 real ones.
    pyBareExcept: "\\n\\s*except\\s*:",
    // The two annotation positions only. See the header for the 210 container
    // occurrences this deliberately does not reach.
    pyAny: "(?:->|:)\\s*Any\\b",
  }),

  /**
   * When an escape carries its reason — `packs/typescript.mjs` argues the two
   * places (same line after the mark, or a comment line directly above). A
   * rule CODE is not a reason: `# noqa: E501` and `# type: ignore[attr]` are
   * the bare forms, and only words after the codes — behind `--`, `—` or a
   * second `#` — explain them. The bare `except:` and the `Any` annotation
   * take a trailing comment.
   */
  hatchExplain: Object.freeze({
    commentLine: "^\\s*#",
    after: Object.freeze({
      pyNoqa: "^(?::?\\s*[A-Z]+[0-9]+(?:[\\s,]+[A-Z]+[0-9]+)*)?\\s*(?:#|--|—)\\s*[A-Za-z]{2}",
      pyTypeIgnore: "^(?:\\[[^\\]]*\\])?\\s*(?:#|--|—)\\s*[A-Za-z]{2}",
      pyBareExcept: "#\\s*[A-Za-z]{2}",
      pyAny: "#\\s*[A-Za-z]{2}",
    }),
  }),

  /**
   * Which tree entries are dependency manifests, as regex SOURCE over the
   * repo-relative path — at any depth, because depth is not a property of a
   * manifest and three of the four Python repos keep theirs in a subdirectory
   * (`backend/`, `service/`, `python_backend/`).
   *
   * The `(?:^|/)` anchor is load-bearing: without it `requirements` would also
   * match a file called `extra-requirements.txt`, which this reader has no
   * opinion about, and an unanchored `setup\.py`-style pattern would match
   * `Tiptoi/service/tiptoi_service/logging_setup.py` — which is source.
   */
  manifestPath: "(?:^|/)(?:requirements[^/]*\\.txt|pyproject\\.toml)$",

  /**
   * `{pkg, deps, devDeps}` per manifest, or `null` when nothing was readable.
   *
   * `pkg` is the manifest's full repo-relative PATH, not its directory. The
   * TypeScript pack can use the directory because `package.json` is unique
   * within one; Python cannot, because `requirements.txt` and
   * `requirements-dev.txt` sit side by side — `Tiptoi/service/` has exactly
   * that pair — and two rows with the same label are two rows a reader cannot
   * tell apart.
   *
   * `deps` and `devDeps` are counted separately and never summed, for the
   * reason `packs/typescript.mjs` gives: a runtime dependency ships and is in
   * the attack surface, a development one is a build-time cost. Which of the
   * two a requirements file fills is decided by its filename and by nothing
   * else — see `isDevList` — and a `pyproject.toml`'s `[project] dependencies`
   * is always runtime, because `[project]` has no development field for this
   * reader to have missed.
   *
   * A manifest this reader does not recognise contributes NO ROW rather than a
   * row of zeros, and if no manifest is readable the whole reading is `null`.
   * "This commit declares nothing this could read" and "this project depends on
   * nothing" are different claims and only one of them is ever true here.
   *
   * @param {{path: string, oid: string}[]} entries  Already filtered to
   *   `manifestPath` and to paths no excluded directory contains.
   * @param {(entry: {path: string, oid: string}) => string} textOf
   */
  manifests(entries, textOf) {
    if (entries.length === 0) return null;
    const rows = [];
    for (const e of entries) {
      let text = "";
      try {
        text = textOf(e);
      } catch {
        continue; // An unreadable blob at some historical sha is not a zero.
      }
      if (e.path.endsWith("pyproject.toml")) {
        const n = projectDependencies(text);
        if (n === null) continue;
        rows.push({ pkg: e.path, deps: n, devDeps: 0 });
      } else {
        const n = countRequirements(text);
        rows.push(isDevList(e.path) ? { pkg: e.path, deps: 0, devDeps: n } : { pkg: e.path, deps: n, devDeps: 0 });
      }
    }
    if (rows.length === 0) return null;
    return rows.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
  },

  /**
   * Every `dir/name` key one Python test file's text names.
   *
   * A Python module IS a file, so `import a.b` names `a/b.py` and
   * `from a.b import X` names either `a/b.py` or `a/b/X.py` — the syntax does
   * not say which, so both keys are emitted and whichever one exists in the
   * tree is the one that can match. Emitting a key for a module that does not
   * exist costs nothing: `keysFor` is asked only about files that do.
   *
   * A relative import resolves against the directory of the file that wrote
   * it, the way `packs/typescript.mjs` resolves `./x`: one dot is that
   * directory, each further dot climbs one level, and climbing above the root
   * clamps. This is what makes `from .store import Thing` inside
   * `service/tests/` mean `service/tests/store` and not some other package's.
   *
   * The directory segment is REQUIRED — `packs/typescript.mjs` states the
   * measured reason under `UNTESTED_REQUIRE_DIR_SEGMENT`. So `import config`,
   * which `personal-podcast-news`'s tests write, names nothing: a single
   * segment has no directory part. That is the same rule that makes a
   * root-level `config.py` answer to no key at all, so the two ends agree —
   * the module is listed as untested rather than matched by a bare name that
   * would also match the word `config` in a URL.
   *
   * Not read: the parenthesised multi-line form `from a.b import (\n  X,\n  Y\n)`
   * contributes its `a/b` key and none of the names, because the regex reads
   * one line. That is an undercount of the narrower keys and never a wrong
   * match.
   *
   * @param {string} text  The test file's contents.
   * @param {string} path  Its repo-relative path — relative imports resolve
   *   against this.
   * @param {{requireDir?: boolean}} [opts]  `requireDir: false` restores the
   *   bare-name rule `PREREG.UNTESTED_REQUIRE_DIR_SEGMENT` switches off. Kept
   *   exact, so turning that constant off restores a definition that already
   *   existed and not a third one.
   * @returns {Set<string>}
   */
  mentions(text, path, opts = {}) {
    const requireDir = opts.requireDir !== false;
    const base = dirSegments(path ?? "");
    const out = new Set();

    /** `["a","b"]` -> `a/b`, or the bare name when the rule is switched off. */
    const emit = (segs) => {
      if (segs.length === 0) return;
      const name = segs[segs.length - 1];
      if (!requireDir) {
        out.add(name);
        return;
      }
      if (segs.length > 1) out.add(segs.slice(0, -1).join("/") + "/" + name);
    };

    for (const m of text.matchAll(PY_FROM)) {
      const prefix = resolveDots(m[1].length, base);
      const dotted = m[2].split(".").filter((s) => s.length > 0);
      const module = [...prefix, ...dotted];
      emit(module);
      // `from a.b import X` may name the module `a/b/X.py`. A trailing comment
      // is cut first, so `# noqa: E402` — which the fleet's tests write on a
      // third of their imports — does not mint a key for a module called
      // `noqa`. A `*` import contributes no name, because `PY_NAME` matches
      // identifiers only.
      const imported = m[3].split("#")[0];
      for (const n of imported.matchAll(PY_NAME)) {
        if (n[0] === "as") continue;
        emit([...module, n[0]]);
      }
    }

    for (const m of text.matchAll(PY_IMPORT)) {
      for (const part of m[1].split(",")) {
        emit(part.trim().split(".").filter((s) => s.length > 0));
      }
    }

    return out;
  },

  /**
   * The edges `untested` follows. In this language a mention already IS an
   * import statement and nothing else, so the two capabilities are one rule:
   * called as a method, never detached.
   */
  imports(text, path, opts = {}) {
    return this.mentions(text, path, opts);
  },

  // No import-graph rule yet: `metrics/graph.mjs` reports this language absent
  // rather than as a tree with no coupling. `imports` above is the safe-side
  // rule `untested` needs; a graph needs every internal import resolved AND
  // the unresolved ones counted, which this pack does not do.
  graphConfigPath: null,
  graphContext: null,
  graphImports: null,
  /**
   * Every `dir/name` key the module at `path` answers to: each non-empty
   * suffix of its own directory, joined to its basename.
   *
   * Suffixes, because an import carries the package root and not the source
   * root: `Tiptoi`'s tests write `from tiptoi_service.main import …` about a
   * file at `service/tiptoi_service/main.py`, so the key that meets them is
   * the suffix `tiptoi_service/main`. Non-empty, because the empty suffix is
   * the bare basename the rule rejects.
   *
   * An `__init__.py` answers under its own directory's name the same way any
   * other file does (`pkg/__init__`), which no import writes — so a package
   * initialiser is always listed as untested. Stated rather than special-cased:
   * the alternative is a rule that says an `__init__.py` is covered whenever
   * its package is named, which would mark a whole tree of them covered on one
   * import.
   *
   * @param {string} path
   * @returns {string[]}
   */
  keysFor(path) {
    const name = basename(path);
    const dir = dirSegments(path);
    const keys = [];
    for (let i = 0; i < dir.length; i++) keys.push(dir.slice(i).join("/") + "/" + name);
    return keys;
  },

  /**
   * No parser. `null` is the answer `dups` and `deadExports` need in order to
   * report absent-with-a-reason instead of zero over 832 files nothing opened.
   */
  analyzer() {
    return null;
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: "no Python parser is available in-process, so no Python file was read as code",
});
