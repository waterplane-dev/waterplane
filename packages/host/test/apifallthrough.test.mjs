// The HTTP API's EDGES, answered the same before and after `api.ts` became a
// route table (docs/notes/host-architecture.md, "api.ts — the HTTP routes as
// tables"). Each probe is a request whose answer depends on the ORDER of the
// old if-chain or on what it did NOT check: a wrong method, a trailing slash,
// an extra segment, an unknown repo, a traversal in an inbox name, a name that
// does not decode. The expectations were recorded off the pre-split code
// (`WP_API_PROBE=1 node --test` prints what this host answers) — changing one is
// a behaviour change, named in its commit, never a way to make a split pass.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handleApi } = await import("../dist/api.js");
const { discoverTargets } = await import("../dist/repos.js");

const ROOT = mkdtempSync(join(tmpdir(), "wp-apiedges-"));
const REAL = realpathSync(ROOT);
const REPO = join(ROOT, "edges");
mkdirSync(REPO);
execFileSync("git", ["init", "-q", REPO]);

/** `R` is the test repo's id, substituted in at run time. */
const PROBES = [
  ["GET", "/api/nope"],
  ["POST", "/api/repos"],
  ["POST", "/api/theme"],
  ["GET", "/api/plugin/abc/hook"],
  ["POST", "/api/plugin/abc/hook"],
  ["POST", "/api/plugin/A/hook"],
  ["GET", "/api/tokenstats/nope"],
  ["GET", "/api/tokenstats/"],
  ["POST", "/api/tokenstats/claude"],
  ["GET", "/api/repos/zzz/inbox"],
  ["DELETE", "/api/repos/zzz/whatever"],
  ["GET", "/api/repos/"],
  ["GET", "/api/repos/R"],
  ["GET", "/api/repos/R/bogus"],
  ["PUT", "/api/repos/R/inbox"],
  ["GET", "/api/repos/R/inbox"],
  ["GET", "/api/repos/R/inbox/"],
  ["GET", "/api/repos/R/inbox/..%2Fsecret"],
  ["GET", "/api/repos/R/inbox/a/b"],
  ["GET", "/api/repos/R/inbox/%E0%A4%A"],
  ["PUT", "/api/repos/R/inbox/%E0%A4%A"],
  ["DELETE", "/api/repos/R/inbox"],
  ["DELETE", "/api/repos/R/inbox/..%2Fx"],
  ["GET", "/api/repos/R/repohealth/extra"],
  ["GET", "/api/repos/R/repohealth/"],
  ["GET", "/api/repos/R/tree/x"],
  ["GET", "/api/repos/R/tree/file?path=.env"],
  ["GET", "/api/repos/R/tree/file/extra?path=.env"],
  ["POST", "/api/repos/R/tree/file"],
  ["GET", "/api/repos/R/git/file/extra?path=.env"],
  ["GET", "/api/repos/R/git/nope"],
  ["GET", "/api/repos/R/artifact?path=nope.png&stat=1"],
  ["GET", "/api/repos/R/artifact/extra?path=nope.png&stat=1"],
  ["PUT", "/api/repos/R/artifact?path=nope.png"],
  ["GET", "/api/repos/R/sweep/extra"],
  ["POST", "/api/repos/R/sweep", "{}"],
  ["GET", "/api/repos/R/compliance/x"],
  ["POST", "/api/repos/R/compliance/bogus"],
  ["POST", "/api/repos/R/compliance"],
  ["POST", "/api/repos/R/capture/run/extra", "{}"],
  ["GET", "/api/repos/R/capture/run"],
  ["GET", "/api/repos/R/archive/extra"],
  ["PUT", "/api/repos/R/archive"],
  ["GET", "/api/repos/R/envfiles/x"],
  ["POST", "/api/repos/R/artifacts/seen/x"],
  ["POST", "/api/repos/R/repohealth/scopes/x"],
];

