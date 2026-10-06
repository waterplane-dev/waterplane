/**
 * One Node truth: `@waterplane/shared`'s `NODE_MIN` is what the doctor and the
 * early refusal use, so the root `engines` must say the same, and `.nvmrc`
 * (what a checkout's `nvm use` picks) must be the major the release pins in
 * `deploy/node-version`. They disagreed (22 / 24.21.0 / >=20 / "node ≥20")
 * while the host already needed 20.12 (`util.parseEnv`; `import.meta.dirname` is 20.11).
 * Two sources, then: `NODE_MIN` (the floor) and `deploy/node-version` (the pin); every other
 * statement — engines, `.nvmrc`, the README, CI, the release scripts — is checked against them here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_MIN, nodeMeetsMin, nodeTooOldSentence } from "@waterplane/shared";

const ROOT = join(import.meta.dirname, "../../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const minor = NODE_MIN.split(".").slice(0, 2).join(".");

test("engines, the npm placeholder and the lockfile's root all say >=NODE_MIN", () => {
  assert.equal(JSON.parse(read("package.json")).engines.node, `>=${minor}`);
  assert.equal(JSON.parse(read("deploy/npm-placeholder/package.json")).engines.node, `>=${minor}`);
  assert.equal(JSON.parse(read("package-lock.json")).packages[""].engines.node, `>=${minor}`);
});

test(".nvmrc is the major deploy/node-version pins, and that pin meets the minimum", () => {
  const pin = read("deploy/node-version").trim();
  assert.equal(read(".nvmrc").trim(), pin.split(".")[0]);
  assert.ok(nodeMeetsMin(pin), `${pin} >= ${NODE_MIN}`);
});

test("every prose or config statement of a Node version reads the same two sources", () => {
  // The minimum in words: README's prerequisites line is NODE_MIN's major.minor, nothing else.
  const readme = read("README.md");
  const stated = [...readme.matchAll(/\*\*Node\s*(?:≥|>=)\s*([\d.]+)\*\*/g)].map((m) => m[1]);
  assert.deepEqual(stated, [minor], "README states the minimum once, as NODE_MIN");
  // Not every one is in the public snapshot (docs/guide.md is private): check the ones present.
  for (const f of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/guide.md"].filter((p) => existsSync(join(ROOT, p)))) {
    for (const m of read(f).matchAll(/\bNode(?:\.js)?\s*(?:≥|>=|v)?\s*(\d{2})(?:\.(\d+))?\+?/g)) {
      assert.equal(`${m[1]}${m[2] ? `.${m[2]}` : ""}`, minor, `${f}: "${m[0]}" is not NODE_MIN (${minor})`);
    }
  }
  // The pin: CI and the release read the file, never a literal of their own.
  assert.match(read(".github/workflows/ci.yml"), /node-version-file: deploy\/node-version/);
  assert.doesNotMatch(read(".github/workflows/ci.yml"), /node-version:\s*['"]?\d/);
  assert.match(read("scripts/release/build.mjs"), /deploy\/node-version/);
  assert.match(read("scripts/release/render-install.mjs"), /deploy\/node-version/);
});

test("nodeMeetsMin compares numerically, v allowed, garbage refused", () => {
  assert.equal(nodeMeetsMin("20.12.0"), true);
  assert.equal(nodeMeetsMin("v20.12.1"), true);
  assert.equal(nodeMeetsMin("20.11.9"), false, "util.parseEnv is missing here");
  assert.equal(nodeMeetsMin("20.9.0"), false);
  assert.equal(nodeMeetsMin("100.0.0"), true, "numeric, not lexical");
  assert.equal(nodeMeetsMin("bogus"), false);
  assert.match(nodeTooOldSentence("20.5.0"), new RegExp(`Node 20\\.5\\.0 is too old: .*${NODE_MIN.replace(/\./g, "\\.")}`));
});
