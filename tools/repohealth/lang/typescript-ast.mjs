/**
 * TypeScript source read into the products a clone detector and an orphan
 * detector are computed from: the identifiers a blob writes, the value names it
 * exports, its blocks, and a signature per block.
 *
 * All of it comes out of ONE parse of one tree, which is why the analyzer is a
 * module and not a pair of private helpers: `dups.mjs` and `deadexports.mjs`
 * are both callers, and a second parse would be a second definition of "what
 * names does this file use". Nothing here imports either of them, or any other
 * metric — the dependency runs one way, so a second language can arrive as a
 * second module beside this one.
 *
 * Nothing here may call a model, touch the network, or read a file.
 *
 * ── Why the whole tree is read through the AST, and never the scanner ───────
 *
 * This analyzer used to drive `ts.createScanner` raw — no `reScanTemplateToken`,
 * no `reScanJsxToken` — on the argument that a mangling applied to both copies
 * of a block mangles them identically, so clone detection survives it. The
 * argument is wrong, and it was wrong in the direction that produces confident
 * numbers from almost none of the source.
 *
 * A raw scanner stops understanding the file at the first `` ` ``. After a
 * `TemplateHead` it hands back the `}` that closes `${…}` as an ordinary
 * `CloseBraceToken`, scans the template's tail as code, and then treats the
 * NEXT backtick as the opening of a fresh template that runs to the one after
 * it. JSX prose does the same through apostrophes: `don't` opens a string that
 * closes at the newline, or does not close at all.
 *
 * Measured under the old tokenizer at HEAD `36aed6c` (325 files, 143,176
 * lines): 220 of the 325 files contained a literal token spanning three or
 * more lines, and 74,723 lines — 52% of the repo — sat inside one, 13,094 of
 * them in `App.tsx`'s 16,236. The consequence is not a slightly blurred
 * signature. EVERY ONE of the 325 identifier sets was wrong, in both
 * directions at once: 10,750 names a file genuinely writes were absent, and
 * 16,705 that it does not write were present. `App.tsx` alone was missing 818,
 * including `GEMINI_MODELS` and `RISKY_PERM_MODES`, which it declares AND uses;
 * and it had gained `{`, `|`, `interface`, `mp4` and `rm` — punctuation and
 * keywords, because the old filter kept any token text starting above `@`,
 * plus identifiers lifted out of template and JSX prose. A name invented out
 * of prose is a false "still used" that hides an orphan; a name lost inside a
 * template is a false "dead" that sends somebody to delete live code, and 8 of
 * the 277 exports the old dead-export tripwire reported were exactly that.
 *
 * The repair is to take both products — the identifier set and the token
 * stream that gets shingled — from the tree the parser already builds.
 * `ts.createSourceFile` handles template nesting and JSX by construction,
 * because it is the same code the compiler uses to compile them, so there is
 * no hand-maintained template-depth stack here to get wrong later. One
 * pre-order walk per blob emits, in source order: an identifier's text, a
 * placeholder for each literal, and a control-prefixed `SyntaxKind` name for
 * every other node. Re-measured after the change, the same question asked of
 * a GENUINE literal node — the only honest form of it — answers 39 of 325
 * files and 742 of 143,176 lines, 28 of them in `App.tsx`: the real
 * multi-line templates, and nothing else.
 *
 * Structural markers are part of the stream on purpose. They are what make two
 * blocks with the same identifiers in a different shape fail to pair, and they
 * cost nothing: the walk has the node kind in its hand. They are `SyntaxKind`
 * NAMES rather than numbers because the numbers are renumbered between
 * TypeScript releases and a signature has to mean the same thing next year.
 *
 * ── Why the memo is load-bearing ────────────────────────────────────────────
 *
 * 157 trees share only 2,071 unique blobs under `packages/`, and one of them is
 * a 16,236-line `App.tsx` that appears in 80 of those trees. Re-parsing per
 * commit turns a backfill from seconds into minutes. Everything a blob
 * contributes — its identifiers, its value exports, its signed blocks —
 * depends on the blob and on the pre-registered parameters and on nothing
 * else, so `SrcFile.oid` (plus those parameters, because a changed constant
 * must not be served a stale signature) is a complete cache key, and all three
 * come out of ONE parse. Per sha only the LSH pass and the mention table run.
 */

