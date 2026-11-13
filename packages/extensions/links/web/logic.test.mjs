/**
 * The links sheet's words and cuts (`logic.ts`, read straight off the TypeScript): one repo cut for
 * the chip and the list, pinned rows kept out of "found", hidden rows counted not dropped.
 *
 *     node --test packages/extensions/links/web/logic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { byRepo, discoveryLine, foundCut, inRepo, localWords, matching, probeWords, sharedEnv, shortUrl } from "./logic.ts";

const ago = (ts) => `@${ts}`;
const f = (o) => ({ key: "local:1", kind: "local", repo: "a", label: "x", url: null, env: "dev", hidden: false, ...o });
const state = (o = {}) => ({ pinned: [], found: [], localAt: null, cloudAt: null, discovering: { local: false, cloud: false }, notes: [], file: "/x", ...o });

test("the repo cut is the same for chip and list", () => {
  const rows = [{ repo: "a" }, { repo: "b" }, { repo: null }, { repo: "a" }];
  assert.equal(inRepo(rows, { repo: "a" }).length, 2);
  assert.equal(inRepo(rows, null).length, 4);
});

test("groups sort by name with the repo-less group last", () => {
  const g = byRepo([{ repo: null }, { repo: "b" }, { repo: "a" }]);
  assert.deepEqual(g.map(([r]) => r), ["a", "b", null]);
});

test("found leaves out what is pinned and counts what is hidden", () => {
  const s = state({
    pinned: [{ id: "p:000000000000", repo: "a", label: "x", env: "dev", from: "local:1", openUrl: null, probe: null }],
    found: [f({ key: "local:1" }), f({ key: "local:2" }), f({ key: "run:p/x", repo: "a", hidden: true }), f({ key: "local:3", repo: "b" })],
  });
  const c = foundCut(s, { repo: "a" }, false);
  assert.deepEqual(c.shown.map((x) => x.key), ["local:2"]);
  assert.equal(c.hidden, 1);
  assert.equal(c.total, 2);
  assert.equal(foundCut(s, { repo: "a" }, true).shown.length, 2);
});

test("probe words say a sign-in wall is up, and why something is down", () => {
  assert.equal(probeWords(null, ago).text, "not checked yet");
  assert.match(probeWords({ at: 5, state: "up", status: 403, ms: 80 }, ago).text, /^up \(403, sign-in\) · 80 ms/);
  assert.match(probeWords({ at: 5, state: "down", error: "ECONNREFUSED" }, ago).text, /down — ECONNREFUSED/);
  assert.match(probeWords({ at: 5, state: "down", status: 502 }, ago).text, /HTTP 502/);
});

test("a local pin says whether its port listens", () => {
  assert.equal(localWords({ port: 5180, listening: false }), "nothing listens on :5180 right now");
  assert.equal(localWords({ port: 5180, listening: true }), ":5180 on this desktop");
  assert.equal(localWords({ url: "https://x" }), null);
});

test("the discovery line says each half's age or that it is running", () => {
  assert.equal(discoveryLine(state({ localAt: 1, discovering: { local: false, cloud: true } }), ago), "this desktop: @1 · cloud: looking now…");
});

test("search: every word must appear in some field, blank keeps every row", () => {
  const rows = [
    f({ key: "local:5180", label: "node :5180", port: 5180, repo: "notes-app", url: "https://desk.ts.net:8780" }),
    f({ key: "run:p/api", kind: "cloudrun", label: "api", repo: "shopfront", project: "shopfront-123456", env: "prod", url: "https://api-x.run.app" }),
  ];
  assert.equal(matching(rows, "").length, 2);
  assert.deepEqual(matching(rows, "NOTES").map((r) => r.key), ["local:5180"]);
  assert.deepEqual(matching(rows, ":5180").map((r) => r.key), ["local:5180"]);
  assert.deepEqual(matching(rows, "cloud run prod").map((r) => r.key), ["run:p/api"]);
  assert.deepEqual(matching(rows, "shop 123456").map((r) => r.key), ["run:p/api"]);
  assert.equal(matching(rows, "shop notes").length, 0);
});

test("the chip filters: one cut for the count and the list, up/down empties found", async () => {
  const { cutBoth, groupRows, groupTally, NO_FACETS } = await import("./logic.ts");
  const pins = [
    { repo: "a", env: "prod", probe: { at: 1, state: "down" } },
    { repo: "a", env: "dev", port: 5180, probe: { at: 1, state: "up" } },
    { repo: null, env: "prod", probe: null },
  ];
  const found = [f({ env: "prod" }), f({ env: "dev", port: 3000 })];
  const prod = cutBoth(pins, found, { ...NO_FACETS, env: "prod" });
  assert.equal(prod.n, prod.pins.length + prod.found.length);
  assert.equal(prod.n, 3);
  assert.equal(cutBoth(pins, found, { ...NO_FACETS, where: "here" }).n, 2);
  const down = cutBoth(pins, found, { ...NO_FACETS, health: "down" });
  assert.deepEqual([down.pins.length, down.found.length], [1, 0]);
  assert.equal(cutBoth(pins, found, { ...NO_FACETS, health: "unchecked" }).n, 1);
  assert.deepEqual(groupRows(pins, "env").map((g) => g.title), ["prod", "dev"]);
  assert.deepEqual(groupRows(pins, "where").map((g) => g.title), ["this desktop", "hosted"]);
  assert.deepEqual(groupRows(pins, "repo").map((g) => g.title), ["a", "no repo"]);
  assert.equal(groupTally(pins, true), "3 · 1 down");
  assert.equal(groupTally(found, false), "2");
});

test("the repo chip: pins first, else found-and-not-hidden, else none", async () => {
  const { repoChipCount } = await import("./logic.ts");
  const pin = { id: "p:000000000000", repo: "a", label: "x", env: "dev", openUrl: null, probe: null };
  const s = state({ pinned: [pin], found: [f({ key: "local:2", repo: "a" }), f({ key: "local:3", repo: "b" }), f({ key: "local:4", repo: "b", hidden: true })] });
  assert.deepEqual([repoChipCount(s, "a").n, repoChipCount(s, "a").label], [1, "links"]);
  assert.deepEqual([repoChipCount(s, "b").n, repoChipCount(s, "b").label], [1, "found"]);
  assert.equal(repoChipCount(s, "c"), null);
});

test("a row's address drops the scheme, www and closing slash, and keeps path and query", () => {
  assert.equal(shortUrl("https://waterplane.dev/"), "waterplane.dev");
  assert.equal(shortUrl("https://www.npmjs.com/package/waterplane"), "npmjs.com/package/waterplane");
  assert.equal(shortUrl("http://a.b:8790/x?id=1"), "a.b:8790/x?id=1");
});

test("a group's env is said once only when every row shares it", () => {
  assert.equal(sharedEnv([{ env: "prod" }, { env: "prod" }]), "prod");
  assert.equal(sharedEnv([{ env: "prod" }, { env: "dev" }]), null);
  assert.equal(sharedEnv([]), null);
});
