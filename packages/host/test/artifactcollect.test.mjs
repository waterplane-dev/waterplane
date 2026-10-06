// Collecting a build's output (`host/artifacts.ts`) — the disk half.
//
// The rules are pinned without a filesystem in `shared/test/artifacts.test.mjs`;
// what is only true on disk is here: the hard link that keeps a 227 MB APK
// costing 227 MB, the name a real repo's own manifest supplies, the duplicate
// that is folded because the bytes match, and the prune that removes an older
// build of exactly what was just produced and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAND } from "@waterplane/shared";
import { artifactPolicy, collectArtifacts, projectVersion, saveArtifactPolicy } from "../dist/artifacts.js";

const POLICY = { collect: true, prune: true, keep: 3 };
const when = new Date(2026, 8, 22, 10, 42);

/** A repo is made INSIDE the temp dir under a fixed name: the collected
 *  artifact is named after the repo's directory, so a random one would make
 *  every expectation here unwritable. */
function repo(files = {}, name = "demo") {
  const dir = join(mkdtempSync(join(tmpdir(), "art-")), name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
const art = (dir, relPath) => ({
  repoId: "r1", name: relPath.split("/").pop(), relPath,
  size: statSync(join(dir, relPath)).size, mtime: statSync(join(dir, relPath)).mtimeMs,
});
const outbox = (dir) => { try { return readdirSync(join(dir, ".claude", "outbox")).sort(); } catch { return []; } };

test("a nameless APK is collected into the outbox under the project's own version", () => {
  const dir = repo({
    "pubspec.yaml": "name: demo\nversion: 1.1.0+344\n",
    "build/app/outputs/flutter-apk/app-debug.apk": "APKBYTES",
  });
  const said = [];
  const out = collectArtifacts(dir, [art(dir, "build/app/outputs/flutter-apk/app-debug.apk")], POLICY, (l) => said.push(l), when);
  const names = outbox(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /-debug-1\.1\.0\+344/, `named from pubspec, got ${names[0]}`);
  assert.equal(out[0].relPath, `.claude/outbox/${names[0]}`, "the run REPORTS the collected copy — one artifact, where a person looks");
  assert.ok(said.some((l) => l.includes("artifact:")), "and says so in the build's own output");
  // The original is untouched: gradle's tree is not ours to tidy.
  assert.ok(statSync(join(dir, "build/app/outputs/flutter-apk/app-debug.apk")).isFile());
});

test("the collected copy is INDEPENDENT of what the next build overwrites", () => {
  // A hard link is cheaper and was wrong: `flutter build`, `cp -f` and
  // `printf >` all rewrite their output IN PLACE, so a link put the next
  // build's bytes inside the artifact collected from the previous one — and
  // "the newest 3" silently became three names for one file.
  const dir = repo({ "build/out.apk": "FIRST" });
  collectArtifacts(dir, [art(dir, "build/out.apk")], POLICY, () => {}, when);
  const [name] = outbox(dir);
  writeFileSync(join(dir, "build/out.apk"), "SECOND");
  assert.equal(readFileSync(join(dir, ".claude", "outbox", name), "utf8"), "FIRST");
  assert.notEqual(statSync(join(dir, ".claude", "outbox", name)).ino, statSync(join(dir, "build/out.apk")).ino);
});

test("the same bytes under two names are offered once", () => {
  const dir = repo({
    "pubspec.yaml": "version: 2.0.0+7\n",
    "build/app/outputs/flutter-apk/app-debug.apk": "IDENTICAL",
    "picture-app-debug-v2.0.0-7.apk": "IDENTICAL",
  });
  const said = [];
  const out = collectArtifacts(dir, [
    art(dir, "build/app/outputs/flutter-apk/app-debug.apk"),
    art(dir, "picture-app-debug-v2.0.0-7.apk"),
  ], POLICY, (l) => said.push(l), when);
  assert.equal(out.length, 1, "one artifact, not two downloads of one file");
  assert.match(out[0].relPath, /picture-app-debug-v2\.0\.0-7\.apk$/, "the name somebody chose wins");
  assert.ok(said.some((l) => l.includes("same file twice")), "a fold is a sentence, never a file quietly not appearing");
});

test("a prune removes older builds of what was just produced, and nothing else", () => {
  const dir = repo({
    "app/build.gradle": 'android { defaultConfig { versionName "3.1" \n versionCode 12 } }',
    "build/outputs/apk/debug/app-debug.apk": "NEW",
    ".claude/outbox/demo-debug-3.1+9.apk": "OLD1",
    ".claude/outbox/demo-debug-3.1+10.apk": "OLD2",
    ".claude/outbox/demo-debug-3.1+11.apk": "OLD3",
    ".claude/outbox/demo-release-3.1+11.apk": "SIBLING",
    ".claude/outbox/notes.md": "not a build",
  });
  const old = Date.now() / 1000 - 3600;
  for (const [i, n] of ["demo-debug-3.1+9.apk", "demo-debug-3.1+10.apk", "demo-debug-3.1+11.apk"].entries()) {
    utimesSync(join(dir, ".claude", "outbox", n), old + i * 60, old + i * 60);
  }
  const said = [];
  collectArtifacts(dir, [art(dir, "build/outputs/apk/debug/app-debug.apk")], POLICY, (l) => said.push(l), when);
  const left = outbox(dir);
  assert.ok(!left.includes("demo-debug-3.1+9.apk"), "the oldest of the family went");
  assert.ok(left.includes("demo-debug-3.1+11.apk"), "the newest two of the family stayed");
  assert.ok(left.includes("demo-release-3.1+11.apk"), "a SIBLING artifact is not this run's business");
  assert.ok(left.includes("notes.md"), "and neither is anything that is not a build of this artifact");
  assert.ok(said.some((l) => l.includes("removed older build")), "a deletion is a sentence somebody can read afterwards");
});

test("collect off ⇒ the build is offered exactly where it landed", () => {
  const dir = repo({ "build/out.apk": "X" });
  const out = collectArtifacts(dir, [art(dir, "build/out.apk")], { collect: false, prune: true, keep: 3 }, () => {}, when);
  assert.equal(out[0].relPath, "build/out.apk");
  assert.deepEqual(outbox(dir), [], "nothing written, nothing removed");
});

test("a stale artifact is never copied under a name claiming this run made it", () => {
  const dir = repo({ "build/old.apk": "OLD" });
  const a = { ...art(dir, "build/old.apk"), stale: true };
  const out = collectArtifacts(dir, [a], POLICY, () => {}, when);
  assert.equal(out[0].relPath, "build/old.apk");
  assert.deepEqual(outbox(dir), []);
});

test("the version is read from whichever manifest the project actually has", () => {
  assert.equal(projectVersion(repo({ "pubspec.yaml": "version: 1.1.0+344\n" })), "1.1.0+344");
  assert.equal(projectVersion(repo({ "package.json": '{"version":"4.2.1"}' })), "4.2.1");
  assert.equal(projectVersion(repo({ "app/build.gradle": 'versionName "2.3"\nversionCode 41\n' })), "2.3+41");
  assert.equal(projectVersion(repo({ "Cargo.toml": '[package]\nversion = "0.9.1"\n' })), "0.9.1");
  assert.equal(projectVersion(repo({ "package.json": "{not json" })), undefined, "a manifest that does not parse is not an answer");
  assert.equal(projectVersion(repo({})), undefined);
});

test("the policy round-trips through the repo, and its absence is the defaults", () => {
  const dir = repo({});
  assert.deepEqual(artifactPolicy(dir), { collect: true, prune: true, keep: 3 }, "on by default, in a repo that has never been asked");
  saveArtifactPolicy(dir, { collect: true, prune: false, keep: 9 });
  assert.deepEqual(artifactPolicy(dir), { collect: true, prune: false, keep: 9 });
  writeFileSync(join(dir, BRAND.stateDirName, "artifacts.json"), "{ truncated");
  assert.deepEqual(artifactPolicy(dir), { collect: true, prune: true, keep: 3 }, "an unreadable file is the defaults, never the feature silently off");
});
