/**
 * A background setup check never overwrites a verdict recorded while it ran.
 *
 * `checkInBackground` (the sweep's, and since c050de92 a session create's) awaits git and three
 * tree walks — seconds each on WSL over a Windows drive. A fix tapped meanwhile records a fresh
 * verdict through `record()`; the inspection that STARTED before it must not land on top of it,
 * or the badge shows the issue the person just fixed until the next re-check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SetupWatcher } = await import("../dist/setupwatch.js");

test("a verdict recorded while a background check runs is the one that stands", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-setuprace-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = new SetupWatcher(root);
  // A bare dir: the inspection finds issues (no CLAUDE.md, not a repo).
  const running = w.checkInBackground(root, "r");
  w.record(root, [], "r"); // the fix's refreshed report: nothing wrong
  await running;
  assert.equal(w.stateFor(root)?.ok, true, "the older inspection was dropped");
  // With nothing recorded meanwhile, a background check lands as before.
  await w.checkInBackground(root, "r");
  assert.equal(w.stateFor(root)?.ok, false, "an uncontested inspection is recorded");
});
