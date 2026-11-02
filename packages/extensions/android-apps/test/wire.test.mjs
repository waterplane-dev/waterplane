// The android-apps wire: chunking against the plugin channel's caps and the trimmed log reply. The pure
// install-log rules (moved here from core's shared/installlog.ts, deleted in P5) are in rules.test.mjs.
//
//     node --test packages/extensions/android-apps/test/wire.test.mjs   (after the host build)
import { test } from "node:test";
import assert from "node:assert/strict";

const D = "../../../host/dist/extensions/android-apps";
const W = await import(`${D}/shared/wire.mjs`);
const M = await import("../../../shared/dist/plugin/manifest.js");

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const long = (c, n) => c.repeat(n);
const maxRow = (i) => ({
  pullId: `p${i}${long("x", 126)}`.slice(0, 128), pkg: `${long("k", 120)}.${i}`.slice(0, 128),
  label: long("L", 200), version: long("v", 200), code: 123456, file: long("f", 200), repo: long("r", 200),
  outcome: "failed", error: long("e", 500), auto: false, at: 1_700_000_000_000 + i,
});
const reporter = { id: long("d", 200), name: long("n", 200), model: long("m", 200) };
const NOW = 1_700_000_100_000;
const ring = (n, dev = reporter) => Array.from({ length: n }, (_, i) => W.cleanInstallEntry(maxRow(i), dev, NOW + i));

test("the caps this extension is built to are the plugin channel's", () => {
  assert.equal(W.PLUGIN_BYTES_MAX, M.PLUGIN_ARGS_MAX);
  assert.equal(W.PLUGIN_BYTES_MAX, M.PLUGIN_PUSH_MAX);
  assert.equal(W.CALL_RESULT_BYTES_MAX, 512 * 1024);
  assert.ok(W.CHUNK_BYTES_MAX < W.PLUGIN_BYTES_MAX && W.LOG_REPLY_BYTES_MAX < W.CALL_RESULT_BYTES_MAX);
});

test("the caps core's copy had are the ones this extension keeps", () => {
  assert.equal(W.INSTALL_LOG_CAP, 500);
  assert.equal(W.MAX_REPORT_ENTRIES, 300);
  assert.equal(W.installKey("a:b", "c", 1) === W.installKey("a", "b:c", 1), false);
  const row = { id: "l1", install: "installed", pkg: "p.q", installedAt: 5 };
  const got = W.installReportFrom([row, { ...row, install: "asked" }, { ...row, pkg: "" }]);
  assert.equal(got.length, 1, "only the terminal row that names its app is reported");
  assert.equal(got[0].pkg, "p.q");
});

test("300 max-size entries report in chunks each under the cap and merge to the ring one whole report makes", () => {
  const entries = Array.from({ length: 300 }, (_, i) => maxRow(i));
  const chunks = W.chunkReport(reporter, entries);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.entries.length <= W.CHUNK_ENTRIES_MAX, `entries ${c.entries.length}`);
    assert.ok(bytes(c) <= W.CHUNK_BYTES_MAX, `bytes ${bytes(c)}`);
    assert.ok(bytes({ plugin: "android-apps", method: "report", args: c, ackId: "x".repeat(64) }) < W.PLUGIN_BYTES_MAX);
  }
  assert.equal(chunks.reduce((n, c) => n + c.entries.length, 0), 300, "nothing lost");
  // the real store stamps Date.now() PER CHUNK, so each chunk gets its own reportedAt here too
  const clean = (list, now = NOW) => list.map((r) => W.cleanInstallEntry(r, reporter, now)).filter(Boolean);
  const whole = W.mergeInstallLog([], clean(entries)).entries;
  let ringed = [];
  chunks.forEach((c, i) => { ringed = W.mergeInstallLog(ringed, clean(c.entries, NOW + i * 1000)).entries; });
  const keys = (l) => l.map((e) => e.key).sort();
  assert.deepEqual(keys(ringed), keys(whole), "same keys (reportedAt differs per chunk, as in the real store; under the 500 ring nothing is evicted)");
  // idempotent: the same chunks again, and in reverse, change nothing
  let again = ringed;
  for (const c of [...chunks].reverse()) again = W.mergeInstallLog(again, clean(c.entries, NOW + 99_000)).entries;
  assert.deepEqual(keys(again), keys(whole));
});

test("an oversize device is clipped in words, not turned into zero chunks", () => {
  const big = { id: long("i", 60_000), name: long("n", 60_000), model: long("m", 60_000) };
  const chunks = W.chunkReport(big, [{ pullId: "p", pkg: "a.b", outcome: "installed", at: 1 }]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].device.id.length, 128);
  assert.equal(chunks[0].device.name.length, 120);
  assert.ok(bytes(chunks[0]) <= W.CHUNK_BYTES_MAX);
});

test("small entries chunk by the 100-entry cap", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ pullId: `p${i}`, pkg: "a.b", outcome: "installed", at: i + 1 }));
  assert.deepEqual(W.chunkReport({ id: "d" }, rows).map((c) => c.entries.length), [100, 100, 50]);
  assert.deepEqual(W.chunkReport({ id: "d" }, []), []);
});

test("a full 500-entry max-size doc is trimmed oldest-first under 480 KB and says what the host holds", () => {
  const full = W.mergeInstallLog([], ring(500)).entries;
  assert.equal(full.length, 500);
  const whole = { entries: full, devices: W.installDevices(full), total: 500 };
  const doc = W.trimLogDoc(full, 500);
  assert.ok(bytes(doc) <= W.LOG_REPLY_BYTES_MAX, `doc ${bytes(doc)}`);
  assert.ok(bytes(doc) < W.CALL_RESULT_BYTES_MAX);
  assert.equal(doc.total, 500, "total is the held count, not the sent count");
  assert.ok(doc.entries.length < 500 || bytes(whole) <= W.LOG_REPLY_BYTES_MAX);
  assert.deepEqual(doc.entries, full.slice(0, doc.entries.length), "the OLD end was cut");
  assert.equal(W.trimLogDoc(full.slice(0, 3)).entries.length, 3, "a small log is untouched");
});

test("the changed push is a ping far under the push cap", () => {
  assert.ok(bytes({ n: 500, at: Date.now() }) < 100 && bytes({ n: 500, at: Date.now() }) < W.PLUGIN_BYTES_MAX);
});
