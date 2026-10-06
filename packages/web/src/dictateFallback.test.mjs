/**
 * Why dictation fell back to the phone's recogniser, said in words.
 *
 *     node --test packages/web/src/dictateFallback.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dictateFallbackWhy } from "./dictateFallback.ts";

const ok = { available: true };

test("whisper in use: nothing to say", () => {
  assert.equal(dictateFallbackWhy({ secure: true, canRecord: true, status: ok }), null);
});

test("desktop not answered yet: no guess", () => {
  assert.equal(dictateFallbackWhy({ secure: true, canRecord: true }), null);
});

test("plain http names https as the fix, before asking the desktop", () => {
  const s = dictateFallbackWhy({ secure: false, canRecord: false });
  assert.match(s, /phone's own recogniser/);
  assert.match(s, /plain http/);
  assert.match(s, /https/);
});

test("secure but no recording API", () => {
  assert.match(dictateFallbackWhy({ secure: true, canRecord: false }), /no way to record audio/);
});

test("the desktop's own reason is passed through", () => {
  const s = dictateFallbackWhy({ secure: true, canRecord: true, status: { available: false, reason: "no whisper model on this desktop" } });
  assert.match(s, /no whisper model on this desktop$/);
});

test("a refusal with no reason still says whisper is out", () => {
  assert.match(dictateFallbackWhy({ secure: true, canRecord: true, status: { available: false } }), /whisper is not available/);
});
