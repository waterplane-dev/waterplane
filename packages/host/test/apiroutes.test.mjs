// Every METHOD + path the HTTP API answers, pinned as one list — so turning
// `api.ts`'s if-chain into route tables (docs/notes/host-architecture.md,
// "api.ts — the HTTP routes as tables") cannot add, drop or re-verb a route.
//
// Pattern grammar (`routes/apitable.ts`): a literal segment, `:name` = exactly
// one segment, a trailing `*` = zero or more further segments. `*` as the
// METHOD = any. `MOUNT <module>` is a delegating handler with its own dispatch,
// asked in this order. The list is in TABLE order.
//
// Changing ROUTES is a decision about the API, never a way to make a refactor
// pass: a new route is a new line here in the commit that adds it.
import test from "node:test";
import assert from "node:assert/strict";

const ROUTES = [
  "* /api/health",
  "GET /api/theme",
  "* /api/webbundle",
  "* /api/webbundle/file",
  "POST /api/hook",
  // A shell session's `$BROWSER` shim (`backends/shell.ts`) — loopback only, like the hook sink.
  "POST /api/shell/open",
  // Why the next restart is coming (`restartnote.ts`) — loopback only, like the hook sink.
  "POST /api/host/restart-note",
  "POST /api/plugin/:id/hook",
  // A file a plugin offered (`api.offerFile`, plugin API 1.5): bytes, deleted once fetched.
  "GET /api/plugin-file/:id/:token",
  // A plugin's static assets (`manifest.assets`): GET|HEAD, flat names, streamed.
  "* /api/plugin/:id/asset/:file",
  // A plugin's own routes (`api.route`, plugin API 1.2) — added in the commit that added them.
  "* /api/plugin/:id/*",
  "MOUNT peers/routes",
  "MOUNT peers/agentpeer",
  "MOUNT agentintents",
  "MOUNT agentfollowup",
  "MOUNT onboardroutes",
  "GET /api/speedtest/download",
  "POST /api/speedtest/upload",
  "GET /api/speedtest/debug",
  "POST /api/ui-usage",
  "GET /api/ui-usage",
  "DELETE /api/ui-usage",
  "POST /api/netstats",
  "GET /api/netstats",
  "DELETE /api/netstats",
  "GET /api/repos",
  "GET /api/apps/readiness",
  "GET /api/storage/transport",
  "GET /api/storage/host",
  "POST /api/storage/host/clear",
  "GET /api/search",
  "GET /api/transcript",
  "GET /api/scrollback",
  "GET /api/shell",
  "GET /api/transcript/tools",
  "GET /api/context",
  "GET /api/tokenstats",
  "GET /api/localusage",
  "GET /api/tokenstats/:id/*",
  "GET /api/tokenwindows",
  "GET /api/usagelog",
  "GET /api/usagelog/:source",
  "GET /api/usagenow",
  "GET /api/costwindow",
  "GET /api/slash",
  "GET /api/conversations",
  "DELETE /api/conversations",
  "GET /api/external",
  "GET /api/host/root",
  "POST /api/host/root",
  "GET /api/host/setupprefs",
  "POST /api/host/setupprefs",
  // Ask rules (agent-authority §2): PUT needs a browser Origin.
  "GET /api/askrules",
  "PUT /api/askrules",
  "GET /api/host/setup",
  "POST /api/host/setup/fix",
  "GET /api/host/stat",
  "POST /api/host/screenshot",
  "POST /api/host/clipboard",
  "GET /api/host/ocr",
  "POST /api/host/ocr",
  "GET /api/host/dictate",
  "POST /api/host/dictate",
  "GET /api/push/key",
  "POST /api/push/subscribe",
  "POST /api/push/unsubscribe",
  "POST /api/folder",
  "POST /api/repo",
  "POST /api/clone",
  "POST /api/worktree",
  "GET /api/secret/targets",
  "POST /api/secret",
  // The repo scope: resolves the target, then the table below (relative to it).
  "* /api/repos/:id/*",
  "POST /api/repos/:id/archive/bookmark",
  "DELETE /api/repos/:id/archive/bookmark",
  "GET /api/repos/:id/archive/transcript/tools",
  "GET /api/repos/:id/archive/transcript",
  "GET /api/repos/:id/archive/*",
  "DELETE /api/repos/:id/archive/*",
  "POST /api/repos/:id/capture/run/*",
  "GET /api/repos/:id/inbox/*",
  "POST /api/repos/:id/inbox/seen",
  "POST /api/repos/:id/inbox/*",
  "DELETE /api/repos/:id/inbox/*",
  // Not a route: the name is decoded for EVERY verb (a malformed one throws), as it always was.
  "* /api/repos/:id/inbox/*",
  "GET /api/repos/:id/envfiles/*",
  "GET /api/repos/:id/compliance/*",
  "POST /api/repos/:id/compliance/fix/*",
  "POST /api/repos/:id/compliance/limits/*",
  "POST /api/repos/:id/compliance/ignore/*",
  "GET /api/repos/:id/optins/*",
  "POST /api/repos/:id/optins/choice/*",
  "GET /api/repos/:id/repohealth",
  "GET /api/repos/:id/healthindex",
  "POST /api/repos/:id/repohealth/scopes",
  "POST /api/repos/:id/repohealth/refresh",
  "POST /api/repos/:id/artifacts/seen",
  "GET /api/repos/:id/artifacts/*",
  "GET /api/repos/:id/sweep/*",
  "POST /api/repos/:id/sweep/*",
  "GET /api/repos/:id/artifact/*",
  "DELETE /api/repos/:id/artifact/*",
  "GET /api/repos/:id/tree/file/*",
  "PUT /api/repos/:id/tree/file/*",
  "GET /api/repos/:id/tree/*",
  "GET /api/repos/:id/git/status/*",
  "GET /api/repos/:id/git/diff/*",
  "GET /api/repos/:id/git/blob/*",
  "GET /api/repos/:id/git/text/*",
  "GET /api/repos/:id/git/file/*",
  "POST /api/repos/:id/git/stage/*",
  "POST /api/repos/:id/git/commit/*",
  "POST /api/repos/:id/git/message/*",
  "POST /api/repos/:id/git/pull/*",
  "POST /api/repos/:id/git/push/*",
  "GET /api/repos/:id/git/push/*",
  "GET /api/repos/:id/git/log/*",
  "GET /api/repos/:id/git/show/*",
  "POST /api/repos/:id/git/fetch/*",
  "GET /api/repos/:id/git/branches/*",
  "POST /api/repos/:id/git/checkout/*",
  "POST /api/repos/:id/git/branch/*",
  "DELETE /api/repos/:id/git/branch/*",
  "GET /api/repos/:id/worktree/leftover",
  "POST /api/repos/:id/worktree/remove",
];

