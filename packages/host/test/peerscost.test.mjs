/**
 * **What a delegated job cost, read off the peer's own ledger** (`peers/serve.ts`'s
 * `peerJobCostOf`, peer-hosts WP8) — and how the asking side carries it: into its
 * ledger, onto the asking session (`SessionInfo.peerJobs`), into the report's head, and
 * out to the phone (`GET /api/peerjobs`, trusted path only).
 *
 * The fixture is a real conversation log plus a real subagent log, read by `ctxlog.ts`
 * — the same pass the session's own cost chip is drawn from. Every field degrades to
 * ABSENT on its own; nothing here is ever 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_API_VERSION } from "@waterplane/shared";
import { agentUsage, readContextLog } from "../dist/ctxlog.js";
import { PEER_JOB_MARKER, peerJobCostOf, peerJobOriginAt } from "../dist/peers/serve.js";
import { PeerJobs } from "../dist/peers/jobs.js";
import { handlePeerRoutes } from "../dist/peers/routes.js";

const DIR = mkdtempSync(join(tmpdir(), "peerscost-"));
const T0 = Date.parse("2026-09-20T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const rec = (at, id, model, u) => JSON.stringify({
  type: "assistant", timestamp: iso(at), uuid: `u${id}`,
  message: { id, model, role: "assistant", usage: u },
});
const U = (input, read, write, out) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });

/** The doc `getContextSeries` assembles from these two readers (`sessions/ctxseries.ts`). */
function docFrom(log, use) {
  return {
    sessionId: "s", updatedAt: 0, samples: [], events: [], split: log.split,
    ...(log.cost ? { cost: log.cost } : {}),
    ...(log.unpricedTok > 0 ? { unpricedTok: log.unpricedTok } : {}),
    ...(use ? { usageTok: log.usageTok + use.tok, agentTok: use.tok, agentSplit: use.split, ...(use.cost.total > 0 ? { agentCost: use.cost } : {}) } : {}),
    ...(log.model ? { model: log.model } : {}),
    windowTok: null, windowFrom: "unknown", autoCompactTok: null, truncated: false,
  };
}