import { createRequire } from "node:module";

/**
 * `require`, not `await import`.
 *
 * `measureDups` has to stay SYNCHRONOUS. Every other `measure*` in this series
 * is a plain function, the row builder composes them in one expression, and a
 * single promise leaking into a row would land in the committed fixture as
 * `{}` and compare equal to nothing. `typescript` ships CommonJS, so
 * `createRequire` loads it synchronously and the contract in `types.mjs` — a
 * snapshot in, a `Measured` out — survives. Callers that write
 * `await measureDups(...)` out of habit still get the right answer.
 */
const require_ = createRequire(import.meta.url);

/** `{ ts }` once loaded, `null` while untried, `false` once known absent. */
let TS_STATE = null;

/** The compiler, or `null` when it is not installed. */
export function loadTypeScript() {
  if (TS_STATE === false) return null;
  if (TS_STATE) return TS_STATE.ts;
  try {
    const ts = require_("typescript");
    TS_STATE = { ts, markers: null };
    return ts;
  } catch {
    TS_STATE = false;
    return null;
  }
}

/** The one reason string every metric built on this analyzer keys "absent" on. */
export const NO_TYPESCRIPT = "typescript not installed";

// ── tokenisation ────────────────────────────────────────────────────────────

/**
 * Placeholders and the structural-marker prefix. Chosen from the C0 control
 * range so they cannot collide with anything that is also an identifier.
 */
const T_STRING = "s";
const T_NUMBER = "n";
const T_REGEX = "r";
const T_KIND = "";

/** JSX changes how `<` parses; `.mjs`/`.js` are parsed as ordinary TS. */
function isJsxPath(path) {
  return path.endsWith(".tsx") || path.endsWith(".jsx");
}

/**
 * `SyntaxKind` number -> the marker string for a node of that kind, built once
 * and shared by every token that needs it — a fresh `"" + name` per node
 * would allocate a few hundred thousand identical strings per large blob.
 *
 * The enum is reverse-mapped, so it also holds name -> number and several
 * aliases (`FirstToken`, `LastTypeNode`, …) that resolve to the same number as
 * a real kind. Taking the first name that maps back is deterministic and is
 * all a marker needs: it must be stable and distinct, not canonical. Names and
 * not numbers, because the numbers are renumbered between TypeScript releases
 * and a signature has to mean the same thing next year.
 */
function markersOf(ts) {
  if (!TS_STATE.markers) {
    const names = [];
    for (const [name, value] of Object.entries(ts.SyntaxKind)) {
      if (typeof value === "number" && names[value] === undefined) names[value] = name;
    }
    TS_STATE.markers = { one: names.map((n) => T_KIND + n), names };
  }
  return TS_STATE.markers;
}

/** A string that could have been written as an identifier. */
const IDENT_SHAPED = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ── blob analysis: one parse, three products ────────────────────────────────

/**
 * The name a block is reported under. Anonymous blocks keep their position:
 * `blockId` carries the line, so `(anonymous)` is never ambiguous.
 */
function blockName(ts, node) {
  const name = node.name;
  if (name) {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteralLike(name)) return name.text;
    return "(pattern)";
  }
  return "(anonymous)";
}

