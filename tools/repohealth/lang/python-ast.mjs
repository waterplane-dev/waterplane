/**
 * Python source read into the products a clone detector, an orphan detector
 * and an import graph are computed from: the names a blob writes, the
 * top-level names it offers, its blocks with a minhash signature each, and the
 * import statements it runs.
 *
 * The sibling of `typescript-ast.mjs`, and shaped like it on purpose:
 * `identsOf` / `signedBlocks` return what `metrics/dups.mjs` and
 * `deadexports.mjs` already read from the TypeScript pack, memoised by blob oid.
 *
 * ── Why a lexer and not `python3 -I -c "import ast"` ────────────────────────
 *
 * The engine walks hundreds of commits and reads every Python blob at each.
 * A spawned interpreter is absent on some machines (the host this runs on is
 * also a phone's desktop, and a Windows peer), costs a process per batch, and
 * would have to be bounded in time and fall back to "absent". Python's lexical
 * grammar is small enough to read exactly: strings (prefixes, triple quotes,
 * escapes), comments, brackets that suspend the line end, backslash
 * continuations and indentation. The syntax above that is read off logical
 * lines, which is all a `def`, a `class`, an `import` or a top-level name
 * needs. What this does NOT do is parse expressions, so it never claims to know
 * what a name refers to — it only reports which names were WRITTEN.
 *
 * ── Where it gives up, and says so ─────────────────────────────────────────
 *
 * A string that never closes on its line, or a bracket still open at the end of
 * the file, makes the lexer unsure of everything after it. Such a blob yields
 * NO identifiers and NO exports and no blocks (`dups` and `deadExports` then
 * see an empty file, the direction that adds no "dead" line), and `importsOf`
 * returns `null` so the graph reports the reading absent rather than a tree
 * with a lost edge. Identical to the TypeScript analyzer's rule.
 *
 * ── Dead-export caution (Python resolves names late) ───────────────────────
 *
 * A top-level `def` or `class` is an export unless something outside the
 * source text can reach it by a name nobody writes:
 *
 *   - Underscore names are private, and `test_*` / `Test*` are found by a runner.
 *   - A decorated function is registered by its decorator (`@app.get`,
 *     `@click.command`, `@pytest.fixture`, `@celery.task`). Only decorators
 *     that change nothing about reachability (`dataclass`, `lru_cache`,
 *     `contextmanager`, ...) leave a name an export.
 *   - A module-level `__getattr__` makes every name lazy: the file offers none.
 *   - Names in `__all__` are the file's declared API: not offered as dead.
 *   - `main`, `app`, `handler`, `upgrade`/`downgrade` and friends are entry
 *     points a framework or a console script names in a config file.
 *   - Scripts and framework roots (`setup.py`, `manage.py`, `conftest.py`,
 *     `wsgi.py`, `__main__.py`, ...) offer nothing.
 *
 * Every string that is shaped like a name (or a dotted path) contributes its
 * names, and every word inside an f-string, so `getattr(m, "run")` and
 * `f"{render(x)}"` both count as uses. Over-inclusive on purpose: a false
 * "still used" costs nothing, a false "dead" sends somebody to delete live
 * code.
 *
 * Nothing here may call a model, touch the network, run a process or read a file.
 */

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const STRING_PREFIX = /^[rRbBuUfF]{1,2}$/;
const NAME_RE = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER_RE = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/y;
const OP_RE = /\*\*=|\/\/=|>>=|<<=|\.\.\.|->|:=|==|!=|<=|>=|\*\*|\/\/|>>|<<|[-+*/%&|^@]=|[\s\S]/y;
const IDENT_SHAPED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

const T_STRING = "\u0002str";
const T_NUMBER = "\u0002num";
const T_NEWLINE = "\u0002nl";
const T_INDENT = "\u0002in";
const T_DEDENT = "\u0002de";

/**
 * @typedef {{k: "n" | "s" | "d" | "o", v: string, line: number, p: number, e: number, f?: boolean}} Tok
 * @typedef {{indent: number, toks: Tok[], line: number, endLine: number}} LLine
 */

/**
 * Text -> logical lines, or `null` when the lexer cannot tell where it is.
 * @param {string} text
 * @returns {LLine[] | null}
 */
