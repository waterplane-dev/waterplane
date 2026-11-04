// Group 2 of the lock review: the away clock outlives the gate (A3), the editor refuses the
// address that strands the app (A4), boot sentences wait for the card (A6), a re-pair opens the
// blob first (A8).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainSaveRefusal, PLAIN_SAVE_TRAP_WORDS } from "../../hostEditGuard.ts";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

test("A3: the wake listeners are registered for the page, not inside the gate component", () => {
  const gate = src("./AppLockGate.tsx");
  assert.doesNotMatch(gate, /addEventListener\(\s*["'](visibilitychange|pagehide|focus|pageshow)/);
  const actions = src("./actions.ts");
  const watch = src("./wakeActions.ts");
  for (const ev of ["visibilitychange", "pagehide", "focus", "pageshow"]) assert.match(watch, new RegExp(ev));
  assert.match(actions.match(/export function armAppLock[\s\S]*?\n}/)[0], /watchPage\(noteHidden, noteWake\)/, "armed before the first render, like the card");
});

test("A3: the away clock is recorded while HostSetup is showing, and a re-pair stays locked", async () => {
  // Behaviour: with the listeners at module scope, hiding records the clock with no gate mounted.
  const listeners = {};
  const doc = { visibilityState: "visible", addEventListener: (e, f) => { (listeners[e] ??= []).push(f); } };
  globalThis.document = doc;
  globalThis.window = { addEventListener: (e, f) => { (listeners[e] ??= []).push(f); } };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { watchPage } = await import("./wakeActions.ts");
  let hidden = 0, woke = 0;
  watchPage(() => hidden++, () => woke++);
  watchPage(() => hidden++, () => woke++); // idempotent
  assert.equal(listeners.visibilitychange.length, 1);
  doc.visibilityState = "hidden";
  listeners.visibilitychange[0]();
  assert.equal(hidden, 1, "hidden was recorded with no AppLockGate mounted");
  doc.visibilityState = "visible";
  listeners.visibilitychange[0]();
  assert.equal(woke, 1);

  const main = src("../../main.tsx");
  const setup = main.slice(main.indexOf("if (setup) {"), main.indexOf('if (mode === "passive")'));
  assert.match(setup, /hostConfigured\(\) && <AppLockGate \/>/);
  assert.ok(setup.indexOf("<AppLockGate") < setup.indexOf("<HostSetup"));
});

test("A4: a plain saved address is refused in words only where it would strand the app", () => {
  assert.equal(plainSaveRefusal("http://192.168.1.5:8770", true, true, "sentinel"), PLAIN_SAVE_TRAP_WORDS);
  assert.match(PLAIN_SAVE_TRAP_WORDS, /tailnet address/);
  assert.match(PLAIN_SAVE_TRAP_WORDS, /sign-in lock off/);
  assert.equal(plainSaveRefusal("https://studio.tail1234.ts.net", true, true, "sentinel"), null);
  assert.equal(plainSaveRefusal("http://192.168.1.5:8770", false, true, "sentinel"), null, "not sealed");
  assert.equal(plainSaveRefusal("http://192.168.1.5:8770", true, false, "sentinel"), null, "lock off");
  assert.equal(plainSaveRefusal("http://192.168.1.5:8770", true, true, "authenticate"), null, "a new APK has a way in");
  assert.match(src("../../HostSetup.tsx").match(/function save\([\s\S]*?\n  }\n/)[0], /plainSaveRefusal/);
});

test("A6: toasts wait under the card and are said when it goes", async () => {
  const t = await import("../../toast.ts");
  let up = true;
  t.holdToastsWhile(() => up);
  const seen = [];
  const off = t.onToast((m) => seen.push(m));
  t.showToast("the lock is off");
  assert.ok(!seen.includes("the lock is off"));
  up = false;
  t.releaseToasts();
  assert.ok(seen.includes("the lock is off"));
  off();
  t.holdToastsWhile(() => false);
});

test("A8: a re-pair while sealed and not opened opens the blob before the redeem", () => {
  const pair = src("../../PairForm.tsx").match(/async function pair[\s\S]*?api\.pair\.redeem/)[0];
  assert.match(pair, /sealedMode\(\) && !heldTokens\(\)/);
  assert.ok(pair.indexOf("unlockSignIns()") < pair.indexOf("heldTokenFor"));
});
