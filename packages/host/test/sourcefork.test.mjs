/**
 * `sources.conversations.fork(id, atTurn)` CONSUMED (plugin contract 2.2, gap C4, review R3).
 *
 * The phone's request is the existing one — `session.create` with `resumeSessionId` = the backend's
 * own conversation id and `forkAtTurn` = a turn id from its transcript (`useLaunch.ts`'s
 * `runForkRequest`). For a backend whose source forks, `routes/session.ts` asks the source
 * (`convfork.ts`'s `forkViaSource`) where claude's jsonl would be copied: before any kill, a failure
 * refused in words with NOTHING launched, the new id resumed PLAINLY under the SAME backend. The wire
 * `fork` cap turns true for such a backend in the same change (`derive.ts`); claude's file copy and
 * a server-forking backend's `forkVia: "server"` stay as they were.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { sessionRoutes } = await import("../dist/routes/session.js");
const { forkViaSource } = await import("../dist/convfork.js");
const { derive } = await import("../dist/backends/derive.js");
const { registerBackend, unregisterBackend, claudeBackend, backendInfos, forkAtTurnRefusal } = await import("../dist/backends/index.js");

/** A plugin descriptor (claude's shape, no claude log) whose conversations come from its source. */
function acme(id, convs, extra = {}) {
  return {
    ...claudeBackend, id, label: `Acme ${id}`, plugin: "acme", forkVia: undefined,
    facts: { ...claudeBackend.facts, transcript: [], conversations: [{ source: true }] },
    sources: { attach: async () => ({}), conversations: { list: async () => [], ...convs } },
    ...extra,
  };
}
const registered = [];
function reg(d) { registerBackend(d); registered.push(d.id); return d; }
afterEach(() => { for (const id of registered.splice(0)) unregisterBackend(id); });

/** `session.create` over a fake ctx: what was spawned, killed and said. */
async function create(msg) {
  const created = [], killed = [], toasts = [];
  const a = {
    dir: "/tmp/acme-repo",
    msg: { t: "session.create", cwd: "/tmp/acme-repo", ...msg },
    ws: {}, att: { add: () => {} },
    c: {
      sessions: { create: async (cwd, opts) => { created.push(opts); return { id: "s-new" }; }, kill: (id) => killed.push(id), get: () => ({ id: "s-old" }) },
      intents: { post: () => ({ ok: false }) },
      recomputeWatched: () => {}, startPrompt: () => {},
      send: (_ws, m) => { if (m.t === "toast") toasts.push(m.text); },
    },
  };
  const res = await sessionRoutes["session.create"].run(a);
  return { res, created, killed, toasts };
}

test("forkViaSource: the source's new id, or a sentence naming the backend — never the same id back", async () => {
  const calls = [];
  const b = (fork) => ({ label: "Acme", sources: { conversations: { list: async () => [], fork } } });
  assert.deepEqual(await forkViaSource(b(async (id, at) => { calls.push([id, at]); return { id: "ses_cut" }; }), "ses_src", "turn-7"), { newId: "ses_cut" });
  assert.deepEqual(calls, [["ses_src", "turn-7"]], "the turn id is handed over untouched");
  assert.deepEqual(await forkViaSource(b(async () => { throw new Error("busy"); }), "ses_src", "t"), { error: "Acme could not fork it: busy" });
  assert.deepEqual(await forkViaSource(b(async () => null), "ses_src", "t"), { error: "Acme did not fork it — nothing was opened" });
  assert.match((await forkViaSource(b(async () => ({ id: "ses_src" })), "ses_src", "t")).error, /same conversation, not a fork/);
  assert.match((await forkViaSource(b(async () => ({ id: "../x" })), "ses_src", "t")).error, /no usable conversation id/);
  assert.match((await forkViaSource(b(async () => ({})), "ses_src", "t")).error, /no usable conversation id/);
  assert.match((await forkViaSource(b(() => new Promise(() => {})), "ses_src", "t", 30)).error, /did not fork it in time/);
  assert.deepEqual(await forkViaSource({ label: "Acme", sources: { conversations: { list: async () => [] } } }, "s", "t"), { error: "Acme cannot fork a conversation" });
  assert.deepEqual(await forkViaSource(b(async () => ({ id: "x" })), "../etc", "t"), { error: "bad id" });
});