function isFunctionLike(ts, node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function hasModifier(ts, node, kind) {
  return !!node.modifiers && node.modifiers.some((m) => m.kind === kind);
}

/**
 * The names this module adds to somebody else's namespace at RUNTIME.
 *
 * Types are excluded on purpose — an unused exported interface is a word, not
 * a fork, and `.d.ts` is already out of the snapshot. `export default` and
 * `export *` are excluded because neither has a name a consumer has to write,
 * so "is this name mentioned anywhere else" is not a question that can be
 * asked about them. Binding patterns contribute their bound identifiers:
 * `export const {a, b} = x` really does export `a` and `b`.
 */
function valueExports(ts, sf) {
  const K = ts.SyntaxKind;
  const names = new Set();
  const fromBinding = (name) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (ts.isBindingElement(el)) fromBinding(el.name);
    }
  };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      // `export {a, b as c}` and `export {a} from "./m"`. The name a consumer
      // writes is the OUTER one (`c`), which is `element.name`.
      if (st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) if (!el.isTypeOnly) names.add(el.name.text);
      continue;
    }
    if (!hasModifier(ts, st, K.ExportKeyword)) continue;
    if (hasModifier(ts, st, K.DefaultKeyword) || hasModifier(ts, st, K.DeclareKeyword)) continue;
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (st.name && ts.isIdentifier(st.name)) names.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) fromBinding(d.name);
    }
  }
  return [...names].sort();
}

/**
 * One parse of one blob: its identifiers, its value exports, and its blocks
 * with the token range each covers.
 *
 * ── Which declarations are blocks, and why nested ones are ──────────────────
 *
 * `PREREG.DUP_NESTED_BLOCKS` is true, so the walk descends into function-likes
 * instead of stopping at the top level. It has to: `App.tsx` is ONE top-level
 * declaration of 15,199 lines, so a handler copied into two components — which
 * is most of what an agent actually duplicates — was invisible by
 * construction, not by measurement.
 *
 * ── How a parent and its own child are stopped from being two findings ──────
 *
 * Three rules, none of them a threshold:
 *
 *   1. A candidate that starts and ends on the SAME LINES as the block
 *      enclosing it is not a second block. `const f = () => {…}` is a
 *      declaration and an arrow function over exactly the same lines, and so
 *      is `const x = useMemo(() => {…})`; the outer one is kept because it is
 *      the one with a name a person can grep for.
 *   2. A pair of blocks from the same file whose spans overlap is never
 *      reported (see `measureDups`). A block cannot be a duplicate of the
 *      thing it is part of.
 *   3. A pair contained inside another reported pair is dropped, also in
 *      `measureDups`. A whole component copied elsewhere pairs at the top and
 *      again at every nested block within it; that is one fork, and the
 *      outermost pair is the one somebody can act on.
 *
 * A parent and a child forked into DIFFERENT places contain nothing of each
 * other and stay two findings. That is correct and it is the point: "this
 * component was copied" and "this handler inside it turns up in a third file"
 * are different sentences, and the pair ids say which is which.
 */
