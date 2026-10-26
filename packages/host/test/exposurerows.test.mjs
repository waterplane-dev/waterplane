/**
 * The exposure watch as setup-checklist rows (`exposure.ts`): no series ⇒ no rows, the newest
 * row becomes a summary + one row per finding, and an accept writes the CLI's own accepts file
 * (the release gate reads it) in the CLI's format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { exposureChecksFor, setExposureAccept, setExposureDir } = await import("../dist/exposure.js");

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "expo-")));
  const wt = join(base, "repo");
  const dir = join(base, "exposure");
  mkdirSync(wt);
  mkdirSync(dir);
  setExposureDir(dir);
  const f = (key, extra = {}) => ({ key, measure: key.split(":")[0], subject: key.split(":")[1].replace(/@.*/, ""), level: "digest", text: `text of ${key}`, sources: ["x"], ...extra });
  const row = {
    v: 1, at: new Date().toISOString(), repo: "repo", dir: wt,
    findings: [f("A1:left-pad@1.0.0", { version: "1.0.0" }), f("A9:nover"), f("A2:node-pty", { version: "1.2.0" })],
    absent: [], readings: {},
  };
  writeFileSync(join(dir, "repo.jsonl"), JSON.stringify({ ...row, at: "2020-01-01T00:00:00Z" }) + "\n" + JSON.stringify(row) + "\n");
  return { wt, dir, acc: join(dir, "repo.accepted.json") };
}
const byId = (rows, id) => rows.find((c) => c.id === id);

test("no series for a worktree ⇒ no rows, never a throw", () => {
  const w = world();
  assert.deepEqual(exposureChecksFor(join(w.wt, "..", "other")), []);
  setExposureDir(join(w.dir, "missing"));
  assert.deepEqual(exposureChecksFor(w.wt), []);
});

test("the newest row gives a summary and one row per finding; built-in accepts show as such", () => {
  const w = world();
  const rows = exposureChecksFor(w.wt);
  assert.equal(rows[0].id, "exposure");
  assert.ok(byId(rows, "exposure:A1:left-pad@1.0.0"));
  assert.equal(byId(rows, "exposure:A1:left-pad@1.0.0").exposure.name, "repo");
  assert.equal(byId(rows, "exposure:A2:node-pty").accepted.builtIn, true);
});

test("accept writes the CLI's file format and the row comes back accepted; undo removes it", () => {
  const w = world();
  const r = setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "fine" });
  assert.deepEqual(r, { ok: true });
  const text = readFileSync(w.acc, "utf8");
  assert.ok(text.endsWith("\n") && text.includes('\n  "A1:left-pad@1.0.0": {'));
  const saved = JSON.parse(text)["A1:left-pad@1.0.0"];
  assert.equal(saved.reason, "fine");
  assert.ok(saved.at && !saved.until);
  assert.ok(byId(exposureChecksFor(w.wt), "exposure:A1:left-pad@1.0.0").accepted);
  assert.deepEqual(setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: false }), { ok: true });
  assert.equal(byId(exposureChecksFor(w.wt), "exposure:A1:left-pad@1.0.0").accepted, undefined);
});

test("until: a change stores the finding's text; a version needs a newer one on a versioned finding", () => {
  const w = world();
  setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "r", until: { change: true } });
  assert.deepEqual(JSON.parse(readFileSync(w.acc, "utf8"))["A1:left-pad@1.0.0"].until, { change: "text of A1:left-pad@1.0.0" });
  const noVer = setExposureAccept(w.wt, { id: "exposure:A9:nover", accept: true, reason: "r", until: { version: "2.0.0" } });
  assert.equal(noVer.ok, false);
  const old = setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "r", until: { version: "1.0.0" } });
  assert.equal(old.ok, false);
  assert.deepEqual(setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "r", until: { version: "1.1.0" } }), { ok: true });
});

test("a built-in accept cannot be undone here, in words", () => {
  const w = world();
  const r = setExposureAccept(w.wt, { id: "exposure:A2:node-pty", accept: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /Accepted in code/);
});

test("a corrupt accepts file is said in the summary and never overwritten", () => {
  const w = world();
  writeFileSync(w.acc, "{ nope");
  const sum = exposureChecksFor(w.wt)[0];
  assert.equal(sum.status, "warn");
  assert.match(sum.detail, /accepts file could not be read/);
  const r = setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "r" });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(w.acc, "utf8"), "{ nope");
});

test("no series / not an exposure id are refused in words", () => {
  const w = world();
  assert.equal(setExposureAccept(join(w.wt, "x"), { id: "exposure:A1:left-pad@1.0.0", accept: true, reason: "r" }).ok, false);
  assert.equal(setExposureAccept(w.wt, { id: "other", accept: true, reason: "r" }).ok, false);
});

test("an accept until a newer version holds across patch releases of a versioned key, not past it", async () => {
  const w = world();
  const { applyAccepts } = await import("@waterplane/shared");
  const fin = (v) => ({ key: `A3:left-pad@${v}`, measure: "A3", subject: "left-pad", version: v, level: "alert", text: "t", sources: [] });
  const acc = { "A3:left-pad@1.2.3": { reason: "r", at: "2026-10-01", until: { version: "2.0.0" } } };
  const now = "2026-10-26T00:00:00Z";
  assert.ok(applyAccepts([fin("1.2.3")], acc, now)[0].accepted);
  assert.ok(applyAccepts([fin("1.2.4")], acc, now)[0].accepted);
  assert.equal(applyAccepts([fin("2.0.1")], acc, now)[0].accepted, undefined);
  void w;
});

test("a series that was readable and now is not is a warn row, not a clean checklist", () => {
  const w = world();
  assert.ok(exposureChecksFor(w.wt).length > 1);
  writeFileSync(join(w.dir, "repo.jsonl"), "{ torn row with no newline and no end");
  const rows = exposureChecksFor(w.wt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "warn");
  assert.match(rows[0].detail, /could not be read/);
});

test("a row longer than the tail window is still read whole", () => {
  const w = world();
  const big = JSON.stringify({ v: 1, at: new Date().toISOString(), repo: "repo", dir: w.wt, findings: [], absent: [], readings: { pad: "x".repeat(300 * 1024) } });
  writeFileSync(join(w.dir, "repo.jsonl"), big + "\n");
  assert.equal(exposureChecksFor(w.wt)[0].id, "exposure");
});

test("a stop-accepting on a versioned key removes the stem-matched accept", () => {
  const w = world();
  writeFileSync(w.acc, JSON.stringify({ "A1:left-pad@0.9.0": { reason: "r", at: "2026-10-01", until: { version: "3.0.0" } } }));
  assert.ok(byId(exposureChecksFor(w.wt), "exposure:A1:left-pad@1.0.0").accepted);
  assert.deepEqual(setExposureAccept(w.wt, { id: "exposure:A1:left-pad@1.0.0", accept: false }), { ok: true });
  assert.equal(byId(exposureChecksFor(w.wt), "exposure:A1:left-pad@1.0.0").accepted, undefined);
});
