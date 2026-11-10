/**
 * Where a Python import points inside the tree, resolved against the set of
 * `.py` paths the tree holds. The Python half of `metrics/graph.mjs`'s
 * contract, beside `typescript-resolve.mjs`.
 *
 * ── What counts as a module, and the key an edge carries ────────────────────
 *
 * `a/b.py` is module `a.b` and its graph key is `a/b`. `a/b/__init__.py` is
 * package `a.b` and its key is `a/b/__init__`. (`graphKeysFor` in the pack
 * offers exactly these two shapes, so a package and a module of one name never
 * share a key.) A directory with `.py` files below it and no `__init__.py` is a
 * namespace package: it exists, it has no file, it is no edge.
 *
 * ── Which directory an absolute import is read from ─────────────────────────
 *
 * Python reads `import a.b` against `sys.path`, and a repo does not say what
 * its `sys.path` is. The roots tried, nearest first, are the directories above
 * the importing file that are NOT themselves packages (a package directory is
 * never a `sys.path` entry), and each one's `src/`. That finds the repo root,
 * a `src` layout, and a script's own directory. Only when none of them holds
 * the first segment is the name looked for tree-wide, and only if it lives in
 * exactly ONE place and is not a standard-library name. Two places is an
 * ambiguity reported as a MISS, never a pick — a guessed edge can invent a cycle.
 *
 * ── What is external ────────────────────────────────────────────────────────
 *
 * A first segment no root holds is a package from outside (`numpy`, `fastapi`,
 * the standard library): no entry at all, no miss. A first segment that IS this
 * tree's but whose rest is not (`import app.nothing`) is a miss. Every relative
 * import is this tree's own, so one that finds nothing is a miss.
 *
 * ── Edges the graph does not draw ───────────────────────────────────────────
 *
 *   - Imports under `if TYPE_CHECKING:` never run: no edge.
 *   - Imports inside a function body run when it is CALLED, not when the module
 *     loads. Python code puts them there on purpose to break a cycle (in
 *     `trading` they are the whole of a 16-module cycle: 1,438 edges and one
 *     cycle with them, 1,169 and none without). The graph is the load-time
 *     coupling, so they draw no edge and count as neither hit nor miss.
 *   - The parent packages `import a.b.c` also executes (`a/__init__`,
 *     `a/b/__init__`) are not edges: every package would then sit in a cycle
 *     with every module that imports a sibling. The target itself is the edge.
 *   - `from pkg import name` is an edge to `pkg/name.py` when that submodule
 *     exists and to `pkg` otherwise (`name` is then an attribute).
 *   - A target that is a test file is dropped: it is not a node of the graph.
 */

const STDLIB = new Set(
  (
    "abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd code codecs " +
    "codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg csv ctypes curses " +
    "dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp " +
    "fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib " +
    "heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma " +
    "mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath numbers opcode operator " +
    "optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty " +
    "pwd py_compile pyclbr pydoc pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets " +
    "select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 sre_compile sre_constants " +
    "sre_parse ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile " +
    "tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty " +
    "turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref " +
    "xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
  ).split(" "),
);

/** Same three conventions as `packs/python.mjs` `testGlobs`, for one path. */
export function isPythonTest(path) {
  const segs = path.split("/");
  const file = segs[segs.length - 1];
  return file.startsWith("test_") || file.endsWith("_test.py") || segs.slice(0, -1).includes("tests");
}

/**
 * The resolver's data for one tree: every `.py` path (the entries are paths
 * only; no text is read), the directories holding any, and the packages.
 * @param {{path: string}[]} entries
 */
export function buildPythonContext(entries) {
  const all = new Set();
  const dirs = new Set([""]);
  const inits = new Set();
  /** first segment -> parents ("" for the root) holding a module or directory of that name */
  const heads = new Map();
  const top = [];
  for (const e of entries) {
    if (!e.path.endsWith(".py")) continue;
    all.add(e.path);
    const segs = e.path.split("/");
    const file = segs.pop();
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
    if (file === "__init__.py") inits.add(segs.join("/"));
    if (file !== "__init__.py") top.push([file.slice(0, -3), segs.join("/")]);
  }
  // A head is a module or package that sits in a directory which is not itself
  // a package: the only places a `sys.path` entry can be.
  const parentOf = (d) => d.slice(0, Math.max(0, d.lastIndexOf("/")));
  for (const [name, dir] of top) if (!inits.has(dir) || dir === "") note(heads, name, dir);
  for (const d of inits) {
    if (!d) continue;
    const parent = d.includes("/") ? parentOf(d) : "";
    if (!inits.has(parent) || parent === "") note(heads, d.slice(d.lastIndexOf("/") + 1), parent);
  }
  return { all, dirs, inits, heads };
}

