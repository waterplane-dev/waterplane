import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_RUNS, SLUG, WINDOW, flakyRate, parseRuns } from "./flakyrate.mjs";

const run = (flaky) => ({ at: "2026-11-09T00:00:00Z", scripts: 100, failed: flaky, flaky });

test("the slug matches the brand, so the file is where run-e2e writes it", () => {
  assert.match(readFileSync(new URL("../packages/shared/src/brand.ts", import.meta.url), "utf8"), new RegExp(`slug: "${SLUG}"`));
});
test("rate is the share of runs with a flake", () => {
  const runs = [...Array(8).fill(0), 2, 1].map(run);
  assert.equal(flakyRate(runs), 20);
});
test("too few runs is no rate, not 0", () => {
  assert.equal(flakyRate(Array(MIN_RUNS - 1).fill(0).map(run)), null);
});
test("only the last WINDOW runs count", () => {
  const runs = [...Array(10).fill(1), ...Array(WINDOW).fill(0)].map(run);
  assert.equal(flakyRate(runs), 0);
});
test("torn and foreign lines are skipped", () => {
  assert.equal(parseRuns('{"flaky":1}\nnot json\n{"x":1}\n{"flaky":0}\n').length, 2);
});
test("the script prints the number, and is absent (exit 1, reason) with no file or too few runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "flakyrate-"));
  const file = join(dir, "runs.jsonl");
  const go = () => spawnSync("node", [new URL("./flakyrate.mjs", import.meta.url).pathname], { env: { ...process.env, E2E_RUNS_FILE: file }, encoding: "utf8" });
  let r = go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no run history/);
  writeFileSync(file, [1, 0, 0].map((f) => JSON.stringify(run(f))).join("\n") + "\n");
  r = go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only 3 logged runs/);
  writeFileSync(file, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((f) => JSON.stringify(run(f))).join("\n") + "\n");
  r = go();
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "10");
});
