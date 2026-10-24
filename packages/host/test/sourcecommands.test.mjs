/**
 * A backend's OWN slash commands (plugin contract 2.2, the `commands` slot), consumed twice:
 *
 *  - `GET /api/slash?cwd=…&backend=<id>` answers `{commands, why?}` from `sources.commands.list`
 *    (`slash.ts`'s `backendSlashCommands`): validated WHOLE by `sourceCommandsProblems`, an empty
 *    list with a sentence where the backend lists none, fails or answers garbage — never claude's
 *    set in its place. No `backend` ⇒ exactly today's claude answer.
 *  - the delivery's no-turn facts (`deliveryCommandFacts`, read by `deliver/deliverrun.ts`): asked
 *    of the SESSION's descriptor (claude's rule unchanged; a plugin's own `delivery.isLocalCommand`
 *    finally consumed), and a listed command's `local` beats the static rule.
 *
 * Fakes only: a registered plugin descriptor with a fake `CommandSource`, the route handler over a
 * fake ctx/res, and `deliverPrompt` over a fake session manager (`deliversubmit.test.mjs`'s shape).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isLocalCommand, startsNoTurn } from "@waterplane/shared";

const { SESSION_ROUTES } = await import("../dist/routes/apisession.js");
const { listSlashCommands, backendSlashCommands, deliveryCommandFacts, forgetBackendCommands } = await import("../dist/slash.js");
const { registerBackend, unregisterBackend, claudeBackend, backendInfos } = await import("../dist/backends/index.js");
const { deliverPrompt } = await import("../dist/deliver.js");

const slashRoute = SESSION_ROUTES.find((e) => e.kind === "route" && e.method === "GET" && e.pattern === "/api/slash");

const LIST = [
  { name: "/peek", description: "Show the plan", local: true },
  { name: "/review", description: "Review the diff", args: "[pr]" },
  { name: "/model", local: false },
];

/** A plugin descriptor: claude's shape, its own id/label, its own delivery rule and command source. */
function acme(id, { list = async () => LIST, isLocal = () => false, slash = "none", commandsFact = true } = {}) {
  return {
    ...claudeBackend, id, label: `Acme ${id}`, plugin: "acme",
    caps: { ...claudeBackend.caps, slash },
    delivery: { ...claudeBackend.delivery, isLocalCommand: isLocal, startsNoTurn: isLocal },
    facts: { ...claudeBackend.facts, ...(commandsFact ? { commands: [{ source: true }] } : {}) },
    sources: { attach: async () => ({}), ...(list ? { commands: { list } } : {}) },
  };
}

const registered = [];
function reg(d) { registerBackend(d); registered.push(d.id); return d; }
afterEach(() => { for (const id of registered.splice(0)) unregisterBackend(id); forgetBackendCommands(); });

/** Run `GET /api/slash?<q>` through the real handler; resolves the JSON body. */
async function getSlash(q) {
  const res = { req: { method: "GET", url: `/api/slash?${q}`, headers: {} }, status: 0, body: null,
    writeHead(s) { this.status = s; return this; }, end(b) { this.body = b; } };
  const url = new URL(`http://h/api/slash?${q}`);
  const ctx = { root: "/tmp/acme-root", containRepoDir: async (d) => d || null };
  assert.equal(await slashRoute.handler({ res, url }, ctx), true);
  assert.equal(res.status, 200, "the sheet's read is always a 200 — the refusal is a sentence in the body");
  return JSON.parse(String(res.body));
}

test("/api/slash with no backend is exactly today's claude answer, no sentence", async () => {
  const doc = await getSlash("cwd=/tmp/acme-repo");
  assert.deepEqual(doc, { commands: listSlashCommands("/tmp/acme-repo") });
  assert.ok(doc.commands.some((c) => c.name === "/compact" && c.source === "builtin"));
});

