/**
 * Why dictation fell back to the phone's recogniser, said in words.
 *
 *     node --test packages/web/src/dictateFallback.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { askOnLinkBack, dictateFallbackWhy, fallbackHasDoor } from "./dictateFallback.ts";

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
  assert.match(s, /no whisper model on this desktop\./);
});

test("the tap says the phone's recogniser is weaker, where the audio goes, and the setting that fixes it", () => {
  const s = dictateFallbackWhy({ secure: true, canRecord: true, status: { available: false, reason: "no whisper model on this desktop." } });
  assert.match(s, /weaker on code words and mixed languages/);
  assert.match(s, /on Android it may send your audio to Google/);
  assert.match(s, /Settings › Writing & reading › Local dictation/);
  assert.doesNotMatch(s, /\.\./, "a reason that ends in a full stop is not doubled");
  assert.equal(fallbackHasDoor(s), true);
});

test("https and no-recorder cases have a different fix: no door to Settings", () => {
  assert.equal(fallbackHasDoor(dictateFallbackWhy({ secure: false, canRecord: false })), false);
  assert.equal(fallbackHasDoor(dictateFallbackWhy({ secure: true, canRecord: false })), false);
});

test("a refusal with no reason still says whisper is out", () => {
  assert.match(dictateFallbackWhy({ secure: true, canRecord: true, status: { available: false } }), /whisper is not available/);
});

test("the link coming back asks once, and the emit its own request causes does not ask again", () => {
  let asks = 0;
  const listener = askOnLinkBack(false, () => {
    asks++;
    if (asks > 50) throw new Error("re-entered");
    listener({ status: "open" });   // `netBegin` emits synchronously, from inside the ask
  });
  listener({ status: "open" });
  assert.equal(asks, 1);
  listener({ status: "open" });
  assert.equal(asks, 1, "still open is not coming back");
  listener({ status: "closed" });
  listener({ status: "open" });
  assert.equal(asks, 2);
});

test("a link already open at mount is not a link coming back", () => {
  let asks = 0;
  askOnLinkBack(true, () => { asks++; })({ status: "open" });
  assert.equal(asks, 0);
});
