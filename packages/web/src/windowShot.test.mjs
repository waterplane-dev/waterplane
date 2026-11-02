// The compose bar's "pick a window" — what a refused picker says, and the file name (`windowShot.ts`).
import test from "node:test";
import assert from "node:assert/strict";

import { shotName, shotRefusal } from "./windowShot.ts";

test("a cancelled picker says nothing", () => {
  assert.equal(shotRefusal("NotAllowedError", "Permission denied"), null);
});

test("the OS refusing screen capture names the setting", () => {
  assert.match(shotRefusal("NotAllowedError", "Permission denied by system"), /Screen Recording/);
});

test("other failures are worded, never empty", () => {
  assert.match(shotRefusal("NotSupportedError", ""), /cannot capture/);
  assert.match(shotRefusal("AbortError", "boom"), /boom/);
});

test("file name is local time, sortable", () => {
  assert.equal(shotName(new Date(2026, 10, 2, 9, 5, 7)), "window-20261102-090507.png");
});
