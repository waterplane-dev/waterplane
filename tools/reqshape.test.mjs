import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownCommits, parseArea, readAll, shapeProblems } from "./reqshape.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Problems already in the list when this check landed (2026-11-14). A ratchet: the list only
// shrinks — fixing one in docs/requirements/ fails the last test until its line goes here too.
const KNOWN = [
  'R-intent-local-001: ID is not R-automation-<nnn> (file automation.md)',
  'R-updates-010a: ID is not R-updates-<nnn> (file updates.md)',
];

const area = (lines) => parseArea("a.md", lines.join("\n"));

test("a clean area has no problems", () => {
  const items = area(["### R-a-001 · shipped", "x", "- shipped: abc1234, WP5 (note)", "",
    "### R-a-002 · superseded", "y", "- superseded-by: R-a-001"]);
  assert.deepEqual(shapeProblems(items, new Set(["abc1234"])), []);
});

test("each broken shape is named", () => {
  const items = [...area([
    "### R-a-001 · shipped", "- shipped: deadbee",
    "### R-b-002 · shipped",
    "### R-a-003 · built",
    "### R-a-004 · superseded",
    "### R-a-005 · shipped", "- superseded-by: R-a-001",
    "### R-a-006 · superseded", "- superseded-by: R-a-999",
    "### no status here",
  ]), ...parseArea("a.md", "### R-a-001 · requested\n")];
  const p = shapeProblems(items, new Set());
  for (const want of [/R-a-001: shipped deadbee is not a commit/, /R-b-002: ID is not R-a-/, /R-a-003: status "built"/,
    /R-a-004: superseded but no superseded-by/, /R-a-005: superseded-by on a shipped item/,
    /R-a-006: superseded-by R-a-999, which does not exist/, /a\.md: heading does not parse/, /R-a-001: used twice/])
    assert.ok(p.some((l) => want.test(l)), `${want} in\n${p.join("\n")}`);
});

test("without git the commits are not checked, never reported missing", () => {
  assert.deepEqual(shapeProblems(area(["### R-a-001 · shipped", "- shipped: deadbee"]), null), []);
});

test("a history holding none of the cited commits (a public snapshot) checks nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "reqshape-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "snapshot");
    assert.equal(knownCommits(dir, ["abc1234", "def5678"]), null);
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim();
    assert.deepEqual([...knownCommits(dir, [head, "abc1234"])], [head]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("free text on a shipped line is not read as a commit", () => {
  assert.deepEqual(area(["### R-a-001 · shipped", "- shipped: demo-mode WP5a (this commit — needs a new APK)"])[0].shas, []);
});

test("the repo's requirements list has no new shape problems", () => {
  const items = readAll(ROOT);
  const known = knownCommits(ROOT, items.flatMap((i) => i.shas)); // null in the pre-commit's git-less copy
  const found = shapeProblems(items, known);
  const fresh = found.filter((l) => !KNOWN.includes(l));
  assert.deepEqual(fresh, [], `new problems in docs/requirements/:\n${fresh.join("\n")}`);
  const gone = KNOWN.filter((l) => !found.includes(l));
  assert.deepEqual(gone, [], `fixed — remove from KNOWN in tools/reqshape.test.mjs:\n${gone.join("\n")}`);
});