export function lex(text) {
  const n = text.length;
  let i = 0;
  let line = 1;
  let depth = 0;
  /** @type {LLine[]} */
  const lines = [];
  /** @type {LLine | null} */
  let cur = null;
  let atStart = true;

  const skipComment = () => {
    while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
  };

  while (i < n) {
    if (atStart && depth === 0) {
      let col = 0;
      let j = i;
      while (j < n) {
        const c = text[j];
        if (c === " ") col++;
        else if (c === "\t") col = (Math.floor(col / 8) + 1) * 8;
        else if (c === "\f") col = 0;
        else break;
        j++;
      }
      if (j >= n) break;
      const c = text[j];
      if (c === "\n") {
        line++;
        i = j + 1;
        continue;
      }
      if (c === "\r") {
        i = j + 1;
        if (text[i] === "\n") i++;
        line++;
        continue;
      }
      if (c === "#") {
        i = j;
        skipComment();
        continue;
      }
      cur = { indent: col, toks: [], line, endLine: line };
      atStart = false;
      i = j;
    }
    const c = text[i];
    if (c === " " || c === "\t" || c === "\f") {
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      line++;
      if (depth === 0) {
        if (cur) lines.push(cur);
        cur = null;
        atStart = true;
      }
      continue;
    }
    if (c === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) {
      i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 2;
      line++;
      continue;
    }
    if (c === "#") {
      skipComment();
      continue;
    }
    if (!cur) return null;

    const quoteAt = (j) => text[j] === '"' || text[j] === "'";
    let name = null;
    if (/[\p{L}_]/u.test(c)) {
      NAME_RE.lastIndex = i;
      name = NAME_RE.exec(text)[0];
    }
    if (quoteAt(i) || (name && name.length <= 2 && STRING_PREFIX.test(name) && quoteAt(i + name.length))) {
      const prefix = name && !quoteAt(i) ? name : "";
      const start = i;
      let k = i + prefix.length;
      const q = text[k];
      const triple = text[k + 1] === q && text[k + 2] === q;
      k += triple ? 3 : 1;
      const bodyStart = k;
      let closed = false;
      while (k < n) {
        const ch = text[k];
        if (ch === "\\") {
          if (text[k + 1] === "\n") line++;
          k += 2;
          continue;
        }
        if (ch === "\n") {
          if (!triple) return null;
          line++;
        } else if (ch === q && (!triple || (text[k + 1] === q && text[k + 2] === q))) {
          closed = true;
          break;
        }
        k++;
      }
      if (!closed) return null;
      const body = text.slice(bodyStart, k);
      const endPos = k + (triple ? 3 : 1);
      cur.toks.push({ k: "s", v: body, line, p: start, e: endPos, f: /[fF]/.test(prefix) });
      cur.endLine = line;
      i = endPos;
      continue;
    }
    if (name) {
      cur.toks.push({ k: "n", v: name, line, p: i, e: i + name.length });
      cur.endLine = line;
      i += name.length;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      const len = m && m[0].length ? m[0].length : 1;
      cur.toks.push({ k: "d", v: text.slice(i, i + len), line, p: i, e: i + len });
      cur.endLine = line;
      i += len;
      continue;
    }
    OP_RE.lastIndex = i;
    const op = OP_RE.exec(text)[0];
    if (op === "(" || op === "[" || op === "{") depth++;
    else if (op === ")" || op === "]" || op === "}") depth = Math.max(0, depth - 1);
    cur.toks.push({ k: "o", v: op, line, p: i, e: i + op.length });
    cur.endLine = line;
    i += op.length;
  }
  if (depth > 0) return null;
  if (cur && cur.toks.length) lines.push(cur);
  return lines;
}

/** Split a logical line on top-level `;` into statements (token arrays). */
function statements(toks) {
  if (!toks.some((t) => t.k === "o" && t.v === ";")) return [toks];
  const out = [];
  let from = 0;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].k === "o" && toks[i].v === ";") {
      if (i > from) out.push(toks.slice(from, i));
      from = i + 1;
    }
  }
  if (from < toks.length) out.push(toks.slice(from));
  return out;
}

/** `[a, ., b]`-style dotted run starting at `i`: `{names, next}`. */
function dotted(toks, i) {
  const names = [];
  while (i < toks.length && toks[i].k === "n" && !KEYWORDS.has(toks[i].v)) {
    names.push(toks[i].v);
    if (toks[i + 1] && toks[i + 1].k === "o" && toks[i + 1].v === "." && toks[i + 2] && toks[i + 2].k === "n") i += 2;
    else {
      i++;
      break;
    }
  }
  return { names, next: i };
}

