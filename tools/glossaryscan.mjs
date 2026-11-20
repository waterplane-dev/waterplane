/**
 * The visible-string scanner behind a glossary guard, parameterised by its word list: JSX text and
 * string/template literals of TS/TSX sources (imports, class names, ids, comparisons, `<code>` and the
 * like skipped), and Markdown prose outside fences and inline backticks. Copied from
 * `tools/vaultglossary.test.mjs` for `tools/appglossary.test.mjs`; the vault guard can move onto it.
 *
 * `makeGlossary({ banned, exceptions })`: `banned` maps a word (regex source, whole word,
 * case-insensitive unless listed in `caseSensitive`) to what to say instead; `exceptions` are phrase
 * regexes (global) blanked out before the words are looked for.
 */
import ts from "typescript";

export function makeGlossary({ banned, exceptions = [], caseSensitive = [] }) {
  const wordRes = Object.entries(banned).map(([w, hint]) => ({ w, hint, re: new RegExp(`(?<![\\w-])(?:${w})(?![\\w-])`, caseSensitive.includes(w) ? "g" : "gi") }));
  function bannedIn(text) {
    let t = text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const ex of exceptions) t = t.replace(ex, (m) => " ".repeat(m.length));
    const out = [];
    for (const { re, hint, w } of wordRes) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) out.push({ word: caseSensitive.includes(w) ? m[0] : m[0].toLowerCase(), hint });
    }
    return out;
  }
  return {
    bannedIn,
    scanSource: (src, fileName) => scanSource(bannedIn, src, fileName),
    scanMarkdown: (src) => scanMarkdown(bannedIn, src),
  };
}

const SKIP_ATTR = /^(className|id|key|testid|href|src|type|style|role|name|htmlFor|to|path|d|viewBox|fill|stroke|target|rel|inputMode|autoComplete|pattern|accept|tone|variant|size|kind|icon|as|ref|data-.*|aria-(labelledby|describedby|controls|live|current|haspopup)|on[A-Z].*)$/;
const SKIP_CALLEES = /^(cx|clsx|classNames|querySelector(All)?|getElementById|addEventListener|removeEventListener|require|import|setItem|getItem|removeItem|fetch|useState|createContext|icon|testId|testid|log|error|warn|info|debug|assert|String|Symbol|RegExp)$/;
const ONE_TOKEN = /^[a-z][\w.:/-]*$/; // = a lowercase start, then letters, digits and _ . : / - (the vault copy's nested form, unrolled)

function isIdentifierish(s) {
  const t = s.trim();
  if (!t) return true;
  if (/\s/.test(t)) return /^[a-z]+(-[a-z]+)+\s.*\s(--?[a-z]|\.{0,2}\/|\$)/.test(t) ? true : /^(\/|https?:|\.\/|#)\S*$/.test(t); // a hyphenated command line (a flag, path or $var after the program) reads as code; prose such as "re-time the 3" does not
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
function scanSource(bannedIn, src, fileName = "x.tsx") {
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
function scanMarkdown(bannedIn, src) {
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

