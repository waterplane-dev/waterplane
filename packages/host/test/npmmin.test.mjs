/**
 * The doctor's `npm` row: `.npmrc`'s `min-release-age` is silently ignored by npm
 * older than 11.10 (seen on a first install with npm 11.6), so the row warns there,
 * and is absent when the host was not started through npm at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNpm, NPM_MIN } from "../dist/doctor.js";

test("an npm that knows min-release-age is ok", () => {
  assert.equal(checkNpm(`npm/${NPM_MIN} node/v24.1.0 darwin arm64 workspaces/false`)?.status, "ok");
  assert.equal(checkNpm("npm/12.0.1 node/v24.1.0 linux x64")?.status, "ok");
});

test("an older npm warns and says how to fix it", () => {
  const c = checkNpm("npm/11.6.0 node/v22.15.0 win32 x64 workspaces/false");
  assert.equal(c?.status, "warn");
  assert.match(c.detail, /11\.6\.0/);
  assert.match(c.fix, /npm install -g npm@latest/);
});

test("not started through npm: no row", () => {
  assert.equal(checkNpm(undefined), null);
  assert.equal(checkNpm("yarn/1.22.0 node/v22.0.0"), null);
});