/**
 * One `import` / `from` statement as a record, or null.
 * `tc` is set for a statement under `if TYPE_CHECKING:`, which never runs.
 */
function importRecord(toks, tc, line) {
  if (!toks.length || toks[0].k !== "n") return null;
  if (toks[0].v === "import") {
    const modules = [];
    let i = 1;
    for (;;) {
      const d = dotted(toks, i);
      if (!d.names.length) break;
      modules.push(d.names);
      i = d.next;
      if (toks[i] && toks[i].v === "as") i += 2;
      if (toks[i] && toks[i].k === "o" && toks[i].v === ",") i++;
      else break;
    }
    return modules.length ? { from: false, dots: 0, module: [], modules, names: [], tc, line } : null;
  }
  if (toks[0].v === "from") {
    let i = 1;
    let dots = 0;
    while (toks[i] && toks[i].k === "o" && (toks[i].v === "." || toks[i].v === "...")) {
      dots += toks[i].v.length;
      i++;
    }
    const d = dotted(toks, i);
    i = d.next;
    if (!toks[i] || toks[i].v !== "import") return null;
    i++;
    const names = [];
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === "o" && t.v === "*") names.push("*");
      else if (t.k === "n" && t.v !== "as" && !KEYWORDS.has(t.v)) {
        names.push(t.v);
        if (toks[i + 1] && toks[i + 1].v === "as") i += 2;
      }
    }
    if (dots === 0 && d.names.length === 0) return null;
    return { from: true, dots, module: d.names, modules: [], names, tc, line };
  }
  return null;
}

const SAFE_DECORATORS = new Set([
  "dataclass", "dataclasses.dataclass", "lru_cache", "functools.lru_cache", "cache", "functools.cache",
  "contextmanager", "contextlib.contextmanager", "asynccontextmanager", "contextlib.asynccontextmanager",
  "final", "typing.final", "total_ordering", "functools.total_ordering", "staticmethod", "classmethod",
  "runtime_checkable", "typing.runtime_checkable", "unique", "enum.unique",
]);

const ENTRY_NAMES = new Set([
  "main", "app", "application", "handler", "lambda_handler", "create_app", "make_app", "cli", "upgrade", "downgrade",
  "setup", "teardown", "pytest_configure", "pytest_addoption", "load_tests",
]);

const ROOT_FILES = /(?:^|\/)(?:setup|manage|conftest|wsgi|asgi|__main__|noxfile|fabfile|tasks|alembic\/env|env)\.py$/;

/** Decorator text of a line starting with `@`: `a.b.c` before any `(`. */
function decoratorName(toks) {
  const d = dotted(toks, 1);
  return d.names.join(".");
}

/**
 * One blob, read once. `params` null skips the token stream.
 * @returns {{ok: boolean, identifiers: Set<string>, exports: string[], imports: object[], blocks: object[], stream: string[] | null}}
 */
