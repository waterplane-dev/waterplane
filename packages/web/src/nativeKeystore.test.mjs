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

test("on a plain route no fingerprint is ever asked for, and the refusal says why", async () => {
  const calls = [];
  const spy = (name) => async () => { calls.push(name); return {}; };
  globalThis.Capacitor = { Plugins: { ShellKeystore: { wrap: spy("wrap"), unwrap: spy("unwrap"), has: async () => ({ exists: true }) } } };
  globalThis.location = { origin: "http://192.168.1.20:8770" };
  try {
    const plain = (e) => e.code === "plainRoute" && /nothing proves it reaches your desktop/.test(e.message);
    await assert.rejects(nativeKeystore.wrap({ alias: "k", dataB64: "AA==" }), plain);
    await assert.rejects(nativeKeystore.unwrap({ alias: "k", ctB64: "x", nonceB64: "y" }), plain);
    assert.deepEqual(calls, []);
    assert.deepEqual(await nativeKeystore.has({ alias: "k" }), { exists: true }); // asks for no fingerprint
    globalThis.location = { origin: "https://desk.tail1.ts.net" };
    await nativeKeystore.unwrap({ alias: "k", ctB64: "x", nonceB64: "y" });
    assert.deepEqual(calls, ["unwrap"]);
  } finally {
    delete globalThis.Capacitor;
    delete globalThis.location;
  }
});

test("authenticate and lockStatus are feature-detected: an older shell says unavailable", async () => {
  globalThis.Capacitor = { Plugins: { ShellKeystore: { wrap: async () => ({}) } } };
  try {
    assert.equal(nativeKeystore.canAuthenticate(), false);
    await assert.rejects(nativeKeystore.authenticate({}), (e) => e.code === "unavailable");
    await assert.rejects(nativeKeystore.lockStatus(), (e) => e.code === "unavailable");
  } finally {
    delete globalThis.Capacitor;
  }
});

test("authenticate uses no key, so a plain route does not seal it, and its refusals are labelled", async () => {
  let refuse = false;
  const authenticate = async () => { if (refuse) throw Object.assign(new Error("gone"), { code: "cancelled" }); return { method: "biometric" }; };
  globalThis.Capacitor = { Plugins: { ShellKeystore: { wrap: async () => ({}), authenticate } } };
  globalThis.location = { origin: "http://192.168.1.20:8770" };
  try {
    assert.equal(nativeKeystore.canAuthenticate(), true);
    assert.deepEqual(await nativeKeystore.authenticate({ title: "t" }), { method: "biometric" });
    refuse = true;
    await assert.rejects(nativeKeystore.authenticate({}), (e) => e.code === "cancelled" && e.message === "gone");
  } finally {
    delete globalThis.Capacitor;
    delete globalThis.location;
  }
});