function note(map, head, parent) {
  let s = map.get(head);
  if (!s) map.set(head, (s = new Set()));
  s.add(parent);
}

const join = (root, segs) => (root ? [root, ...segs] : segs).join("/");

/** What `root/segs` is: `{key}` for a module or package file, `{ns: true}` for a namespace directory, or null. */
function modAt(ctx, root, segs) {
  if (!segs.length) return ctx.inits.has(root) ? { key: join(root, ["__init__"]) } : ctx.dirs.has(root) ? { ns: true } : null;
  const p = join(root, segs);
  if (ctx.all.has(p + ".py")) return { key: p };
  if (ctx.all.has(p + "/__init__.py")) return { key: p + "/__init__" };
  if (ctx.dirs.has(p)) return { ns: true };
  return null;
}

/** The sys.path-like roots for a file in `dirSegs`, nearest first. */
function rootsFor(ctx, dirSegs) {
  const roots = [];
  for (let n = dirSegs.length; n >= 0; n--) {
    const dir = dirSegs.slice(0, n).join("/");
    if (ctx.inits.has(dir) && n > 0) continue;
    roots.push(dir);
    const src = join(dir, ["src"]);
    if (ctx.dirs.has(src)) roots.push(src);
  }
  return roots;
}

/**
 * Every module one file's import records load, as graph entries:
 * `{spec, internal, candidates}`. Candidates are whole tree keys.
 * @param {object[]} records  `importsOf` output
 * @param {string} fromPath
 * @param {ReturnType<typeof buildPythonContext> | null} ctx
 */
export function resolvePythonImports(records, fromPath, ctx) {
  if (!ctx) return [];
  const out = [];
  const seen = new Set();
  const dirSegs = fromPath.split("/").slice(0, -1);
  const emit = (spec, key) => {
    // A test file is no node of the graph; neither hit nor miss.
    if (key && isPythonTest(key.endsWith("/__init__") ? key.slice(0, -9) + "/__init__.py" : key + ".py")) return;
    const id = `${spec}\u0000${key ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ spec, internal: true, candidates: key ? [key] : [] });
  };

  /** Resolve `base` (a root) + module segments + imported names for a `from` record; false if nothing is there. */
  const fromAt = (spec, root, segs, names) => {
    const base = modAt(ctx, root, segs);
    if (!base) return false;
    if (names.includes("*") || !names.length) names = [];
    if (base.key && !base.key.endsWith("/__init__")) {
      emit(spec, base.key); // module: names are attributes
      return true;
    }
    if (!names.length) {
      if (base.key) emit(spec, base.key);
      return true;
    }
    for (const nm of names) {
      const sub = modAt(ctx, root, [...segs, nm]);
      if (sub && sub.key) emit(spec, sub.key);
      else if (base.key) emit(spec, base.key);
      else emit(spec, null);
    }
    return true;
  };

  for (const r of records) {
    if (r.tc || r.deferred) continue;
    if (r.from && r.dots > 0) {
      const spec = ".".repeat(r.dots) + r.module.join(".");
      if (r.dots - 1 > dirSegs.length) {
        emit(spec, null);
        continue;
      }
      const root = dirSegs.slice(0, dirSegs.length - (r.dots - 1)).join("/");
      if (!fromAt(spec, root, r.module, r.names)) emit(spec, null);
      continue;
    }
    const mods = r.from ? [r.module] : r.modules;
    for (const segs of mods) {
      const spec = segs.join(".");
      const head = segs[0];
      let root = null;
      for (const cand of rootsFor(ctx, dirSegs)) {
        if (modAt(ctx, cand, [head])) {
          root = cand;
          break;
        }
      }
      if (root === null) {
        if (STDLIB.has(head)) continue;
        const places = ctx.heads.get(head);
        if (!places) continue; // external
        if (places.size > 1) {
          emit(spec, null);
          continue;
        }
        root = [...places][0];
        // The head must be a module/package AT that parent, not a deep directory of that name.
        if (!modAt(ctx, root, [head])) {
          continue;
        }
      }
      if (r.from) {
        if (!fromAt(spec, root, segs, r.names)) emit(spec, null);
      } else {
        const t = modAt(ctx, root, segs);
        if (t && t.key) emit(spec, t.key);
        else if (t && t.ns) continue; // a namespace directory: nothing to load
        else emit(spec, null);
      }
    }
  }
  return out;
}
