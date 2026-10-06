// What survives of `shared/src/launch.ts` now that the durable Intent store
// owns the waiting: the repo-relative path guard and the sentence a launch row
// says about itself. The gate itself (`launchVerdict`) and the row sanitiser
// (`cleanIntent`) are gone — `intent.ts`'s `intentVerdict` and `cleanIntentRow`
// are the live implementations, and `intent.test.mjs` pins both, including the
// presence-before-deadline rule this file used to own.
import test from "node:test";
import assert from "node:assert/strict";
import { describeLaunch, safeRel } from "../dist/index.js";

const NOW = 1_700_000_000_000;

test("safeRel refuses anything that could leave the repo", () => {
  assert.equal(safeRel(".claude/inbox/a.png"), true);
  assert.equal(safeRel("/etc/passwd"), false);
  assert.equal(safeRel("../../etc/passwd"), false);
  assert.equal(safeRel("a/../b"), false);
  assert.equal(safeRel("./a.png"), false);
  assert.equal(safeRel("a\\b.png"), false);
  assert.equal(safeRel("a\0b"), false);
  assert.equal(safeRel("   "), false);
});

test("describeLaunch says what it is waiting for, in file names", () => {
  const base = { id: "l1", cwd: "/repo", needs: [".claude/inbox/shot.png"], createdAt: NOW, state: "waiting" };
  assert.match(describeLaunch(base), /waiting for shot\.png/);
  assert.match(describeLaunch({ ...base, needs: ["a.png", "b.png"] }), /waiting for 2 files/);
  assert.equal(describeLaunch({ ...base, state: "done" }), "opened");
  assert.equal(describeLaunch({ ...base, state: "canceled", reason: "you called it off" }), "you called it off");
  assert.equal(describeLaunch({ ...base, state: "failed", reason: "" }), "did not open");
});
