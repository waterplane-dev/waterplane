/**
 * Which build each artifact last was (`buildversions.ts`): `<repo state dir>/versions.jsonl`,
 * appended by builds and agents, read here bounded and newest first. The failure it exists for:
 * VS Code's install button reinstalled 0.2.0 for ten days and nothing said which build ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const { buildVersions } = await import("../dist/buildversions.js");
const { BuildManager } = await import("../dist/builds.js");

function withRepo(fn) {
  const d = mkdtempSync(join(tmpdir(), `${BRAND.slug}-buildversions-`));
  try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}

test("no file is no versions, never an error", () => withRepo((d) => {
  assert.deepEqual(buildVersions(d), {});
}));

test("records group by name, newest first; a torn line hides nothing after it", () => withRepo((d) => {
  mkdirSync(join(d, BRAND.stateDirName), { recursive: true });
  writeFileSync(join(d, BRAND.stateDirName, "versions.jsonl"), [
    JSON.stringify({ name: "vscode-extension", version: "0.6.1", at: 1000 }),
    "{torn",
    JSON.stringify({ name: "vscode-extension", version: "0.7.0", sha: "a1b2c3d", at: 2000, channel: "installed in VS Code" }),
  ].join("\n") + "\n");
  const v = buildVersions(d);
  assert.deepEqual(v["vscode-extension"].map((r) => r.version), ["0.7.0", "0.6.1"]);
  assert.equal(v["vscode-extension"][0].channel, "installed in VS Code");
}));

test("a build entry keeps the artifact it names", () => withRepo((d) => {
  mkdirSync(join(d, BRAND.sharedDirName), { recursive: true });
  writeFileSync(join(d, BRAND.sharedDirName, "builds.json"), JSON.stringify([{ id: "vscode-install", name: "x", cmd: "true", artifact: "vscode-extension" }]));
  assert.equal(new BuildManager(/** @type {any} */ ({})).list(d)[0].artifact, "vscode-extension");
}));
