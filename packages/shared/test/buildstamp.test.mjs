// Which build is this (`shared/src/buildstamp.ts`). The failure: VS Code's "install latest"
// reinstalled 0.2.0 for ten days and nothing said which build was running.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStampText, cleanBuildRecord, parseBuildRecords, recordsByName } from "../dist/buildstamp.js";

const at = new Date(2026, 9, 27, 8, 42).getTime();

test("the identifier is version, commit and local build time", () => {
  assert.equal(buildStampText({ version: "0.7.0", sha: "a1b2c3d", at }), "0.7.0 · a1b2c3d · 27 Oct 08:42");
  assert.equal(buildStampText({ version: "0.7.0", sha: "a1b2c3d", dirty: true, at }), "0.7.0 · a1b2c3d + edits · 27 Oct 08:42");
  assert.equal(buildStampText({ at }), "27 Oct 08:42", "a missing part is not said");
});

test("a record needs a name and a time; junk fields are dropped, not kept", () => {
  assert.equal(cleanBuildRecord({ at }), null);
  assert.equal(cleanBuildRecord({ name: "x" }), null);
  assert.deepEqual(cleanBuildRecord({ name: "x", at, sha: "not a sha", dirty: "yes", channel: "dev\nrm" }), { name: "x", at });
});

test("a torn line hides nothing after it, and history is newest first per name", () => {
  const text = [
    JSON.stringify({ name: "vscode-extension", version: "0.6.1", at: at - 1000 }),
    "{torn",
    JSON.stringify({ name: "vscode-extension", version: "0.7.0", at }),
    JSON.stringify({ name: "apk-dev", at }),
  ].join("\n");
  const by = recordsByName(parseBuildRecords(text));
  assert.deepEqual(by["vscode-extension"].map((r) => r.version), ["0.7.0", "0.6.1"]);
  assert.equal(by["apk-dev"].length, 1);
});
