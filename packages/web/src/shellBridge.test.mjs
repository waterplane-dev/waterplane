/**
 * The page's bridge names: current spelling first, every legacy shell's
 * spelling still reachable (the UI updates over the air, the APK does not).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY } from "@waterplane/shared";
import { defineShellGlobal, nativePlugin, shellInterface } from "./shellBridge.ts";

const legacySlug = LEGACY[0].slug;
const Legacy = legacySlug[0].toUpperCase() + legacySlug.slice(1);

test("a current plugin wins, a legacy-named one is still found, none is undefined", () => {
  globalThis.Capacitor = { Plugins: {} };
  assert.equal(nativePlugin("Link"), undefined);
  globalThis.Capacitor = { Plugins: { [`${Legacy}Link`]: { old: true } } };
  assert.deepEqual(nativePlugin("Link"), { old: true });
  globalThis.Capacitor = { Plugins: { [`${Legacy}Link`]: { old: true }, ShellLink: { fresh: true } } };
  assert.deepEqual(nativePlugin("Link"), { fresh: true });
  delete globalThis.Capacitor;
  assert.equal(nativePlugin("Link"), undefined);
});

test("the JS interface is read under either name", () => {
  assert.equal(shellInterface(), undefined);
  globalThis[`${Legacy}ShellAndroidInterface`] = { v: "old" };
  assert.deepEqual(shellInterface(), { v: "old" });
  globalThis.ShellAndroidInterface = { v: "new" };
  assert.deepEqual(shellInterface(), { v: "new" });
  delete globalThis[`${Legacy}ShellAndroidInterface`];
  delete globalThis.ShellAndroidInterface;
});

test("a window callback is defined under the current and every legacy name, and removed together", () => {
  const off = defineShellGlobal("Nudge", () => 7);
  assert.equal(globalThis.shellNudge(), 7);
  assert.equal(globalThis[`${legacySlug}ShellNudge`](), 7);
  off();
  assert.equal(globalThis.shellNudge, undefined);
  assert.equal(globalThis[`${legacySlug}ShellNudge`], undefined);
  const offBack = defineShellGlobal("Back", () => true, "");
  assert.equal(globalThis.shellBack(), true);
  assert.equal(globalThis[`${legacySlug}Back`](), true);
  offBack();
});
