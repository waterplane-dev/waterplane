// Which exposure findings earn a push (`shared/src/exposurepush.ts`): seeding, dedupe forever,
// accepts, digest, unwatched, the cap of three.
import test from "node:test";
import assert from "node:assert/strict";
import { exposurePushes, exposurePushKey, NOTIFICATION_KINDS, notifyEnabled, notifyLevel } from "../dist/index.js";

const NOW = "2026-10-26T12:00:00Z";
const f = (o = {}) => ({ key: "A1:x@1.0.0", measure: "A1", subject: "x", version: "1.0.0", level: "alert", severity: "high", text: "x is bad", sources: [], ...o });
const row = (findings, o = {}) => ({ v: 1, at: NOW, repo: "r", dir: "/r", findings, absent: [], readings: {}, ...o });
const ser = (findings, o = {}, accepts = null) => [{ row: row(findings, o), accepts }];
const all = () => true;
const St = (keys = [], repos = ['r']) => ({ keys: new Set(keys), repos: new Set(repos) });

test("the kind is registered, default on", () => {
  assert.ok(NOTIFICATION_KINDS.includes("exposure"));
  assert.equal(notifyEnabled(undefined, "exposure"), true);
  assert.equal(notifyLevel("exposure"), "info");
});

test("a new open alert pushes once; its key is remembered", () => {
  const p = exposurePushes(ser([f()]), all, St(), NOW);
  assert.equal(p.push.length, 1);
  assert.equal(p.push[0].attention, true);
  assert.equal(p.push[0].body, "x is bad");
  assert.deepEqual(p.remember, [exposurePushKey("r", f())]);
});

test("pushed once FOREVER: a remembered key never pushes again, whatever happened in between", () => {
  const seen = new Set([exposurePushKey("r", f())]);
  assert.equal(exposurePushes(ser([f()]), all, St([...seen]), NOW).push.length, 0);
  // a new version is a new finding
  assert.equal(exposurePushes(ser([f({ version: "1.0.1" })]), all, St([...seen]), NOW).push.length, 1);
});

test("seeding is per repo: firstRun, a repo not yet marked (late add, no store) remember and push nothing", () => {
  const a = exposurePushes(ser([f(), f({ subject: "y", key: "A1:y@1.0.0" })], { firstRun: true }), all, St(), NOW);
  assert.equal(a.push.length, 0);
  assert.equal(a.remember.length, 2);
  // not firstRun, but never seen as watched: still silent, and marked
  const b = exposurePushes(ser([f()]), all, St([], []), NOW);
  assert.equal(b.push.length, 0);
  assert.equal(b.remember.length, 1);
  assert.deepEqual(b.seenRepos, ["r"]);
  // M1: a zero-alert sweep marks the repo, so the first real alert later PUSHES
  const quiet = exposurePushes(ser([]), all, St([], []), NOW);
  assert.deepEqual(quiet.seenRepos, ["r"]);
  assert.equal(exposurePushes(ser([f()]), all, St([], quiet.seenRepos), NOW).push.length, 1);
});

test("seeding remembers only keys not already remembered", () => {
  const k = exposurePushKey("r", f());
  assert.deepEqual(exposurePushes(ser([f()], { firstRun: true }), all, St([k]), NOW).remember, []);
});

test("an unreadable accepts file: nothing pushed, remembered or resolved for that repo", () => {
  const p = exposurePushes([{ row: row([f()]), accepts: null, unreadable: true }], all, St(), NOW);
  assert.deepEqual(p, { push: [], remember: [], seenRepos: [], resolve: [] });
});

test("two advisories on one package@version are two pushes", () => {
  const a = f({ key: "adv:GHSA-1:x", version: "1.0.0" }), b = f({ key: "adv:GHSA-2:x", version: "1.0.0" });
  assert.notEqual(exposurePushKey("r", a), exposurePushKey("r", b));
  assert.equal(exposurePushes(ser([a, b]), all, St([exposurePushKey("r", a)]), NOW).push.length, 1);
});

test("pushes carry attention keys; a finding no longer open (or a clean repo) is resolved", () => {
  const p = exposurePushes(ser([f()]), all, St(), NOW);
  assert.equal(p.push[0].key, "exposure:r:A1:x@1.0.0");
  const gone = exposurePushes(ser([]), all, St([exposurePushKey("r", f())]), NOW);
  assert.deepEqual(gone.resolve.sort(), ["exposure:r", "exposure:r:A1:x@1.0.0"]);
});

test("an accepted finding is not pushed; a digest finding is neither pushed nor remembered", () => {
  const acc = { "A1:x@1.0.0": { reason: "ok", at: "2026-10-01" } };
  assert.equal(exposurePushes(ser([f()], {}, acc), all, St(), NOW).push.length, 0);
  const d = exposurePushes(ser([f({ level: "digest" })]), all, St(), NOW);
  assert.equal(d.push.length, 0);
  assert.equal(d.remember.length, 0);
});

test("an unwatched dir is skipped entirely", () => {
  const p = exposurePushes(ser([f()]), () => false, St(), NOW);
  assert.deepEqual(p, { push: [], remember: [], seenRepos: [], resolve: [] });
});

test("severity: critical/high are attention, the rest information", () => {
  const p = exposurePushes(ser([f({ severity: "low" })]), all, St(), NOW);
  assert.equal(p.push[0].attention, false);
});

test("three findings are three pushes; four are ONE, and all four are remembered", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => f({ key: `A1:p${i}@1`, subject: `p${i}`, version: "1" }));
  const three = exposurePushes(ser(mk(3)), all, St(), NOW);
  assert.equal(three.push.length, 3);
  const four = exposurePushes(ser(mk(4)), all, St(), NOW);
  assert.equal(four.push.length, 1);
  assert.equal(four.push[0].title, "4 new exposure findings in r");
  assert.equal(four.remember.length, 4);
});
