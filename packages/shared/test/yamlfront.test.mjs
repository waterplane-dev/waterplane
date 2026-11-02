/**
 * `frontmatterYamlProblem`: the strict-YAML rules GitHub Copilot CLI applies to a SKILL.md's
 * frontmatter, where Claude Code is lenient. The first case is the measured failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { frontmatterYamlProblem } from "../dist/index.js";

const fm = (...lines) => `---\n${lines.join("\n")}\n---\nbody: with a colon is fine here\n`;

test("an unquoted description containing \": \" is the shape Copilot skipped", () => {
  const p = frontmatterYamlProblem(fm("name: web", "description: waterplane phone client (packages/web/src) — START HERE: the generated map"));
  assert.match(p, /`description`/);
  assert.match(p, /": "/);
});

test("the same words as one double-quoted line pass", () => {
  assert.equal(frontmatterYamlProblem(fm("name: web", 'description: "waterplane phone client — START HERE: the map, \\"quoted\\" too"')), null);
  assert.equal(frontmatterYamlProblem(fm("name: web", "description: 'it''s fine: single quotes'")), null);
});

test("block and flow values are accepted as written", () => {
  assert.equal(frontmatterYamlProblem(fm("name: x", "description: >", "  folded: with a colon", "  and more")), null);
  assert.equal(frontmatterYamlProblem(fm("name: x", "description: |-", "  literal: text")), null);
  assert.equal(frontmatterYamlProblem(fm("name: x", "tags: [a, b]", "meta: {k: v}")), null);
});

test("a quote that never closes on its line is a problem", () => {
  assert.match(frontmatterYamlProblem(fm('description: "starts but never ends', "name: x")), /double-quoted string that does not close/);
  assert.match(frontmatterYamlProblem(fm("description: 'never ends")), /single-quoted/);
});

test("an unquoted \" #\" cuts the value short as a comment", () => {
  assert.match(frontmatterYamlProblem(fm("description: covers issue #12 and #13")), /" #"/);
  assert.equal(frontmatterYamlProblem(fm("description: covers issue#12", "# a whole-line comment: fine")), null);
});

test("a plain value may not start with an indicator, nor continue onto a line with \": \"", () => {
  assert.match(frontmatterYamlProblem(fm("description: *bold* claim")), /starts with "\*"/);
  assert.match(frontmatterYamlProblem(fm("description: a long plain value", "  wrapped here: and broken")), /continues onto a line/);
  assert.equal(frontmatterYamlProblem(fm("description: a long plain value", "  wrapped here and fine")), null);
});

test("no frontmatter, or an ordinary one, is null", () => {
  assert.equal(frontmatterYamlProblem("# Just a heading\n\nkey: value in the body\n"), null);
  assert.equal(frontmatterYamlProblem(fm("name: visual-check", "description: How to look at a screenshot — the five-rung ladder.")), null);
});