function fixture() {
  const conv = join(DIR, "conv.jsonl");
  writeFileSync(conv, [
    JSON.stringify({ type: "user", timestamp: iso(T0), message: { role: "user", content: "run the tests" } }),
    rec(T0 + 1000, "m1", "claude-opus-5-20260801", U(10, 20_000, 3_000, 400)),
    rec(T0 + 2000, "m2", "claude-opus-5-20260801", U(5, 23_000, 1_000, 600)),
  ].join("\n") + "\n");
  const sub = join(DIR, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-a.jsonl"), rec(T0 + 1500, "a1", "claude-opus-5", U(2, 9_000, 500, 100)) + "\n");
  return { log: readContextLog(conv), use: agentUsage(sub, null) };
}

test("peerJobCostOf: money and tokens off the ledger, the agents IN, the model an alias", () => {
  const { log, use } = fixture();
  const doc = docFrom(log, use);
  const row = { state: "done", startedAt: T0, settledAt: T0 + 6 * 60_000 };
  const cost = peerJobCostOf(doc, row, T0 + 9e6, null);
  // the four kinds, parent + agent, never merged
  assert.deepEqual(cost.tokens, { in: 17, out: 1_100, cacheRead: 52_000, cacheWrite: 4_500 });
  // the dollars are the ledger's own per-record pricing, parent + agents
  const want = log.cost.total + use.cost.total;
  assert.ok(want > 0);
  assert.equal(cost.usd, want);
  assert.equal(cost.model, "opus-5");
  assert.equal(cost.durationMs, 6 * 60_000);
  assert.equal(cost.weekPct, undefined, "no calibration ⇒ no share, never a guess");
});

test("peerJobCostOf: each field degrades to ABSENT on its own", () => {
  const { log, use } = fixture();
  // the agent directory was not read ⇒ no money and no tokens (a bill missing its agents is worse than none) — the model and duration stand
  const noAgents = peerJobCostOf(docFrom(log, null), { state: "running", startedAt: T0 }, T0 + 120_000, null);
  assert.deepEqual(noAgents, { model: "opus-5", durationMs: 120_000 });
  // nothing readable and never started ⇒ nothing at all
  assert.equal(peerJobCostOf(null, { state: "queued" }, T0, null), undefined);
  // a settled row with no settledAt is not timed off the clock
  assert.equal(peerJobCostOf(null, { state: "failed", startedAt: T0 }, T0 + 1e6, null), undefined);
  // weekPct only off a FRESH weekly calibration
  const doc = docFrom(log, use);
  const fresh = peerJobCostOf(doc, { state: "done", startedAt: T0, settledAt: T0 + 1 }, T0 + 60_000, { checkedAt: T0, sessionUsdPerPct: null, weeklyUsdPerPct: 20 });
  assert.equal(fresh.weekPct, fresh.usd / 20);
  const stale = peerJobCostOf(doc, { state: "done", startedAt: T0, settledAt: T0 + 1 }, T0 + 3_600_000, { checkedAt: T0, sessionUsdPerPct: null, weeklyUsdPerPct: 20 });
  assert.equal(stale.weekPct, undefined);
  // an unpriced model: tokens yes, usd absent (never $0), the unpriced count said
  const conv = join(DIR, "unpriced.jsonl");
  writeFileSync(conv, rec(T0, "x1", "claude-nonesuch-9", U(10, 100, 10, 5)) + "\n");
  const un = peerJobCostOf(docFrom(readContextLog(conv), { tok: 0, split: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0 } }), { state: "done" }, T0, null);
  assert.equal(un.usd, undefined);
  assert.deepEqual(un.tokens, { in: 10, out: 5, cacheRead: 100, cacheWrite: 10 });
  assert.equal(un.unpricedTok, 125);
});

test("peerJobOriginAt: the job worktree's marker says why a session there exists", () => {
  const wt = join(DIR, "wt");
  mkdirSync(join(wt, PEER_JOB_MARKER, ".."), { recursive: true });
  writeFileSync(join(wt, PEER_JOB_MARKER), JSON.stringify({ id: "peer-mac-k1", from: "mac", key: "k1", askerLabel: "repo · fix tests", label: "run e2e" }));
  assert.deepEqual(peerJobOriginAt(wt), { from: "mac", jobId: "peer-mac-k1", askerLabel: "repo · fix tests", label: "run e2e" });
  assert.equal(peerJobOriginAt(DIR), null);
});

// ── the asking side carries it ───────────────────────────────────────────────

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "peerscost-jobs-"));
  const r = { t: 1_000_000, jobs: [], posted: [], intents: new Map() };
  r.getReply = { kind: "ok", body: { id: "peer-pc-k1", state: "running", peerApi: PEER_API_VERSION, version: "x", intentId: "i", sessionId: "ps1", cost: { usd: 0.3, model: "opus-5-5", durationMs: 60_000 } } };
  r.j = new PeerJobs({
    file: join(dir, "peer-jobs.json"),
    store: { outbound: (n) => (n === "pc" ? { name: "pc", addr: "100.64.0.9:8770", token: "tok" } : null) },
    client: {
      hello: async () => ({ kind: "ok", body: { peerApi: PEER_API_VERSION, version: "x", you: "mac" } }),
      postJob: async (_t, body) => { r.lastPost = body; return r.getReply; },
      getJob: async () => r.getReply,
      getArtifact: async () => ({ kind: "rejected", status: 404, text: "no" }),
    },
    now: () => r.t, pollMs: 5000, reportMax: 16000,
    schedule: () => ({ cancel() {} }),
    sessionAlive: () => true,
    setPeerWait: () => {},
    setPeerJobs: (id, list) => r.jobs.push([id, list]),
    intentState: (id) => r.intents.get(id),
    postReport: async (draft) => { r.posted.push(draft); r.intents.set(draft.id, "queued"); return { ok: true, existing: false }; },
    addBacklog: async () => true,
    saveArtifact: () => null,
    notify: () => {},
  });
  return r;
}