test("the phone's fork request: fork(id, atTurn), then the NEW id resumed plainly under the SAME backend", async () => {
  const calls = [];
  reg(acme("acmefk", { fork: async (id, at) => { calls.push([id, at]); return { id: "ses_cut" }; } }));
  const { res, created, killed } = await create({
    title: "x (before #3)", resumeMode: "fork", resumeSessionId: "ses_src", forkAtTurn: "msg_42",
    launch: { backend: "acmefk", model: "m" },
  });
  assert.deepEqual(res, { ok: true, sessionId: "s-new" });
  assert.deepEqual(calls, [["ses_src", "msg_42"]]);
  assert.equal(created.length, 1);
  assert.equal(created[0].resumeSessionId, "ses_cut", "the fork, not the source");
  assert.equal(created[0].resumeMode, "continue", "resumed plainly — the fork is already its own conversation");
  assert.equal(created[0].forkAtTurn, undefined, "the turn was the source's business, not the launch's");
  assert.deepEqual(created[0].launch, { backend: "acmefk", model: "m" }, "the same backend and flags");
  assert.equal(created[0].origin.kind, "fork");
  assert.deepEqual(killed, []);
});

test("a failed fork is refused in words: nothing launched, nothing killed (reset included)", async () => {
  reg(acme("acmefail", { fork: async () => { throw new Error("server gone"); } }));
  const { res, created, killed, toasts } = await create({
    resumeMode: "fork", resumeSessionId: "ses_src", forkAtTurn: "msg_1", replaceSessionId: "s-old",
    launch: { backend: "acmefail" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "Acme acmefail could not fork it: server gone");
  assert.deepEqual(toasts, ["could not fork this conversation: Acme acmefail could not fork it: server gone"]);
  assert.deepEqual(created, [], "no session opened");
  assert.deepEqual(killed, [], "the reset's session is left exactly where it was");
});

test("wire fork: true only where the source has fork(); the refusal lifts for exactly those", () => {
  reg(acme("acmeyes", { fork: async () => ({ id: "n" }) }));
  reg(acme("acmeno", {}));
  const caps = (id) => backendInfos().find((i) => i.id === id).caps;
  assert.equal(caps("acmeyes").fork, true);
  assert.equal(caps("acmeno").fork, false);
  assert.equal(forkAtTurnRefusal("acmeyes"), null);
  assert.match(forkAtTurnRefusal("acmeno"), /^Acme acmeno .*cannot be cut at a turn/);
  // A `fork` slot whose fact is not listed as a source is not asked, so it is not a fork either.
  assert.equal(derive({ ...acme("x", { fork: async () => null }), facts: {} }).wireCaps().fork, false);
});

test("claude and a backend's server fork are untouched: claude's caps, and forkVia server never calls the source", async () => {
  assert.equal(backendInfos().find((i) => i.id === "claude").caps.fork, true);
  assert.equal(derive(claudeBackend).sourceForks, false);
  assert.equal(forkAtTurnRefusal("claude"), null);
  let asked = 0;
  reg(acme("acmesrv", { fork: async () => { asked++; return { id: "never" }; } }, { forkVia: "server" }));
  const { res, created } = await create({ resumeMode: "fork", resumeSessionId: "ses_src", forkAtTurn: "msg_9", launch: { backend: "acmesrv" } });
  assert.equal(res.ok, true);
  assert.equal(asked, 0, "the server forks it itself, as before");
  assert.equal(created[0].resumeMode, "fork");
  assert.equal(created[0].forkAtTurn, "msg_9");
  assert.equal(created[0].resumeSessionId, "ses_src");
});
