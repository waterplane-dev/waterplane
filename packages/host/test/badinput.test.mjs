// Untrusted input at both host edges is CHECKED, not cast.
//
// HTTP: a body that is not the JSON its route reads (malformed, truncated, not
// an object, over the cap) is answered 400/413 `{ ok:false, error }` in words by
// `handleApi` — before this it read as `{}` and the phone got a downstream
// refusal about a field that was never really absent. An EMPTY body is not
// malformed: routes whose fields are all optional still take one.
//
// WS: a frame that is not an object with a string `t` is answered with an
// `error` frame, never thrown at `msg.t`; `{"t":"__proto__"}` and friends are
// not routes (own keys only); an unknown `t` stays the versioned no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handleApi } = await import("../dist/api.js");
const { discoverTargets } = await import("../dist/repos.js");
const { readJsonBody, BadBody } = await import("../dist/httpio.js");
const { dispatch } = await import("../dist/routes/index.js");
const { createWsOps } = await import("../dist/server/wsops.js");

const ROOT = mkdtempSync(join(tmpdir(), "wp-badinput-"));
const REPO = join(ROOT, "bad");
mkdirSync(REPO);
execFileSync("git", ["init", "-q", REPO]);
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

async function withApi(fn) {
  const [target] = await discoverTargets(ROOT);
  assert.ok(target, "the scratch repo was not discovered");
  const ctx = {
    root: ROOT,
    sessions: { list: () => [], onHookEvent() {} },
    setup: { stateFor() { return undefined; }, record() {} },
    capture: { run: () => ({ error: "stub capture" }), runsFor: () => [] },
    uiStats: { merge: () => 0 },
  };
  const server = createServer((req, res) => {
    handleApi(req, res, ctx).catch(() => { res.statusCode = 500; res.end("threw"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path.replace("/R/", `/${target.id}/`), {
      method, ...(body != null ? { body, headers: { "content-type": "application/json" } } : {}),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  try { await fn(call); } finally { server.close(); }
}

test("a malformed or truncated body to a mutating route is 400 in words, not a downstream refusal", async () => {
  await withApi(async (call) => {
    for (const body of ['{"paths": ["a.txt"', "not json", "{'paths': []}"]) {
      const r = await call("POST", "/api/repos/R/sweep", body);
      assert.equal(r.status, 400, body);
      assert.equal(r.json?.ok, false);
      assert.match(r.json?.error ?? "", /malformed JSON body/, body);
    }
    // Valid JSON that is not an object is refused the same way, never destructured.
    for (const body of ["null", '"x"', "42"]) {
      const r = await call("POST", "/api/repos/R/git/stage", body);
      assert.equal(r.status, 400, body);
      assert.match(r.json?.error ?? "", /must be a JSON object/, body);
    }
    // A well-formed body still reaches the route's own check.
    const ok = await call("POST", "/api/repos/R/sweep", "{}");
    assert.equal(ok.status, 400);
    assert.equal(ok.json?.error, "paths must be an array of worktree-relative strings");
  });
});

test("an empty body: refused where the route needs one, {} where every field is optional", async () => {
  await withApi(async (call) => {
    const need = await call("POST", "/api/repos/R/sweep");
    assert.equal(need.status, 400);
    assert.match(need.json?.error ?? "", /needs a JSON body/);
    // capture/run: `target` is optional — the stub's own answer proves the route ran.
    const capture = await call("POST", "/api/repos/R/capture/run");
    assert.deepEqual([capture.status, capture.json], [400, { ok: false, error: "stub capture" }]);
    // ui-usage is a fire-and-forget beacon: an empty one is still a 200.
    const usage = await call("POST", "/api/ui-usage");
    assert.deepEqual([usage.status, usage.json], [200, { ok: true, merged: 0 }]);
    // A malformed body to an OPTIONAL route is still malformed.
    const bad = await call("POST", "/api/repos/R/capture/run", "{");
    assert.equal(bad.status, 400);
    assert.match(bad.json?.error ?? "", /malformed JSON body/);
  });
});

test("/api/hook keeps its no-op contract: a garbled body from loopback is still a 204", async () => {
  await withApi(async (call) => {
    for (const body of [undefined, "{", "null"]) {
      const r = await call("POST", "/api/hook", body);
      assert.equal(r.status, 204, String(body));
    }
  });
});

test("readJsonBody: over the cap is a 413 BadBody; within it parses", async () => {
  const big = Readable.from([Buffer.from('{"a":"'), Buffer.alloc(2000, 0x61), Buffer.from('"}')]);
  await assert.rejects(readJsonBody(big, { limit: 1000 }), (e) => e instanceof BadBody && e.status === 413 && /over 1 kB/.test(e.message));
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('{"a":1}')])), { a: 1 });
  assert.deepEqual(await readJsonBody(Readable.from([]), { optional: true }), {});
  assert.equal(await readJsonBody(Readable.from([Buffer.from("7")]), { anyJson: true }), 7);
});

// ── WebSocket ──────────────────────────────────────────────────────

/** A HostCtx whose every member but `attached` throws when touched: a frame that
 *  reaches anything at all is a frame the router should have ignored. */
function trapCtx(ws) {
  const attached = new Map([[ws, new Set()]]);
  return new Proxy({ attached }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "then") return undefined;
      throw new Error(`frame reached ctx.${String(k)}`);
    },
  });
}

