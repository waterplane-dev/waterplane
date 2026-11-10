import test from "node:test";
import assert from "node:assert/strict";

import { lanTestWords, staleLanOffer, tailnetOkWords } from "./hostTestWords.ts";

test("the tailnet test names how long it took and which folder the desktop serves", () => {
  assert.equal(tailnetOkWords(123.4, "/Users/me/dev"), "Reached in 123 ms: the desktop serving /Users/me/dev.");
});

test("a Wi-Fi test tells proven, impostor, unchecked and silent apart", () => {
  assert.equal(lanTestWords({ s: "ok", ms: 40, proven: true }).tone, "ok");
  assert.match(lanTestWords({ s: "ok", ms: 40, proven: false }).text, /not this desktop/);
  assert.match(lanTestWords({ s: "ok", ms: 40, proven: null }).text, /switch to this desktop to check/);
  assert.match(lanTestWords({ s: "bad", aborted: true }).text, /address may have changed/);
});

test("a stale Wi-Fi address is met with the one the desktop reports now", () => {
  const bad = { s: "bad", aborted: true };
  assert.equal(staleLanOffer("http://192.168.0.62:8770", bad, ["192.168.0.64"]), "192.168.0.64");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", bad, ["192.168.0.62"]), null, "same address: nothing to offer");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", { s: "ok", ms: 5, proven: true }, ["192.168.0.64"]), null, "a proven address is not stale");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", null, ["192.168.0.64"]), "192.168.0.64", "untested: offered before the test too");
  assert.equal(staleLanOffer(null, null, ["192.168.0.64"]), null, "an empty field has its own chips");
});