test("/api/slash?backend= answers that backend's own list: source backend, args, local only when true", async () => {
  reg(acme("acme1"));
  const doc = await getSlash("cwd=/tmp/acme-repo&backend=acme1");
  assert.deepEqual(doc, { commands: [
    { name: "/peek", source: "backend", description: "Show the plan", local: true },
    { name: "/review", source: "backend", description: "Review the diff", args: "[pr]" },
    { name: "/model", source: "backend" },
  ] });
  assert.equal(backendInfos().find((i) => i.id === "acme1").caps.commands, true, "the wire cap the phone gates the sheet on");
});

test("a malformed list is dropped WHOLE, with the sentence — never a partial list, never claude's", async () => {
  reg(acme("acme2", { list: async () => [{ name: "/ok" }, { name: "two words" }] }));
  const doc = await getSlash("cwd=/tmp/acme-repo&backend=acme2");
  assert.deepEqual(doc.commands, []);
  assert.match(doc.why, /^Acme acme2's command list was dropped whole — command 1 is named "two words"/);
  reg(acme("acme2b", { list: async () => [{ name: "/a" }, { name: "/a" }] }));
  assert.match((await getSlash("cwd=/r&backend=acme2b")).why, /\/a is listed twice/);
});

test("null, a throw and an empty list each say why the list is empty", async () => {
  reg(acme("acme3", { list: async () => null }));
  reg(acme("acme4", { list: async () => { throw new Error("socket closed"); } }));
  reg(acme("acme5", { list: async () => [] }));
  assert.deepEqual(await getSlash("cwd=/r&backend=acme3"), { commands: [], why: "Acme acme3 cannot say which commands it has right now" });
  assert.deepEqual(await getSlash("cwd=/r&backend=acme4"), { commands: [], why: "Acme acme4 could not list its commands: socket closed" });
  assert.deepEqual(await getSlash("cwd=/r&backend=acme5"), { commands: [], why: "Acme acme5 lists no slash commands here" });
});

test("a failure is never remembered; a good list is reused, not re-asked", async () => {
  let n = 0, fail = true;
  reg(acme("acme6", { list: async () => { n++; if (fail) throw new Error("not yet"); return LIST; } }));
  assert.equal((await getSlash("cwd=/r&backend=acme6")).commands.length, 0);
  fail = false;
  assert.equal((await getSlash("cwd=/r&backend=acme6")).commands.length, 3, "the next ask succeeds");
  assert.equal((await getSlash("cwd=/r&backend=acme6")).commands.length, 3);
  assert.equal(n, 2, "the good list was kept; the failure was not");
});

test("no commands fact: claude's set where the vocabulary IS claude's, else a sentence; unknown id a sentence", async () => {
  reg(acme("acme7", { list: null, commandsFact: false, slash: "claude" }));
  reg(acme("acme8", { list: null, commandsFact: false }));
  assert.deepEqual(await getSlash("cwd=/tmp/acme-repo&backend=acme7"), { commands: listSlashCommands("/tmp/acme-repo") });
  assert.deepEqual(await getSlash("cwd=/r&backend=acme8"), { commands: [], why: "Acme acme8 does not tell this host its slash commands" });
  const unknown = await getSlash("cwd=/r&backend=nosuch");
  assert.deepEqual(unknown.commands, []);
  assert.match(unknown.why, /nosuch/);
  assert.equal("commands" in backendInfos().find((i) => i.id === "acme8").caps, false, "no source, no wire cap");
});

test("claude pins: the route's claude answer and claude's delivery facts are shared's rule, unchanged", async () => {
  assert.deepEqual(await backendSlashCommands(claudeBackend, "/tmp/acme-repo"), { commands: listSlashCommands("/tmp/acme-repo") },
    "claude has no commands source and a claude vocabulary — its own set");
  for (const t of ["/usage", "/context", "/btw note", "/compact", "/clear", "hello", "/nosuch", "  /model x"]) {
    assert.deepEqual(await deliveryCommandFacts(undefined, "/r", t), { local: isLocalCommand(t), noTurn: startsNoTurn(t) }, t);
    assert.deepEqual(await deliveryCommandFacts("claude", "/r", t), { local: isLocalCommand(t), noTurn: startsNoTurn(t) }, t);
  }
});

test("delivery facts: the session's OWN rule, then the listed command's local; unknown backend neither", async () => {
  reg(acme("acme9", { isLocal: (t) => t.startsWith("/model") }));
  const f = (t) => deliveryCommandFacts("acme9", "/r", t);
  assert.deepEqual(await f("/usage"), { local: false, noTurn: false }, "claude's list is no longer typed at another binary");
  assert.deepEqual(await f("/peek"), { local: true, noTurn: true }, "listed local:true");
  assert.deepEqual(await f("/peek now please"), { local: true, noTurn: true }, "args after the word");
  assert.deepEqual(await f("/model gpt"), { local: false, noTurn: false }, "listed local:false beats the static rule");
  assert.deepEqual(await f("/review 12"), { local: false, noTurn: false }, "listed, local unstated ⇒ the descriptor's rule");
  assert.deepEqual(await deliveryCommandFacts("acme9", undefined, "/peek"), { local: false, noTurn: false }, "no cwd, no list asked");
  assert.deepEqual(await deliveryCommandFacts("gone-backend", "/r", "/usage"), { local: false, noTurn: false });
});

test("delivery facts: a list that fails or is late leaves the descriptor's rule", async () => {
  reg(acme("acme10", { isLocal: (t) => t === "/peek", list: async () => { throw new Error("down"); } }));
  assert.deepEqual(await deliveryCommandFacts("acme10", "/r", "/peek"), { local: true, noTurn: true });
  reg(acme("acme11", { list: () => new Promise(() => {}) }));
  const t0 = Date.now();
  assert.deepEqual(await deliveryCommandFacts("acme11", "/r", "/peek"), { local: false, noTurn: false });
  assert.ok(Date.now() - t0 < 4000, "bounded: a hanging list never holds a delivery");
});

test("a list that never settles is not joined for ever: the next ask asks the source afresh", async () => {
  let calls = 0;
  reg(acme("acme13", { list: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve(LIST)) }));
  assert.deepEqual(await deliveryCommandFacts("acme13", "/r", "/peek"), { local: false, noTurn: false }, "the hung ask is bounded");
  assert.deepEqual(await deliveryCommandFacts("acme13", "/r", "/peek"), { local: true, noTurn: true }, "the second ask reached the source");
  assert.equal(calls, 2);
});

