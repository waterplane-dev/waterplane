/**
 * Lines as the repo's file-size cap counts them: eslint's `max-lines` with `skipComments: true,
 * skipBlankLines: false`. A line holding only comment is free, a blank line outside a comment
 * counts, and a line with code and a trailing comment counts. The ONE copy of that rule, for
 * everything that mirrors the cap (shape tests, the early warning, the health readings).
 *
 * Parsed by TypeScript, the parser eslint runs here, because a scan by hand cannot tell `//` in a
 * string, a template, a regex or JSX text from a comment. Why comments are free:
 * docs/notes/refactoring.md, "The cap counts code, not notes".
 */
import ts from "typescript";

/** Every line in the file, as eslint's `max-lines` sees it: split on newlines, a final one adds none. */
export function lineCount(text) {
  if (!text) return 0;
  const n = text.split(/\r\n|\r|\n/).length;
  return /(\r\n|\r|\n)$/.test(text) ? n - 1 : n;
}

const COMMENT = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia, // eslint hands a shebang to the parser as a `//` comment
]);

const isJsDoc = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/** `text` as the cap counts it. `path` picks the grammar by its extension (`.tsx` allows JSX). */
export function codeLineCount(text, path = "file.tsx") {
  if (!text) return 0;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const tokenLines = new Set();
  const commentLines = new Set();
  const mark = (set, from, to) => { for (let l = lineOf(from); l <= lineOf(to); l++) set.add(l); };
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant, text);
  const comments = (from, to) => {
    scanner.resetTokenState(from);
    while (scanner.getTokenEnd() < to) {
      const kind = scanner.scan();
      if (kind === ts.SyntaxKind.EndOfFileToken) return;
      if (COMMENT.has(kind)) mark(commentLines, scanner.getTokenStart(), scanner.getTokenEnd() - 1);
    }
  };
  const walk = (node) => {
    // Filtered, not skipped on arrival: a `/** */` closing a file is the end token's only child, and
    // that token still has to be read as the leaf whose trivia holds the comment.
    const kids = node.getChildren(sf).filter((k) => !isJsDoc(k));
    if (kids.length) { kids.forEach(walk); return; }
    const start = node.getStart(sf);
    if (start > node.pos) comments(node.pos, start);
    if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.end > start) mark(tokenLines, start, node.end - 1);
  };
  walk(sf);
  let free = 0;
  for (const l of commentLines) if (!tokenLines.has(l)) free++;
  return lineCount(text) - free;
}
