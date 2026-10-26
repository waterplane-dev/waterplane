import { test } from "node:test";
import assert from "node:assert/strict";
import { apkNeedWords, apkOk, cmpVersion } from "./apkGate.ts";

test("versions compare by number, not by text", () => {
  assert.ok(cmpVersion("0.1.10", "0.1.9") > 0);
  assert.equal(cmpVersion("v0.1.8", "0.1.8"), 0);
  assert.equal(cmpVersion("0.1.8-dev", "0.1.8"), 0);
  assert.ok(cmpVersion("0.2", "0.1.9") > 0);
});

test("apkOk: no requirement passes, an older or silent shell does not", () => {
  assert.equal(apkOk(undefined, ""), true);
  assert.equal(apkOk("0.1.8", "0.1.8"), true);
  assert.equal(apkOk("0.1.8", "0.1.9"), true);
  assert.equal(apkOk("0.1.8", "0.1.6"), false);
  assert.equal(apkOk("0.1.8", ""), false);
});

test("the refusal names both versions, or says an older one", () => {
  assert.equal(apkNeedWords("0.1.8", "0.1.6"), "needs the 0.1.8 APK · yours is 0.1.6");
  assert.equal(apkNeedWords("0.1.8", ""), "needs the 0.1.8 APK · yours is an older one");
});
