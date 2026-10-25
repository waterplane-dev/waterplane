// scripts/traffic-archive.mjs keeps the GitHub traffic GitHub drops after 14 days. Its file only
// grows and is never rewritten, so what it may write is pinned here: a traffic day only once it is
// over, one row per repo/kind/day (per asset for downloads), and a re-run adds nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "../packages/shared/dist/brand.js";
import { launchdPlist, marketplaceRow, newRows, npmPublishRows, npmRows, playCsvRows, starRows, playListingRow, report, rowsFrom, stateDir } from "../scripts/traffic-archive.mjs";

const NOW = new Date("2026-10-15T20:00:00Z");
const day = (d, count) => ({ timestamp: `${d}T00:00:00Z`, count, uniques: 1 });
const answers = {
  traffic: {
    clones: { clones: [day("2026-10-13", 3), day("2026-10-14", 2), day("2026-10-15", 9)] },
    views: { views: [day("2026-10-14", 5)] },
  },
  releases: [{ tag_name: "v0.1.0", assets: [{ name: "a.tar.gz", download_count: 4 }, { name: "b.apk", download_count: 1 }] }],
};

test("today's traffic is still counting, so it is never written", () => {
  const rows = rowsFrom("o/r", answers, NOW);
  assert.deepEqual(rows.filter((r) => r.kind === "clones").map((r) => r.day), ["2026-10-13", "2026-10-14"]);
  assert.deepEqual(rows.filter((r) => r.kind === "views").map((r) => r.day), ["2026-10-14"]);
});

test("download totals are one row per asset per day", () => {
  const dl = rowsFrom("o/r", answers, NOW).filter((r) => r.kind === "downloads");
  assert.deepEqual(dl.map((r) => [r.day, r.tag, r.asset, r.count]),
    [["2026-10-15", "v0.1.0", "a.tar.gz", 4], ["2026-10-15", "v0.1.0", "b.apk", 1]]);
});

test("a release is one row on the day it went out; a draft has none", () => {
  const rows = rowsFrom("o/r", { traffic: {}, releases: [
    { tag_name: "v0.2.0", published_at: "2026-10-12T08:00:00Z", assets: [] },
    { tag_name: "v0.3.0", draft: true, published_at: null, assets: [] },
  ] }, NOW).filter((r) => r.kind === "release");
  assert.deepEqual(rows.map((r) => [r.day, r.tag]), [["2026-10-12", "v0.2.0"]]);
  assert.deepEqual(newRows(rows.map((r) => JSON.stringify(r)).join("\n"), rows), []);
});

test("a re-run adds nothing; a later day adds only the new rows; a torn line is skipped", () => {
  const first = newRows("", rowsFrom("o/r", answers, NOW));
  const file = first.map((r) => JSON.stringify(r)).join("\n") + "\n{torn\n";
  assert.deepEqual(newRows(file, rowsFrom("o/r", answers, NOW)), []);
  const later = new Date("2026-10-16T09:00:00Z");
  const added = newRows(file, rowsFrom("o/r", answers, later));
  assert.deepEqual(added.map((r) => `${r.kind}:${r.day}${r.asset ? ":" + r.asset : ""}`),
    ["clones:2026-10-15", "downloads:2026-10-16:a.tar.gz", "downloads:2026-10-16:b.apk"]);
});

test("the archive lives in the state dir, outside any repo", () => {
  assert.equal(stateDir({ [`${BRAND.envPrefix}STATE_DIR`]: "/s" }, "/h"), "/s");
  assert.equal(stateDir({ XDG_STATE_HOME: "/x" }, "/h"), `/x/${BRAND.configDirName}`);
  assert.equal(stateDir({}, "/h"), `/h/.local/state/${BRAND.configDirName}`);
});

test("the launchd job runs daily with an explicit PATH (launchd's own has no gh)", () => {
  const p = launchdPlist({ node: "/n/node", script: "/r/s.mjs", out: "/o.jsonl", repos: ["o/r"], exts: ["p.x"], npms: ["pk"], pathEnv: "/gh/bin:/usr/bin", logDir: "/l" });
  assert.doesNotMatch(p, /Weekday/);
  assert.match(p, /<key>Hour<\/key><integer>10<\/integer>/);
  assert.match(p, /<string>--ext<\/string><string>p\.x<\/string>/);
  assert.match(p, /<string>--npm<\/string><string>pk<\/string>/);
  assert.match(p, /<string>\/gh\/bin:\/usr\/bin<\/string>/);
  assert.match(p, /<string>--repo<\/string><string>o\/r<\/string>/);
});

test("a Marketplace reading is one row per extension per day; a missing extension or stat is no row", () => {
  const answer = { results: [{ extensions: [{ statistics: [{ statisticName: "install", value: 3 }, { statisticName: "downloadCount", value: 86 }] }] }] };
  const r = marketplaceRow("p.x", answer, NOW);
  assert.deepEqual([r.kind, r.day, r.installs, r.downloads], ["marketplace", "2026-10-15", 3, 86]);
  assert.deepEqual(newRows(JSON.stringify(r) + "\n", [marketplaceRow("p.x", answer, NOW)]), []);
  assert.equal(marketplaceRow("p.x", { results: [{ extensions: [] }] }, NOW), null);
  assert.equal(marketplaceRow("p.x", { results: [{ extensions: [{ statistics: [] }] }] }, NOW), null);
});

