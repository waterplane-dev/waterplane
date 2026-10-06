/**
 * The keystore wrapper's refusal words, pinned without a phone.
 *
 *     node --test packages/web/src/nativeKeystore.test.mjs
 *
 * The page words a refusal off its `code`, so a code this file does not know
 * must become `failed` (never passed through as if it were one of ours), and
 * a missing plugin must say `unavailable` rather than throw a TypeError.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { KEYSTORE_CODES, isKeystoreError, nativeKeystore, toKeystoreError } from "./nativeKeystore.ts";

test("a known native code passes through with its message", () => {
  for (const code of KEYSTORE_CODES) {
    const e = Object.assign(new Error(`m-${code}`), { code });
    assert.deepEqual(toKeystoreError(e), { code, message: `m-${code}` });
  }
});

test("an unknown or missing code is failed, message kept", () => {
  assert.deepEqual(toKeystoreError(Object.assign(new Error("boom"), { code: "UNIMPLEMENTED" })), { code: "failed", message: "boom" });
  assert.deepEqual(toKeystoreError(new Error("plain")), { code: "failed", message: "plain" });
  assert.deepEqual(toKeystoreError("just words"), { code: "failed", message: "just words" });
  assert.deepEqual(toKeystoreError(undefined), { code: "failed", message: "failed" });
  assert.deepEqual(toKeystoreError({ code: "lockout", errorMessage: "too many" }), { code: "lockout", message: "too many" });
});

test("isKeystoreError recognises only the shape the wrapper rejects with", () => {
  assert.equal(isKeystoreError({ code: "cancelled", message: "x" }), true);
  assert.equal(isKeystoreError({ code: "nope", message: "x" }), false);
  assert.equal(isKeystoreError(new Error("x")), false);
});

test("no plugin: available() is false and every call rejects unavailable", async () => {
  assert.equal(nativeKeystore.available(), false);
  await assert.rejects(nativeKeystore.status(), (e) => e.code === "unavailable");
  await assert.rejects(nativeKeystore.has({ alias: "a" }), (e) => e.code === "unavailable");
});

test("a plugin's rejection is normalised; its answers are passed on", async () => {
  const calls = [];
  globalThis.Capacitor = { Plugins: { ShellKeystore: {
    status: async () => ({ hardware: true, enrolled: false, strongBox: false }),
    has: async (o) => { calls.push(["has", o]); return { exists: true }; },
    generate: async () => { throw Object.assign(new Error("already"), { code: "exists" }); },
    wrap: async () => { throw Object.assign(new Error("odd"), { code: "SOMETHING_ELSE" }); },
    unwrap: async () => ({ dataB64: "AA==" }),
    remove: async () => undefined,
  } } };
  try {
    assert.equal(nativeKeystore.available(), true);
    assert.deepEqual(await nativeKeystore.has({ alias: "k" }), { exists: true });
    assert.deepEqual(calls, [["has", { alias: "k" }]]);
    await assert.rejects(nativeKeystore.generate({ alias: "k" }), (e) => e.code === "exists" && e.message === "already");
    await assert.rejects(nativeKeystore.wrap({ alias: "k", dataB64: "AA==" }), (e) => e.code === "failed" && e.message === "odd");
    assert.deepEqual(await nativeKeystore.unwrap({ alias: "k", ctB64: "x", nonceB64: "y" }), { dataB64: "AA==" });
  } finally {
    delete globalThis.Capacitor;
  }
});
