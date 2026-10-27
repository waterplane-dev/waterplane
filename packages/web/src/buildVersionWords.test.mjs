// Which build a build entry last produced (`buildVersionWords.ts`).
import test from "node:test";
import assert from "node:assert/strict";
import { buildStampText } from "@waterplane/shared";
import { buildRecordWords, earlierBuildsLabel, entryVersions, lastBuildWords, shellStampOf } from "./buildVersionWords.ts";

const at = new Date(2026, 9, 27, 8, 42).getTime();
const r = { name: "vscode-extension", version: "0.7.0", sha: "a1b2c3d", at, channel: "installed in VS Code" };

test("an entry finds its records by its artifact, else by its own id", () => {
  const versions = { "vscode-extension": [r], apk: [{ name: "apk", at }] };
  assert.deepEqual(entryVersions({ id: "vscode-install", artifact: "vscode-extension" }, versions), [r]);
  assert.equal(entryVersions({ id: "apk" }, versions).length, 1);
  assert.deepEqual(entryVersions({ id: "e2e" }, versions), []);
  assert.deepEqual(entryVersions({ id: "apk" }, undefined), [], "an older host sent none");
});

test("the line is the artifact's own identifier, then where it went", () => {
  assert.equal(buildRecordWords(r), "0.7.0 · a1b2c3d · 27 Oct 08:42 → installed in VS Code");
  assert.equal(lastBuildWords({ name: "x", at }), "last build: 27 Oct 08:42");
});

test("the earlier-builds toggle is absent with nothing earlier", () => {
  assert.equal(earlierBuildsLabel(0, false), null);
  assert.equal(earlierBuildsLabel(1, false), "1 earlier build");
  assert.equal(earlierBuildsLabel(3, true), "hide earlier builds");
});

test("the shell's stamp is its version, the commit and the build time gradle baked in", () => {
  const s = shellStampOf({ versionName: "1.0", versionCode: 2, gitSha: "fb531d26", gitDirty: true, builtAt: at });
  assert.deepEqual(s, { version: "1.0 (2)", sha: "fb531d26", dirty: true, at });
  assert.equal(buildStampText(s), "1.0 (2) · fb531d26 + edits · 27 Oct 08:42");
});

test("an APK from before the stamp has none, never a stamp at time zero", () => {
  assert.equal(shellStampOf({ versionName: "1.0", versionCode: 2 }), null);
  assert.equal(shellStampOf({ versionName: "1.0", versionCode: 2, gitSha: "", gitDirty: false, builtAt: 0 }), null);
  assert.equal(shellStampOf(null), null);
  assert.deepEqual(shellStampOf({ gitSha: "", builtAt: at }), { at }, "an empty sha is not said");
});
