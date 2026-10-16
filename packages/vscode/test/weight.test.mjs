// What a folder's agent instructions cost on every turn: CLAUDE.md plus the
// skills' DESCRIPTIONS, never their bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, data, tmp } from "./helpers.mjs";

const REPO = join(FIXTURES, "repo");

test("a description wrapped over three lines is measured whole", async () => {
  const doc = await data.weighFolder(REPO);
  const a = doc.skills.find((s) => s.name === "a");
  const whole = "First line of a wrapped description that carries on to a second line and ends on a third.";
  assert.equal(a.descChars, whole.length);
  assert.equal(a.bodyChars, readFileSync(join(REPO, ".claude/skills/a/SKILL.md"), "utf8").length);
});

test("always-on = CLAUDE.md + descriptions, not bodies", async () => {
  const doc = await data.weighFolder(REPO);
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8").length;
  assert.equal(doc.claudeMdChars, md);
  assert.deepEqual(doc.skills.map((s) => s.name), ["a", "b"]);
  const descs = doc.skills.reduce((n, s) => n + s.descChars, 0);
  assert.equal(doc.reading.alwaysOnChars, md + descs);
  assert.ok(doc.reading.alwaysOnChars < md + doc.skills.reduce((n, s) => n + s.bodyChars, 0));
  assert.equal(doc.reading.skillCount, 2);
  assert.equal(doc.reading.verdict, "lean");
  assert.equal(doc.folder, REPO);
});

test("a folder with no instructions carries nothing", async () => {
  const doc = await data.weighFolder(tmp("bare"));
  assert.equal(doc.claudeMdChars, 0);
  assert.deepEqual(doc.skills, []);
  assert.equal(doc.reading.alwaysOnChars, 0);
});
