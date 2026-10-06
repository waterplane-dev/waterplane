/**
 * A resume of a conversation whose session is already closed starts with the
 * reopen stack's words (`record.carryOfClosed`), not a row with none: the
 * closed session's `history/` file went with its kill, and the row is blank on
 * the phone without them. Only the first and latest prompts and the tab name
 * survive on the closed row, so only those are carried.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { carryOfClosed } from "../dist/sessions/record.js";

const base = { id: "3a18ac63", cwd: "/r", title: "r", closedAt: 3000, launch: {}, alive: false };

test("first and latest prompts become two history entries, in order", () => {
  const c = carryOfClosed({ ...base, openedAt: 1000, lastActiveAt: 2000, firstPrompt: "start here", lastPrompt: "now this", tabTitle: "a tab" });
  assert.deepEqual(c.history.map((e) => [e.kind, e.text, e.sentAt]), [["prompt", "start here", 1000], ["prompt", "now this", 2000]]);
  assert.equal(c.tabTitle, "a tab");
});

test("one prompt (first === latest) is carried once", () => {
  const c = carryOfClosed({ ...base, firstPrompt: "only", lastPrompt: "only" });
  assert.deepEqual(c.history.map((e) => e.text), ["only"]);
  assert.equal(c.tabTitle, undefined);
});

test("a row with no words and no tab name carries nothing", () => {
  assert.equal(carryOfClosed({ ...base }), null);
});
