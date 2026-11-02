/**
 * **An agent runs a build BUTTON, without a daemon** (`agentbuild.ts`).
 * Driven with fake sockets and a fake build manager: buttons only (never a free
 * command), a key makes the run once-only, and the caller gate is every agent
 * route's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAgentBuilds, agentBuildEntry } from "../dist/agentbuild.js";

const ENTRIES = [
  { id: "apk", name: "Debug APK", cmd: "./gradlew assembleDebug", dir: "android" },
  { id: "flav", name: "Flavor", cmd: "./gradlew assemble{{f}}", params: [{ id: "f", kind: "choice", options: ["Dev", "Prod"], default: "Dev", optionsCmd: "ls" }] },
];

const call = async ({ method = "POST", path = "/api/agent/builds/run", body = {}, query = "", headers = {}, remote = "127.0.0.1", entries = ENTRIES } = {}) => {
  const runs = [];
  const out = {};
  const deps = {
    builds: {
      list: () => entries,
      run: (dir, id, params, opts) => { runs.push({ dir, id, params, opts }); return id === "flav" && !params?.f ? { error: "needs a value" } : { runId: opts.id, name: "Debug APK" }; },
    },
    containRepoDir: async (d) => (typeof d === "string" && d.startsWith("/r/") ? "/r/p" : null),
    repoDir: async (id) => (id === "p" ? "/r/p" : null),
    json: (_res, data, status = 200) => { out.data = data; out.status = status; },
    readJson: async () => body,
  };
  const url = new URL(`http://x${path}${query}`);
  const handled = await handleAgentBuilds({ method, headers, socket: { remoteAddress: remote } }, {}, path, url, deps);
  return { handled, runs, ...out };
};

test("runs a listed button with the key as the run id", async () => {
  const r = await call({ body: { dir: "/r/p", id: "apk", key: "ship-1" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.runs, [{ dir: "/r/p", id: "apk", params: undefined, opts: { id: "agent-build-ship-1" } }]);
  assert.equal(r.data.runId, "agent-build-ship-1");
  assert.match(r.data.note, /outbox/);
});

test("an id that is not a button is refused and nothing runs", async () => {
  const r = await call({ body: { dir: "/r/p", id: "rm -rf", key: "k" } });
  assert.equal(r.status, 404);
  assert.deepEqual(r.runs, []);
});

test("no key, a bad key, no id or no dir is refused with a sentence", async () => {
  for (const body of [{ dir: "/r/p", id: "apk" }, { dir: "/r/p", id: "apk", key: "a b" }, { dir: "/r/p", key: "k" }, { id: "apk", key: "k" }]) {
    const r = await call({ body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.data.error, "string");
    assert.deepEqual(r.runs, []);
  }
});

test("a dir outside the root and an unknown repo id are refused", async () => {
  assert.equal((await call({ body: { dir: "/etc", id: "apk", key: "k" } })).status, 400);
  assert.equal((await call({ body: { repo: "zz", id: "apk", key: "k" } })).status, 404);
  assert.equal((await call({ body: { repo: "p", id: "apk", key: "k" } })).status, 200);
});

test("params pass through as strings only; run()'s own refusal is relayed", async () => {
  const ok = await call({ body: { dir: "/r/p", id: "flav", key: "k", params: { f: "Prod", n: 3 } } });
  assert.deepEqual(ok.runs[0].params, { f: "Prod" });
  const no = await call({ body: { dir: "/r/p", id: "flav", key: "k" } });
  assert.equal(no.status, 400);
  assert.equal(no.data.error, "needs a value");
});

test("GET lists the buttons without the approval-gated optionsCmd, and says what to do when there are none", async () => {
  const r = await call({ method: "GET", path: "/api/agent/builds", query: "?dir=/r/p" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.builds[1], { id: "flav", name: "Flavor", cmd: "./gradlew assemble{{f}}", params: [{ id: "f", options: ["Dev", "Prod"], default: "Dev" }] });
  const none = await call({ method: "GET", path: "/api/agent/builds", query: "?dir=/r/p", entries: [] });
  assert.match(none.data.note, /builds\.json/);
  assert.deepEqual(agentBuildEntry(ENTRIES[0]), ENTRIES[0]);
});

test("not loopback, proxied or a browser is refused; other paths are not mine", async () => {
  const b = { dir: "/r/p", id: "apk", key: "k" };
  assert.equal((await call({ body: b, remote: "100.64.0.2" })).status, 403);
  assert.equal((await call({ body: b, headers: { "x-forwarded-for": "1.2.3.4" } })).status, 403);
  assert.equal((await call({ body: b, headers: { origin: "http://127.0.0.1:8770" } })).status, 403);
  assert.equal((await call({ path: "/api/agent/buildsx" })).handled, false);
  assert.equal((await call({ method: "GET", body: b })).status, 405);
});