function analyzeBlob(path, text, params) {
  const identifiers = new Set();
  const lines = lex(text);
  if (!lines) return { ok: false, identifiers, exports: [], imports: [], blocks: [], stream: null };

  const stream = params ? [] : null;
  const lineStart = [];
  const imports = [];
  const reserved = new Set(); // names in __all__
  const defs = []; // top-level candidate exports
  const blocks = [];
  let hasModuleGetattr = false;

  // Pass 1: names, strings, the token stream.
  let prevIndent = 0;
  const indents = [0];
  for (const ln of lines) {
    lineStart.push(stream ? stream.length : 0);
    if (stream) {
      if (ln.indent > indents[indents.length - 1]) {
        indents.push(ln.indent);
        stream.push(T_INDENT);
      } else {
        while (ln.indent < indents[indents.length - 1]) {
          indents.pop();
          stream.push(T_DEDENT);
        }
      }
      prevIndent = ln.indent;
    }
    for (const t of ln.toks) {
      switch (t.k) {
        case "n":
          if (!KEYWORDS.has(t.v)) identifiers.add(t.v);
          if (stream) stream.push(t.v);
          break;
        case "s":
          if (IDENT_SHAPED.test(t.v)) for (const w of t.v.match(WORD)) identifiers.add(w);
          else if (t.f) for (const w of t.v.match(WORD) ?? []) identifiers.add(w);
          if (stream) stream.push(T_STRING);
          break;
        case "d":
          if (stream) stream.push(T_NUMBER);
          break;
        default:
          if (stream) stream.push(t.v);
      }
    }
    if (stream) stream.push(T_NEWLINE);
  }
  void prevIndent;

  // Pass 2: structure.
  let tcIndent = null;
  /** @type {{indent: number, name: string, kind: "def" | "class"}[]} */
  const scope = [];
  let decorators = [];
  const L = lines.length;
  const endOf = (k) => {
    let j = k + 1;
    while (j < L && lines[j].indent > lines[k].indent) j++;
    return j - 1;
  };

  for (let k = 0; k < L; k++) {
    const ln = lines[k];
    const toks = ln.toks;
    while (scope.length && scope[scope.length - 1].indent >= ln.indent) scope.pop();
    if (tcIndent !== null && ln.indent <= tcIndent) tcIndent = null;
    const inTC = tcIndent !== null;
    const first = toks[0];

    if (first.k === "n" && first.v === "if") {
      // `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`
      const rest = toks.slice(1, -1).map((t) => t.v).join("");
      if (/^(?:typing\.|t\.)?TYPE_CHECKING$/.test(rest) && toks[toks.length - 1].v === ":") tcIndent = ln.indent;
    }

    for (const st of statements(toks)) {
      if (st[0].k === "n" && (st[0].v === "import" || st[0].v === "from")) {
        const r = importRecord(st, inTC, ln.line);
        if (r) {
          r.deferred = scope.some((s) => s.kind === "def");
          imports.push(r);
        }
      }
    }

    if (first.k === "o" && first.v === "@") {
      decorators.push(decoratorName(toks));
      continue;
    }

    let defAt = -1;
    if (first.k === "n" && first.v === "def") defAt = 0;
    else if (first.k === "n" && first.v === "async" && toks[1] && toks[1].v === "def") defAt = 1;
    const isClass = first.k === "n" && first.v === "class";

    if ((defAt >= 0 || isClass) && toks[defAt >= 0 ? defAt + 1 : 1] && toks[defAt >= 0 ? defAt + 1 : 1].k === "n") {
      const name = toks[defAt >= 0 ? defAt + 1 : 1].v;
      if (ln.indent === 0) {
        if (defAt >= 0 && name === "__getattr__") hasModuleGetattr = true;
        defs.push({ name, decorators });
      }
      const inDef = scope.some((s) => s.kind === "def");
      const dotName = [...scope.map((s) => s.name), name].join(".");
      if (defAt >= 0 && params && (params.nested || !inDef)) {
        const endIdx = endOf(k);
        const lines_ = lines[endIdx].endLine - ln.line + 1;
        if (lines_ >= params.minLines) {
          blocks.push({
            name: dotName,
            line: ln.line,
            lines: lines_,
            start: toks[0].p,
            end: lines[endIdx].toks[lines[endIdx].toks.length - 1].e,
            tokStart: lineStart[k],
            tokEnd: endIdx + 1 < L ? lineStart[endIdx + 1] : stream.length,
          });
        }
      }
      scope.push({ indent: ln.indent, name, kind: defAt >= 0 ? "def" : "class" });
      decorators = [];
      continue;
    }
    decorators = [];

    // `__all__ = [...]`, `__all__ += [...]`
    if (ln.indent === 0 && first.k === "n" && first.v === "__all__") {
      for (const t of toks) if (t.k === "s") reserved.add(t.v);
    }

    // A multi-line module- or class-level assignment is a block too: a data
    // table copied between two files is a clone.
    if (params && first.k === "n" && !KEYWORDS.has(first.v) && first.v !== "__all__" && toks[1] && toks[1].k === "o" && (toks[1].v === "=" || toks[1].v === ":")) {
      const top = scope[scope.length - 1];
      if (!top || (top.kind === "class" && !scope.some((s) => s.kind === "def"))) {
        const lines_ = ln.endLine - ln.line + 1;
        if (lines_ >= params.minLines) {
          blocks.push({
            name: [...scope.map((s) => s.name), first.v].join("."),
            line: ln.line,
            lines: lines_,
            start: toks[0].p,
            end: toks[toks.length - 1].e,
            tokStart: lineStart[k],
            tokEnd: k + 1 < L ? lineStart[k + 1] : stream.length,
          });
        }
      }
    }
  }

  const rootFile = ROOT_FILES.test(path);
  const exports = [];
  if (!hasModuleGetattr && !rootFile) {
    for (const d of defs) {
      const n = d.name;
      if (n.startsWith("_") || n.startsWith("test_") || /^Test[A-Z_]/.test(n) || ENTRY_NAMES.has(n) || /^(?:get|build|make|create)_app$/.test(n) || reserved.has(n)) continue;
      if (d.decorators.some((dn) => !SAFE_DECORATORS.has(dn))) continue;
      exports.push(n);
    }
  }
  return { ok: true, identifiers, exports, imports, blocks, stream };
}

