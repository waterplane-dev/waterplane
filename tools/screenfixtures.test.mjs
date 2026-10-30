// tools/screenfixtures.mjs: version arithmetic, manifest resolution, row states.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as sf from "./screenfixtures.mjs";
import { parseVersion, cmpVersion, bannerVersion, versionGap, resolveEntries, rowFor, unprovenCount } from "./screenfixtures.mjs";

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

test("noProofCount counts rows with NO proof, and is ABSENT — not 0 — with no installed version", () => {
  const rows = [{ proof: ["fixture"] }, { proof: [] }, { proof: ["capture", "live"] }, { proof: [] }];
  assert.deepEqual(sf.noProofCount(rows, "2.1.301"), { value: 2 });
  assert.deepEqual(sf.noProofCount([], "2.1.301"), { value: 0 }, "a known version with no signals lacking proof IS a zero");
  const unknown = sf.noProofCount(rows, null);
  assert.equal(unknown.value, null);
  assert.match(unknown.reason, /unknown/);
});

test("--reading prints exactly one JSON number on stdout", async (t) => {
  const script = fileURLToPath(new URL("./screenfixtures.mjs", import.meta.url));
  const { CLI_SIGNALS } = await import(new URL("../packages/shared/dist/clihealth/healthcatalog.js", import.meta.url).href);
  const empty = mkdtempSync(join(tmpdir(), "captures-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const health = join(empty, "clihealth.json");
  writeFileSync(health, JSON.stringify({ version: "9.9.9", signals: {} }));
  // A pinned --cli, a live record with no goods and an empty capture dir make
  // the count deterministic: on a v9.9.9 nothing has proof, so every signal counts.
  const future = execFileSync(process.execPath, [script, "--reading", "--cli", "9.9.9", "--health", health, "--captures", empty], { encoding: "utf8" });
  assert.equal(future, `${CLI_SIGNALS.length}\n`);
  const out = execFileSync(process.execPath, [script, "--reading", "--cli", "v2.1.301", "--health", health, "--captures", empty], { encoding: "utf8" });
  assert.match(out, /^\d+\n$/);
  assert.equal(typeof JSON.parse(out), "number");
});

test("--reading is ABSENT — exit 1, nothing on stdout — without a live record to ask", (t) => {
  const script = fileURLToPath(new URL("./screenfixtures.mjs", import.meta.url));
  const empty = mkdtempSync(join(tmpdir(), "captures-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [script, "--reading", "--cli", "2.1.314", "--health", "/nonexistent", "--captures", empty], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "", "a desktop with no host state reads absent, never every signal unproved");
  assert.match(r.stderr, /clihealth/);
});

// --unproven: the second reading (`screenUnproven`).

test("unprovenCount counts signals with NO match of any version; a guard proves nothing", () => {
  const rows = [{ match: 0, guard: 4 }, { match: 1, guard: 0 }, { match: 0, guard: 0 }, { match: 3, guard: 2 }];
  assert.deepEqual(unprovenCount(rows, {}), { value: 2 });
  assert.deepEqual(unprovenCount([{ match: 1 }], {}), { value: 0 }, "every signal proven IS a zero");
});

test("unprovenCount is ABSENT — not 0, not all — without a manifest or a catalog", () => {
  const rows = [{ match: 0 }, { match: 2 }];
  for (const m of [null, undefined]) {
    const got = unprovenCount(rows, m);
    assert.equal(got.value, null);
    assert.match(got.reason, /signals\.json/);
  }
  const empty = unprovenCount([], {});
  assert.equal(empty.value, null);
  assert.match(empty.reason, /no signals/);
});

test("--unproven prints exactly one JSON number on stdout", () => {
  const script = fileURLToPath(new URL("./screenfixtures.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script, "--unproven"], { encoding: "utf8" });
  assert.match(out, /^\d+\n$/);
  assert.ok(JSON.parse(out) <= 10);
});

// ── tools/harvestfixtures.mjs: the host's captures into the manifest ────

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSamples, leaks, planHarvest, withEntries, formatManifest, fixturePath } from "./harvestfixtures.mjs";

const KNOWN = new Set(["prompt.box", "hook.pipe", "limit.reset"]);

function captureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "harvest-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test("listSamples: a capture's version is its dir's X.Y.Z, and nothing else counts", (t) => {
  const dir = captureDir({
    "2.1.303/prompt.box.txt": "box",
    "2.1.303/hook.pipe.json": "{}",
    "2.1.303/not.asignal.txt": "x",
    "2.1.303/prompt.box.md": "x",
    "latest/prompt.box.txt": "x",
    "2.1/prompt.box.txt": "x",
    "2.1.302/prompt.box.txt": "older",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { samples, skipped } = listSamples(dir, KNOWN);
  assert.deepEqual(samples.map((s) => `${s.version} ${s.id} ${s.ext}`), ["2.1.302 prompt.box txt", "2.1.303 hook.pipe json", "2.1.303 prompt.box txt"]);
  assert.equal(skipped.length, 4, skipped.join("; "));
  assert.ok(skipped.some((s) => s.startsWith("latest/")) && skipped.some((s) => s.startsWith("2.1/")));
  assert.deepEqual(listSamples(join(dir, "missing"), KNOWN), { samples: [], skipped: [] });
});

test("leaks: a home path, an address or an opaque run refuses a sample; masked words do not", () => {
  assert.deepEqual(leaks("❯ 1. Xxxxx xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 0000000000000000000000000"), []);
  assert.deepEqual(leaks("Enter to select · Esc to cancel\n~ <redacted:40>"), []);
  assert.deepEqual(leaks(" /xxxxxxx/xx0xxx0x0x00xxxxxxxx_00x0000xx/X/xxxxx"), [], "a masked temp path");
  assert.deepEqual(leaks('{ "additionalWorkingDirectories": "<string>" }'), [], "a schema key is words");
  assert.deepEqual(leaks('{ "ephemeral_5m_input_tokens": "<number>" }'), [], "…digits and all");
  assert.match(leaks('{ "toolu_014eSw5ZGDhNfrMw3JtzPhFA": {} }').join(), /opaque/);
  assert.match(leaks("secret 3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c").join(), /opaque/, "a hex secret");
  assert.match(leaks("cwd /Users/alice/repo").join(), /home/);
  assert.match(leaks("ask bob@example.com").join(), /email/);
  assert.match(leaks("key sk-ant-abcdefghijklmnopqrstuvwxyz0123").join(), /opaque/);
});

test("planHarvest: role from the reader, cli from the version, a listed path is never added twice", () => {
  const samples = [
    { id: "prompt.box", version: "2.1.303", ext: "txt", file: "a" },
    { id: "prompt.box", version: "2.1.302", ext: "txt", file: "b" },
    { id: "hook.pipe", version: "2.1.303", ext: "json", file: "c" },
    { id: "limit.reset", version: "2.1.303", ext: "txt", file: "d" },
    { id: "prompt.box", version: "2.1.301", ext: "txt", file: "e" },
  ];
  const text = { a: "a box", b: "no box here", c: "{}", d: "anything", e: "/home/alice" };
  const manifest = { _about: "x", signals: { "prompt.box": [{ path: fixturePath(samples[1]), role: "match" }] } };
  samples.push({ id: "limit.reset", version: "2.1.304", ext: "txt", file: "f" });
  text.f = "/Hfref/nyvpr"; // ROT13 of a home path: refused only once decoded
  const plan = planHarvest(samples, manifest, {
    read: (f) => text[f],
    readSignal: (id, t) => (id === "limit.reset" ? null : t.includes("box") || t === "{}"),
    decode: (id, t) => (id === "limit.reset" ? t.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c <= "Z" ? 65 : 97))) : t),
  });
  assert.deepEqual(plan.map((p) => [p.path, p.action, p.role ?? p.why]), [
    ["screens/harvest-prompt.box-2.1.303.txt", "new", "match"],
    ["screens/harvest-prompt.box-2.1.302.txt", "present", undefined],
    ["screens/harvest-hook.pipe-2.1.303.json", "new", "match"],
    ["screens/harvest-limit.reset-2.1.303.txt", "refused", "no fixture reader for this signal"],
    ["screens/harvest-prompt.box-2.1.301.txt", "refused", "carries a home directory path"],
    ["screens/harvest-limit.reset-2.1.304.txt", "refused", "carries a home directory path"],
  ]);
  const next = withEntries(manifest, plan);
  assert.equal(next.signals["prompt.box"].length, 2, "the listed entry is kept, the new one appended");
  assert.deepEqual(next.signals["prompt.box"][1], { path: "screens/harvest-prompt.box-2.1.303.txt", role: "match", test: "packages/host/test/harvested.test.mjs", cli: "2.1.303" });
  assert.equal(next.signals["hook.pipe"][0].cli, "2.1.303");
  assert.equal(manifest.signals["prompt.box"].length, 1, "the manifest handed in is not mutated");
});

test("formatManifest: signals.json round-trips byte for byte, so --write adds one line per fixture", () => {
  const file = fileURLToPath(new URL("../packages/host/test/fixtures/signals.json", import.meta.url));
  const raw = readFileSync(file, "utf8");
  assert.equal(formatManifest(JSON.parse(raw)), raw);
});

// ── Proof on the installed CLI: fixture, host capture or live record ────

test("proof: a 2.1.314 host capture and a live good on 2.1.314 prove a signal whose fixtures stop at 2.1.312", (t) => {
  const dir = captureDir({ "2.1.314/deliver.echo.txt": "echo", "2.1.312/prompt.box.txt": "old", "2.1.314/hook.pipe.json": "{}" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const known = new Set(["deliver.echo", "prompt.box", "hook.pipe"]);
  const captured = sf.capturedOn(listSamples(dir, known).samples, "2.1.314");
  assert.deepEqual([...captured].sort(), ["deliver.echo", "hook.pipe"], "only the installed version's captures count");
  const e = [{ ...real, cli: "2.1.312" }];
  const live = { version: "2.1.314", lastGoodAt: 1_793_359_762_127, misses: 0 };
  const echo = rowFor({ id: "deliver.echo", name: "Echo" }, e, live, "2.1.314", null, captured);
  assert.equal(echo.state, "behind", "the fixture age is still reported as it is");
  assert.deepEqual(echo.proof, ["capture", "live"]);
  assert.deepEqual(sf.noProofCount([echo], "2.1.314"), { value: 0 });
});

test("proof: each of fixture, capture and live is enough alone; an older or never-good live record is none", () => {
  const e = [{ ...real, cli: "2.1.314" }];
  const old = [{ ...real, cli: "2.1.312" }];
  assert.deepEqual(rowFor(spec, e, null, "2.1.314", null, new Set()).proof, ["fixture"]);
  assert.deepEqual(rowFor(spec, old, null, "2.1.314", null, new Set(["s"])).proof, ["capture"]);
  assert.deepEqual(rowFor(spec, old, { version: "2.1.314", lastGoodAt: 1 }, "2.1.314", null, null).proof, ["live"]);
  assert.deepEqual(rowFor(spec, old, { version: "2.1.312", lastGoodAt: 1 }, "2.1.314", null, null).proof, [], "good on the previous CLI proves nothing here");
  assert.deepEqual(rowFor(spec, old, { version: "2.1.314", lastGoodAt: null, misses: 3 }, "2.1.314", null, null).proof, [], "a record with only misses is no proof");
  assert.deepEqual(rowFor(spec, undefined, null, "2.1.314", null, new Set(["s"])).proof, ["capture"], "a capture proves a signal with no fixture at all");
  assert.deepEqual(rowFor(spec, e, { version: "2.1.314", lastGoodAt: 1 }, null, null, new Set(["s"])).proof, [], "with no installed version nothing is proof");
});

// ── --debt: host captures the repo does not have yet (`harvestDebt`) ────

test("harvestDebt counts captures whose fixture path the manifest lacks, any version", () => {
  const samples = [
    { id: "prompt.box", version: "2.1.314", ext: "txt" },
    { id: "hook.pipe", version: "2.1.314", ext: "json" },
    { id: "hook.pipe", version: "2.1.312", ext: "json" },
  ];
  const manifest = { signals: { "hook.pipe": [{ path: "screens/harvest-hook.pipe-2.1.312.json", role: "match" }] } };
  assert.deepEqual(sf.harvestDebt(samples, manifest, true), { value: 2 });
  assert.deepEqual(sf.harvestDebt([], manifest, true), { value: 0 }, "a capture dir with nothing new IS a zero");
});

test("harvestDebt is ABSENT — not 0 — without a manifest or a capture dir", () => {
  const none = sf.harvestDebt([], null, true);
  assert.equal(none.value, null);
  assert.match(none.reason, /signals\.json/);
  const nodir = sf.harvestDebt([], { signals: {} }, false);
  assert.equal(nodir.value, null);
  assert.match(nodir.reason, /capture dir/);
});

test("--debt prints exactly one JSON number on stdout", (t) => {
  const script = fileURLToPath(new URL("./screenfixtures.mjs", import.meta.url));
  const dir = captureDir({ "9.9.9/prompt.box.txt": "box", "9.9.9/hook.pipe.json": "{}" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(execFileSync(process.execPath, [script, "--debt", "--captures", dir], { encoding: "utf8" }), "2\n");
  const r = spawnSync(process.execPath, [script, "--debt", "--captures", join(dir, "missing")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});
