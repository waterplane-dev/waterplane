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
  // The one-buffer reader held the loop for the whole file. Measured here, on
  // this machine, the way it read: one read, one split, every usage line
  // parsed — the stall a sliced read must be well under (self-calibrating, so a
  // slow machine raises both). Sliced, the longest stall is one slice plus one read.
  const t0 = performance.now();
  for (const line of readFileSync(p).toString("utf8").split("\n")) if (line.includes('"usage"')) JSON.parse(line);
  const oneBuffer = performance.now() - t0;
  assert.ok(worst < oneBuffer * 0.6, `event loop held for ${Math.round(worst)} ms; the one-buffer read takes ${Math.round(oneBuffer)} ms`);
});