test("the asker keeps the CLEANED cost, lists every job on the session, and puts the cost in the report's head", async () => {
  const r = rig();
  r.j.start();
  r.j.submit({ peer: "pc", req: { key: "k1", branch: "b", commit: "a".repeat(40), steps: ["go"], label: "run e2e", askerLabel: "repo · fix" }, cwd: "/r", sessionId: "s1" });
  await r.j.tick();
  assert.equal(r.lastPost.askerLabel, "repo · fix", "the asking session's label rides to the peer");
  let [sid, list] = r.jobs.at(-1);
  assert.equal(sid, "s1");
  assert.deepEqual(list.map((x) => [x.label, x.state, x.cost?.usd]), [["run e2e", "running", 0.3]]);
  // a junk field from the peer is dropped, the rest kept; a later view with no cost keeps the last reading
  r.getReply = { kind: "ok", body: { ...r.getReply.body, cost: { usd: -5, durationMs: 120_000 } } };
  r.t += 5000; await r.j.tick();
  assert.deepEqual(r.j.get("peer-pc-k1").cost, { durationMs: 120_000 });
  r.getReply = { kind: "ok", body: { id: "peer-pc-k1", state: "done", peerApi: 1, version: "x", intentId: "i", sessionId: "ps1",
    cost: { usd: 0.84, model: "opus-5-5", durationMs: 360_000 }, report: { ok: true, text: "green", truncated: false, artifacts: [] } } };
  r.t += 5000; await r.j.tick();
  const rec = r.j.get("peer-pc-k1");
  assert.equal(rec.endedAt, r.t);
  assert.equal(r.posted.length, 1);
  assert.ok(r.posted[0].payload.steps[0].startsWith("[report from peer pc · $0.84 · opus-5-5 · 6 min] The job finished on pc."), r.posted[0].payload.steps[0]);
  // settle the report row: the job closes, the session KEEPS the line (with its cost)
  r.intents.set(r.posted[0].id, "done");
  r.t += 5000; await r.j.tick();
  assert.equal(r.j.get("peer-pc-k1").closed, true);
  [sid, list] = r.jobs.at(-1);
  assert.deepEqual(list.map((x) => [x.state, x.cost?.usd, x.endedAt]), [["done", 0.84, rec.endedAt]]);
  // the phone's ledger: no token, the asking session, both labels
  const led = r.j.ledger()[0];
  assert.equal(led.sessionId, "s1");
  assert.equal(led.askerLabel, "repo · fix");
  assert.equal(led.peerBase, "http://100.64.0.9:8770");
  assert.ok(!JSON.stringify(led).includes("tok\""));
});

test("GET /api/peerjobs: the trusted path only, read-only, empty without a ledger", async () => {
  const sent = [];
  const res = { writeHead(c) { sent.push({ status: c }); return { end() {} }; } };
  const call = async (method, from, jobs) => {
    sent.length = 0;
    await handlePeerRoutes({ method, headers: {}, socket: { remoteAddress: from } }, res, "/api/peerjobs", new URL("http://x/api/peerjobs"), {
      store: {}, canManage: (k) => k === "loopback" || k === "tailscale",
      json: (_r, body, status = 200) => sent.push({ status, body }), readJson: async () => ({}), ...(jobs ? { jobs } : {}),
    });
    return sent.at(-1);
  };
  const rows = [{ peer: "pc", jobId: "j", state: "done", since: 1, cwd: "/r" }];
  assert.deepEqual((await call("GET", "127.0.0.1", () => rows)).body, { ok: true, jobs: rows });
  assert.equal((await call("GET", "192.168.1.9", () => rows)).status, 403);
  assert.equal((await call("POST", "127.0.0.1", () => rows)).status, 405);
});
