/**
 * A Dart tokenizer and a declaration scanner, in plain JS.
 *
 * There is no Dart parser in this tool's reach (the SDK's analyzer is a
 * separate install, and `git.mjs` is the only module allowed to spawn
 * anything), and the three questions asked of Dart code need less than one:
 *
 *   - which URIs a file imports, exports or takes as a `part` (directives);
 *   - which top-level names a library declares, and which names it uses;
 *   - where the function-like bodies are, for the clone detector.
 *
 * All three come off one token stream plus a bracket-matching pass, with no
 * grammar. The scanner reads a *header* (everything up to the first `(`, `{`,
 * `=`, `=>` or `;` at depth 0) and decides what it was from the first tokens,
 * the way a person skimming the file does. Where it cannot tell it says
 * nothing: a declaration it fails to name is a name never listed as an export,
 * which can only ever remove a dead-export line, never add one.
 *
 * ── What the lexer gets right on purpose ────────────────────────────────────
 *
 *   - Comments, including nested block comments, are dropped. A `// import 'x'`
 *     is not an import, and a name in a comment is not a use.
 *   - Strings: single, double, triple, raw (`r'..'`). `$name` and `${expr}` are
 *     READ, because they are real uses of the name; the string itself becomes
 *     one `str` token with its value kept when it has no interpolation (a
 *     directive's URI is such a string).
 *   - `>` is never merged with a following `>`: `List<List<int>>` must close
 *     two generics. `=>`, `==`, `<=`, `>=`, `!=` stay whole so a header scan
 *     does not mistake them for an assignment.
 *
 * `ok` is false when the file ended inside a comment, a string or an
 * unbalanced bracket run the lexer could not recover from: callers treat that
 * as "imports unknown", never as a shorter list (the graph reading would
 * otherwise lose every edge after the spot).
 */

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;
const OP = /^(?:=>|==|!=|<=|>=|&&|\|\||\?\?=?|\?\.|\.\.\.\??|\?\.\.|\.\.|\+\+|--|[-+*\/%&|^~]=|<<=?)/;
const NUM = /^(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][-+]?\d+)?)/y;

/**
 * @typedef {{k: "id" | "str" | "num" | "op", s: string, p: number, e: number, plain?: boolean}} Tok
 */

/**
 * @param {string} text
 * @returns {{toks: Tok[], interp: Set<string>, ok: boolean}}
 */
