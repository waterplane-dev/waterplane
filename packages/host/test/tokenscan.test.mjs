/**
 * The token ledger's scan, made non-blocking WITHOUT changing a number.
 *
 *     node --test packages/host/test/tokenscan.test.mjs
 *
 * `fixtures/tokenscan.expected.json` was produced by the ONE-BUFFER reader this
 * replaced (`readFileSync`-style whole-file read + split, sync directory walk),
 * run over `fixtures/tokenscan.mjs`'s tree in UTC. The async, chunked reader
 * must reproduce it field for field; every chunk size must agree with every
 * other (a slice boundary falls inside multi-byte text and inside a JSON line);
 * and a big log must not hold the event loop for long — the reason for the change.
 * The fields left out of the comparison move with the clock or the price list,
 * not with the scan: `scannedAt`, `pricesAsOf`, and the wire's recent-hours window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixture } from "./fixtures/tokenscan.mjs";
import { TokenStatsStore } from "../dist/tokenstats.js";
import { summarizeLog } from "../dist/tokenscan.js";

process.env.TZ = "UTC";
const expected = JSON.parse(readFileSync(new URL("./fixtures/tokenscan.expected.json", import.meta.url), "utf8"));

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "wp-tokenscan-"));
  const projects = writeFixture(home);
  return { home, projects };
}

test("the async chunked scan reproduces the one-buffer reader's document exactly", async () => {
  const { home } = freshHome();
  const prev = process.env.WATERPLANE_CLAUDE_HOME;
  process.env.WATERPLANE_CLAUDE_HOME = home;
  try {
    const store = new TokenStatsStore(join(home, "root"));
    const doc = await store.read(0);
    for (const k of ["scannedAt", "pricesAsOf", "hours", "hoursFrom"]) delete doc[k];
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), expected);
    store.flush?.();
  } finally {
    if (prev === undefined) delete process.env.WATERPLANE_CLAUDE_HOME; else process.env.WATERPLANE_CLAUDE_HOME = prev;
  }
});

test("every slice size gives the same summary — boundaries inside multi-byte text and inside a line", async () => {
  const { projects } = freshHome();
  for (const rel of ["-fx-repo-one/conv-a.jsonl", "-fx-repo-one/conv-a/subagents/agent-x.jsonl", "-fx-repo-two/conv-b.jsonl"]) {
    const p = join(projects, rel);
    const st = statSync(p);
    const whole = await summarizeLog(p, st.size, 1, st.size + 1);
    assert.ok(whole, rel);
    for (const chunk of [3, 7, 64, 1000, 65_536]) {
      assert.deepEqual(await summarizeLog(p, st.size, 1, chunk), whole, `${rel} @ ${chunk}`);
    }
  }
  // Nothing countable is null, not an empty summary; a missing file is null, not a throw.
  assert.equal(await summarizeLog(join(projects, "-fx-repo-two/conv-users.jsonl"), statSync(join(projects, "-fx-repo-two/conv-users.jsonl")).size, 1), null);
  assert.equal(await summarizeLog(join(projects, "nope.jsonl"), 10, 1), null);
});

test("only the stat'ed size is read — a log growing mid-scan does not leak its new tail in", async () => {
  const { projects } = freshHome();
  const p = join(projects, "-fx-repo-one/conv-a/subagents/agent-x.jsonl");
  const size = statSync(p).size;
  const before = await summarizeLog(p, size, 1, 16);
  writeFileSync(p, readFileSync(p, "utf8") + JSON.stringify({ type: "assistant", timestamp: "2026-07-01T09:00:00Z", message: { id: "late", model: "claude-test-b", usage: { input_tokens: 999 } } }) + "\n");
  assert.deepEqual(await summarizeLog(p, size, 1, 16), before);
});

test("a big log does not hold the event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-tokenscan-big-"));
  const p = join(dir, "big.jsonl");
  const row = (i) => JSON.stringify({
    type: "assistant", cwd: "/fx/big", timestamp: new Date(Date.UTC(2026, 6, 1) + i * 1000).toISOString(),
    message: { id: `b${i}`, model: "claude-test-a", content: [{ type: "text", text: "x".repeat(200) }],
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  });
  const lines = [];
  for (let i = 0; i < 60_000; i++) lines.push(row(i));
  writeFileSync(p, lines.join("\n") + "\n");
  const size = statSync(p).size;
  const longestStall = async () => {
    let worst = 0;
    let last = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 2);
    try {
      last = performance.now();
      const sum = await summarizeLog(p, size, 1);
      assert.equal(Object.values(sum.x).reduce((n, t) => n + t[5], 0), 60_000);
    } finally {
      clearInterval(tick);
    }
    return worst;
  };
  // The one-buffer reader held the loop for the whole file. Measured here, on
  // this machine, the way it read: one read, one split, every usage line
  // parsed — the stall a sliced read must be well under (self-calibrating, so a
  // slow machine raises both). Sliced, the longest stall is one slice plus one read.
  const t0 = performance.now();
  for (const line of readFileSync(p).toString("utf8").split("\n")) if (line.includes('"usage"')) JSON.parse(line);
  const oneBuffer = performance.now() - t0;
  // Best of three: with every core busy the scheduler can park this process
  // mid-slice, and that gap reads as a stall. A reader that really holds the
  // loop for the file holds it on every attempt; a preemption rarely lands twice.
  let worst = Infinity;
  for (let i = 0; i < 3 && worst >= oneBuffer * 0.6; i++) worst = Math.min(worst, await longestStall());
  assert.ok(worst < oneBuffer * 0.6, `event loop held for ${Math.round(worst)} ms; the one-buffer read takes ${Math.round(oneBuffer)} ms`);
});

test("b is the first answered request's input+cache, present only when one was answered", async () => {
  const { projects } = freshHome();
  const sums = [];
  for (const rel of ["-fx-repo-one/conv-a.jsonl", "-fx-repo-two/conv-users.jsonl"]) {
    const p = join(projects, rel);
    try { sums.push(await summarizeLog(p, statSync(p).size, 1)); } catch { /* fixture name may differ */ }
  }
  const a = sums[0];
  assert.ok(a && typeof a.b === "number" && a.b > 0, "an answered log carries b");
  assert.ok(a.b <= Object.values(a.x).reduce((n, t) => n + t[0] + t[2] + t[3], 0));
  assert.equal(sums[1], null);
});

