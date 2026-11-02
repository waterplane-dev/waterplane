// The install readings the launcher's count and the Apps sheet share (P4 review F3). Shape pins: the
// wiring modules reach the Capacitor bridge through extensionless imports node cannot load, so the wiring is
// read as source. Each assertion is a reason the badge and the sheet once disagreed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// The store itself (shared in-flight ask, a rejected ask, unsubscribe mid-emit) is RUN by
// `askedStore.test.mjs`; what stays here is the wiring around it, which reaches the bridge.
test("caps are re-asked on resume and after the Settings screen", () => {
  const s = src("./useInstallCaps.ts");
  assert.match(s, /createAskedStore</, "the caps are the one asked store, not a useState per mount");
  assert.match(s, /visibilitychange[\s\S]{0,120}refreshInstallStatus\(\)/, "a resume (back from Settings) re-asks");
  assert.match(src("./sdk/install.ts"), /openInstallSettings\(\)\.finally\(\(\) => \{ void refreshInstallStatus\(\); \}\)/);
});

test("every allow-list change is heard by a mounted reader: a write here and a copy adopted from another phone", () => {
  const n = src("./nativeInstall.ts");
  const write = n.slice(n.indexOf("export function writeInstallAllow"), n.indexOf("export function onInstallAllowChange"));
  assert.match(write, /for \(const fn of \[\.\.\.allowListeners\]\) fn\(\);/);
  assert.match(n, /onSettingsChange\(\(\) => \{ for \(const f of \[\.\.\.allowListeners\]\) f\(\); \}, \[LS\.installAllow\]\)/);
  assert.match(src("./sdk/install.ts"), /onInstallAllowChange\(\(\) => \{ read = true; allow\.set\(readInstallAllow\(\)\); \}\)/);
});

test("the launcher count draws nothing until the caps are known, never a count over NO_INSTALL", () => {
  const ix = src("../../extensions/android-apps/web/index.ts");
  assert.match(ix, /if \(!caps\) return null;/);
  assert.doesNotMatch(ix, /caps \?\? NO_INSTALL/);
});
