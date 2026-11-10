/**
 * Dart `blocks` (clone candidates) and `idents` (names and exports), off the
 * token stream of `dart-lex.mjs`. The contract is `lang/typescript-ast.mjs`'s:
 * `blocks(file, params)` -> `{name, line, lines, start, end, sig}[]`,
 * `idents(file)` -> `{identifiers: Set<string>, exports: string[]}`.
 *
 * ── Blocks ──────────────────────────────────────────────────────────────────
 * A block is a top-level function, a method or constructor with a body, or a
 * variable/field with an initializer, of at least `params.minLines` lines. A
 * class is not a block; its members are, named `Class.member`. The signed
 * stream is the file's tokens with identifiers and keywords by text, strings
 * as one `S` and numbers as one `N`, so a copy with other literals is still the
 * same clone. `params.nested` is ignored: closures inside a method are not
 * blocks here (a Flutter `build` is one method and is what gets copied).
 *
 * ── Exports ─────────────────────────────────────────────────────────────────
 * A top-level declaration whose name does not start with `_`: class, mixin,
 * enum, function, getter/setter, variable. Left out on purpose, because naming
 * them is not how they are used or because nobody can tell. Dart has no
 * `export` keyword, so a name the declaring file itself uses outside the
 * declaration (a root widget `main()` runs, a helper two functions call) is
 * over-public, not dead, and is not listed either. Also left out:
 *   - `main` (the entry point is called by the runtime);
 *   - an `extension` (applied by type, never named at the call site);
 *   - a `typedef` (a type, like the TS pack's types);
 *   - anything annotated `@pragma(...)` (called from native code);
 *   - every declaration of a library that lists a generated part
 *     (`part 'x.g.dart'`): the generated file is not read, and it may be what
 *     names the declaration.
 * `identifiers` is every identifier token plus every name inside a string
 * interpolation; a word that is only in a string is not a use.
 */
import { parseDart } from "./dart-lex.mjs";
import { GENERATED_SUFFIXES } from "./dart-resolve.mjs";
import { contentKey } from "./typescript-ast.mjs";

const PARSE_CACHE = new Map();
const BLOCK_CACHE = new Map();

/** Drop the memos (a cold-run timing). */
export function clearDartCaches() {
  PARSE_CACHE.clear();
  BLOCK_CACHE.clear();
}

/** The parse of a file, memoised by blob oid (or a content key), shared with the resolver. */
export function parseOf(file) {
  const key = file.oid ?? contentKey(file.text);
  let p = PARSE_CACHE.get(key);
  if (!p) {
    p = parseDart(file.text);
    PARSE_CACHE.set(key, p);
  }
  return p;
}

export function identsOf(file) {
  const p = parseOf(file);
  const identifiers = new Set(p.interp);
  for (const t of p.toks) if (t.k === "id") identifiers.add(t.s);
  const generatedPart = p.directives.some(
    (d) => d.kind === "part" && d.uris.some((u) => GENERATED_SUFFIXES.some((s) => u.endsWith(s))),
  );
  const exports = [];
  if (p.ok && !generatedPart) {
    // Dart has no `export` keyword: every top-level name is public, and a name
    // the file itself uses (a root widget `main()` runs, a helper two
    // functions call) is over-public, not dead. So a name is a candidate only
    // when nothing OUTSIDE its own declaration mentions it either.
    const total = new Map();
    for (const t of p.toks) if (t.k === "id") total.set(t.s, (total.get(t.s) ?? 0) + 1);
    const usedOutside = (d, name) => {
      if (p.interp.has(name)) return true;
      let inside = 0;
      for (let i = d.hs; i <= d.end; i++) if (p.toks[i].k === "id" && p.toks[i].s === name) inside++;
      return (total.get(name) ?? 0) > inside;
    };
    for (const d of p.decls) {
      if (!d.top || d.scope !== "") continue;
      if (d.kind === "extension" || d.kind === "typedef") continue;
      if (d.notes.some((n) => n === "pragma")) continue;
      for (const name of [d.name, ...(d.extra ?? [])]) {
        if (!name || name.startsWith("_") || name === "main" || name.startsWith("$")) continue;
        if (usedOutside(d, name)) continue;
        if (!exports.includes(name)) exports.push(name);
      }
    }
  }
  return { identifiers, exports };
}

// ── minhash (the same seeded permutations as lang/typescript-ast.mjs) ───────

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

export function blocksOf(file, params) {
  const key = `${file.oid ?? contentKey(file.text)}|${params.minLines},${params.shingle},${params.hashes}`;
  const hit = BLOCK_CACHE.get(key);
  if (hit) return hit;
  const out = [];
  const p = parseOf(file);
  if (p.ok) {
    const text = file.text;
    const stream = p.toks.map((t) => (t.k === "str" ? "S" : t.s));
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const lineOf = (pos) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    for (const d of p.decls) {
      if (d.kind === "class" || d.kind === "mixin" || d.kind === "enum" || d.kind === "extension" || d.kind === "typedef") continue;
      if (!d.hasBody) continue;
      const first = p.toks[d.hs];
      const last = p.toks[d.end];
      if (!first || !last) continue;
      const from = lineOf(first.p);
      const to = lineOf(last.e - 1);
      if (to - from + 1 < params.minLines) continue;
      const sig = signature(stream, d.hs, d.end + 1, params.shingle, params.hashes);
      if (!sig) continue;
      out.push({
        name: d.scope ? `${d.scope}.${d.name}` : d.name,
        line: from + 1,
        lines: to - from + 1,
        start: first.p,
        end: last.e,
        sig,
      });
    }
  }
  BLOCK_CACHE.set(key, out);
  return out;
}
