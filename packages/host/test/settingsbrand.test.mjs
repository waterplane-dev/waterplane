/**
 * The host's synced-settings store across a brand rename: a record written by
 * the phone under the legacy prefix (`<old>pad`) is served under the current
 * name, never over a value the current bundle already wrote, and the legacy
 * record itself stays on disk for a rolled-back build to read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LEGACY, lsKey } from "@waterplane/shared";
import { SettingsStore } from "../dist/settings.js";

const OLD = LEGACY[0];
const seed = (doc, stateDir = BRAND.stateDirName) => {
  const root = mkdtempSync(join(tmpdir(), "settingsbrand-"));
  mkdirSync(join(root, stateDir), { recursive: true });
  writeFileSync(join(root, stateDir, "settings.json"), JSON.stringify(doc));
  return root;
};

test("a legacy-prefixed record is read back under the current name, value intact", () => {
  const root = seed({ [`${OLD.storagePrefix}pad`]: { value: "[\"words\"]", ts: 5 } });
  const s = new SettingsStore(root);
  assert.deepEqual(s.get(lsKey("pad")), { value: "[\"words\"]", ts: 5 });
  const disk = JSON.parse(readFileSync(join(root, BRAND.stateDirName, "settings.json"), "utf8"));
  assert.equal(disk[lsKey("pad")].value, "[\"words\"]", "adopted on disk at once");
  assert.equal(disk[`${OLD.storagePrefix}pad`].value, "[\"words\"]", "the legacy record is kept");
  assert.equal(s.all()[`${OLD.storagePrefix}pad`], undefined, "and never served");
});

test("a value already under the current name wins over the legacy one", () => {
  const root = seed({
    [`${OLD.storagePrefix}pad`]: { value: "old", ts: 9 },
    [lsKey("pad")]: { value: "new", ts: 1 },
  });
  assert.equal(new SettingsStore(root).get(lsKey("pad")).value, "new");
});

test("the store under a not-yet-moved legacy state dir is still found", () => {
  const root = seed({ [`${OLD.storagePrefix}pad`]: { value: "kept", ts: 3 } }, OLD.stateDirName);
  assert.equal(new SettingsStore(root).get(lsKey("pad")).value, "kept");
});

test("clear forgets the legacy records too, so nothing is resurrected next boot", () => {
  const root = seed({ [`${OLD.storagePrefix}pad`]: { value: "old", ts: 2 } });
  new SettingsStore(root).clear();
  assert.equal(new SettingsStore(root).get(lsKey("pad")), undefined);
});