test("dispatch: prototype keys are not routes, and an unknown t is a no-op", async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    const ws = {};
    const c = trapCtx(ws);
    for (const t of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__", "no.such.message"]) {
      assert.doesNotThrow(() => dispatch(c, ws, { t }), t);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(rejections, []);
  } finally { process.off("unhandledRejection", onRej); }
});

test("a WS frame that is not an object with a string t is answered with an error frame, never thrown", (t) => {
  const sent = [];
  const handled = [];
  const ctx = {
    ROOT, BOOT_ID: "test", PORT: 0,
    auth: { deviceFor: () => null, needsToken: () => false, isEnabled: () => false, passive: { restricted: () => false } },
    authStateFor: () => ({}),
    socketAuthorized: () => true, // every frame is dispatched here; the revoke/relock drop is clients.test.mjs's subject
    send: (_ws, m) => sent.push(m), broadcast() {},
    clients: new Set(), attached: new Map(), wsKind: new Map(), wsToken: new Map(), wsDevice: new Map(),
    netstats: { noteSocketOpen() {}, noteSocketClose() {} },
    recomputeWatched() {},
    plugins: { streams: { socketGone() {} } }, // a closing socket ends its plugin streams
    handleClientMessage: (_ws, m) => handled.push(m),
  };
  const ops = createWsOps(ctx);
  const wss = new EventEmitter();
  ops.wireWsConnections(wss, { ip: null, tsBin: null, tsDns: null, httpsUrl: null, boundLan: [] });
  const ws = new EventEmitter();
  wss.emit("connection", ws, { headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  // A connection arms the host's liveness ping (`wsops.ts`, every WS_PING_MS); only the socket's
  // close clears it. A fake that never closes leaves it ticking past the test, and the tick that
  // gives up calls a `terminate()` this fake does not have: close it on every path.
  t.after(() => ws.emit("close", 1000));
  sent.length = 0;

  for (const raw of ["null", '"hello"', "42", "[]", "{}", '{"t":7}', "{nope"]) {
    assert.doesNotThrow(() => ws.emit("message", Buffer.from(raw)), raw);
  }
  assert.equal(handled.length, 0, "no malformed frame reached the router");
  assert.equal(sent.length, 7);
  for (const m of sent) assert.deepEqual([m.t, m.context], ["error", "message"]);

  // A well-formed frame — even of a type this host never heard of — is routed.
  ws.emit("message", Buffer.from('{"t":"from.a.newer.client"}'));
  ws.emit("message", Buffer.from('{"t":"__proto__"}'));
  assert.deepEqual(handled.map((m) => m.t), ["from.a.newer.client", "__proto__"]);
  assert.equal(sent.length, 7, "and answered with no error");
});
