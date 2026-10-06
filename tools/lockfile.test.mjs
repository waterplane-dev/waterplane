// Every package either lockfile installs comes from the npm registry and carries a sha512 hash.
// `npm ci` checks a tarball against `integrity`, so a stripped hash, a git URL, a plain tarball URL
// or another registry is how a dependency gets past it — and a lockfile diff is the last thing
// anyone reads in review. Why: docs/notes/testing-and-ops.md#supply-chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org/";

function offenders(lockPath) {
  const lock = JSON.parse(readFileSync(resolve(REPO, lockPath), "utf8"));
  const bad = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes("node_modules/")) continue; // the root and workspace source dirs
    if (entry.link) continue; // a workspace symlink: its source is in this repo
    if (!entry.resolved?.startsWith(REGISTRY)) bad.push(`${path}: resolved ${entry.resolved ?? "(none)"}`);
    if (!entry.integrity?.startsWith("sha512-")) bad.push(`${path}: integrity ${entry.integrity ?? "(none)"}`);
  }
  return { version: lock.lockfileVersion, bad };
}

for (const lockPath of ["package-lock.json", "packages/app/package-lock.json"]) {
  test(`${lockPath}: every package from ${REGISTRY} with a sha512 integrity`, () => {
    const { version, bad } = offenders(lockPath);
    assert.ok(version >= 2, `${lockPath} is lockfileVersion ${version}; v1 has no per-path packages map to check`);
    assert.deepEqual(bad, [], `regenerate with npm, or justify the source in the PR:\n${bad.join("\n")}`);
  });
}
