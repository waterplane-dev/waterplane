/**
 * Self-update's pure half: which install a path belongs to, version order,
 * checksum-file parsing, nodejs.org's file names and which versions a prune
 * keeps. No network, no disk — the CLI's end-to-end path is exercised by hand
 * against a fake install (docs/notes/distribution.md, "Self-update").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "@waterplane/shared";
import {
  compareVersions, detectMode, nodeDistName, nodeVersionOfDir, parseShaLines, rollbackTarget, selectPrune,
} from "../dist/cli/selfupdate.js";

const S = BRAND.slug;
const inTree = (root) => `${root}/packages/host/dist/cli/selfupdate.js`;

test("mode: a tarball install is <data>/versions/<v>/ carrying release.json", () => {
  const root = "/home/me/.local/share/x/versions/0.2.0";
  const m = detectMode(inTree(root), (p) => p === `${root}/release.json`, S);
  assert.deepEqual(m, { kind: "tarball", dataDir: "/home/me/.local/share/x", version: "0.2.0", root });
});

test("mode: versions/<v> without release.json is not claimed as a tarball", () => {
  const root = "/srv/versions/0.2.0";
  assert.equal(detectMode(inTree(root), () => false, S).kind, "unknown");
});

test("mode: a temp dir under versions/ is never a version", () => {
  const root = "/d/versions/.tmp-0.2.0-12";
  assert.equal(detectMode(inTree(root), () => true, S).kind, "checkout"); // .git "exists" in this fake
  assert.equal(detectMode(inTree(root), () => false, S).kind, "unknown");
});

test("mode: npm global is node_modules/<slug>", () => {
  const root = `/usr/local/lib/node_modules/${S}`;
  assert.deepEqual(detectMode(inTree(root), () => true, S), { kind: "npm", root });
  assert.equal(detectMode(inTree("/usr/local/lib/node_modules/other"), () => false, S).kind, "unknown");
});

test("mode: a checkout has .git at its root; nothing matching is unknown", () => {
  const root = "/Users/me/dev/repo";
  assert.deepEqual(detectMode(inTree(root), (p) => p === `${root}/.git`, S), { kind: "checkout", root });
  assert.deepEqual(detectMode(inTree(root), () => false, S), { kind: "unknown", root });
});

test("versions: semver precedence, pre-releases below their release, garbage is null", () => {
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("unknown", "1.0.0"), null);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
});

test("sha lines: sha256sum text and binary-mode names, junk ignored", () => {
  const a = "a".repeat(64), b = "B".repeat(64);
  const m = parseShaLines(`${a}  x-0.1.1.tar.gz\n${b} *node-v24.21.0-darwin-arm64.tar.gz\r\nnot a line\n${"c".repeat(63)}  short\n`);
  assert.equal(m.get("x-0.1.1.tar.gz"), a);
  assert.equal(m.get("node-v24.21.0-darwin-arm64.tar.gz"), "b".repeat(64));
  assert.equal(m.size, 2);
});

test("node dist names for this os/arch, null where none is published for us", () => {
  assert.equal(nodeDistName("24.21.0", "darwin", "arm64"), "node-v24.21.0-darwin-arm64");
  assert.equal(nodeDistName("v24.21.0", "linux", "x64"), "node-v24.21.0-linux-x64");
  assert.equal(nodeDistName("24.21.0", "linux", "arm"), "node-v24.21.0-linux-armv7l");
  assert.equal(nodeDistName("24.21.0", "darwin", "arm"), null);
  assert.equal(nodeDistName("24.21.0", "win32", "x64"), null);
  assert.equal(nodeDistName("24", "linux", "x64"), null);
  assert.equal(nodeVersionOfDir("node-v24.21.0-linux-x64"), "24.21.0");
  assert.equal(nodeVersionOfDir("current"), null);
});

test("prune: keep current plus the newest, never a non-version", () => {
  assert.deepEqual(selectPrune(["0.1.0", "0.1.1", "0.1.2"], "0.1.2"), ["0.1.0"]);
  // rolled back to the oldest: it stays, with the newest beside it
  assert.deepEqual(selectPrune(["0.1.0", "0.1.1", "0.1.2"], "0.1.0"), ["0.1.1"]);
  assert.deepEqual(selectPrune(["0.1.0", ".tmp-x", "junk"], "0.1.0"), []);
  assert.deepEqual(selectPrune(["0.1.0", "0.2.0", "0.10.0", "0.9.0"], "0.10.0", 2).sort(), ["0.1.0", "0.2.0"]);
});

test("rollback goes to the newest version below current, else none", () => {
  assert.equal(rollbackTarget(["0.1.0", "0.1.1", "0.1.2"], "0.1.2"), "0.1.1");
  assert.equal(rollbackTarget(["0.1.0", "0.1.2"], "0.1.0"), null);
  assert.equal(rollbackTarget(["0.1.0-rc.1", "0.1.0"], "0.1.0"), "0.1.0-rc.1");
});
