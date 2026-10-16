/**
 * The kept readings of every source other than claude (`usagesourcelog.ts`) — `usagelog.ts`'s
 * rules per source file: a reading with nothing to say is DROPPED, an unchanged one is kept only
 * every REPEAT_MS, the cap bounds the file, a corrupt line is skipped, and `last()` carries the
 * chip's unit so a restart can re-offer it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WATERPLANE_USAGELOG_CAP = "100";
const { SourceUsageLog, SOURCE_LOG_KNOBS, sourceLogPath, sourceLogOpener, parseSourceLine } = await import("../dist/usagesourcelog.js");

const MIN = 60_000;
const T0 = Date.now() - 10 * 24 * 60 * MIN;
const reading = (t, pct, extra = {}) => ({
  source: "copilot", label: "Copilot", checkedAt: t,
  windows: [{ id: "chat", unit: "mo", pct, resetAt: T0 + 30 * 24 * 60 * MIN, used: 9, limit: 200, unitName: "credits", ...extra }],
});

function fresh(source = "copilot") {
  const root = mkdtempSync(join(tmpdir(), "waterplane-srclog-"));
  return { root, log: new SourceUsageLog(root, source), path: sourceLogPath(root, source) };
}

test("one file per source, beside claude's; claude and malformed ids have none", () => {
  const { root, path } = fresh();
  assert.match(path, /usagelog-copilot\.jsonl$/);
  assert.equal(sourceLogPath(root, "claude"), null);
  assert.equal(sourceLogPath(root, "../etc"), null);
  assert.match(sourceLogPath(root, "plugin:provider"), /usagelog-plugin_cprovider\.jsonl$/);
  assert.throws(() => new SourceUsageLog(root, "Bad/Id"), /not a usage source id/);
  rmSync(root, { recursive: true, force: true });
});

test("the file name is one-to-one: `a:b`, `a_b`, `a_cb` and `a__b` are four files", () => {
  const { root } = fresh();
  const ids = ["a:b", "a_b", "a_cb", "a__b", "a::b", "a_:b", "a:_b", "ab"];
  const paths = ids.map((id) => sourceLogPath(root, id));
  assert.equal(new Set(paths).size, ids.length, paths.join("\n"));
  for (const p of paths) assert.ok(!p.slice(root.length).includes(":"), "no `:` reaches the file system");
  rmSync(root, { recursive: true, force: true });
});

test("a change is kept at once; a repeat waits REPEAT_MS; older-or-equal instants are dropped", () => {
  const { root, log, path } = fresh();
  log.note(reading(T0, 5));
  log.note(reading(T0 + MIN, 5)); // same, too soon
  log.note(reading(T0 + 2 * MIN, 6)); // changed
  log.note(reading(T0 + 2 * MIN, 7)); // same instant
  log.note(reading(T0 + 2 * MIN + SOURCE_LOG_KNOBS.REPEAT_MS, 6)); // same, but REPEAT_MS later
  const doc = log.read();
  assert.deepEqual(doc.samples.map((s) => s.w[0].pct), [5, 6, 6]);
  assert.equal(doc.source, "copilot");
  assert.equal(doc.keptFrom, T0);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);
  rmSync(root, { recursive: true, force: true });
});

test("nothing to say is dropped, never nulls; a remembered re-offer is not written again", () => {
  const { root, log } = fresh();
  log.note({ source: "copilot", label: "Copilot", checkedAt: T0, windows: [] });
  log.note({ source: "copilot", label: "Copilot", checkedAt: T0, windows: [{ id: "chat", unit: "mo", pct: null, resetAt: null }] });
  log.note({ ...reading(T0, 5), remembered: true });
  assert.equal(log.read().samples.length, 0);
  assert.equal(log.last(), null);
  rmSync(root, { recursive: true, force: true });
});

test("the wire sample is the three fields; last() keeps the chip's unit and count", () => {
  const { root, log } = fresh();
  log.note(reading(T0, 5));
  assert.deepEqual(log.read().samples, [{ t: T0, w: [{ id: "chat", pct: 5, resetAt: T0 + 30 * 24 * 60 * MIN }] }]);
  assert.deepEqual(log.last(), { t: T0, w: [{ id: "chat", pct: 5, resetAt: T0 + 30 * 24 * 60 * MIN, unit: "mo", used: 9, limit: 200, unitName: "credits" }] });
  rmSync(root, { recursive: true, force: true });
});

test("a count with no percentage still draws a point (pct derived), never out of range", () => {
  const { root, log } = fresh();
  log.note(reading(T0, null, { used: 50, limit: 200 }));
  log.note(reading(T0 + MIN, 4300, { used: 60, limit: 200 })); // out of range ⇒ null pct, count stays
  assert.deepEqual(log.read().samples.map((s) => s.w[0].pct), [25, 30]);
  rmSync(root, { recursive: true, force: true });
});

test("a corrupt line is skipped across a restart; the cap bounds what is kept", () => {
  const { root, log, path } = fresh();
  for (let i = 0; i < 130; i++) log.note(reading(T0 + i * MIN, i % 100));
  appendFileSync(path, "{not json\n\n[1,2]\n{\"t\":-1,\"w\":[]}\n");
  const again = new SourceUsageLog(root, "copilot");
  const doc = again.read();
  assert.equal(doc.cap, 100);
  assert.equal(doc.samples.length, 100);
  assert.equal(doc.samples.at(-1).t, T0 + 129 * MIN);
  assert.equal(again.last().t, T0 + 129 * MIN);
  assert.equal(parseSourceLine("{\"t\":5,\"w\":[{\"id\":\"chat\",\"pct\":101,\"resetAt\":null}]}"), null);
  rmSync(root, { recursive: true, force: true });
});

test("past RETAIN is not kept; sinceMs narrows", () => {
  const { root, log } = fresh();
  const now = Date.now();
  log.note(reading(now - SOURCE_LOG_KNOBS.RETAIN_MS - MIN, 1));
  log.note(reading(now - 3 * 60 * MIN, 2));
  log.note(reading(now - 30 * MIN, 3));
  assert.deepEqual(log.read().samples.map((s) => s.w[0].pct), [2, 3]);
  assert.deepEqual(log.read(60 * MIN).samples.map((s) => s.w[0].pct), [3]);
  rmSync(root, { recursive: true, force: true });
});

test("the opener answers an unwritten source only when asked to create", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-srclog-"));
  const open = sourceLogOpener(root);
  assert.equal(open("copilot", true), null);
  assert.equal(open("claude", false), null);
  const log = open("copilot", false);
  log.note(reading(T0, 5));
  assert.equal(open("copilot", true).read().samples.length, 1);
  rmSync(root, { recursive: true, force: true });
});
