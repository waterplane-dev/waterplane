/**
 * Vault glossary guard (R-vault-144): one word per concept on vault screens.
 *
 * Scans only what a person READS: JSX text and string/template literals in
 * packages/extensions/vault/web/**\/*.{ts,tsx} (not tests, not the demo fixture),
 * plus the vault README prose outside code fences and inline backticks.
 * Concept words only (owner 2026-11-08): everyday words (key, token, window, kind, kept, hold) are
 * not banned yet; they come back with the journey spec if still confusing.
 * Banned words are the table BANNED below (word -> replacement hint); the
 * proposal with the reasons is the owner's glossary (R-vault-144).
 *
 * RATCHET: tools/vaultglossary.baseline.json (file -> hits). A count may only go
 * DOWN, and a file with hits needs an entry. `node tools/vaultglossary.test.mjs
 * --write` rewrites the baseline; `--hits=<path>` also dumps every hit as JSON.
 *
 * Skipped on purpose (errs toward fewer false positives): imports, object keys,
 * className, id, key, data-xyz, testid, href attributes, string-literal types,
 * comparison operands and case labels, `<code>` children, strings that are one
 * lowercase/camel/snake/kebab token, `wp-secret ...` command strings, and
 * anything inside inline backticks. Add `glossary-ignore` in a trailing
 * comment on the same line to skip a line on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const VAULT = join(ROOT, "packages/extensions/vault");
const BASELINE = join(ROOT, "tools/vaultglossary.baseline.json");

/** word (regex source, whole-word, case-insensitive) -> what to say instead. */
export const BANNED = {
  "held": "original (left in place)",
  "credentials?": "secret (an API value) or login (a site's username + password)",
  "leas(e|es|ed|ing)": "allowed for 5 min / allowed until 18:00",
  "grant(s|ed)?": "allowed for ... / allowed until you end it",
  "standing": "allowed until you end it",
  "armed": "open",
  "dormant": "paused",
  "re-?arm(s|ed|ing)?": "turn back on",
  "lift(ed)?": "put back / delete original",
  "quiet": "nothing recorded",
  "lock now": "End all (the only lock is Lock list)",
  "unlocked": "shown / open",
  "staged": "move in",
  "migrat(e|es|ing|ion)": "move in",
  "step by step": "move in",
  "try them": "move in",
  "find (&|and) move in": "Find on the desktop / Move in",
  "reported": "says",
  "claimed": "says",
  "pane": "(drop it)",
  "pid": "(drop it)",
  "worktree": "repo",
  "tmux": "(drop it)",
  "broker": "(drop it)",
  "proxied": "the vault spends it for you",
  "sealed": "(drop it)",
  "catalog": "the list of what you store",
  "treatments?": "ways to hand it out",
  "readers?": "programs that read it",
  "consumers?": "program",
  "rewir(e|ed|ing)": "update the code",
  "exposure": "reach",
  "revok(e|es|ed|ing)": "End",
  "boot.?unlock": "after a reboot, open again with the phone",
  "repo window|project window": "repo",
  "projects?": "repo",
  "accounts?": "login",
};
const WORD_RES = Object.entries(BANNED).map(([w, hint]) => ({ w, hint, re: new RegExp(`(?<![\\w-])(?:${w})(?![\\w-])`, "gi") }));

/** Phrases that stay (exact phrase, not word). */
export const EXCEPTIONS = [
  /\b(recovery|phone|API|access) keys?\b/gi,
  /\b(API|access) tokens?\b/gi,
  /\bwhole account\b/gi,
  /\bthe account\b/gi,
  /\block list\b/gi,
  /\bapp window\b/gi,
  /\bGCP project( id)?\b/gi,
  /\bproject id\b/gi,
];

/** Banned hits in one visible string: [{word, hint}] */
export function bannedIn(text) {
  let t = text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  for (const ex of EXCEPTIONS) t = t.replace(ex, (m) => " ".repeat(m.length));
  const out = [];
  for (const { re, hint } of WORD_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) out.push({ word: m[0].toLowerCase(), hint });
  }
  return out;
}