// ── The delivery itself: the no-turn proof (the screen moving) follows the source's `local` ─────

/** A session that never echoes what was typed but DOES redraw (`deliversubmit.test.mjs`'s blind case). */
function blindSession(backend) {
  let frame = 0;
  const state = { returns: 0 };
  const info = { id: "s1", cwd: "/r", running: true, backend, turnActive: false };
  return {
    state,
    get: () => info,
    idleMs: () => 300,
    waitReady: async () => true,
    screenText: async () => `frame ${frame++}`,
    scrollback: () => "",
    recordPrompt: () => {},
    isHooked: () => false,
    stopCount: () => 0,
    geometry: () => ({ cols: 80, rows: 30 }),
    claimSubmittedPrompt: () => false,
    lastSubmittedPrompt: () => null,
    turnFromHook: () => false,
    keepsClaudeLog: () => false,
    getTranscript: () => null,
    noteHookFallback: () => {},
    healthScope: () => false,
    write: (_id, data) => { if (data === "\r") state.returns++; },
  };
}

test("a command the backend lists local:true is proven by the screen moving; unlisted it is an ordinary prompt", async () => {
  reg(acme("acme12"));
  const local = await deliverPrompt(blindSession("acme12"), "s1", "/peek", "command", { watch: false });
  assert.notEqual(local, "unconfirmed", "the source said it starts no turn: a redrawing screen proves it landed");
  const prompt = await deliverPrompt(blindSession("acme12"), "s1", "/review", "command", { watch: false });
  assert.equal(prompt, "unconfirmed", "not local by the list or the rule: no echo, no proof — never retried");
  const claudes = await deliverPrompt(blindSession("acme12"), "s1", "/usage", "command", { watch: false });
  assert.equal(claudes, "unconfirmed", "claude's local list does not vouch for another binary's /usage");
});
