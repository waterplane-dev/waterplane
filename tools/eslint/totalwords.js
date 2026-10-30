/**
 * `local/total-wire-words`: a value that crosses the wire is an OPEN set.
 *
 * Every enum the host sends — a `blockReason`, a budget `why`, a health
 * `because` — grows on the host first, and the phone's bundle is often a
 * release behind (and the reverse when the phone has not reloaded). A wording
 * written as an exhaustive `switch` with no `default` is total only for the
 * build that compiled it: the next reason falls out of the bottom and the row
 * reads "undefined". e7adb005 fixed one such function and 57c5dff7 another;
 * this rule is the ratchet neither of them added.
 *
 * Two shapes are checked:
 *
 * - A `switch` whose cases are all string literals, inside a function that
 *   returns a string (annotated `: string`, or a case that returns a string
 *   literal or template), must have a `default:`. A switch over a value that
 *   never leaves this build (a phone-only mode, a local union) says so with a
 *   `// closed: <why>` comment on or right above the `switch` line.
 * - A module-level `const T: Record<K, string>` read as `T[k]` must say what an
 *   unknown `k` reads as: through `wordOf(T, k, fallback)`, with `?? fallback`
 *   / `|| fallback`, or under a `k in T` test. A `// closed: <why>` on the
 *   table's declaration exempts every read of it; one on (or right above) a
 *   read's line exempts that read — a key already filtered by `k in T`, or one
 *   drawn from a literal list in the same expression.
 */

/** `// closed: why`, or a `closed: why` line of a doc comment. */
const CLOSED = /(?:^|\n)[ \t*]*closed:[ \t]*\S/;

const isStringCase = (c) =>
  c.test && ((c.test.type === "Literal" && typeof c.test.value === "string") ||
    (c.test.type === "TemplateLiteral" && c.test.expressions.length === 0));

const isStringy = (n) =>
  n && ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");

const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function enclosingFn(node) {
  for (let p = node.parent; p; p = p.parent) if (FN.has(p.type)) return p;
  return null;
}

/** Does this function's annotation say it returns a string (or `string | …`)? */
function annotatedString(fn) {
  const t = fn?.returnType?.typeAnnotation;
  if (!t) return false;
  if (t.type === "TSStringKeyword") return true;
  return t.type === "TSUnionType" && t.types.some((u) => u.type === "TSStringKeyword");
}

/** A `return "…"` directly in a case body (not inside a nested function). */
function caseReturnsString(sw) {
  for (const c of sw.cases) {
    for (const st of c.consequent) {
      if (st.type === "ReturnStatement" && isStringy(st.argument)) return true;
      if (st.type === "BlockStatement" && st.body.some((s) => s.type === "ReturnStatement" && isStringy(s.argument))) return true;
    }
  }
  return false;
}

const STATEMENT_HOLDERS = new Set(["Program", "BlockStatement", "StaticBlock", "SwitchCase", "ClassBody"]);

/**
 * A `// closed: <why>` that belongs to this node: one on the node's own first
 * line, or one in the comment block right above the STATEMENT holding it that
 * starts its own line. A trailing note on the previous statement is that
 * statement's, never the next one's.
 */
function hasClosedNote(src, node) {
  const line = node.loc.start.line;
  if (src.getAllComments().some((c) => CLOSED.test(c.value) && c.loc.start.line === line)) return true;
  let stmt = node;
  while (stmt.parent && !STATEMENT_HOLDERS.has(stmt.parent.type)) stmt = stmt.parent;
  const ownLine = (c) => src.lines[c.loc.start.line - 1].slice(0, c.loc.start.column).trim() === "";
  return src.getCommentsBefore(stmt).some((c) => ownLine(c) && CLOSED.test(c.value));
}

/** `Record<K, string>` with K a closed set (a union or a named type) — a
 *  `Record<string, string>` already says every key may be missing. */
