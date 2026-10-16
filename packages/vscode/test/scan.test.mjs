// The per-file reader the all-sessions store is built from (the host's
// `summarizeLog`, bundled) agrees with the per-session cursor on the fixture:
// one duplicate refused, the <synthetic> rejection skipped, the same split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { data, LOG, pick } from "./helpers.mjs";

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