/** A content key for blobs that arrive without an oid (same FNV-1a as the TS analyzer). */
export function contentKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `c${(h >>> 0).toString(36)}:${text.length}`;
}

// ── minhash (same seed and mixing as typescript-ast.mjs) ────────────────────

const COEFF_CACHE = new Map();
function coefficients(n) {
  const hit = COEFF_CACHE.get(n);
  if (hit) return hit;
  const a = new Int32Array(n);
  const b = new Int32Array(n);
  let x = 0x9e3779b9;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < n; i++) {
    a[i] = next() | 1;
    b[i] = next();
  }
  const c = { a, b };
  COEFF_CACHE.set(n, c);
  return c;
}

function signature(tokens, from, to, shingle, hashes) {
  if (to - from < shingle) return null;
  const { a, b } = coefficients(hashes);
  const sig = new Int32Array(hashes).fill(-1);
  let any = false;
  for (let i = from; i + shingle <= to; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < shingle; j++) {
      const t = tokens[i + j];
      for (let k = 0; k < t.length; k++) {
        h ^= t.charCodeAt(k);
        h = Math.imul(h, 0x01000193);
      }
      h ^= 0x2f;
      h = Math.imul(h, 0x01000193);
    }
    h >>>= 0;
    any = true;
    for (let k = 0; k < hashes; k++) {
      const v = (Math.imul(a[k], h) + b[k]) >>> 0;
      if (v < (sig[k] >>> 0)) sig[k] = v | 0;
    }
  }
  return any ? sig : null;
}

// ── per-blob caches, keyed by oid (or content hash) ─────────────────────────

/** key -> `{identifiers, exports, imports | null}`. */
const IDENT_CACHE = new Map();
const BLOCK_CACHE = new Map();

export function clearPythonCaches() {
  IDENT_CACHE.clear();
  BLOCK_CACHE.clear();
}

function remember(key, a) {
  const hit = { identifiers: a.identifiers, exports: a.exports, imports: a.ok ? a.imports : null };
  IDENT_CACHE.set(key, hit);
  return hit;
}

function identEntry(key, path, text) {
  const k = `${key}|${ROOT_FILES.test(path) ? 1 : 0}`;
  return IDENT_CACHE.get(k) ?? remember(k, analyzeBlob(path, text, null));
}

/** `{identifiers, exports}` for one blob. */
export function identsOf(key, path, text) {
  const { identifiers, exports } = identEntry(key, path, text);
  return { identifiers, exports };
}

/** The import statements one blob runs, or `null` when the lexer lost its place. */
export function importsOf(key, path, text) {
  return identEntry(key, path, text).imports;
}

/** Signed blocks of one blob: `{name, line, lines, start, end, sig}`. */
export function signedBlocks(oid, path, text, params) {
  const key = `${oid}|${params.minLines},${params.shingle},${params.hashes},${params.nested ? 1 : 0}`;
  const hit = BLOCK_CACHE.get(key);
  if (hit) return hit;
  const out = [];
  const a = analyzeBlob(path, text, params);
  const ik = `${oid}|${ROOT_FILES.test(path) ? 1 : 0}`;
  if (!IDENT_CACHE.has(ik)) remember(ik, a);
  if (a.ok) {
    for (const b of a.blocks) {
      const sig = signature(a.stream, b.tokStart, b.tokEnd, params.shingle, params.hashes);
      if (!sig) continue;
      out.push({ name: b.name, line: b.line, lines: b.lines, start: b.start, end: b.end, sig });
    }
  }
  BLOCK_CACHE.set(key, out);
  return out;
}
