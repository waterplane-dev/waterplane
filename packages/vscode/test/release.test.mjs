import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, marketplaceVersions, openVsxVersions, planRelease, readmeImages } from "../scripts/release-lib.mjs";

const base = {
  name: "waterplane",
  version: "0.4.0",
  changelog: "# Changelog\n\n## 0.4.0 - 2026-11-01\n\n- x\n\n## 0.3.0 - 2026-10-19\n",
  scripts: { package: "vsce package -o waterplane-0.4.0.vsix && node scripts/check-vsix.mjs waterplane-0.4.0.vsix" },
  dirty: [],
  images: [{ url: "https://raw/x.png", status: 200 }],
  published: { marketplace: ["0.3.0"], openvsx: [] },
  only: ["marketplace", "openvsx"],
  tokens: { VSCE_PAT: true, OVSX_PAT: true },
  publish: true,
};

test("versions compare numerically, and anything not x.y.z is unknown", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.3.0", "1.0.0"), -1);
  assert.equal(compareVersions("0.3.0-pre", "0.3.0"), null);
});

test("registry answers become version lists", () => {
  assert.deepEqual(marketplaceVersions({ results: [{ extensions: [{ versions: [{ version: "0.3.0" }] }] }] }), ["0.3.0"]);
  assert.deepEqual(marketplaceVersions({ results: [{ extensions: [] }] }), []);
  assert.deepEqual(openVsxVersions({ allVersions: { latest: "u", "0.3.0": "u" } }), ["0.3.0"]);
});

test("only relative README images are checked", () => {
  assert.deepEqual(readmeImages("![a](media/a.png) ![b](https://x/b.png)"), ["media/a.png"]);
});

test("a ready release publishes to every registry missing the version", () => {
  assert.deepEqual(planRelease(base), { vsix: "waterplane-0.4.0.vsix", problems: [], targets: ["marketplace", "openvsx"], skipped: [] });
});

test("a registry that already has the version is skipped, so a repeat is safe", () => {
  const p = planRelease({ ...base, published: { marketplace: ["0.4.0"], openvsx: ["0.4.0"] } });
  assert.deepEqual(p.targets, []);
  assert.equal(p.problems.length, 0);
  assert.match(p.skipped.at(-1), /nothing to publish/);
});

test("each reason to stop is said", () => {
  const p = planRelease({
    ...base,
    changelog: "## Unreleased\n",
    scripts: { package: "vsce package -o waterplane-0.3.0.vsix" },
    dirty: [" M src/a.ts"],
    images: [{ url: "https://raw/x.png", status: 404 }],
    published: { marketplace: ["0.5.0"], openvsx: null },
  });
  assert.equal(p.problems.length, 7);
  assert.deepEqual(p.targets, []);
});

test("tokens are needed only to publish", () => {
  const tokens = { VSCE_PAT: false, OVSX_PAT: false };
  assert.equal(planRelease({ ...base, tokens, publish: false }).problems.length, 0);
  assert.equal(planRelease({ ...base, tokens }).problems.length, 2);
});
