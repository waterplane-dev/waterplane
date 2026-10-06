import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildShrinkwrap, resolveDep } from "./shrinkwrap-lib.mjs";

const h = (n) => ({ version: "1.0.0", resolved: `https://registry.npmjs.org/${n}/-/${n}-1.0.0.tgz`, integrity: `sha512-${n}` });
const lock = {
  packages: {
    "": {},
    "node_modules/a": { ...h("a"), dependencies: { x: "^2", b: "^1" } },
    "node_modules/a/node_modules/x": { ...h("x"), version: "2.0.0" },
    "node_modules/b": { ...h("b"), optionalDependencies: { gone: "^1", o: "^1" } },
    "node_modules/o": { ...h("o"), optional: true, os: ["darwin"] },
    "node_modules/x": { ...h("x"), version: "1.0.0" },
    "node_modules/devonly": { ...h("devonly"), dev: true },
    "node_modules/@waterplane/shared": { resolved: "packages/shared", link: true },
  },
};
const staged = { name: "wp", version: "9.9.9", dependencies: { a: "1.0.0", "@waterplane/shared": "0.1.0" }, bundleDependencies: ["@waterplane/shared"] };
const bundled = { "@waterplane/shared": { version: "0.1.0" } };

test("nested resolution wins over hoisted", () => {
  assert.equal(resolveDep(lock.packages, "node_modules/a", "x"), "node_modules/a/node_modules/x");
  assert.equal(resolveDep(lock.packages, "node_modules/b", "x"), "node_modules/x");
});

test("closure: nested + hoisted, optional present kept, absent optional skipped, dev excluded", () => {
  const sw = buildShrinkwrap(lock, staged, bundled);
  const keys = Object.keys(sw.packages);
  assert.deepEqual(keys.sort(), ["", "node_modules/@waterplane/shared", "node_modules/a", "node_modules/a/node_modules/x", "node_modules/b", "node_modules/o"].sort());
  assert.equal(sw.packages["node_modules/a/node_modules/x"].version, "2.0.0");
  assert.equal(sw.packages["node_modules/@waterplane/shared"].inBundle, true);
  assert.equal(sw.packages[""].name, "wp");
  assert.equal(sw.lockfileVersion, 3);
});

test("a missing required dep throws", () => {
  assert.throws(() => buildShrinkwrap(lock, { ...staged, dependencies: { nope: "1" } }, bundled), /nope/);
});

test("the real lockfile: every locked entry has integrity + registry.npmjs.org resolved, no dev", () => {
  const real = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const host = JSON.parse(readFileSync(new URL("../../packages/host/package.json", import.meta.url), "utf8"));
  const deps = Object.fromEntries(Object.keys(host.dependencies).filter((n) => n !== "@waterplane/shared").map((n) => [n, real.packages[`node_modules/${n}`].version]));
  const sw = buildShrinkwrap(real, { name: "wp", version: "1.0.0", dependencies: { ...deps, "@waterplane/shared": "0.1.0" } }, bundled);
  const entries = Object.entries(sw.packages).filter(([k, e]) => k && !e.inBundle);
  assert.ok(entries.length > 5);
  for (const [k, e] of entries) {
    assert.match(e.resolved, /^https:\/\/registry\.npmjs\.org\//, k);
    assert.ok(e.integrity, k);
    assert.ok(!real.packages[k].dev, `${k} is dev-only`);
  }
});
