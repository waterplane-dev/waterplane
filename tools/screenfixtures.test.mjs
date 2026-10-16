// tools/screenfixtures.mjs: version arithmetic, manifest resolution, row states.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseVersion, cmpVersion, bannerVersion, versionGap, resolveEntries, rowFor, currentCount } from "./screenfixtures.mjs";

test("parseVersion reads x.y.z anywhere, else null", () => {
  assert.deepEqual(parseVersion("2.1.293"), [2, 1, 293]);
  assert.deepEqual(parseVersion("2.1.301 (Claude Code)"), [2, 1, 301]);
  assert.equal(parseVersion("2.1"), null);
  assert.equal(parseVersion(undefined), null);
});

test("cmpVersion orders numerically, not as strings", () => {
  assert.ok(cmpVersion("2.1.9", "2.1.10") < 0);
  assert.ok(cmpVersion("2.2.0", "2.1.99") > 0);
  assert.ok(cmpVersion("3.0.0", "2.9.9") > 0);
  assert.equal(cmpVersion("2.1.5", "v2.1.5"), 0);
});

test("bannerVersion reads the welcome banner, null without one", () => {
  assert.equal(bannerVersion("  ✻ Welcome\n Claude Code v2.1.293\n"), "2.1.293");
  assert.equal(bannerVersion("no banner, v2.1.1 alone"), null);
});

test("versionGap: equal or newer-than is zero", () => {
  assert.deepEqual(versionGap("2.1.5", "2.1.5"), { n: 0, unit: "releases" });
  assert.deepEqual(versionGap("2.1.9", "2.1.5"), { n: 0, unit: "releases" });
  assert.equal(versionGap("junk", "2.1.5"), null);
});

test("versionGap with releases counts only published versions in (older, newer]", () => {
  const releases = ["2.1.1", "2.1.2", "2.1.4", "2.1.5", "2.2.0", "nonsense"];
  assert.deepEqual(versionGap("2.1.1", "2.1.5", releases), { n: 3, unit: "releases" });
  assert.deepEqual(versionGap("2.1.2", "2.2.0", releases), { n: 3, unit: "releases" });
  assert.deepEqual(versionGap("2.1.5", "2.1.9", releases), { n: 0, unit: "releases" });
});

test("versionGap offline: patch distance inside a minor, null across one", () => {
  assert.deepEqual(versionGap("2.1.290", "2.1.301"), { n: 11, unit: "patch numbers" });
  assert.equal(versionGap("2.1.290", "2.2.1"), null);
  assert.equal(versionGap("2.1.290", "3.1.301"), null);
});

const files = { "a/x.txt": "Claude Code v2.1.200\nscreen", "a/y.txt": "no banner" };
const read = (p) => { if (p in files) return files[p]; throw new Error("ENOENT"); };

test("resolveEntries: dedupes by path, match wins over guard, either order", () => {
  for (const entries of [
    [{ path: "a/x.txt", role: "guard" }, { path: "a/x.txt", role: "match" }],
    [{ path: "a/x.txt", role: "match" }, { path: "a/x.txt", role: "guard" }],
  ]) {
    const { fixtures, missing } = resolveEntries(entries, read);
    assert.deepEqual(fixtures, [{ path: "a/x.txt", role: "match", cli: "2.1.200" }]);
    assert.deepEqual(missing, []);
  }
});

test("resolveEntries: a missing file is reported, not counted; role defaults to guard", () => {
  const { fixtures, missing } = resolveEntries([{ path: "a/y.txt" }, { path: "a/gone.txt", role: "match" }], read);
  assert.deepEqual(fixtures, [{ path: "a/y.txt", role: "guard", cli: null }]);
  assert.deepEqual(missing, ["a/gone.txt"]);
});

test("resolveEntries: manifest cli beats the banner; no banner and no cli is null", () => {
  const { fixtures } = resolveEntries([{ path: "a/x.txt", cli: "2.1.250" }, { path: "a/y.txt" }], read);
  assert.equal(fixtures.find((f) => f.path === "a/x.txt").cli, "2.1.250");
  assert.equal(fixtures.find((f) => f.path === "a/y.txt").cli, null);
});

