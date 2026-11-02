// Max-size ring pins for the install log (docs/notes/android-apps-architecture.md sections 4 and 7, P0;
// moved here from packages/shared/test when P5 deleted core's copy). The log's transport is the generic
// plugin channel, whose caps are 64 KB (args, push) and 512 KB (a call's result). These pins say how big the
// worst-case report and doc are against those caps, so the chunked report and trimmed doc are built to a
// measured size. A pin changes only with a decision about the caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INSTALL_LOG_CAP, MAX_REPORT_ENTRIES, cleanInstallEntry, entryAt, installDevices, mergeInstallLog,
} from "../../../host/dist/extensions/android-apps/shared/wire.mjs";
import { PLUGIN_ARGS_MAX, PLUGIN_PUSH_MAX } from "../../../shared/dist/plugin/manifest.js";

const KB = 1024;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const long = (c, n) => c.repeat(n);
/** A report row whose every string is at its cap, so its serialized size is the worst a phone can send. */
const maxRow = (i) => ({
  pullId: `p${i}${long("x", 126)}`.slice(0, 128),
  pkg: `${long("k", 120)}.${i}`.slice(0, 128),
  label: long("L", 200),
  version: long("v", 200),
  code: 123456,
  file: long("f", 200),
  repo: long("r", 200),
  outcome: "failed",
  error: long("e", 500),
  auto: false,
  at: 1_700_000_000_000 + i,
});
const reporter = { id: long("d", 200), name: long("n", 200), model: long("m", 200) };
const NOW = 1_700_000_100_000;

test("the caps the plugin channel will carry are the recorded ones", () => {
  assert.equal(PLUGIN_ARGS_MAX, 64 * KB);
  assert.equal(PLUGIN_PUSH_MAX, 64 * KB);
  assert.match(read("../../../host/src/plugins/pluginregistry.ts"), /const CALL_RESULT_MAX = 512 \* 1024;/);
  assert.equal(INSTALL_LOG_CAP, 500);
  assert.equal(MAX_REPORT_ENTRIES, 300);
});

test("a max-size row is clipped to the entry limits", () => {
  const e = cleanInstallEntry(maxRow(1), reporter, NOW);
  assert.ok(e);
  assert.equal(e.label.length, 120);
  assert.equal(e.error.length, 300);
  assert.equal(e.deviceName.length, 120);
  assert.equal(e.deviceId.length, 128);
});

/** The chunker the extension is specified to use: at most 100 entries and 48 KB serialized per call, whichever first. */
function chunks(rows, maxN = 100, maxBytes = 48 * KB) {
  const out = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && (cur.length >= maxN || bytes({ device: reporter, entries: [...cur, r] }) > maxBytes)) { out.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

test("300 max-size report rows are over one call's args cap; 48 KB chunks fit and merge to the same ring", () => {
  const rows = Array.from({ length: MAX_REPORT_ENTRIES }, (_, i) => maxRow(i));
  const size = bytes({ device: reporter, entries: rows });
  assert.ok(size > PLUGIN_ARGS_MAX, `300 max-size rows are ${size} B, expected over ${PLUGIN_ARGS_MAX}`);
  const parts = chunks(rows);
  assert.ok(parts.length > 1);
  for (const c of parts) assert.ok(bytes({ device: reporter, entries: c }) <= 48 * KB && c.length <= 100);
  assert.equal(parts.flat().length, rows.length);
  const clean = (rs) => rs.map((r) => cleanInstallEntry(r, reporter, NOW));
  const whole = mergeInstallLog([], clean(rows)).entries;
  let ring = [];
  for (const c of parts) ring = mergeInstallLog(ring, clean(c)).entries;
  assert.deepEqual(ring, whole, "chunked reports merge to the ring one whole report makes");
  // A repeated chunk is harmless (at-most-once is not needed: the merge is a union by key).
  assert.deepEqual(mergeInstallLog(ring, clean(parts[0])).entries, whole);
});

test("a full max-size doc is over a call's 512 KB today, so the extension must trim oldest-first under 480 KB", () => {
  const entries = Array.from({ length: INSTALL_LOG_CAP + 50 }, (_, i) => cleanInstallEntry(maxRow(i), reporter, NOW));
  const ring = mergeInstallLog([], entries).entries;
  assert.equal(ring.length, INSTALL_LOG_CAP, "the ring keeps 500");
  const docOf = (es) => ({ entries: es, devices: installDevices(es), total: es.length });
  const size = bytes(docOf(ring));
  assert.ok(size > 512 * KB, `recorded: a full max-size doc is ${size} B, over the 512 KB result cap`);
  assert.ok(size > PLUGIN_PUSH_MAX, "a whole-doc push could never fit PLUGIN_PUSH_MAX: the push has to be a ping");
  // The trim rule: drop oldest (by entryAt, the ring's own order) until under 480 KB; the newest survive.
  let kept = [...ring].sort((a, b) => entryAt(b) - entryAt(a));
  while (kept.length && bytes(docOf(kept)) >= 480 * KB) kept.pop();
  assert.ok(kept.length > 100 && kept.length < ring.length);
  assert.ok(bytes(docOf(kept)) < 480 * KB);
  assert.equal(entryAt(kept[0]), Math.max(...ring.map(entryAt)));
  assert.ok(bytes({ n: ring.length, at: NOW }) < KB, "the ping that replaces the push is tiny");
});

test("a plugin push over the cap is an error STRING, not a throw", () => {
  // pluginapi.ts returns the refusal; a caller that ignores the return value never hears it.
  const src = read("../../../host/src/plugins/pluginapi.ts");
  assert.match(src, /if \(bytes > PLUGIN_PUSH_MAX\) return `the data is/);
});
