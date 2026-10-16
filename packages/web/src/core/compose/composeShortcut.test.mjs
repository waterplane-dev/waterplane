/**
 * Ctrl/⌘+Return's line on the shortcut card (`composeShortcut.ts`): live only
 * with the caret in the compose box, words in it, and no dialog up.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { composeSendLive } from "./composeShortcut.ts";

const el = (sel, value) => ({ matches: (s) => s === "textarea[data-compose]:not(.pipe)" && sel, value });

test("composeSendLive", () => {
  assert.equal(composeSendLive(el(true, "hi"), false), true);
  assert.equal(composeSendLive(el(true, "   "), false), false);
  assert.equal(composeSendLive(el(true, "hi"), true), false);
  assert.equal(composeSendLive(el(false, "hi"), false), false);
  assert.equal(composeSendLive(null, false), false);
});