export function lexDart(text) {
  const n = text.length;
  /** @type {Tok[]} */
  const toks = [];
  const interp = new Set();
  let ok = true;

  /** Lex code from `i`; stop at the `}` that closes an interpolation. Returns the index after it. */
  function code(i, sink, untilClose) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") {
        i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        let d = 1;
        i += 2;
        while (i < n && d > 0) {
          if (text[i] === "/" && text[i + 1] === "*") {
            d++;
            i += 2;
          } else if (text[i] === "*" && text[i + 1] === "/") {
            d--;
            i += 2;
          } else i++;
        }
        if (d > 0) ok = false;
        continue;
      }
      if (c === "#" && text[i + 1] === "!" && i === 0) {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      // string, with an optional raw prefix
      if (c === "'" || c === '"' || ((c === "r" || c === "R") && (text[i + 1] === "'" || text[i + 1] === '"'))) {
        i = string(i, sink);
        continue;
      }
      if (ID_START.test(c)) {
        let j = i + 1;
        while (j < n && ID_PART.test(text[j])) j++;
        sink.push({ k: "id", s: text.slice(i, j), p: i, e: j });
        i = j;
        continue;
      }
      if (c >= "0" && c <= "9") {
        NUM.lastIndex = i;
        const m = NUM.exec(text);
        const j = m && m[0].length ? i + m[0].length : i + 1;
        sink.push({ k: "num", s: "N", p: i, e: j });
        i = j;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilClose && depth === 0) return i + 1;
        depth--;
      }
      const m = OP.exec(text.slice(i, i + 4));
      const len = m ? m[0].length : 1;
      sink.push({ k: "op", s: text.slice(i, i + len), p: i, e: i + len });
      i += len;
    }
    if (untilClose) ok = false;
    return i;
  }

  /** Lex one string literal starting at `i`; push one `str` token. Returns the index after it. */
  function string(i, sink) {
    const start = i;
    let raw = false;
    if (text[i] === "r" || text[i] === "R") {
      raw = true;
      i++;
    }
    const q = text[i];
    const triple = text[i + 1] === q && text[i + 2] === q;
    i += triple ? 3 : 1;
    let value = "";
    let plain = true;
    for (;;) {
      if (i >= n) {
        ok = false;
        break;
      }
      const c = text[i];
      if (triple ? c === q && text[i + 1] === q && text[i + 2] === q : c === q) {
        i += triple ? 3 : 1;
        break;
      }
      if (!triple && c === "\n") {
        // A single-quoted string does not span lines: recover at the newline.
        ok = false;
        break;
      }
      if (!raw && c === "\\") {
        value += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (!raw && c === "$") {
        if (text[i + 1] === "{") {
          plain = false;
          // Its tokens are discarded, its identifiers are real uses.
          const tmp = [];
          i = code(i + 2, tmp, true);
          for (const x of tmp) if (x.k === "id") interp.add(x.s);
          continue;
        }
        if (ID_START.test(text[i + 1] ?? "")) {
          plain = false;
          let j = i + 2;
          while (j < n && ID_PART.test(text[j])) j++;
          interp.add(text.slice(i + 1, j));
          i = j;
          continue;
        }
      }
      value += c;
      i++;
    }
    sink.push({ k: "str", s: plain ? value : "S", p: start, e: i, plain });
    return i;
  }

  code(0, toks, false);
  return { toks, interp, ok };
}

// ── brackets ────────────────────────────────────────────────────────────────

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** `match[i]` is the index of the bracket that closes `toks[i]`, or -1. */
export function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== "op") continue;
    if (OPEN[t.s]) stack.push(i);
    else if (t.s === ")" || t.s === "]" || t.s === "}") {
      // Pop to the nearest opener of the same family; stray closers are ignored.
      for (let j = stack.length - 1; j >= 0; j--) {
        if (OPEN[toks[stack[j]].s] === t.s) {
          match[stack[j]] = i;
          stack.length = j;
          break;
        }
      }
    }
  }
  return match;
}

// ── the declaration scanner ─────────────────────────────────────────────────

const CLASS_LIKE = new Set(["class", "mixin", "enum", "extension", "typedef"]);
const MODIFIERS = new Set([
  "abstract", "base", "final", "interface", "sealed", "static", "external", "const", "late", "var", "covariant", "factory", "augment",
]);

const isOp = (t, s) => t !== undefined && t.k === "op" && t.s === s;

/**
 * Skip an annotation at `i` (`@name`, `@a.b(args)`), return the index after it
 * and its leading name.
 */
function annotation(toks, match, i) {
  let j = i + 1;
  let name = "";
  while (j < toks.length && toks[j].k === "id") {
    name += (name ? "." : "") + toks[j].s;
    j++;
    if (isOp(toks[j], ".")) j++;
    else break;
  }
  if (isOp(toks[j], "(") && match[j] > 0) j = match[j] + 1;
  return { next: j, name };
}

/**
 * Find the end of a function-like or variable declaration whose header ended
 * at `t` (the terminator index). Returns `{end, name}` with `end` the index of
 * the last token, or null when the shape is not recognised.
 */
