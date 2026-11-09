/**
 * Every in-repo extension's manifest passes the contract the host loads it by, and its README says
 * what it does and where it is.
 *
 * The host refuses a manifest with problems (`manifestProblems`), and the extension then shows as
 * "Failed to load" on the phone — an over-long `places` line was enough (2026-11-09, ten of twelve
 * after a wording pass). The Plugins screen's "About" fold shows README.md, so a README without a
 * "Where to find it" section leaves the person where the old card did.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXT = join(ROOT, "packages/extensions");
const { manifestProblems } = await import(join(ROOT, "packages/shared/dist/plugin/manifest.js"));
const dirs = readdirSync(EXT).filter((d) => existsSync(join(EXT, d, "waterplane-plugin.json")));

// 5, not the private repo's 12: the public snapshot leaves the private extensions out and holds 7.
test("there are extensions to check", () => assert.ok(dirs.length >= 5, dirs.join(", ")));

for (const d of dirs) {
  test(`${d}: manifest passes manifestProblems`, () => {
    const m = JSON.parse(readFileSync(join(EXT, d, "waterplane-plugin.json"), "utf8"));
    assert.deepEqual(manifestProblems(m), []);
  });
  test(`${d}: README says what it does and where to find it`, () => {
    const f = join(EXT, d, "README.md");
    assert.ok(existsSync(f), `${d} has no README.md`);
    const t = readFileSync(f, "utf8");
    assert.ok(/^## Where to find it\b/m.test(t), `${d}/README.md has no "## Where to find it" section`);
  });
}