function analyzeBlob(ts, path, text, params) {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    isJsxPath(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const K = ts.SyntaxKind;
  const { one: marker, names } = markersOf(ts);
  const identifiers = new Set();
  const blocks = [];
  /** The shingled stream. Not built at all when only identifiers are wanted. */
  const tokens = params ? [] : null;
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;

  const visit = (node, scope, inDecl, enclosing) => {
    const kind = node.kind;
    const tokStart = tokens ? tokens.length : 0;

    // ── what this node contributes to the two streams ──
    switch (kind) {
      case K.Identifier:
      case K.PrivateIdentifier:
        identifiers.add(node.text);
        if (tokens) tokens.push(node.text);
        break;
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail:
      case K.JsxText:
        if (tokens) tokens.push(T_STRING);
        break;
      case K.NumericLiteral:
      case K.BigIntLiteral:
        if (tokens) tokens.push(T_NUMBER);
        break;
      case K.RegularExpressionLiteral:
        if (tokens) tokens.push(T_REGEX);
        break;
      default:
        // The operator of a unary expression is a field, not a child node, so
        // without it `-x` and `!x` shingle identically.
        if (tokens) {
          tokens.push(
            kind === K.PrefixUnaryExpression || kind === K.PostfixUnaryExpression
              ? marker[kind] + names[node.operator]
              : marker[kind],
          );
        }
        break;
    }

    // A quoted property name and `o["name"]` are how a consumer names an
    // export without writing an identifier. Over-inclusive on purpose: a
    // false "still used" costs nothing, a false "dead" sends somebody to
    // delete live code.
    if (node.name && ts.isStringLiteralLike(node.name) && IDENT_SHAPED.test(node.name.text)) {
      identifiers.add(node.name.text);
    }
    if (
      kind === K.ElementAccessExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      IDENT_SHAPED.test(node.argumentExpression.text)
    ) {
      identifiers.add(node.argumentExpression.text);
    }

    // ── is this a block? ──
    let candidate = false;
    if (params && (params.nested || !inDecl)) {
      candidate =
        (isFunctionLike(ts, node) && (!!node.body || ts.isArrowFunction(node))) ||
        ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
          !!node.initializer);
    }

    let scopeNow = scope;
    let enclosingNow = enclosing;
    let block = null;
    if (candidate) {
      const name = blockName(ts, node);
      scopeNow = scope ? `${scope}.${name}` : name;
      // `node.pos` is the end of the PREVIOUS node, so it swallows the block's
      // leading comments and blank lines; `skipTrivia` puts the start back on
      // the first real character. Otherwise a well-documented 5-line function
      // clears a 20-line floor on its doc comment.
      const start = ts.skipTrivia(text, node.pos);
      const end = node.end;
      if (end > start) {
        const from = lineOf(start);
        const to = lineOf(end - 1);
        const sameLinesAsParent = enclosing && enclosing.from === from && enclosing.to === to;
        block = { name: scopeNow, line: from + 1, lines: to - from + 1, start, end, from, to, tokStart, tokEnd: 0 };
        if (!sameLinesAsParent && block.lines >= params.minLines) blocks.push(block);
        else block = null;
        enclosingNow = { from, to };
      }
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // The class is not a block — its members are, and they are reported as
      // `Cls.member` the way a person would name them.
      const n = node.name && ts.isIdentifier(node.name) ? node.name.text : "(class)";
      scopeNow = scope ? `${scope}.${n}` : n;
    }

    ts.forEachChild(node, (child) => visit(child, scopeNow, inDecl || candidate, enclosingNow));
    if (block) block.tokEnd = tokens.length;
  };

  visit(sf, "", false, null);
  return { identifiers, exports: valueExports(ts, sf), blocks, tokens };
}

/**
 * A content key for blobs that arrive without an oid.
 *
 * `Snapshot.tests` has no oid — only a path and text — and a test file's path
 * repeats across all 157 trees while its content does not, so path alone would
 * serve a stale set for every sha after the first. FNV-1a over the text is one
 * cheap linear pass against a parse that is far dearer.
 */
export function contentKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `c${(h >>> 0).toString(36)}:${text.length}`;
}

// ── minhash ─────────────────────────────────────────────────────────────────

/**
 * The permutation coefficients, generated from a fixed seed by a fixed LCG.
 *
 * They must be identical on every machine and in every future run, because a
 * signature cached across a backfill and a signature recomputed years later to
 * re-derive the fixture have to agree. A seeded generator says that in code;
 * 128 magic numbers in a literal would say it only by luck.
 */
const COEFF_CACHE = new Map();
function coefficients(n) {
  const hit = COEFF_CACHE.get(n);
  if (hit) return hit;
  const a = new Int32Array(n);
  const b = new Int32Array(n);
  let x = 0x9e3779b9;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < n; i++) {
    a[i] = next() | 1; // odd, so multiplication mod 2^32 stays a bijection
    b[i] = next();
  }
  const c = { a, b };
  COEFF_CACHE.set(n, c);
  return c;
}

/**
 * Minhash signature over `shingle`-token shingles of `tokens[from, to)`, or
 * `null` when the range is too small to have one.
 */