const EXPECT = {
  "GET /api/nope": [404, "{\"error\":\"not found\"}"],
  "POST /api/repos": [404, "{\"error\":\"not found\"}"],
  "POST /api/theme": [404, "{\"error\":\"not found\"}"],
  "GET /api/plugin/abc/hook": [404, "{\"error\":\"not found\"}"],
  "POST /api/plugin/abc/hook": [404, "{\"ok\":false,\"error\":\"this host runs no plugins\"}"],
  "POST /api/plugin/A/hook": [404, "{\"error\":\"not found\"}"],
  "GET /api/tokenstats/nope": [404, "{\"error\":\"no backend called \\\"nope\\\"; this host has: claude, claude-local, claude-endpoint, shell\"}"],
  "GET /api/tokenstats/": [404, "{\"error\":\"no backend called \\\"\\\"; this host has: claude, claude-local, claude-endpoint, shell\"}"],
  "POST /api/tokenstats/claude": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/zzz/inbox": [404, "{\"error\":\"unknown repo\"}"],
  "DELETE /api/repos/zzz/whatever": [404, "{\"error\":\"unknown repo\"}"],
  "GET /api/repos/": [404, "{\"error\":\"unknown repo\"}"],
  "GET /api/repos/R": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/bogus": [404, "{\"error\":\"not found\"}"],
  "PUT /api/repos/R/inbox": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/inbox": [200, "{\"files\":[]}"],
  "GET /api/repos/R/inbox/": [200, "{\"files\":[]}"],
  "GET /api/repos/R/inbox/..%2Fsecret": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/inbox/a/b": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/inbox/%E0%A4%A": [500, "threw"],
  "PUT /api/repos/R/inbox/%E0%A4%A": [500, "threw"],
  "DELETE /api/repos/R/inbox": [404, "{\"error\":\"not found\"}"],
  "DELETE /api/repos/R/inbox/..%2Fx": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/repohealth/extra": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/repohealth/": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/tree/x": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/tree/file?path=.env": [403, "{\"error\":\"this app doesn't display .env files — see the secrets sheet\"}"],
  "GET /api/repos/R/tree/file/extra?path=.env": [403, "{\"error\":\"this app doesn't display .env files — see the secrets sheet\"}"],
  "POST /api/repos/R/tree/file": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/git/file/extra?path=.env": [403, "{\"error\":\"this app doesn't display .env files — see the secrets sheet\"}"],
  "GET /api/repos/R/git/nope": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/artifact?path=nope.png&stat=1": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/artifact/extra?path=nope.png&stat=1": [404, "{\"error\":\"not found\"}"],
  "PUT /api/repos/R/artifact?path=nope.png": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/sweep/extra": [200, "{\"scope\":\"outbox\",\"rows\":[],\"total\":{\"count\":0,\"bytes\":0},\"counts\":{\"7d\":{\"count\":0,\"bytes\":0},\"30d\":{\"count\":0,\"bytes\":0},\"90d\":{\"count\":0,\"bytes\":0},\"365d\":{\"count\":0,\"bytes\":0}}}"],
  "POST /api/repos/R/sweep": [400, "{\"error\":\"paths must be an array of worktree-relative strings\"}"],
  "GET /api/repos/R/compliance/x": [404, "{\"error\":\"not found\"}"],
  "POST /api/repos/R/compliance/bogus": [404, "{\"error\":\"not found\"}"],
  "POST /api/repos/R/compliance": [404, "{\"error\":\"not found\"}"],
  "POST /api/repos/R/capture/run/extra": [400, "{\"ok\":false,\"error\":\"stub capture\"}"],
  "GET /api/repos/R/capture/run": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/archive/extra": [200, "{\"cwd\":\"<root>/edges\",\"total\":0,\"offset\":0,\"rows\":[],\"scanned\":0}"],
  "PUT /api/repos/R/archive": [404, "{\"error\":\"not found\"}"],
  "GET /api/repos/R/envfiles/x": [200, "{\"files\":[]}"],
  "POST /api/repos/R/artifacts/seen/x": [404, "{\"error\":\"not found\"}"],
  "POST /api/repos/R/repohealth/scopes/x": [404, "{\"error\":\"not found\"}"],
};

async function run() {
  const [target] = await discoverTargets(ROOT);
  assert.ok(target, "the scratch repo was not discovered");
  const ctx = {
    root: ROOT,
    sessions: { list: () => [], onHookEvent() {} },
    setup: { stateFor() { return undefined; }, record() {} },
    capture: { run: () => ({ error: "stub capture" }), runsFor: () => [] },
  };
  const server = createServer((req, res) => {
    handleApi(req, res, ctx).catch(() => { res.statusCode = 500; res.end("threw"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = {};
  try {
    for (const [method, raw, body] of PROBES) {
      const path = raw.replace(/\/R(?=\/|$|\?)/, `/${target.id}`);
      const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, ...(body != null ? { body, headers: { "content-type": "application/json" } } : {}),
      });
      out[`${method} ${raw}`] = [r.status, (await r.text()).split(REAL).join("<root>").split(ROOT).join("<root>")];
    }
  } finally { server.close(); }
  return out;
}

test("the API's fall-through edges answer what they always answered", async () => {
  const got = await run();
  if (process.env.WP_API_PROBE === "1") console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, EXPECT);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