test("b skips an output-only first record and anchors on the first request that carried context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-tokenscan-b-"));
  const p = join(dir, "conv.jsonl");
  const rec = (id, usage) => JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:00Z", message: { id, model: "claude-opus-4-1", usage } });
  writeFileSync(p, [
    rec("m0", { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    rec("m1", { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }),
  ].join("\n") + "\n");
  const s = await summarizeLog(p, statSync(p).size, 1);
  assert.equal(s.b, 143, "b is the first request with input or cache, never 0 from an output-only record");
});

test("read, costWindow and windowSeries all carry the store's undated count (design round 4)", async () => {
  const home = mkdtempSync(join(tmpdir(), "wp-tokenscan-undated-"));
  const store = new TokenStatsStore(join(home, "root"));
  const hour = "2026-10-08T11";
  store.store = { "-r": { conv: { m: 0, s: 0, w: "/r", x: { [`\u0000claude-sonnet-4-5`]: [5, 5, 0, 0, 0, 2], [`${hour}\u0000claude-sonnet-4-5`]: [1, 1, 0, 0, 0, 1] } } } };
  store.lastScan = Date.now();
  const big = 1e12;
  assert.equal((await store.read(big)).undated, 2);
  assert.equal((await store.costWindow(0, Date.now(), { byConv: new Map() }, big)).undated, 2);
  assert.equal((await store.windowSeries([{ id: "w", anchor: Date.now(), lenMs: 3_600_000 }], big)).undated, 2);
});

test("an assistant line with a missing or unparseable timestamp lands under the empty hour undatedRecords reads (design round 4, r4-1 L2)", async () => {
  const { undatedRecords } = await import("../dist/costwindow.js");
  const dir = mkdtempSync(join(tmpdir(), "wp-tokenscan-undated-"));
  const p = join(dir, "conv.jsonl");
  const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 };
  const rec = (id, ts) => JSON.stringify({ type: "assistant", ...(ts === undefined ? {} : { timestamp: ts }), message: { id, model: "claude-opus-4-1", usage } });
  writeFileSync(p, [
    rec("m-none", undefined),
    rec("m-bad", "not a time"),
    rec("m-dated", "2026-10-01T10:00:00Z"),
  ].join("\n") + "\n");
  const mtime = 1_790_000_000_000;
  const s = await summarizeLog(p, statSync(p).size, mtime);
  const empty = Object.entries(s.x).filter(([k]) => k.split("\u0000")[0] === "");
  assert.equal(empty.length, 1, "both undated records share ONE empty-hour key");
  assert.equal(empty[0][0], "\u0000claude-opus-4-1");
  assert.equal(empty[0][1][5], 2, "two requests, counted");
  assert.equal(s.m, mtime, "the file's mtime rides with it — the bound a window's undated count is cut by");
  const files = { "-r": { conv: s } };
  assert.equal(undatedRecords(files), 2);
  assert.equal(undatedRecords(files, mtime + 1), 0, "a span opened after the log was written misses none");
});
