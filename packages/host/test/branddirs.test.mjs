/**
 * The boot move of the daemon's own directories from a legacy brand name to the
 * current one (`branddirs.ts`), and the per-repo resolver that never moves.
 *
 * Every case here is a way a rename loses or hides a person's data silently:
 * a ledger left behind under the old name while the stores open an empty new
 * one, a file overwritten by a merge, a second boot moving things twice, a
 * per-repo dir moved without a tap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";
import {
  adoptLegacyDir, adoptRepoStateDir, configDir, dataDir, legacyRepoStateDirs, migrateHostDirs, repoStateDir, rootStateDir,
} from "../dist/branddirs.js";

const OLD = LEGACY[0].stateDirName;
const NEW = BRAND.stateDirName;
const fresh = (tag) => mkdtempSync(join(tmpdir(), `branddirs-${tag}-`));
const put = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

test("a legacy root state dir is renamed, and a symlink is left at the old name", () => {
  const root = fresh("rename");
  put(join(root, OLD, "sessions.json"), "[1]");
  put(join(root, OLD, "history", "a.json"), "{}");
  const r = adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  assert.equal(r.action, "renamed");
  assert.equal(readFileSync(join(root, NEW, "sessions.json"), "utf8"), "[1]");
  assert.ok(existsSync(join(root, NEW, "history", "a.json")));
  assert.ok(lstatSync(join(root, OLD)).isSymbolicLink(), "the old name is a symlink now");
  assert.equal(readlinkSync(join(root, OLD)), NEW, "relative, so it survives the parent moving");
  assert.equal(readFileSync(join(root, OLD, "sessions.json"), "utf8"), "[1]", "old paths still resolve");
  assert.equal(rootStateDir(root), join(root, NEW));
});

test("a second boot touches nothing", () => {
  const root = fresh("idem");
  put(join(root, OLD, "acks.json"), "{}");
  adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  const again = adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  assert.equal(again.action, "current");
  assert.equal(again.note, undefined);
  assert.ok(lstatSync(join(root, OLD)).isSymbolicLink());
});

test("neither present: nothing is created", () => {
  const root = fresh("none");
  const r = adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  assert.equal(r.action, "fresh");
  assert.ok(!existsSync(join(root, NEW)));
  assert.ok(!existsSync(join(root, OLD)));
});

test("both present: what the new dir lacks moves in, nothing is overwritten, conflicts stay put", () => {
  const root = fresh("merge");
  put(join(root, OLD, "intents.json"), "old-intents");
  put(join(root, OLD, "settings.json"), "old-settings");
  put(join(root, NEW, "settings.json"), "new-settings");
  const r = adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  assert.equal(r.action, "merged");
  assert.deepEqual(r.kept, ["settings.json"]);
  assert.equal(readFileSync(join(root, NEW, "intents.json"), "utf8"), "old-intents");
  assert.equal(readFileSync(join(root, NEW, "settings.json"), "utf8"), "new-settings", "the new copy is never overwritten");
  assert.equal(readFileSync(join(root, OLD, "settings.json"), "utf8"), "old-settings", "the old copy is never deleted");
  assert.ok(lstatSync(join(root, OLD)).isDirectory(), "a legacy dir still holding a file is not replaced by a link");
  assert.match(r.note, /settings\.json/);
});

test("both present and the legacy one empties: it becomes the symlink", () => {
  const root = fresh("merge2");
  put(join(root, OLD, "a.json"), "a");
  mkdirSync(join(root, NEW));
  const r = adoptLegacyDir(join(root, NEW), [join(root, OLD)]);
  assert.equal(r.action, "merged");
  assert.ok(lstatSync(join(root, OLD)).isSymbolicLink());
  assert.equal(readFileSync(join(root, OLD, "a.json"), "utf8"), "a");
});

test("boot: config, data and root state all move; an explicit CONFIG_DIR is used verbatim", () => {
  const home = fresh("home");
  const root = join(home, "dev");
  const L = LEGACY[0];
  put(join(home, "config", L.configDirName, ".env"), "K=1\n");
  put(join(home, "data", L.configDirName, "models", "w.bin"), "weights");
  put(join(root, L.stateDirName, "sessions.json"), "[]");
  const saved = { x: process.env.XDG_CONFIG_HOME, d: process.env.XDG_DATA_HOME, c: process.env[`${BRAND.envPrefix}CONFIG_DIR`], lc: process.env[`${L.envPrefix}CONFIG_DIR`] };
  try {
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_DATA_HOME = join(home, "data");
    delete process.env[`${BRAND.envPrefix}CONFIG_DIR`];
    delete process.env[`${L.envPrefix}CONFIG_DIR`];
    const out = migrateHostDirs(root);
    assert.deepEqual(out.map((r) => r.action), ["renamed", "renamed", "renamed"]);
    assert.equal(configDir(), join(home, "config", BRAND.configDirName));
    assert.equal(readFileSync(join(configDir(), ".env"), "utf8"), "K=1\n");
    assert.equal(dataDir(), join(home, "data", BRAND.configDirName));
    assert.ok(existsSync(join(dataDir(), "models", "w.bin")));
    assert.equal(rootStateDir(root), join(root, BRAND.stateDirName));
    assert.deepEqual(migrateHostDirs(root).map((r) => r.action), ["current", "current", "current"], "idempotent");

    // An override (tests, e2e) is never migrated and never redirected.
    const override = join(home, "elsewhere");
    process.env[`${L.envPrefix}CONFIG_DIR`] = override;
    assert.equal(configDir(), override, "the legacy knob name still works");
    assert.equal(migrateHostDirs(root).length, 2, "no config move under an override");
  } finally {
    for (const [k, v] of [["XDG_CONFIG_HOME", saved.x], ["XDG_DATA_HOME", saved.d], [`${BRAND.envPrefix}CONFIG_DIR`, saved.c], [`${L.envPrefix}CONFIG_DIR`, saved.lc]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("a repo's state dir is resolved, never moved, until the setup fix", () => {
  const repo = fresh("repo");
  assert.equal(repoStateDir(repo), join(repo, NEW), "neither: the current name, for the first writer");
  put(join(repo, OLD, "builds.json"), "[]");
  assert.equal(repoStateDir(repo), join(repo, OLD), "legacy only: read where it is");
  assert.deepEqual(legacyRepoStateDirs(repo), [join(repo, OLD)]);
  assert.ok(!existsSync(join(repo, NEW)), "resolving moved nothing");

  const r = adoptRepoStateDir(repo);
  assert.equal(r.action, "renamed");
  assert.equal(repoStateDir(repo), join(repo, NEW));
  assert.deepEqual(legacyRepoStateDirs(repo), [], "our own symlink is not a legacy dir");
  assert.equal(realpathSync(join(repo, OLD)), realpathSync(join(repo, NEW)));
});