function signature(tokens, from, to, shingle, hashes) {
  if (to - from < shingle) return null;
  const { a, b } = coefficients(hashes);
  const sig = new Int32Array(hashes).fill(-1); // -1 is 0xffffffff unsigned
  let any = false;
  for (let i = from; i + shingle <= to; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < shingle; j++) {
      const t = tokens[i + j];
      for (let k = 0; k < t.length; k++) {
        h ^= t.charCodeAt(k);
        h = Math.imul(h, 0x01000193);
      }
      h ^= 0x2f; // shingle separator, so ["ab","c"] != ["a","bc"]
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

// ── the per-blob caches ─────────────────────────────────────────────────────

/** key -> `{identifiers, exports}`. The identifier half, for any blob. */
const IDENT_CACHE = new Map();
/** key|params -> signed blocks. The 25x saving; see the header. */
const BLOCK_CACHE = new Map();

/**
 * Clear every memo. For a caller that wants to time a cold run.
 *
 * One clearer for both caches because both are filled by one parse: a caller
 * that emptied only one would be served a half-cold analysis and time it as a
 * cold one. This is the only clearer: `metrics/dups.mjs` used to wrap it under
 * a name of its own, which meant the metric had to import the parser in order
 * to forget it — the one import that had to go when a repo in another language
 * stopped having a parser at all.
 */
export function clearTsCaches() {
  IDENT_CACHE.clear();
  BLOCK_CACHE.clear();
}

/**
 * `{identifiers, exports}` for one blob, memoised.
 *
 * `key` is the blob oid where there is one and a content hash where there is
 * not. No parse parameters in the key: neither product depends on any.
 */
export function identsOf(ts, key, path, text) {
  const k = `${key}|${isJsxPath(path) ? 1 : 0}`;
  let hit = IDENT_CACHE.get(k);
  if (hit === undefined) {
    let a;
    try {
      a = analyzeBlob(ts, path, text, null);
    } catch {
      // An unparseable blob claims no exports rather than all of them, and
      // names nothing rather than everything.
      a = { identifiers: new Set(), exports: [] };
    }
    hit = { identifiers: a.identifiers, exports: a.exports };
    IDENT_CACHE.set(k, hit);
  }
  return hit;
}

/**
 * Signed blocks of one blob: `{name, line, lines, start, end, sig}`.
 *
 * A block leaves here already signed because the signature is a product of the
 * parse — it is read off the token stream this walk emits, and that stream is
 * the one thing the memo does NOT keep. What the caller compares is an
 * `Int32Array` of `params.hashes` minhash slots; how it bands and thresholds
 * them is its own business.
 *
 * The cache key carries the parameters as well as the oid, because
 * `DUP_MIN_LINES`, `DUP_SHINGLE`, `DUP_HASHES` and `DUP_NESTED_BLOCKS` all
 * change what a signature means — and a bumped constant served a stale
 * signature is exactly the silent history rewrite `constants.mjs` was written
 * to prevent.
 */
export function signedBlocks(ts, oid, path, text, params) {
  const jsx = isJsxPath(path) ? 1 : 0;
  const key = `${oid}|${jsx}|${params.minLines},${params.shingle},${params.hashes},${params.nested ? 1 : 0}`;
  const hit = BLOCK_CACHE.get(key);
  if (hit) return hit;
  const out = [];
  let analysis = null;
  try {
    analysis = analyzeBlob(ts, path, text, params);
  } catch {
    analysis = null; // One unparseable blob in a 157-commit history is not a stop.
  }
  if (analysis) {
    // This parse produced the identifiers and exports too, so the blob never
    // has to be parsed a second time for `measureDeadExports`. That is the
    // "all three out of one parse" the header claims, and it is worth about a
    // fifth of the backfill.
    const identKey = `${oid}|${jsx}`;
    if (!IDENT_CACHE.has(identKey)) {
      IDENT_CACHE.set(identKey, { identifiers: analysis.identifiers, exports: analysis.exports });
    }
    for (const b of analysis.blocks) {
      const sig = signature(analysis.tokens, b.tokStart, b.tokEnd, params.shingle, params.hashes);
      if (!sig) continue;
      out.push({ name: b.name, line: b.line, lines: b.lines, start: b.start, end: b.end, sig });
    }
  }
  BLOCK_CACHE.set(key, out);
  return out;
}