const SKIP_ATTR = /^(className|id|key|testid|href|src|type|style|role|name|htmlFor|to|path|d|viewBox|fill|stroke|target|rel|inputMode|autoComplete|pattern|accept|tone|variant|size|kind|icon|as|ref|data-.*|aria-(labelledby|describedby|controls|live|current|haspopup)|on[A-Z].*)$/;
const SKIP_CALLEES = /^(cx|clsx|classNames|querySelector(All)?|getElementById|addEventListener|removeEventListener|require|import|setItem|getItem|removeItem|fetch|useState|createContext|icon|testId|testid|log|error|warn|info|debug|assert|String|Symbol|RegExp)$/;
const ONE_TOKEN = /^[a-z][a-z0-9]*([A-Z_.:/-][A-Za-z0-9]*)*$/;

function isIdentifierish(s) {
  const t = s.trim();
  if (!t) return true;
  if (/\s/.test(t)) return /^(wp-secret|\/|https?:|\.\/|\.\.\/|#|\$)/.test(t) && /^(wp-secret)/.test(t) ? true : /^(\/|https?:|\.\/|#)\S*$/.test(t);
  if (ONE_TOKEN.test(t)) return true;
  if (/^[\W\d_]+$/.test(t)) return true;
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 1 && !/^[A-Z][a-z]/.test(t)) return true; // CONSTANT_CASE
  return false;
}

/** A lone word a person reads: the noun of plural(n, "project"), or a value of a const named ...WORDS/SHORT/LABELS/NOUNS/TITLES (STEP_SHORT). */
const READ_NAMES = /(WORDS?|SHORT|LABELS?|NOUNS?|TITLES?)$/i;
function loneWordRead(node) {
  for (let p = node.parent, child = node; p; child = p, p = p.parent) {
    if (ts.isCallExpression(p) && /^plural$/.test(calleeName(p)) && p.arguments.includes(child)) return true;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && READ_NAMES.test(p.name.text)) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function skippedByContext(node) {
  for (let p = node.parent, child = node; p; child = p, p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return true;
    if (ts.isPropertyAssignment(p) && p.name === child) return true;
    if (ts.isComputedPropertyName(p) || ts.isElementAccessExpression(p) && p.argumentExpression === child) return true;
    if (ts.isCaseClause(p) && p.expression === child) return true;
    if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true;
    if (ts.isCallExpression(p) && SKIP_CALLEES.test(calleeName(p)) && p.arguments.includes(child)) return true;
    if (ts.isTaggedTemplateExpression(p) && p.template === child) return true;
    if (ts.isJsxAttribute(p)) {
      const n = p.name.getText();
      return SKIP_ATTR.test(n);
    }
    if (ts.isJsxElement(p)) {
      const tag = p.openingElement.tagName.getText();
      if (/^(code|pre|kbd)$/.test(tag)) return true;
      if (child !== p.openingElement && child !== p.closingElement && tag === "Hint" && /mono/.test(p.openingElement.attributes.getText())) return true;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /^(className|cssText|classes|cls|css|style|styles|id|key|route|path|url|re|regex|pattern|\w+(Re|Regex|Class|Css|Id|Path|Url|Route|Pattern))$/.test(p.name.text) && p.initializer === child) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** Visible-string hits of one TS/TSX source: [{line, word, hint, text}] */
export function scanSource(src, fileName = "x.tsx") {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const hits = [];
  const add = (node, text, isJsxText) => {
    if (!isJsxText && isIdentifierish(text) && !(/^[a-z]+$/.test(text.trim()) && bannedIn(text).length > 0 && loneWordRead(node))) return;
    if (skippedByContext(node)) return;
    const start = node.getStart(sf);
    let off = start;
    if (isJsxText) off = start + (text.length - text.trimStart().length);
    const line = sf.getLineAndCharacterOfPosition(off).line + 1;
    if (/glossary-ignore/.test(lines[line - 1] || "")) return;
    for (const h of bannedIn(text)) hits.push({ line, word: h.word, hint: h.hint, text: text.replace(/\s+/g, " ").trim().slice(0, 140) });
  };
  const visit = (n) => {
    if (ts.isJsxText(n)) { if (n.text.trim()) add(n, n.text, true); }
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text, false);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) { if (n.text.trim()) add(n.parent, n.text, false); }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** README prose hits: outside fences and inline backticks. */
export function scanMarkdown(src) {
  const hits = [];
  let fence = false;
  src.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence || /glossary-ignore/.test(l)) return;
    const text = l.replace(/\]\([^)]*\)/g, "]");
    for (const h of bannedIn(text)) hits.push({ line: i + 1, word: h.word, hint: h.hint, text: l.trim().slice(0, 140) });
  });
  return hits;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e) && !/\.test\./.test(e) && !/demofixture/i.test(e)) out.push(p);
  }
  return out;
}

