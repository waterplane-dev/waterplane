/**
 * `local/total-wire-words`, pinned both ways, through ESLint itself.
 *
 * A wording over a value that crossed the wire must say what a value this
 * build has never heard of reads as. e7adb005 (a budget `why`) and 57c5dff7
 * (an intent `blockReason`) each printed "undefined" on an older phone; each
 * fixed one function and added no ratchet. This is the ratchet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter, RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local from "./eslint/rules.js";
import { totalWireWords } from "./eslint/totalwords.js";

const languageOptions = { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } };

test("RuleTester: switches and tables, valid and invalid", () => {
  const tester = new RuleTester({ languageOptions });
  tester.run("total-wire-words", totalWireWords, {
    valid: [
      // a default sentence
      `function f(r: R): string { switch (r) { case "a": return "x"; default: return "y"; } }`,
      // a switch that is not a wording (no string return, no annotation)
      `function f(r: R) { switch (r) { case "a": go(); break; case "b": stop(); break; } }`,
      // a switch over numbers
      `function f(n: number): string { switch (n) { case 1: return "one"; case 2: return "two"; } return "many"; }`,
      // closed, on the line above
      `function f(m: Mode): string {\n  // closed: a phone-only mode, never on the wire\n  switch (m) { case "a": return "x"; }\n}`,
      // closed, inside a longer comment block above
      `function f(m: Mode): string {\n  // The two modes the toggle draws.\n  // closed: set by this build's own toggle\n  switch (m) { case "a": return "x"; }\n}`,
      // tables: wordOf, ?? fallback, || fallback, `k in T`, a literal key, a write
      `const T: Record<K, string> = { a: "x" }; const w = wordOf(T, row.kind, "?");`,
      `const T: Record<K, string> = { a: "x" }; const w = T[row.kind] ?? "?";`,
      `const T: Record<K, string> = { a: "x" }; const w = T[row.kind] || "?";`,
      `const T: Record<K, string> = { a: "x" }; const w = row.kind in T ? T[row.kind] : "?";`,
      `const T: Record<K, string> = { a: "x" }; function f(k) { if (k in T) return T[k]; return "?"; }`,
      `const T: Record<K, string> = { a: "x" }; const w = T["a"];`,
      `const T: Record<K, string> = { a: "x" }; T[k] = "y";`,
      // a table closed at its declaration exempts every read
      `// closed: keyed by this build's own literal list\nconst T: Record<K, string> = { a: "x" }; const w = T[k];`,
      `// closed: keyed by this build's own literal list\nexport const T: Record<K, string> = { a: "x" }; const w = T[k];`,
      // a `closed:` line inside the table's doc comment
      `/**\n * Words for the chips.\n * closed: keyed by this build's own literal list\n */\nconst T: Record<K, string> = { a: "x" }; const w = T[k];`,
      // one read closed on its own
      `const T: Record<K, string> = { a: "x" };\n// closed: k is filtered by \`k in T\` above\nconst w = T[k];`,
      // Record<string, string> already says any key may be missing
      `const T: Record<string, string> = { a: "x" }; const w = T[k];`,
      // a table this file does not declare is not this rule's to judge
      `const w = OTHER[k];`,
    ],
    invalid: [
      { code: `function f(r: R): string { switch (r) { case "a": return "x"; case "b": return "y"; } }`, errors: [{ messageId: "switch" }] },
      // unannotated, but a case returns a string
      { code: `function f(r) { switch (r) { case "a": return "x"; } return undefined; }`, errors: [{ messageId: "switch" }] },
      { code: "const f = (r) => { switch (r) { case \"a\": return `x ${r}`; } };", errors: [{ messageId: "switch" }] },
      // `: string | null` is still a wording
      { code: `function f(r: R): string | null { switch (r) { case "a": return null; } }`, errors: [{ messageId: "switch" }] },
      // a plain comment above is not a closed note
      { code: `function f(m: Mode): string {\n  // the two modes\n  switch (m) { case "a": return "x"; }\n}`, errors: [{ messageId: "switch" }] },
      // a bare `closed:` with no reason is not one either
      { code: `function f(m: Mode): string {\n  // closed:\n  switch (m) { case "a": return "x"; }\n}`, errors: [{ messageId: "switch" }] },
      // a doc comment that merely mentions the word mid-line is not a note
      { code: `/** Not closed: this one is open. */\nconst T: Record<K, string> = { a: "x" }; const w = T[k];`, errors: [{ messageId: "table" }] },
      // a trailing closed note on the PREVIOUS statement covers that statement only
      { code: `const T: Record<K, string> = { a: "x" };\nconst a = T[j]; // closed: j is a literal key\nconst b = T[k];`, errors: [{ messageId: "table" }] },
      { code: `function f(m: Mode): string {\n  const x = 1; // closed: about x\n  switch (m) { case "a": return "x"; }\n}`, errors: [{ messageId: "switch" }] },
      // table read with no fallback, before and after its declaration
      { code: `const T: Record<K, string> = { a: "x" }; const w = T[row.kind];`, errors: [{ messageId: "table" }] },
      { code: `function f(k) { return T[k]; } const T: Record<K, string> = { a: "x" };`, errors: [{ messageId: "table" }] },
      { code: `export const T: Record<K, string> = { a: "x" }; const w = \`is \${T[k]}\`;`, errors: [{ messageId: "table" }] },
      // `k in T` guards only the branch it tests
      { code: `const T: Record<K, string> = { a: "x" }; const w = k in T ? "?" : T[k];`, errors: [{ messageId: "table" }] },
      // a guard on ANOTHER key guards nothing
      { code: `const T: Record<K, string> = { a: "x" }; const w = j in T ? T[k] : "?";`, errors: [{ messageId: "table" }] },
    ],
  });
});

test("registered as local/total-wire-words", () => {
  assert.equal(local.rules["total-wire-words"], totalWireWords);
});

test("eslint.config.js turns it on for shared and web, and leaves the host alone", async () => {
  const { default: config } = await import("../eslint.config.js");
  const linter = new Linter({ configType: "flat" });
  const code = `export function f(r: R): string { switch (r) { case "a": return "x"; } }\n`;
  const hits = (filename) => linter.verify(code, config, { filename }).filter((m) => m.ruleId === "local/total-wire-words").length;
  assert.equal(hits("packages/shared/src/x.ts"), 1);
  assert.equal(hits("packages/web/src/x.ts"), 1);
  assert.equal(hits("packages/web/src/features/x/X.tsx"), 1);
  assert.equal(hits("packages/host/src/x.ts"), 0, "the host is the NEWER end of its own values");
});