test("resolveEntries: no entries is empty; a glob over a missing dir is missing", () => {
  assert.deepEqual(resolveEntries(undefined, read), { fixtures: [], missing: [] });
  assert.deepEqual(resolveEntries([{ path: "nodir-xyz/*.txt" }], read), { fixtures: [], missing: ["nodir-xyz/*.txt"] });
});

test("resolveEntries expands a real glob against the fixtures dir", () => {
  const { fixtures, missing } = resolveEntries([{ path: "permmode/*.txt", role: "guard" }, { path: "permmode/trust-box.txt", role: "match" }], () => "x");
  assert.deepEqual(missing, []);
  assert.ok(fixtures.length > 1);
  assert.ok(fixtures.every((f) => f.path.startsWith("permmode/") && f.path.endsWith(".txt")));
  assert.equal(fixtures.filter((f) => f.path === "permmode/trust-box.txt").length, 1);
  assert.equal(fixtures.find((f) => f.path === "permmode/trust-box.txt").role, "match");
});

// rowFor reads the real fixtures dir; entries here name real files via a glob-free path.
const spec = { id: "s", name: "S" };
const real = { path: "permmode/trust-box.txt", role: "match" };

test("rowFor none: no entries, or only missing files", () => {
  assert.equal(rowFor(spec, undefined, null, "2.1.300").state, "none");
  const r = rowFor(spec, [{ path: "permmode/not-there.txt" }], null, "2.1.300");
  assert.equal(r.state, "none");
  assert.deepEqual(r.missing, ["permmode/not-there.txt"]);
});

test("rowFor undated: a capture exists but nothing says which CLI", () => {
  const r = rowFor(spec, [real], null, "2.1.300");
  assert.equal(r.state, "undated");
  assert.equal(r.undated, 1);
});

test("rowFor unknown / current / behind with a manifest cli", () => {
  const e = [{ ...real, cli: "2.1.290" }];
  assert.equal(rowFor(spec, e, null, null).state, "unknown");
  assert.equal(rowFor(spec, e, null, "2.1.290").state, "current");
  const b = rowFor(spec, e, null, "2.1.301");
  assert.equal(b.state, "behind");
  assert.deepEqual(b.gap, { n: 11, unit: "patch numbers" });
  assert.equal(b.newest, "2.1.290");
  assert.equal(b.match, 1);
  assert.equal(b.guard, 0);
  assert.equal(rowFor(spec, e, null, "2.2.0").gap, null);
  assert.equal(rowFor(spec, e, null, "2.2.0").state, "behind");
});

test("rowFor: live health is carried, defaults filled", () => {
  const e = [{ ...real, cli: "2.1.290" }];
  assert.equal(rowFor(spec, e, null, "2.1.290").live, null);
  assert.deepEqual(rowFor(spec, e, { misses: 2 }, "2.1.290").live, { version: null, misses: 2, lastGoodAt: null, lastMissAt: null });
});

// --reading: the repo's own repo-health reading (`.waterplane-shared/health.json`).

test("currentCount counts `current` rows, and is ABSENT — not 0 — with no installed version", () => {
  const rows = [{ state: "current" }, { state: "behind" }, { state: "current" }, { state: "none" }];
  assert.deepEqual(currentCount(rows, "2.1.301"), { value: 2 });
  assert.deepEqual(currentCount([], "2.1.301"), { value: 0 }, "a known version with nothing current IS a zero");
  const unknown = currentCount(rows, null);
  assert.equal(unknown.value, null);
  assert.match(unknown.reason, /unknown/);
});

test("--reading prints exactly one JSON number on stdout", () => {
  const script = fileURLToPath(new URL("./screenfixtures.mjs", import.meta.url));
  // A pinned --cli makes the count deterministic: every capture is behind a v9.9.9.
  const future = execFileSync(process.execPath, [script, "--reading", "--cli", "9.9.9", "--health", "/nonexistent"], { encoding: "utf8" });
  assert.equal(future, "0\n");
  const out = execFileSync(process.execPath, [script, "--reading", "--cli", "2.1.301", "--health", "/nonexistent"], { encoding: "utf8" });
  assert.match(out, /^\d+\n$/);
  assert.equal(typeof JSON.parse(out), "number");
});
