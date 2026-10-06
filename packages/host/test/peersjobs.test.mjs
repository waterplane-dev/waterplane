/**
 * **The asking side of a peer job, without a daemon** (`peers/jobs.ts`, `client.ts`, `agentpeer.ts`).
 * The state machine runs over a fake client, a fake clock and a fake intent store; the loopback
 * route over fake requests and a fake git. The e2e (`scripts/e2e-peer.mjs`) is the two-host case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_API_HEADER, PEER_API_VERSION, peerReportId } from "@waterplane/shared";
import { PeerJobs, UNREACHABLE_CEILING_MS } from "../dist/peers/jobs.js";
import { PeerClient } from "../dist/peers/client.js";
import { makePeerAgentHandler, verifyPushed } from "../dist/peers/agentpeer.js";

const SHA = "a".repeat(40);
const REQ = { key: "k1", branch: "feat", commit: SHA, steps: ["run the tests"] };

function rig(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "peerjobs-"));
  const r = {
    file: join(dir, "peer-jobs.json"),
    t: 1_000_000,
    calls: [], waits: [], posted: [], backlog: [], notes: [], saved: [], armed: 0,
    helloReply: { kind: "ok", body: { peerApi: PEER_API_VERSION, version: "x", you: "mac" } },
    postReply: { kind: "ok", body: { id: "peer-pc-k1", state: "running", peerApi: 1, version: "x", intentId: "i", sessionId: "ps1" } },
    getReply: { kind: "ok", body: { id: "peer-pc-k1", state: "running", peerApi: 1, version: "x", intentId: "i", sessionId: "ps1" } },
    artReply: { kind: "ok", body: new TextEncoder().encode("PNG").buffer },
    alive: true, intents: new Map(),
    ...over,
  };
  r.deps = {
    file: r.file,
    store: { outbound: (n) => (n === "pc" ? { name: "pc", addr: "100.64.0.9:8770", token: "tok" } : null) },
    client: {
      hello: async () => { r.calls.push("hello"); return r.helloReply; },
      postJob: async (_t, body) => { r.calls.push("post"); r.lastPost = body; return r.postReply; },
      getJob: async () => { r.calls.push("get"); return r.getReply; },
      getArtifact: async (_t, _id, name) => { r.calls.push(`art:${name}`); return r.artReply; },
    },
    now: () => r.t, pollMs: 5000, reportMax: 16000,
    schedule: () => { r.armed++; return { cancel() {} }; },
    sessionAlive: () => r.alive,
    setPeerWait: (id, w) => r.waits.push([id, w]),
    intentState: (id) => r.intents.get(id),
    postReport: async (draft, peer) => { r.posted.push({ draft, peer }); r.intents.set(draft.id, "queued"); return { ok: true, existing: false }; },
    addBacklog: async (p) => { r.backlog.push(p); return true; },
    saveArtifact: (cwd, peer, name) => { r.saved.push([cwd, peer, name]); return `.claude/outbox/peer-${peer}-${name}`; },
    notify: (title, body, b) => r.notes.push({ title, body, b }),
  };
  r.make = () => new PeerJobs(r.deps);
  return r;
}
const submit = (j, o = {}) => j.submit({ peer: "pc", req: REQ, cwd: "/root/proj", sessionId: "s1", ...o });
const finishView = (over = {}) => ({
  id: "peer-pc-k1", state: "done", peerApi: 1, version: "x", intentId: "i", sessionId: "ps1",
  report: { ok: true, text: "all green", truncated: false, artifacts: [{ name: "out.png", size: 3 }] }, ...over,
});

test("a job is written down, forwarded once, polled, and reported as ONE pinned session row", async () => {
  const r = rig();
  const j = r.make(); j.start();
  const s = submit(j);
  assert.equal(s.ok, true); assert.equal(s.existing, false);
  assert.equal(JSON.parse(readFileSync(r.file, "utf8")).jobs[0].state, "queued", "ledgered before any forward");
  assert.equal(r.waits[0][1].state, "queued");
  await j.tick();
  assert.deepEqual(r.calls, ["hello", "post"]);
  assert.equal(r.lastPost.from, "mac", "the peer's name for us comes from hello");
  assert.equal(j.get("peer-pc-k1").state, "running");
  assert.equal(r.waits.at(-1)[1].peerBase, "http://100.64.0.9:8770");
  assert.equal(r.waits.at(-1)[1].peerSessionId, "ps1");
  r.t += 5000; await j.tick();
  assert.equal(r.calls.at(-1), "get");
  r.getReply = { kind: "ok", body: finishView() };
  r.t += 5000; await j.tick();
  assert.equal(r.posted.length, 1);
  const { draft, peer } = r.posted[0];
  assert.equal(peer, "pc");
  assert.equal(draft.id, peerReportId("pc", "k1"));
  assert.equal(draft.pinned, true);
  assert.deepEqual(draft.target, { kind: "session", sessionId: "s1" });
  assert.match(draft.payload.steps[0], /^\[report from peer pc\]/);
  assert.match(draft.payload.steps[0], /all green/);
  assert.match(draft.payload.steps[0], /- \.claude\/outbox\/peer-pc-out\.png/, "the full transport path");
  assert.deepEqual(r.saved, [["/root/proj", "pc", "out.png"]]);
  assert.equal(r.waits.at(-1)[1].state, "done", "the tag stays until the report row settles");
  assert.equal(j.get("peer-pc-k1").closed, undefined);
  // the ladder delivers the row; the next tick sees it settled and clears the tag
  r.intents.set(draft.id, "done");
  r.t += 5000; await j.tick();
  assert.equal(j.get("peer-pc-k1").closed, true);
  assert.equal(r.waits.at(-1)[1], null);
  // nothing more is asked of anyone, and the report is not posted twice
  const n = r.calls.length;
  r.t += 60000; await j.tick();
  assert.equal(r.calls.length, n); assert.equal(r.posted.length, 1);
});

test("the same key is the same job: nothing is forwarded twice", async () => {
  const r = rig(); const j = r.make(); j.start();
  submit(j); await j.tick();
  const again = submit(j);
  assert.equal(again.existing, true);
  await j.tick();
  assert.equal(r.calls.filter((c) => c === "post").length, 1);
  assert.equal(submit(j, { peer: "nobody", req: { ...REQ, key: "z" } }).ok, false, "an unpaired peer is a sentence");
});

test("an unreachable peer backs off to 60 s and is never failed by this side", async () => {
  const r = rig({ getReply: { kind: "unreachable", error: "ECONNREFUSED" } });
  const j = r.make(); j.start();
  submit(j); await j.tick();                          // posted fine
  const rec = () => j.get("peer-pc-k1");
  for (let i = 0; i < 40; i++) { r.t += 61_000; await j.tick(); }
  assert.equal(rec().state, "unreachable");
  assert.equal(rec().detail, "ECONNREFUSED");
  assert.ok(rec().unreachableSince > 0);
  assert.equal(r.waits.at(-1)[1].state, "unreachable");
  // backoff: just under the ceiling is NOT due, the ceiling is
  const before = r.calls.length;
  r.t += UNREACHABLE_CEILING_MS - 1000; await j.tick();
  assert.equal(r.calls.length, before, "not due yet");
  r.t += 1000; r.getReply = { kind: "ok", body: { id: "peer-pc-k1", state: "running", peerApi: 1, version: "x", intentId: "i" } };
  await j.tick();
  assert.equal(rec().state, "running", "it reconnected");
  assert.equal(rec().unreachableSince, undefined);
});

test("an unreachable peer before the forward keeps the job queued-and-retrying, not failed", async () => {
  const r = rig({ helloReply: { kind: "unreachable", error: "timeout" } });
  const j = r.make(); j.start();
  submit(j); await j.tick();
  assert.equal(j.get("peer-pc-k1").state, "unreachable");
  assert.equal(j.get("peer-pc-k1").sent, undefined);
  r.helloReply = { kind: "ok", body: { peerApi: PEER_API_VERSION, version: "x" } };
  r.t += 61_000; await j.tick();
  assert.equal(j.get("peer-pc-k1").state, "running");
  assert.equal(r.lastPost.from, "pc", "no `you` in hello: our name for it is the fallback");
});

test("a version mismatch (409) is refused with both numbers and nothing is opened; the sentence is the report", async () => {
  const r = rig({ postReply: { kind: "mismatch", text: "pc runs peer API 2, this host 1 — upgrade this host" } });
  const j = r.make(); j.start();
  submit(j); await j.tick();
  const rec = j.get("peer-pc-k1");
  assert.equal(rec.state, "refused");
  assert.match(rec.detail, /peer API 2, this host 1/);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.posted.length, 1);
  assert.match(r.posted[0].draft.payload.steps[0], /was refused on pc[\s\S]*peer API 2, this host 1/);
  // hello on a different API version is refused locally with the shared sentence
  const q = rig({ helloReply: { kind: "ok", body: { peerApi: PEER_API_VERSION + 1, version: "x" } } });
  const k = q.make(); k.start(); submit(k); await k.tick();
  assert.match(k.get("peer-pc-k1").detail, /upgrade this host/);
  assert.equal(q.calls.includes("post"), false);
});

test("the peer's limit state is shown, polled slowly, and not terminal", async () => {
  const r = rig({ postReply: { kind: "ok", body: { id: "peer-pc-k1", state: "limit", peerApi: 1, version: "x", intentId: "i", waiting: "resets at 9:00" } } });
  const j = r.make(); j.start();
  submit(j); await j.tick();
  assert.equal(j.get("peer-pc-k1").state, "limit");
  const n = r.calls.length;
  r.t += 6000; await j.tick();
  assert.equal(r.calls.length, n, "a limit is polled every 30 s, not every 5");
  assert.equal(r.posted.length, 0);
});

test("the asking session gone: a manual backlog row and a notification, never another session", async () => {
  const r = rig({ alive: false, getReply: { kind: "ok", body: finishView({ report: { ok: true, text: "done it", truncated: false, artifacts: [] } }) } });
  const j = r.make(); j.start();
  submit(j); await j.tick();
  r.t += 5000; await j.tick();
  assert.equal(r.posted.length, 0);
  assert.equal(r.backlog.length, 1);
  assert.match(r.backlog[0].label, /the asking session has closed/);
  assert.match(r.backlog[0].text, /done it/);
  assert.equal(r.notes.length, 1);
  assert.equal(j.get("peer-pc-k1").closed, true);
});

test("a report row that fails to deliver falls back to the backlog once", async () => {
  const r = rig({ getReply: { kind: "ok", body: finishView({ report: { ok: true, text: "x", truncated: false, artifacts: [] } }) } });
  const j = r.make(); j.start();
  submit(j); await j.tick(); r.t += 5000; await j.tick();
  r.intents.set(r.posted[0].draft.id, "failed");
  r.t += 5000; await j.tick();
  assert.equal(r.backlog.length, 1);
  assert.equal(j.get("peer-pc-k1").closed, true);
  r.t += 5000; await j.tick();
  assert.equal(r.backlog.length, 1);
});

test("artifacts: over the cap and past the count are named as not fetched, the rest come", async () => {
  const arts = [{ name: "big.zip", size: 9 << 20 }, { name: "ok.txt", size: 3 }];
  const r = rig({ getReply: { kind: "ok", body: finishView({ report: { ok: true, text: "t", truncated: false, artifacts: arts } }) } });
  const j = r.make(); j.start();
  submit(j); await j.tick(); r.t += 5000; await j.tick();
  assert.deepEqual(r.saved.map((s) => s[2]), ["ok.txt"]);
  assert.match(r.posted[0].draft.payload.steps[0], /not fetched: big\.zip: over the 8 MB cap/);
});

test("a restart re-reads the ledger, re-sets the tag and polls again; no open job means no timer", async () => {
  const r = rig();
  const a = r.make(); a.start();
  assert.equal(r.armed, 0, "no job, no timer");
  submit(a); await a.tick();
  r.waits.length = 0; r.calls.length = 0;
  const b = r.make(); b.start();
  assert.equal(r.waits[0][0], "s1"); assert.equal(r.waits[0][1].state, "running");
  assert.ok(r.armed > 0);
  await b.tick();
  assert.deepEqual(r.calls, ["get"], "polls, does not re-forward");
  assert.equal(existsSync(r.file), true);
});

test("DELETE calls it off on this side: no report, tag cleared", async () => {
  const r = rig(); const j = r.make(); j.start();
  submit(j); await j.tick();
  const rec = j.cancel("peer-pc-k1");
  assert.equal(rec.closed, true); assert.equal(rec.state, "failed");
  assert.equal(r.waits.at(-1)[1], null);
  assert.equal(r.posted.length, 0);
});

// ── client ───────────────────────────────────────────────────────────────────

test("the client carries the bearer and the API header, and reads a 409 as a mismatch sentence", async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return { status: 409, ok: false, json: async () => ({ error: "x", peerApi: 3 }), arrayBuffer: async () => new ArrayBuffer(0) }; };
  const c = new PeerClient(f);
  const rep = await c.postJob({ name: "pc", addr: "127.0.0.1:1", token: "tok" }, { key: "k" });
  assert.equal(seen.url, "http://127.0.0.1:1/api/peer/jobs");
  assert.equal(seen.init.headers.authorization, "Bearer tok");
  assert.equal(seen.init.headers[PEER_API_HEADER], String(PEER_API_VERSION));
  assert.ok(seen.init.signal, "has a timeout");
  assert.equal(rep.kind, "mismatch");
  assert.match(rep.text, /peer API 3, this host 1 — upgrade this host/);
});

test("the client: a network error and a 5xx are 'unreachable', a 403 is 'not paired', hello is cached", async () => {
  let n = 0;
  const c = new PeerClient(async () => { n++; throw new Error("ECONNREFUSED"); });
  assert.equal((await c.hello({ name: "pc", addr: "127.0.0.1:1", token: "t" })).kind, "unreachable");
  const c5 = new PeerClient(async () => ({ status: 503, ok: false, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
  assert.equal((await c5.getJob({ name: "pc", addr: "a:1", token: "t" }, "x")).kind, "unreachable");
  const c4 = new PeerClient(async () => ({ status: 403, ok: false, json: async () => ({ error: "not paired" }), arrayBuffer: async () => new ArrayBuffer(0) }));
  assert.equal((await c4.getJob({ name: "pc", addr: "a:1", token: "t" }, "x")).kind, "denied");
  let hits = 0; let now = 0;
  const ch = new PeerClient(async () => { hits++; return { status: 200, ok: true, json: async () => ({ peerApi: 1, version: "v" }), arrayBuffer: async () => new ArrayBuffer(0) }; }, () => now);
  const t = { name: "pc", addr: "a:1", token: "t" };
  await ch.hello(t); await ch.hello(t); assert.equal(hits, 1);
  now = 11 * 60_000; await ch.hello(t); assert.equal(hits, 2);
  assert.equal(n, 1);
});

// ── the loopback route ───────────────────────────────────────────────────────

const fakeReq = (method, body, over = {}) => ({ method, headers: {}, socket: { remoteAddress: "127.0.0.1" }, __body: body, ...over });
function routeRig(over = {}) {
  const submitted = [];
  const jobs = new Map();
  const git = async (_cwd, args) => {
    const a = args.join(" ");
    if (a.startsWith("rev-parse")) return { ok: true, out: SHA };
    if (a.startsWith("ls-remote")) return { ok: true, out: over.tip === null ? "" : `${over.tip ?? SHA}\trefs/heads/feat` };
    if (a.startsWith("merge-base")) return { ok: !!over.ancestor, out: "" };
    if (a === "config --get remote.origin.url") return { ok: true, out: "git@github.com:me/proj.git" };
    return { ok: false, out: "" };
  };
  const h = makePeerAgentHandler({
    jobs: {
      get: (id) => jobs.get(id), list: () => [...jobs.values()], cancel: () => undefined,
      submit: (p) => { submitted.push(p); const rec = { id: `peer-${p.peer}-${p.req.key}`, peer: p.peer, state: "queued", branch: p.req.branch, commit: p.req.commit }; jobs.set(rec.id, rec); return { ok: true, rec, existing: false }; },
    },
    containRepoDir: async (d) => (typeof d === "string" && d.startsWith("/root") ? d : null),
    repoDir: async () => null,
    sessionCwd: (id) => (id === "s1" ? "/root/proj" : null),
    runningSessionFor: () => "s9",
    git,
  });
  const out = {};
  const io = { json: (_res, data, status = 200) => { out.status = status; out.data = data; }, readJson: async (req) => req.__body };
  const call = async (req, path = "/api/agent/peer/pc/intents") => { out.status = undefined; out.handled = await h(req, {}, path, new URL("http://x" + path), io); return out; };
  return { call, submitted, out };
}

test("the route: same gate as the agent route — not loopback, a browser, a proxy are all refused", async () => {
  const r = routeRig();
  assert.equal((await r.call(fakeReq("POST", {}, { socket: { remoteAddress: "100.1.2.3" } }))).status, 403);
  assert.equal((await r.call(fakeReq("POST", {}, { headers: { origin: "http://x" } }))).status, 403);
  assert.equal((await r.call(fakeReq("POST", {}, { headers: { "x-forwarded-for": "1.2.3.4" } }))).status, 403);
  assert.equal(r.submitted.length, 0);
  assert.equal((await r.call(fakeReq("GET"), "/api/agent/intents")).handled, false, "other paths are not this route's");
});

test("the route shares agentBasics' refusals, word for word", async () => {
  const r = routeRig();
  let o = await r.call(fakeReq("POST", { dir: "/root/proj", prompt: "x" }));
  assert.equal(o.status, 400); assert.match(o.data.error, /`key` is required/);
  o = await r.call(fakeReq("POST", { key: "k1", dir: "/root/proj" }));
  assert.match(o.data.error, /`prompt` \(or `steps`/);
  o = await r.call(fakeReq("POST", { key: "k1", prompt: "x" }));
  assert.match(o.data.error, /`repo` .* or `dir` is required/);
  o = await r.call(fakeReq("POST", { key: "k1", prompt: "x", dir: "/etc" }));
  assert.match(o.data.error, /outside the configured root/);
  o = await r.call(fakeReq("POST", { key: "k1", prompt: "x", dir: "/root/proj", session: "nope" }));
  assert.match(o.data.error, /no live session "nope"/);
  assert.equal(r.submitted.length, 0);
});

test("a branch that is not on origin, or a commit past its tip, is a 400 and nothing is forwarded", async () => {
  const body = { key: "k1", prompt: "go", dir: "/root/proj", branch: "feat", commit: SHA };
  let r = routeRig({ tip: null });
  let o = await r.call(fakeReq("POST", body));
  assert.equal(o.status, 400); assert.match(o.data.error, /not on origin; push first/); assert.equal(r.submitted.length, 0);
  r = routeRig({ tip: "b".repeat(40), ancestor: false });
  o = await r.call(fakeReq("POST", body));
  assert.equal(o.status, 400); assert.match(o.data.error, /is not on origin\/feat; push first/);
  r = routeRig({ tip: "b".repeat(40), ancestor: true });
  o = await r.call(fakeReq("POST", body));
  assert.equal(o.status, 200, "an older commit on the pushed branch is fine");
  r = routeRig();
  o = await r.call(fakeReq("POST", { ...body, branch: "--upload-pack=x" }));
  assert.equal(o.status, 400);
});

test("the route answers {ok,id,state,peer,fires,existing}, forwards the remote and the full sha, and a retry is existing", async () => {
  const r = routeRig();
  const body = { key: "k1", prompt: "go", dir: "/root/proj", branch: "feat", commit: "aaaaaaa", closeWhenDone: true, peerDir: "/home/x/proj" };
  let o = await r.call(fakeReq("POST", body));
  assert.equal(o.status, 200);
  assert.deepEqual({ ...o.data, note: undefined }, { ok: true, id: "peer-pc-k1", state: "queued", peer: "pc", existing: false, fires: "sent to pc — waiting", note: undefined });
  const p = r.submitted[0];
  assert.equal(p.req.commit, SHA); assert.equal(p.req.remote, "git@github.com:me/proj.git");
  assert.deepEqual(p.req.steps, ["go"]); assert.equal(p.req.dir, "/home/x/proj"); assert.equal(p.req.closeWhenDone, true);
  assert.equal(p.sessionId, "s9", "the newest live session in that cwd");
  assert.equal(p.cwd, "/root/proj");
  o = await r.call(fakeReq("POST", body));
  assert.equal(o.data.existing, true); assert.equal(r.submitted.length, 1);
  o = await r.call(fakeReq("POST", { ...body, session: "s1", key: "k2" }));
  assert.equal(r.submitted[1].sessionId, "s1", "a named session wins");
  o = await r.call(fakeReq("GET"), "/api/agent/peer/pc/intents/peer-pc-k1");
  assert.equal(o.data.state, "queued");
  o = await r.call(fakeReq("GET"), "/api/agent/peer/other/intents/peer-pc-k1");
  assert.equal(o.status, 404, "a job is read under its own peer only");
});

test("verifyPushed refuses a non-sha and a branch name that is an option", async () => {
  const git = async () => ({ ok: true, out: SHA });
  assert.equal((await verifyPushed("/x", "feat", "zzz", git)).ok, false);
  assert.equal((await verifyPushed("/x", "a..b", SHA, git)).ok, false);
  assert.equal((await verifyPushed("/x", "-x", SHA, git)).ok, false);
});

test("the peer's id for the job is kept and used for every read, whatever it calls us", async () => {
  // We know the peer as "pc"; it knows us as "mac" and names the job peer-mac-k1.
  const view = (o = {}) => ({ id: "peer-mac-k1", state: "running", peerApi: 1, version: "x", intentId: "peer-mac-k1", sessionId: "ps1", ...o });
  const r = rig({ postReply: { kind: "ok", body: view() } });
  const asked = [];
  r.deps.client.getJob = async (_t, id) => { asked.push(["job", id]); return { kind: "ok", body: r.getBody }; };
  r.deps.client.getArtifact = async (_t, id, name) => { asked.push(["art", id, name]); return r.artReply; };
  r.getBody = view();
  const j = r.make(); j.start();
  submit(j); await j.tick();
  assert.equal(j.get("peer-pc-k1").id, "peer-pc-k1", "the local id is unchanged");
  assert.equal(j.get("peer-pc-k1").remoteId, "peer-mac-k1");
  r.t += 5000; await j.tick();
  r.getBody = view({ state: "done", report: { ok: true, text: "ok", truncated: false, artifacts: [{ name: "o.png", size: 3 }] } });
  r.t += 5000; await j.tick();
  assert.deepEqual(asked, [["job", "peer-mac-k1"], ["job", "peer-mac-k1"], ["art", "peer-mac-k1", "o.png"]]);
});

test("a restart resumes polling by the remote id, not the local one", async () => {
  const r = rig({ postReply: { kind: "ok", body: { id: "peer-mac-k1", state: "running", peerApi: 1, version: "x", intentId: "peer-mac-k1" } } });
  const seen = [];
  r.deps.client.getJob = async (_t, id) => { seen.push(id); return { kind: "ok", body: { id, state: "running", peerApi: 1, version: "x", intentId: id } }; };
  const a = r.make(); a.start();
  submit(a); await a.tick();
  const b = r.make(); b.start();
  await b.tick();
  assert.deepEqual(seen, ["peer-mac-k1"]);
});

test("a refused or failed POST answer is terminal and its sentence is the report; no polling follows", async () => {
  for (const state of ["refused", "failed"]) {
    const r = rig({ postReply: { kind: "ok", body: { id: "peer-mac-k1", state, peerApi: 1, version: "x", intentId: "peer-mac-k1", detail: "no clone of x/y under this host's root" } } });
    const j = r.make(); j.start();
    submit(j); await j.tick();
    assert.equal(j.get("peer-pc-k1").state, state);
    assert.equal(r.posted.length, 1, state);
    assert.match(r.posted[0].draft.payload.steps[0], /no clone of x\/y under this host's root/);
    r.t += 60_000; await j.tick();
    assert.equal(r.calls.filter((c) => c === "get").length, 0, "never polled");
  }
});
