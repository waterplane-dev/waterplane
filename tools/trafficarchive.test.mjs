// scripts/traffic-archive.mjs keeps the GitHub traffic GitHub drops after 14 days. Its file only
// grows and is never rewritten, so what it may write is pinned here: a traffic day only once it is
// over, one row per repo/kind/day (per asset for downloads), and a re-run adds nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "../packages/shared/dist/brand.js";
import { launchdPlist, newRows, rowsFrom, stateDir } from "../scripts/traffic-archive.mjs";

const NOW = new Date("2026-10-15T20:00:00Z");
const day = (d, count) => ({ timestamp: `${d}T00:00:00Z`, count, uniques: 1 });
const answers = {
  traffic: {
    clones: { clones: [day("2026-10-13", 3), day("2026-10-14", 2), day("2026-10-15", 9)] },
    views: { views: [day("2026-10-14", 5)] },
  },
  releases: [{ tag_name: "v0.1.0", assets: [{ name: "a.tgz", download_count: 4 }, { name: "b.apk", download_count: 1 }] }],
};

test("today's traffic is still counting, so it is never written", () => {
  const rows = rowsFrom("o/r", answers, NOW);
  assert.deepEqual(rows.filter((r) => r.kind === "clones").map((r) => r.day), ["2026-10-13", "2026-10-14"]);
  assert.deepEqual(rows.filter((r) => r.kind === "views").map((r) => r.day), ["2026-10-14"]);
});

test("download totals are one row per asset per day", () => {
  const dl = rowsFrom("o/r", answers, NOW).filter((r) => r.kind === "downloads");
  assert.deepEqual(dl.map((r) => [r.day, r.tag, r.asset, r.count]),
    [["2026-10-15", "v0.1.0", "a.tgz", 4], ["2026-10-15", "v0.1.0", "b.apk", 1]]);
});

test("a re-run adds nothing; a later day adds only the new rows; a torn line is skipped", () => {
  const first = newRows("", rowsFrom("o/r", answers, NOW));
  const file = first.map((r) => JSON.stringify(r)).join("\n") + "\n{torn\n";
  assert.deepEqual(newRows(file, rowsFrom("o/r", answers, NOW)), []);
  const later = new Date("2026-10-16T09:00:00Z");
  const added = newRows(file, rowsFrom("o/r", answers, later));
  assert.deepEqual(added.map((r) => `${r.kind}:${r.day}${r.asset ? ":" + r.asset : ""}`),
    ["clones:2026-10-15", "downloads:2026-10-16:a.tgz", "downloads:2026-10-16:b.apk"]);
});

test("the archive lives in the state dir, outside any repo", () => {
  assert.equal(stateDir({ [`${BRAND.envPrefix}STATE_DIR`]: "/s" }, "/h"), "/s");
  assert.equal(stateDir({ XDG_STATE_HOME: "/x" }, "/h"), `/x/${BRAND.configDirName}`);
  assert.equal(stateDir({}, "/h"), `/h/.local/state/${BRAND.configDirName}`);
});

test("the launchd job runs weekly with an explicit PATH (launchd's own has no gh)", () => {
  const p = launchdPlist({ node: "/n/node", script: "/r/s.mjs", out: "/o.jsonl", repos: ["o/r"], pathEnv: "/gh/bin:/usr/bin", logDir: "/l" });
  assert.match(p, /<key>Weekday<\/key><integer>1<\/integer>/);
  assert.match(p, /<string>\/gh\/bin:\/usr\/bin<\/string>/);
  assert.match(p, /<string>--repo<\/string><string>o\/r<\/string>/);
});
