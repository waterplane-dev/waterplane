/**
 * **An agent flags its own session, without a daemon** (`agentfollowup.ts`).
 * The resolution is pure; the handler is driven with fake sockets and a fake
 * session store. Sets, never clears: no verb or body here removes a flag.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAgentFollowUp, resolveFollowUpSession } from "../dist/agentfollowup.js";

const id = (p) => p;
const S = (over) => ({ id: "a", cwd: "/r/p", title: "A", running: true, idle: true, ...over });

test("by session id when it is live", () => {
  const r = resolveFollowUpSession([S({ id: "a" }), S({ id: "b" })], { session: "b" }, id);
  assert.deepEqual(r, { ok: true, id: "b" });
});

test("a session id that is not live falls back to dir, else refuses", () => {
  assert.equal(resolveFollowUpSession([S()], { session: "zz" }, id).status, 404);
  assert.deepEqual(resolveFollowUpSession([S()], { session: "zz", dir: "/r/p" }, id), { ok: true, id: "a" });
  assert.equal(resolveFollowUpSession([S({ running: false })], { session: "a" }, id).ok, false, "a dead session is not live");
});

test("neither session nor dir is refused with a sentence", () => {
  const r = resolveFollowUpSession([S()], {}, id);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /\$PWD/);
});

test("by dir: the one session in that cwd, from a subdirectory, longest cwd wins", () => {
  assert.deepEqual(resolveFollowUpSession([S()], { dir: "/r/p/packages/x" }, id), { ok: true, id: "a" });
  const nested = [S({ id: "outer", cwd: "/r" }), S({ id: "inner", cwd: "/r/p" })];
  assert.deepEqual(resolveFollowUpSession(nested, { dir: "/r/p/src" }, id), { ok: true, id: "inner" });
  assert.equal(resolveFollowUpSession([S({ cwd: "/r/pp" })], { dir: "/r/p" }, id).ok, false, "a sibling prefix is not a parent");
  assert.equal(resolveFollowUpSession([S()], { dir: "/elsewhere" }, id).status, 404);
});

test("by dir with several sessions: the one mid-turn", () => {
  const two = [S({ id: "a", idle: true }), S({ id: "b", idle: false })];
  assert.deepEqual(resolveFollowUpSession(two, { dir: "/r/p" }, id), { ok: true, id: "b" });
  const hooked = [S({ id: "a", turnActive: false, idle: false }), S({ id: "b", turnActive: true })];
  assert.deepEqual(resolveFollowUpSession(hooked, { dir: "/r/p" }, id), { ok: true, id: "b" }, "the hook's flag beats the silence guess");
});

test("ambiguous: 409 naming every candidate, so the agent can retry with session", () => {
  const none = [S({ id: "a", title: "One" }), S({ id: "b", title: "Two" })];
  const r = resolveFollowUpSession(none, { dir: "/r/p" }, id);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /a \(One\)/);
  assert.match(r.error, /b \(Two\)/);
  assert.match(r.error, /"session"/);
  const both = [S({ id: "a", idle: false }), S({ id: "b", idle: false })];
  assert.match(resolveFollowUpSession(both, { dir: "/r/p" }, id).error, /2 are mid-turn/);
});

// ── The handler ──────────────────────────────────────────────────────────

const call = async ({ remote = "127.0.0.1", headers = {}, method = "POST", path = "/api/agent/followup", body, sessions } = {}) => {
  const set = [];
  const out = {};
  const deps = {
    sessions: { list: () => sessions ?? [S()], setFollowUp: (i, f) => { set.push([i, f]); return true; } },
    json: (_res, data, status = 200) => { out.data = data; out.status = status; },
    readJson: async () => body,
    now: () => 1234,
  };
  const handled = await handleAgentFollowUp({ method, headers, socket: { remoteAddress: remote } }, {}, path, deps);
  return { handled, set, ...out };
};

test("sets an agent flag and answers it", async () => {
  const r = await call({ body: { dir: "/r/p", reason: "  tests\nfail  " } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.set, [["a", { by: "agent", at: 1234, reason: "tests fail" }]]);
  assert.deepEqual(r.data, { ok: true, session: "a", followUp: { by: "agent", at: 1234, reason: "tests fail" } });
});

test("an empty or missing reason is refused and nothing is set", async () => {
  for (const reason of [undefined, "", "   \n "]) {
    const r = await call({ body: { dir: "/r/p", reason } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.set, []);
  }
});

test("not loopback, proxied or a browser is refused; other paths and verbs are not a clear", async () => {
  const b = { dir: "/r/p", reason: "x" };
  assert.equal((await call({ remote: "100.1.2.3", body: b })).status, 403);
  assert.equal((await call({ headers: { "x-forwarded-for": "100.1.2.3" }, body: b })).status, 403);
  assert.equal((await call({ headers: { origin: "http://127.0.0.1:8770" }, body: b })).status, 403);
  const del = await call({ method: "DELETE", body: b });
  assert.equal(del.status, 405);
  assert.deepEqual(del.set, []);
  assert.equal((await call({ path: "/api/agent/intents", body: b })).handled, false);
});

test("an ambiguous folder sets nothing", async () => {
  const r = await call({ body: { dir: "/r/p", reason: "x" }, sessions: [S({ id: "a" }), S({ id: "b" })] });
  assert.equal(r.status, 409);
  assert.deepEqual(r.set, []);
});