// ── Against the table ───────────────────────────────────────────────────────
// The list above was checked against the old if-chain's literals in the pin
// commit (988b8a1b); since the split it is checked against the table itself.
const { API_ROUTES, listRoutes } = await import("../dist/routes/apiroutes.js");
const { matchSegs } = await import("../dist/routes/apitable.js");

const sorted = (a) => [...a].sort();
const SCOPE = "/api/repos/:id/";
/** Per `kind` (the segment after the repo id), in order — the only order a repo route's answer depends on. */
const byKind = (list) => {
  const out = {};
  for (const r of list) {
    const p = r.split(" ")[1];
    if (!p?.startsWith(SCOPE)) continue;
    (out[p.slice(SCOPE.length).split("/")[0]] ??= []).push(r);
  }
  return out;
};

test("the table answers exactly the pinned routes", () => {
  assert.deepEqual(sorted(listRoutes()), sorted(ROUTES));
});

test("order where order is behaviour: the mounts, the repo scope last, each repo kind's entries", () => {
  const got = listRoutes();
  assert.deepEqual(got.filter((r) => r.startsWith("MOUNT")), ROUTES.filter((r) => r.startsWith("MOUNT")));
  const top = API_ROUTES.map((e) => (e.kind === "mount" ? `MOUNT ${e.name}` : `${e.method} ${e.pattern}`));
  assert.equal(top.at(-1), "* /api/repos/:id/*", "the repo scope must be the LAST entry: what it does not match is the 404");
  // The mounts sit after the two hook sinks, as they always did.
  assert.ok(top.indexOf("MOUNT peers/routes") > top.indexOf("POST /api/plugin/:id/hook"));
  assert.deepEqual(byKind(got), byKind(ROUTES));
});

test("every route is reachable: its own sample path is first-matched by it", () => {
  const sample = (segs) => segs.filter((s) => s !== "*").map((s) => (s.startsWith(":") ? "x1" : s));
  const check = (table) => {
    const bad = [];
    for (const e of table) {
      if (e.kind === "mount") continue;
      if (e.sub) bad.push(...check(e.sub.table));
      if (e.method === "*") continue;
      const parts = sample(e.segs);
      const first = table.find((o) => o.kind === "route" && (o.method === "*" || o.method === e.method) && matchSegs(o.segs, parts));
      if (first !== e) bad.push(`${e.method} ${e.pattern} is shadowed by ${first?.method} ${first?.pattern}`);
    }
    return bad;
  };
  assert.deepEqual(check(API_ROUTES), []);
});

test("the matcher: literal, :name (one raw segment, empty allowed), trailing * (zero or more)", () => {
  const segs = (p) => p.split("/");
  assert.deepEqual(matchSegs(segs("/api/x"), segs("/api/x")), { params: {}, rest: [] });
  assert.equal(matchSegs(segs("/api/x"), segs("/api/x/")), null);
  assert.equal(matchSegs(segs("/api/x"), segs("/api/y")), null);
  assert.deepEqual(matchSegs(segs("/api/r/:id/*"), segs("/api/r/")), { params: { id: "" }, rest: [] });
  assert.deepEqual(matchSegs(segs("/api/r/:id/*"), segs("/api/r/a%2Fb/c/d")), { params: { id: "a%2Fb" }, rest: ["c", "d"] });
  assert.equal(matchSegs(segs("/api/r/:id/*"), segs("/api/r")), null);
  assert.deepEqual(matchSegs(segs("inbox/*"), ["inbox"]), { params: {}, rest: [] });
  assert.deepEqual(matchSegs(segs("inbox/*"), ["inbox", ""]), { params: {}, rest: [""] });
});