test("the report sums the window and says a total with no older reading is a first reading", () => {
  const rows = [
    ...rowsFrom("o/r", answers, NOW),
    { repo: "p.x", kind: "marketplace", day: "2026-10-01", installs: 1, downloads: 10 },
    { repo: "p.x", kind: "marketplace", day: "2026-10-15", installs: 3, downloads: 86 },
  ];
  const md = report(rows.map((r) => JSON.stringify(r)).join("\n"), NOW, 7);
  assert.match(md, /- Views: 5 /);
  assert.match(md, /- Clones: 5 /);
  assert.match(md, /p\.x \(Marketplace installs\): 3 on 2026-10-15, 86 downloads incl\. updates, \+2 since 2026-10-01/);
  assert.match(md, /a\.tar\.gz \(downloads\): 4 on 2026-10-15, first reading 2026-10-15/);
});

test("npm downloads are one row per finished day, re-runs add nothing, and the report sums them", () => {
  const answer = { downloads: [{ day: "2026-10-13", downloads: 3 }, { day: "2026-10-14", downloads: 0 }, { day: "2026-10-15", downloads: 7 }] };
  const rows = npmRows("pk", answer, NOW);
  assert.deepEqual(rows.map((r) => [r.kind, r.day, r.count]), [["npm", "2026-10-13", 3], ["npm", "2026-10-14", 0]]);
  assert.deepEqual(newRows(rows.map((r) => JSON.stringify(r)).join("\n"), npmRows("pk", answer, NOW)), []);
  const md = report(rows.map((r) => JSON.stringify(r)).join("\n"), NOW, 7);
  assert.match(md, /## npm pk\n\n- Downloads: 3\n- Days with downloads: 2026-10-13 \(3\)/);
});

test("a Play listing's range is read off the page; no public page is a row saying so", () => {
  const html = `<title id="main-title">Tom &amp; Jerry - Apps on Google Play</title><div class="wVqUob"><div class="ClM7O">1.5K+</div><div class="g1rdde">Downloads</div></div>`;
  const r = playListingRow("a.b.c", html, NOW);
  assert.deepEqual([r.kind, r.listed, r.range, r.min, r.name], ["playlisting", true, "1.5K+", 1500, "Tom & Jerry"]);
  const gone = playListingRow("a.b.c", null, NOW);
  assert.deepEqual([gone.listed, gone.range, gone.min], [false, null, null]);
  assert.equal(playListingRow("a.b.c", "<html>no figure</html>", NOW), null);
});

test("a Play installs report is read by header name, UTF-16 or UTF-8, and its last two days wait", () => {
  const csv = [
    "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs",
    "2026-10-10,a.b.c,4,1,0,12,3,1,9",
    "2026-10-12,a.b.c,2,0,0,14,2,0,11",
    "2026-10-14,a.b.c,5,0,0,19,5,0,16",
  ].join("\r\n");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
  for (const buf of [utf16, Buffer.from(csv, "utf8")]) {
    const rows = playCsvRows("a.b.c", buf, NOW);
    assert.deepEqual(rows.map((r) => [r.day, r.installs, r.uninstalls, r.active, r.total]),
      [["2026-10-10", 3, 1, 9, 12], ["2026-10-12", 2, 0, 11, 14]]);
  }
  const old = playCsvRows("a.b.c", Buffer.from("Date,Package Name,Daily Device Installs\n2026-10-01,a.b.c,7"), NOW);
  assert.deepEqual([old[0].installs, old[0].active, old[0].total], [7, null, null]);
  assert.deepEqual(playCsvRows("a.b.c", Buffer.from("nothing,here\n1,2"), NOW), []);
});

test("stars: the history comes from starred_at, today's total from the repo, and a re-run adds nothing", () => {
  const gazers = [{ starred_at: "2026-10-10T08:00:00Z" }, { starred_at: "2026-10-10T09:00:00Z" }, { starred_at: "2026-10-12T01:00:00Z" }, { starred_at: "2026-10-15T10:00:00Z" }];
  const rows = starRows("o/r", { stargazers_count: 3, forks_count: 1, subscribers_count: 2 }, gazers, NOW);
  assert.deepEqual(rows.map((r) => [r.day, r.stars, r.forks]), [["2026-10-10", 2, null], ["2026-10-12", 3, null], ["2026-10-15", 3, 1]]);
  assert.deepEqual(newRows(rows.map((r) => JSON.stringify(r)).join("\n"), starRows("o/r", { stargazers_count: 3 }, gazers, NOW)), []);
});

test("npm publish days are one row per version, two versions on one day kept apart", () => {
  const doc = { time: { created: "2026-10-07T12:15:22Z", modified: "2026-10-24T09:41:32Z", "0.0.0-stage": "2026-10-07T12:15:22Z", "0.0.1": "2026-10-07T12:17:30Z", "0.1.6": "2026-10-24T09:41:31Z" } };
  const rows = npmPublishRows("pk", doc, NOW);
  assert.deepEqual(rows.map((r) => [r.day, r.version]), [["2026-10-07", "0.0.0-stage"], ["2026-10-07", "0.0.1"], ["2026-10-24", "0.1.6"]]);
  assert.equal(newRows("", rows).length, 3);
  assert.deepEqual(newRows(rows.map((r) => JSON.stringify(r)).join("\n"), npmPublishRows("pk", doc, NOW)), []);
});