function afterHeader(toks, match, hs, t) {
  const term = toks[t];
  const prevId = (from) => {
    let k = from - 1;
    // `foo<T>(` : step back over the type arguments.
    if (isOp(toks[k], ">")) {
      let d = 0;
      for (; k >= hs; k--) {
        if (isOp(toks[k], ">")) d++;
        else if (isOp(toks[k], "<") && --d === 0) {
          k--;
          break;
        }
      }
    }
    return k >= hs && toks[k].k === "id" ? toks[k].s : null;
  };
  if (term.s === "(") {
    const name = prevId(t);
    let j = match[t];
    if (j < 0) return null;
    j++;
    // Initializer list, `async`, `sync*`: walk to the body or the `;`.
    while (j < toks.length) {
      const x = toks[j];
      if (x.k === "op" && (x.s === "{" || x.s === "=>" || x.s === ";")) break;
      if (x.k === "op" && (x.s === "(" || x.s === "[") && match[j] > 0) j = match[j];
      j++;
    }
    return bodyEnd(toks, match, j, name);
  }
  if (term.s === "{" || term.s === "=>") return bodyEnd(toks, match, t, prevId(t));
  // `=` or `;`: a variable.
  const name = prevId(t);
  if (term.s === ";") return { end: t, name, names: name ? [name] : [], variable: true };
  const names = name ? [name] : [];
  let j = t + 1;
  while (j < toks.length) {
    const x = toks[j];
    if (x.k === "op" && x.s === ";") break;
    if (x.k === "op" && (x.s === "(" || x.s === "[" || x.s === "{") && match[j] > 0) {
      j = match[j] + 1;
      continue;
    }
    if (x.k === "op" && x.s === "," && toks[j + 1]?.k === "id" && toks[j + 2]?.k === "op" && (toks[j + 2].s === "=" || toks[j + 2].s === "," || toks[j + 2].s === ";")) {
      names.push(toks[j + 1].s);
    }
    j++;
  }
  return { end: Math.min(j, toks.length - 1), name, names, variable: true, init: true };
}

function bodyEnd(toks, match, j, name) {
  const x = toks[j];
  if (!x) return null;
  if (x.s === ";") return { end: j, name, body: false };
  if (x.s === "{") return match[j] > 0 ? { end: match[j], name, body: true } : null;
  if (x.s === "=>") {
    let k = j + 1;
    while (k < toks.length) {
      const y = toks[k];
      if (y.k === "op" && y.s === ";") break;
      if (y.k === "op" && (y.s === "(" || y.s === "[" || y.s === "{") && match[k] > 0) {
        k = match[k] + 1;
        continue;
      }
      k++;
    }
    return { end: Math.min(k, toks.length - 1), name, body: true };
  }
  return null;
}

/**
 * First terminator of a header from `i`: the index of the first `(` `{` `=`
 * `=>` `;` at depth 0, stepping over `Function(` parameter lists and `[..]`.
 */
function headerEnd(toks, match, i, stopAtBrace) {
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.k !== "op") continue;
    if (t.s === "[" && match[j] > 0) {
      j = match[j];
      continue;
    }
    if (t.s === "(") {
      if (toks[j - 1]?.k === "id" && toks[j - 1].s === "Function" && match[j] > 0) {
        j = match[j];
        continue;
      }
      return j;
    }
    if (t.s === "{" || t.s === "=" || t.s === "=>" || t.s === ";") return j;
    if (stopAtBrace === false && t.s === "}") return -1;
  }
  return -1;
}

/**
 * Scan a run of declarations in `toks[from, to)`.
 *
 * @param {Tok[]} toks
 * @param {Int32Array} match
 * @param {number} from
 * @param {number} to
 * @param {boolean} top  Top level: directives and class-likes are read.
 * @param {string} scope  Enclosing class name, for block names.
 * @param {{directives: object[], decls: object[]}} out
 */
