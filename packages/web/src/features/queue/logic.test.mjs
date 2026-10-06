/** The queue sheet's words, moved out of App's `overlayViews.queue`. */
import test from "node:test";
import assert from "node:assert/strict";

import { LAUNCH_HELD_OFFLINE, serialToast } from "./logic.ts";

test("the serialize switch says which way it went", () => {
  assert.equal(serialToast(true), "new queued work will run one session at a time per repo");
  assert.equal(serialToast(false), "new queued work will all start at once");
});

test("a held launch's refusal says the desktop still holds it", () => {
  assert.match(LAUNCH_HELD_OFFLINE, /It stays held; try again when the link is back\.$/);
});
