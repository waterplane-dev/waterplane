/**
 * The exposure push sweep: the store, seeding on first deploy, remember-before-send, an unreadable
 * store pushing nothing. (The decision itself is `shared/test/exposurepush.test.mjs`.)
 *
 *     node --test packages/host/test/exposurepush.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExposurePush } from "../dist/exposurepush.js";
import { setExposureDir } from "../dist/exposure.js";

const dirs = [];
after(() => { setExposureDir(null); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "exposurepush-")); dirs.push(d); setExposureDir(d); return d; };

const f = (o = {}) => ({ key: "A1:x@1", measure: "A1", subject: "x", version: "1", level: "alert", severity: "high", text: "x is bad", sources: [], ...o });
const series = (findings, o = {}) => () => [{ row: { v: 1, at: "t", repo: "r", dir: "/r", findings, absent: [], readings: {}, ...o }, accepts: null }];

function make(dir, over = {}) {
  const sent = [];
  const w = new ExposurePush({
    notify: (kind, p) => sent.push({ kind, ...p }),
    storePath: () => join(dir, "pushed.json"),
    watched: () => new Set(["/r"]), repoIdFor: async () => "id1",
    series: series([f()]), ...over,
  });
  return { w, sent };
}

test("no store yet: the first sweep seeds and pushes nothing; a NEW finding after that pushes once", async () => {
  const d = tmp();
  const a = make(d);
  await a.w.sweep();
  assert.equal(a.sent.length, 0);
  assert.equal(JSON.parse(readFileSync(join(d, "pushed.json"), "utf8")).keys.length, 1);
  const b = make(d, { series: series([f(), f({ subject: "y", key: "A1:y@1" })]) });
  await b.w.sweep();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].kind, "exposure");
  assert.equal(b.sent[0].level, "attention");
  assert.deepEqual(b.sent[0].open, { to: "setup", repoId: "id1" });
  assert.equal(b.sent[0].key, "exposure:r:A1:y@1");
  await b.w.sweep();
  assert.equal(b.sent.length, 1, "spent for good");
});

test("an unwatched repo (or targets.json unusable) pushes and stores nothing", async () => {
  const d = tmp();
  const a = make(d, { watched: () => new Set() });
  await a.w.sweep();
  const b = make(d, { watched: () => null });
  await b.w.sweep();
  assert.equal(existsSync(join(d, "pushed.json")), false);
  assert.equal(a.sent.length + b.sent.length, 0);
});

test("a store that cannot be used as a store is never answered by re-pushing everything", async () => {
  const d = tmp();
  writeFileSync(join(d, "pushed.json"), "{not json");
  const a = make(d);
  await a.w.sweep(); // corrupt, moved aside by the guard: re-seeds quietly
  assert.equal(a.sent.length, 0);
  assert.ok(readdirSync(d).some((n) => n.startsWith("pushed.json.corrupt-")));
});

test("M1: a clean sweep marks the repo, so the first real alert later is PUSHED", async () => {
  const d = tmp();
  const a = make(d, { series: series([]) });
  await a.w.sweep();
  assert.deepEqual(JSON.parse(readFileSync(join(d, "pushed.json"), "utf8")).repos, ["r"]);
  const b = make(d);
  await b.w.sweep();
  assert.equal(b.sent.length, 1);
});

test("a repo added to the watch late seeds silently, then pushes only new keys; a v1 store reads as keys with no repos", async () => {
  const d = tmp();
  writeFileSync(join(d, "pushed.json"), JSON.stringify({ v: 1, keys: [] }));
  const a = make(d, { series: series([f()], {}) });
  await a.w.sweep();
  assert.equal(a.sent.length, 0);
  const st = JSON.parse(readFileSync(join(d, "pushed.json"), "utf8"));
  assert.equal(st.v, 2);
  assert.deepEqual(st.repos, ["r"]);
  const before = readFileSync(join(d, "pushed.json"), "utf8");
  await a.w.sweep();
  assert.equal(readFileSync(join(d, "pushed.json"), "utf8"), before, "nothing changed: no rewrite");
});

test("an unreadable accepts file pushes nothing and remembers nothing", async () => {
  const d = tmp();
  const a = make(d, { series: () => [{ row: { v: 1, at: "t", repo: "r", dir: "/r", findings: [f()], absent: [], readings: {} }, accepts: null, unreadable: true }] });
  await a.w.sweep();
  assert.equal(a.sent.length, 0);
  assert.equal(existsSync(join(d, "pushed.json")), false);
});

test("a throwing notify leaves the key remembered; the next sweep does not re-push; gone findings are resolved", async () => {
  const d = tmp();
  await make(d, { series: series([]) }).w.sweep();
  let calls = 0;
  const resolved = [];
  const mk = (findings) => new ExposurePush({
    notify: () => { calls++; throw new Error("boom"); },
    storePath: () => join(d, "pushed.json"), watched: () => new Set(["/r"]), repoIdFor: async () => "id1",
    series: series(findings), resolveAttention: (k) => { resolved.push(k); return 0; },
  });
  await mk([f()]).sweep();
  await mk([f()]).sweep();
  assert.equal(calls, 1);
  await mk([]).sweep();
  assert.ok(resolved.includes("exposure:r:A1:x@1"));
});
