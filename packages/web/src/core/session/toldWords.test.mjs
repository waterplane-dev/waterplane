/** "Not told about the outbox" — once per backend, with the way back (`toldWords.ts`). */
import test from "node:test";
import assert from "node:assert/strict";

import { notTold, toldGoneText, toldNoticeDue, toldText } from "./toldWords.ts";

test("owed only for told:none, once per backend; absent told (an older host) is never a guess", () => {
  assert.equal(toldNoticeDue("none", "acme", []), true);
  assert.equal(toldNoticeDue("none", "acme", ["acme"]), false, "shown once for that backend");
  assert.equal(toldNoticeDue("none", "copilot", ["acme"]), true, "…and once for each other one");
  for (const told of ["plugin-dir", "env-file", "config", "flag", undefined]) {
    assert.equal(toldNoticeDue(told, "x", []), false, String(told));
    assert.equal(notTold(told), false, `no way-back icon either for ${told}`);
  }
  assert.equal(notTold("none"), true);
});

test("a shell is never 'not told' — there is no agent to tell (review R5)", () => {
  assert.equal(notTold("none", "shell"), false, "no way-back icon on a shell tab");
  assert.equal(toldNoticeDue("none", "shell", [], "shell"), false, "and no notice");
  assert.equal(notTold("none", undefined), true, "an agent backend still says it");
  assert.equal(toldNoticeDue("none", "acme", [], undefined), true);
});

test("the words name the backend and the folder as written, and the dismissal names the way back", () => {
  assert.match(toldText("acme"), /^acme was not told about the outbox/);
  assert.match(toldText("acme"), /\.claude\/outbox\//, "the full transport path, as CLAUDE.md asks");
  assert.match(toldGoneText("acme"), /Shown once for acme on this phone/);
  assert.match(toldGoneText("acme"), /icon beside the title brings it back/);
});