function scanRun(toks, match, from, to, top, scope, out) {
  let i = from;
  while (i < to) {
    const t = toks[i];
    if (t.k === "op" && (t.s === ";" || t.s === "}" || t.s === ",")) {
      i++;
      continue;
    }
    // metadata
    const notes = [];
    while (i < to && isOp(toks[i], "@")) {
      const a = annotation(toks, match, i);
      notes.push(a.name);
      i = a.next;
    }
    if (i >= to) break;
    const first = toks[i];
    const hs = i;

    if (top && first.k === "id" && (first.s === "import" || first.s === "export" || first.s === "part" || first.s === "library")) {
      let j = i + 1;
      const uris = [];
      let partOf = false;
      if (first.s === "part" && toks[j]?.k === "id" && toks[j].s === "of") {
        partOf = true;
        j++;
      }
      while (j < to && !isOp(toks[j], ";")) {
        const x = toks[j];
        // A string after `==` is a condition's operand, not an alternative URI.
        if (x.k === "str" && x.plain && !isOp(toks[j - 1], "==")) uris.push(x.s);
        if (isOp(x, "(") && match[j] > 0) {
          // Conditional-import test `if (dart.library.io)`: its own strings are skipped by the `==` rule above.
          j++;
          continue;
        }
        j++;
      }
      if (first.s !== "library") out.directives.push({ kind: partOf ? "partof" : first.s, uris, tok: i });
      i = j + 1;
      continue;
    }

    // class-like?
    let kw = -1;
    for (let j = i; j < Math.min(i + 5, to); j++) {
      const x = toks[j];
      if (x.k !== "id") break;
      if (CLASS_LIKE.has(x.s) && toks[j + 1] && (toks[j + 1].k === "id" || x.s === "extension")) {
        kw = j;
        break;
      }
      if (!MODIFIERS.has(x.s) && x.s !== "mixin" && x.s !== "interface") break;
    }
    if (kw >= 0 && top) {
      const kind = toks[kw].s;
      let nameTok = toks[kw + 1];
      if (kind === "extension") {
        if (nameTok?.k === "id" && nameTok.s === "type") nameTok = toks[kw + 2];
        if (nameTok?.k === "id" && nameTok.s === "on") nameTok = null;
      }
      const name = nameTok?.k === "id" ? nameTok.s : null;
      // Header end: `{` or `;` (or `=` for a mixin application), over parens.
      let j = kw + 1;
      let term = -1;
      for (; j < to; j++) {
        const x = toks[j];
        if (x.k !== "op") continue;
        if ((x.s === "(" || x.s === "[") && match[j] > 0) {
          j = match[j];
          continue;
        }
        if (x.s === "{" || x.s === ";" || x.s === "=") {
          term = j;
          break;
        }
      }
      if (term < 0) break;
      let end = term;
      let body = null;
      if (toks[term].s === "{" && match[term] > 0) {
        end = match[term];
        body = [term + 1, end];
      } else if (toks[term].s === "=") {
        while (end < to && !isOp(toks[end], ";")) end++;
      }
      out.decls.push({ kind, name, hs, end, notes, top: true, scope: "" });
      if (body && (kind === "class" || kind === "mixin" || kind === "extension" || kind === "enum")) {
        let bs = body[0];
        if (kind === "enum") {
          // Values come first, then `;`, then members.
          let k = bs;
          while (k < body[1] && !isOp(toks[k], ";")) {
            if ((toks[k].s === "(" || toks[k].s === "{" || toks[k].s === "[") && match[k] > 0) k = match[k];
            k++;
          }
          bs = k + 1;
        }
        if (bs < body[1]) scanRun(toks, match, bs, body[1], false, name ?? "(ext)", out);
      }
      i = end + 1;
      continue;
    }

    // function / method / variable
    const t0 = headerEnd(toks, match, i, true);
    if (t0 < 0 || t0 >= to) break;
    const r = afterHeader(toks, match, hs, t0);
    if (!r || r.end < i) {
      i++;
      continue;
    }
    const kind = r.variable ? "var" : "fn";
    if (r.name || r.names?.length) {
      const names = r.names?.length ? r.names : [r.name];
      out.decls.push({
        kind,
        name: names[0],
        extra: names.slice(1),
        hs,
        end: r.end,
        notes,
        top,
        scope,
        hasBody: r.body !== false && (r.body === true || r.init === true),
      });
    }
    i = r.end + 1;
  }
}

/**
 * Everything the analyzers and the resolver read off one file, memoised by
 * the caller.
 *
 * @param {string} text
 */
export function parseDart(text) {
  const { toks, interp, ok } = lexDart(text);
  const match = matchBrackets(toks);
  const out = { directives: [], decls: [] };
  if (ok) scanRun(toks, match, 0, toks.length, true, "", out);
  return { toks, interp, ok, directives: out.directives, decls: out.decls };
}
