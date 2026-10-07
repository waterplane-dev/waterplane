/**
 * The header's [Claude | Shell] tabs: which one is lit and where the other goes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pairTabs } from "./pairTabs.ts";

const can = { pending: false, isShell: false, canOpenShell: true };
const cli = { id: "a", createdAt: 1 };

test("a companion shell lights Shell and Claude goes back to its parent", () => {
  const sh = { id: "s", companionOf: "a", createdAt: 2 };
  assert.deepEqual(pairTabs(sh, [cli, sh], { ...can, isShell: true }), { on: "shell", cli });
});

test("a session with companions lights Claude and Shell goes to the NEWEST", () => {
  const old = { id: "s1", companionOf: "a", createdAt: 2 };
  const neu = { id: "s2", companionOf: "a", createdAt: 3 };
  assert.deepEqual(pairTabs(cli, [cli, old, neu], can), { on: "cli", shell: { attach: neu } });
});

test("a session with no companion: Shell opens one, only where the host can", () => {
  assert.deepEqual(pairTabs(cli, [cli], can), { on: "cli", shell: "open" });
  assert.equal(pairTabs(cli, [cli], { ...can, canOpenShell: false }), null);
});

test("no tabs on a pending open, a plain shell, or a companion whose parent is gone", () => {
  assert.equal(pairTabs(cli, [cli], { ...can, pending: true }), null);
  assert.equal(pairTabs({ id: "p" }, [{ id: "p" }], { ...can, isShell: true }), null);
  const orphan = { id: "s", companionOf: "gone" };
  assert.equal(pairTabs(orphan, [orphan], { ...can, isShell: true }), null);
});