function isStringRecord(ann) {
  const t = ann?.typeAnnotation;
  if (t?.type !== "TSTypeReference" || t.typeName?.type !== "Identifier" || t.typeName.name !== "Record") return false;
  const args = (t.typeArguments ?? t.typeParameters)?.params ?? [];
  if (args.length !== 2 || args[1].type !== "TSStringKeyword") return false;
  return args[0].type !== "TSStringKeyword" && args[0].type !== "TSNumberKeyword";
}

const sameExpr = (src, a, b) => src.getText(a) === src.getText(b);

/** Is this read guarded: `?? x` / `|| x`, or under a `k in T` test? */
function guarded(src, member) {
  const p = member.parent;
  if (p?.type === "LogicalExpression" && p.left === member && (p.operator === "??" || p.operator === "||")) return true;
  const isInTest = (t) => {
    if (!t) return false;
    if (t.type === "BinaryExpression" && t.operator === "in") {
      return sameExpr(src, t.left, member.property) && sameExpr(src, t.right, member.object);
    }
    if (t.type === "LogicalExpression" && t.operator === "&&") return isInTest(t.left) || isInTest(t.right);
    return false;
  };
  for (let n = member, up = member.parent; up; n = up, up = up.parent) {
    if (FN.has(up.type)) return false;
    if ((up.type === "ConditionalExpression" || up.type === "IfStatement") && up.consequent === n && isInTest(up.test)) return true;
    if (up.type === "LogicalExpression" && up.operator === "&&" && up.right === n && isInTest(up.left)) return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const totalWireWords = {
  meta: {
    type: "problem",
    docs: { description: "a wording over a wire value says what an unknown value reads as" },
    schema: [],
    messages: {
      switch:
        "A string switch that words a value with no `default:` prints `undefined` for a value " +
        "a newer host adds. Add a `default:` sentence, or mark a switch over a value that never " +
        "crosses the wire with `// closed: <why>`.",
      table:
        "`{{name}}[…]` has no answer for a key this build does not know. Read it through " +
        "`wordOf({{name}}, k, fallback)`, add `?? fallback`, test `k in {{name}}` first, or mark the " +
        "table `// closed: <why>` if its keys never cross the wire.",
    },
  },
  create(ctx) {
    const src = ctx.sourceCode ?? ctx.getSourceCode();
    /** name → closed? for module-level `Record<K, string>` tables. */
    const tables = new Map();
    /** Computed reads, judged once every table in the file is known. */
    const reads = [];
    return {
      "Program > VariableDeclaration > VariableDeclarator, Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(d) {
        if (d.id.type !== "Identifier" || !isStringRecord(d.id.typeAnnotation)) return;
        const decl = d.parent.parent.type === "ExportNamedDeclaration" ? d.parent.parent : d.parent;
        tables.set(d.id.name, hasClosedNote(src, decl));
      },
      SwitchStatement(sw) {
        if (sw.cases.length === 0 || sw.cases.some((c) => c.test === null)) return;
        if (!sw.cases.every(isStringCase)) return;
        if (!annotatedString(enclosingFn(sw)) && !caseReturnsString(sw)) return;
        if (hasClosedNote(src, sw)) return;
        ctx.report({ node: sw, messageId: "switch" });
      },
      "MemberExpression[computed=true]"(m) {
        if (m.object.type === "Identifier") reads.push(m);
      },
      "Program:exit"() {
        for (const m of reads) {
          const closed = tables.get(m.object.name);
          if (closed === undefined || closed) continue;
          if (m.property.type === "Literal" || (m.property.type === "TemplateLiteral" && m.property.expressions.length === 0)) continue;
          // A write (`T[k] = …`) is not a wording.
          if (m.parent.type === "AssignmentExpression" && m.parent.left === m) continue;
          if (guarded(src, m) || hasClosedNote(src, m)) continue;
          ctx.report({ node: m, messageId: "table", data: { name: m.object.name } });
        }
      },
    };
  },
};
