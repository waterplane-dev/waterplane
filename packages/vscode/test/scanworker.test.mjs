// The all-sessions scan as the extension runs it: in a worker thread (dist/scanworker.js), which
// loads, refreshes, saves and folds the store, and posts back only the folded doc — with the
// scan's own stats on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { FIXTURES, data, pick, tmp } from "./helpers.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "scanworker.js");

function runWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: job });
    const progress = [];
    w.on("message", (m) => {
      if (m.t === "progress") progress.push(m);
      else { void w.terminate(); resolve({ msg: m, progress }); }
    });
    w.on("error", reject);
  });
}

test("the worker scans the fixture config dir and posts the same fold the store gives, with its stats", async () => {
  const cacheFile = join(tmp("worker"), "tokenstore.v5.json");
  const { msg, progress } = await runWorker({ configDir: FIXTURES, cacheFile });
  assert.equal(msg.t, "done");
  assert.ok(progress.length >= 1);
  assert.ok(existsSync(cacheFile), "the store is saved");
  const doc = msg.doc;
  assert.ok(doc.logs > 0, "the scan's stats reach the doc");
  assert.ok(doc.scannedAt > 0);

  const store = new data.TokenStore(join(tmp("worker-ref"), "s.json"));
  await store.load();
  await store.refresh(FIXTURES);
  const ref = data.foldCorpus(store.files, Date.now(), store.stats);
  assert.deepEqual(pick(doc.totals), pick(ref.totals));
  assert.ok(Math.abs(doc.cost.total - ref.cost.total) < 1e-9);
  assert.equal(doc.logs, ref.logs);
});

test("the worker, extension and webview bundles carry no process launcher", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["scanworker.js", "extension.js", "webview.js"]) {
    const src = readFileSync(join(dirname(WORKER), f), "utf8");
    assert.ok(!src.includes("child_process"), `${f} bundles child_process`);
  }
});

test("the host's real subagent reader is bundled, with only its meta reader shimmed", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["scanworker.js", "extension.js"]) {
    const src = readFileSync(join(dirname(WORKER), f), "utf8");
    assert.ok(!src.includes("agentlanestub"), `${f} still bundles the v0.1 stub`);
  }
  const ext = readFileSync(join(dirname(WORKER), "extension.js"), "utf8");
  assert.ok(ext.includes("agentCumOf") || ext.includes("subagents"), "extension.js reads the subagents");
});
