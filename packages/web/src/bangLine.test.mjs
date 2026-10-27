/**
 * `bangLine.ts` — which code in a reply is a command the reader offers to put
 * in the session's shell. Run: node --test packages/web/src/bangLine.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bangLine, shellBlock } from "./bangLine.ts";

test("a bang line hands over the command without the bang", () => {
  assert.equal(bangLine("! gh pr close 11 -R waterplane-dev/waterplane"), "gh pr close 11 -R waterplane-dev/waterplane");
  assert.equal(bangLine("  !gh auth login  "), "gh auth login");
});

test("things that start with ! but are not commands", () => {
  for (const s of ["!=", "!==", "!important", "!!", "!", "! ", "!0", "a ! b", "! one\n! two"]) {
    assert.equal(bangLine(s), null, s);
  }
});

test("a shell fence loses its prompt prefixes and blank lines", () => {
  assert.equal(shellBlock("bash", "$ npm ci\n\n% npm test\n! gh pr list"), "npm ci\nnpm test\ngh pr list");
  assert.equal(shellBlock("sh", "\n\n"), null);
});

test("an untagged fence counts only when every line is a bang line", () => {
  assert.equal(shellBlock("", "! git fetch\n! git status"), "git fetch\ngit status");
  assert.equal(shellBlock("", "! git fetch\nconst x = 1"), null);
  assert.equal(shellBlock("ts", "const x = 1"), null);
});