/** file (repo-relative) -> hits, only files with hits */
export function scanAll() {
  const res = {};
  for (const f of walk(join(VAULT, "web")).sort()) {
    const h = scanSource(readFileSync(f, "utf8"), f);
    if (h.length) res[relative(ROOT, f)] = h;
  }
  const readme = join(VAULT, "README.md");
  if (existsSync(readme)) {
    const h = scanMarkdown(readFileSync(readme, "utf8"));
    if (h.length) res[relative(ROOT, readme)] = h;
  }
  return res;
}

const counts = (all) => Object.fromEntries(Object.entries(all).map(([f, h]) => [f, h.length]).sort(([a], [b]) => a.localeCompare(b)));

const hitsArg = process.argv.find((a) => a.startsWith("--hits="));
if (process.argv.includes("--write") || hitsArg) {
  const all = scanAll();
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, JSON.stringify(counts(all), null, 2) + "\n");
    console.log(`baseline written: ${Object.values(all).reduce((n, h) => n + h.length, 0)} hits in ${Object.keys(all).length} files`);
  }
  if (hitsArg) writeFileSync(hitsArg.slice(7), JSON.stringify(all, null, 1));
} else {
  // The public snapshot leaves the vault out (deploy/public-allowlist.txt): nothing to scan there.
  test("vault glossary ratchet: banned words on vault screens only go down", { skip: !existsSync(VAULT) && "the vault is not in this tree (public snapshot)" }, () => {
    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
    const now = scanAll();
    const bad = [];
    const lower = [];
    for (const [f, hits] of Object.entries(now)) {
      const b = base[f];
      if (b === undefined) bad.push(`${f}: ${hits.length} banned word(s) and no baseline entry. First: line ${hits[0].line} "${hits[0].word}" -> ${hits[0].hint}`);
      else if (hits.length > b) bad.push(`${f}: ${hits.length} banned words, baseline ${b}. New ones are the last ${hits.length - b} of:\n` + hits.slice(-(hits.length - b)).map((h) => `    ${f}:${h.line} "${h.word}" -> ${h.hint}  | ${h.text}`).join("\n"));
      else if (hits.length < b) lower.push(`lower the baseline: ${f} ${b} -> ${hits.length}`);
    }
    for (const [f, b] of Object.entries(base)) if (!now[f] && b > 0) lower.push(`lower the baseline: ${f} ${b} -> 0`);
    if (lower.length) console.log(lower.join("\n") + "\n(run: node tools/vaultglossary.test.mjs --write)");
    assert.equal(bad.length, 0, "\n" + bad.join("\n"));
  });

  test("vault glossary exceptions and skips", () => {
    assert.deepEqual(bannedIn("Your recovery key and phone key"), []);
    assert.equal(bannedIn("Grant a lease").length, 2);
    assert.deepEqual(scanSource('const a = <div className="key row">Ok</div>;').length, 0);
    assert.equal(scanSource('const a = <p>Revoke the key</p>;').length, 1);
    assert.equal(scanSource('const k = x.kind === "standing grant";').length, 0);
    assert.equal(scanSource('const m = "grant for ten minutes";').length, 1);
    // a variable whose name merely ENDS in re/id/key/path/url (where, more, hybrid) still shows its text; only a real class/css/id/regex name is skipped
    assert.equal(scanSource('const where = "in a terminal pane"; const more = " 2 more projects";').length, 2);
    assert.equal(scanSource('const className = "grant"; const nameRe = "grant";').length, 0);
    // a lone concept word is read when it is plural()'s noun or a value of a *_SHORT / *WORDS table; any other lone word is an identifier
    assert.equal(scanSource('const a = plural(n, "project");').length, 1);
    assert.equal(scanSource('const STEP_SHORT = { a: "readers" };').length, 1);
    assert.equal(scanSource('const kind = { a: "project" };').length, 0);
    // inflections the plain forms missed
    assert.equal(bannedIn("leased for 5 min").length, 1);
    assert.equal(bannedIn("one card re-arms it").length, 1);
    assert.equal(bannedIn("revoking it").length, 1);
  });
}
