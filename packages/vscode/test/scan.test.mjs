// The per-file reader the all-sessions store is built from (the host's
// `summarizeLog`, bundled) agrees with the per-session cursor on the fixture:
// one duplicate refused, the <synthetic> rejection skipped, the same split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, LOG, pick, tmp } from "./helpers.mjs";

test("summarizeLog dedupes by message.id and skips <synthetic>: 7 records, 1 duplicate → 6", async () => {
  const st = statSync(LOG);
  const sum = await data.summarizeLog(LOG, st.size, Math.round(st.mtimeMs));
  assert.ok(sum, "fixture summarises");
  const tallies = Object.values(sum.x);
  const requests = tallies.reduce((n, t) => n + t[5], 0);
  assert.equal(requests, 6);
  assert.ok(!Object.keys(sum.x).some((k) => k.includes("<synthetic>")), "no synthetic bucket");
  assert.equal(sum.w, "/Users/x/repo");
});

test("summarizeLog totals equal updateContextLog(...).split field for field", async () => {
  const st = statSync(LOG);
  const sum = await data.summarizeLog(LOG, st.size, Math.round(st.mtimeMs));
  const t = [0, 0, 0, 0, 0, 0];
  for (const v of Object.values(sum.x)) for (let i = 0; i < 6; i++) t[i] += v[i];
  const scan = { input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] };
  const cur = data.updateContextLog(LOG, null);
  assert.deepEqual(scan, pick(cur.split));
  assert.equal(cur.usageTok, t[0] + t[1] + t[2] + t[3]);
});

test("store: version 6 is pinned, and the first request `b` survives a save/load round-trip", async () => {
  const st = statSync(LOG);
  const sum = await data.summarizeLog(LOG, st.size, Math.round(st.mtimeMs));
  assert.equal(typeof sum.b, "number", "the fixture log has a first request");
  const file = join(tmp("store6"), "tokenstore.json");
  const a = new data.TokenStore(file);
  a.files.p = { s: sum };
  await a.save();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 6, "a format change must bump this on purpose (one full re-read)");
  const b = new data.TokenStore(file);
  await b.load();
  assert.equal(b.files.p.s.b, sum.b);
  const old = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...old, v: 5 }));
  const c = new data.TokenStore(file);
  await c.load();
  assert.deepEqual(c.files, {}, "another version is discarded and rebuilt");
});
