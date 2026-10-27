/**
 * Triage marks on exposure / crash findings (`exposure.ts` setExposureTriage, `agentexposure.ts`): validation,
 * clear, an unreadable file is never overwritten, a fixed group stops counting, an agent cannot clear.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const { exposureChecksFor, setExposureTriage, setExposureDir, exposureSeriesAll } = await import("../dist/exposure.js");
const { handleAgentExposure } = await import("../dist/agentexposure.js");

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "expotri-")));
  const wt = join(base, "repo");
  const dir = join(base, "exposure");
  mkdirSync(wt); mkdirSync(dir);
  setExposureDir(dir);
  const f = (key, extra = {}) => ({ key, measure: key.split(":")[0], subject: key.split(":")[1], level: "alert", text: `text of ${key}`, sources: ["x"], ...extra });
  const row = { v: 1, at: new Date().toISOString(), repo: "repo", dir: wt, findings: [f("C1:crashA", { group: "g-1", appVersion: "1.0.0" }), f("C1:crashB", { group: "g-2", appVersion: "1.0.0" }), f("C2:plain", {})], absent: [], readings: {} };
  writeFileSync(join(dir, "repo.jsonl"), JSON.stringify(row) + "\n");
  return { wt, dir, tri: join(dir, "repo.triage.json") };
}
const count = (rows) => rows.find((c) => c.id === "exposure").detail;

test("mark by check id or triage id; validates state, fixedIn, commit, note; id must exist", () => {
  const w = world();
  assert.equal(setExposureTriage(w.wt, { id: "exposure:C1:crashA", state: "investigating", note: "looking" }).ok, true);
  assert.equal(JSON.parse(readFileSync(w.tri, "utf8"))["g-1"].state, "investigating");
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "seen" }).ok, true);
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "bogus" }).ok, false);
  assert.match(setExposureTriage(w.wt, { id: "g-2", state: "fixed" }).error, /fixedIn/);
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "fixed", fixedIn: "1 2" }).ok, false);
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "fixed", fixedIn: "1.2.3", commit: "zz" }).ok, false);
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "fixed", fixedIn: "1.2.3", commit: "abc" }).ok, false, "commit is 7-40 hex, as on the phone");
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "seen", note: "x".repeat(281) }).ok, false);
  assert.equal(setExposureTriage(w.wt, { id: "nope", state: "seen" }).ok, false);
  assert.equal(setExposureTriage(w.wt, { id: "g-2", state: "fixed", fixedIn: "1.2.3", commit: "abc1234" }).ok, true);
});

test("clear removes the entry; clearing nothing is refused", () => {
  const w = world();
  setExposureTriage(w.wt, { id: "g-1", state: "seen" });
  assert.equal(setExposureTriage(w.wt, { id: "g-1", clear: true }).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(w.tri, "utf8")), {});
  assert.equal(setExposureTriage(w.wt, { id: "g-1", clear: true }).ok, false);
});

test("an unreadable triage file is never overwritten, is said on the summary, and skips the push", () => {
  const w = world();
  writeFileSync(w.tri, "{nope");
  const r = setExposureTriage(w.wt, { id: "g-1", state: "seen" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unreadable/);
  assert.equal(readFileSync(w.tri, "utf8"), "{nope");
  assert.match(count(exposureChecksFor(w.wt)), /triage file could not be read/);
  assert.equal(exposureSeriesAll()[0].unreadable, true);
});

test("a fixed group drops out of the count", () => {
  const w = world();
  const before = exposureChecksFor(w.wt).find((c) => c.id === "exposure").detail;
  setExposureTriage(w.wt, { id: "g-1", state: "fixed", fixedIn: "2.0.0" });
  const rows = exposureChecksFor(w.wt);
  assert.notEqual(rows.find((c) => c.id === "exposure").detail, before);
  assert.equal(exposureSeriesAll()[0].triage["g-1"].state, "fixed");
});

const call = async ({ method = "POST", path = "/api/agent/exposure/triage", body, query = "", remote = "127.0.0.1" } = {}) => {
  const out = { refreshed: [] };
  const deps = {
    sessions: { list: () => [{ id: "s1", cwd: body?.dir ?? "/x", title: "repo \u00b7 main", running: true, idle: true }] },
    refresh: (d) => { out.refreshed.push(d); },
    json: (_r, data, status = 200) => { out.data = data; out.status = status; },
    readJson: async () => body,
  };
  out.handled = await handleAgentExposure({ method, headers: {}, socket: { remoteAddress: remote } }, {}, path, new URL(`http://x${path}${query}`), deps);
  return out;
};

test("agent GET lists findings and changes nothing; POST marks with by=agent; clear is 403", async () => {
  const w = world();
  const g = await call({ method: "GET", path: "/api/agent/exposure", query: `?dir=${encodeURIComponent(w.wt)}` });
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.findings.map((f) => f.triageId), ["g-1", "g-2", "C2:plain"]);
  assert.throws(() => readFileSync(w.tri), "GET wrote nothing");
  const miss = await call({ method: "GET", path: "/api/agent/exposure", query: `?dir=${encodeURIComponent(w.wt + "/zz")}` });
  assert.equal(miss.data.findings.length, 0);
  const p = await call({ body: { dir: w.wt, triageId: "g-1", state: "fixed", fixedIn: "1.0.1", commit: "abc1234" } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.refreshed, [w.wt]);
  const by = JSON.parse(readFileSync(w.tri, "utf8"))["g-1"].by;
  assert.deepEqual(by, { kind: "agent", repo: "repo", session: "s1" });
  const c = await call({ body: { dir: w.wt, triageId: "g-1", clear: true } });
  assert.equal(c.status, 403);
  assert.equal(JSON.parse(readFileSync(w.tri, "utf8"))["g-1"].state, "fixed");
  assert.equal((await call({ body: { dir: w.wt, triageId: "nope", state: "seen" } })).status, 400);
  assert.equal((await call({ remote: "100.64.0.1", body: { dir: w.wt, triageId: "g-1", state: "seen" } })).status, 403);
});

test("fixed is refused for a finding with no app version, in the host and on the agent route", async () => {
  const w = world();
  const r = setExposureTriage(w.wt, { id: "C2:plain", state: "fixed", fixedIn: "1.0.0" });
  assert.equal(r.ok, false);
  assert.match(r.error, /fixed needs a crash group with an app version; accept it instead/);
  assert.equal(setExposureTriage(w.wt, { id: "C2:plain", state: "investigating" }).ok, true);
  const p = await call({ body: { dir: w.wt, triageId: "C2:plain", state: "fixed", fixedIn: "1.0.0" } });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /accept it instead/);
});

test("a mark records markedVersion; a fixed mark yields byMark; a stale mark is kept, listed and clearable by id", () => {
  const w = world();
  setExposureTriage(w.wt, { id: "g-1", state: "seen" });
  assert.equal(JSON.parse(readFileSync(w.tri, "utf8"))["g-1"].markedVersion, "1.0.0");
  setExposureTriage(w.wt, { id: "g-2", state: "fixed", fixedIn: "2.0.0" });
  const rows = exposureChecksFor(w.wt);
  assert.equal(rows.find((c) => c.id === "exposure:C1:crashB").accepted.byMark, true);
  // the group leaves the reading
  writeFileSync(join(w.dir, "repo.jsonl"), JSON.stringify({ v: 1, at: new Date().toISOString(), repo: "repo", dir: w.wt, findings: [], absent: [], readings: {} }) + "\n");
  const sum = exposureChecksFor(w.wt).find((c) => c.id === "exposure");
  assert.deepEqual(sum.staleMarks.map((m) => m.triageId).sort(), ["g-1", "g-2"]);
  assert.equal(setExposureTriage(w.wt, { id: "g-1", clear: true }).ok, true);
  assert.equal(setExposureTriage(w.wt, { id: "g-1", state: "seen" }).ok, false, "marking still needs a present finding");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(w.tri, "utf8"))), ["g-2"]);
});

test("a malformed triage entry reads as no mark: checks and the push series survive", () => {
  const w = world();
  writeFileSync(w.tri, JSON.stringify({ "g-1": { state: "seen", at: "x" }, "g-2": { state: "fixed" }, bad: 7 }));
  const rows = exposureChecksFor(w.wt);
  assert.ok(rows.length > 1, "the watch region is not collapsed");
  assert.equal(rows.find((c) => c.id === "exposure:C1:crashA").exposure.triage, undefined);
  assert.deepEqual(exposureSeriesAll()[0].triage, {});
});

test("agent GET: open by default, all=1 adds status and stale marks", async () => {
  const w = world();
  setExposureTriage(w.wt, { id: "g-1", state: "fixed", fixedIn: "2.0.0" });
  writeFileSync(w.tri, JSON.stringify({ ...JSON.parse(readFileSync(w.tri, "utf8")), gone: { state: "seen", at: "2026-10-01T00:00:00Z", by: { kind: "person" } } }));
  const q = encodeURIComponent(w.wt);
  const open = await call({ method: "GET", path: "/api/agent/exposure", query: `?dir=${q}` });
  assert.deepEqual(open.data.findings.map((x) => x.triageId), ["g-2", "C2:plain"]);
  const all = await call({ method: "GET", path: "/api/agent/exposure", query: `?dir=${q}&all=1` });
  assert.equal(all.data.findings.find((x) => x.triageId === "g-1").status, "fixed");
  assert.ok(all.data.findings.find((x) => x.triageId === "g-1").triage);
  assert.deepEqual(all.data.staleMarks.map((m) => m.triageId), ["gone"]);
});

test("agent POST without a resolving session is refused like the follow-up route; by.repo is the session's", async () => {
  const w = world();
  const none = await callWith([], { dir: w.wt, triageId: "g-1", state: "seen" });
  assert.equal(none.status, 404);
  assert.match(none.data.error, /no live session runs in/);
  assert.throws(() => readFileSync(w.tri));
  // A backlog session's title starts "backlog · …": the repo comes from its folder (a worktree's main checkout), not the title.
  const ok = await callWith([{ id: "s9", cwd: `${w.wt}/.claude/worktrees/agent-x`, title: "backlog \u00b7 repo \u00b7 fix it", running: true, idle: true }], { dir: w.wt, session: "s9", triageId: "g-1", state: "seen" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(w.tri, "utf8"))["g-1"].by, { kind: "agent", repo: basename(w.wt), session: "s9" });
});

async function callWith(sessions, body) {
  const out = {};
  const deps = { sessions: { list: () => sessions }, json: (_r, data, status = 200) => { out.data = data; out.status = status; }, readJson: async () => body };
  await handleAgentExposure({ method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } }, {}, "/api/agent/exposure/triage", new URL("http://x/api/agent/exposure/triage"), deps);
  return out;
}
