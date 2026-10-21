// The sessions list: a slim row per recent log, the running-prompt heuristic, the recent window and
// cap, and "only a log that changed is read again".
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, prompt, req, slash, tmp } from "./helpers.mjs";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const turnsOf = (lines) => {
  const p = join(tmp("run"), "r.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return data.projectTurns(data.advanceTurns(p, null));
};

test("running: an open last turn is a tool_use reply, a streamed partial, or an unanswered prompt", () => {
  assert.equal(turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: "tool_use" })]).at(-1).open, true);
  assert.equal(turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: null })]).at(-1).open, true);
  assert.equal(turnsOf([prompt(0, "go")]).at(-1).open, true);
});

test("running: end_turn, stop_sequence, max_tokens, an absent stop_reason and a local command are not open", () => {
  for (const stop of ["end_turn", "stop_sequence", "max_tokens"]) {
    assert.equal(turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop })]).at(-1).open, undefined, stop);
  }
  assert.equal(turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2 })]).at(-1).open, undefined, "no field at all = cannot tell");
  assert.equal(turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: "end_turn" }), slash(2, "/model")]).at(-1).open, undefined);
});

test("running: the record that finishes a message repeats its id, and still closes the turn", () => {
  const rows = turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: null }), req(2, "a", { input: 5, output: 2, stop: "end_turn" })]);
  assert.equal(rows.at(-1).open, undefined);
  assert.equal(rows.at(-1).requests, 1, "still one request");
});

test("running: only the last turn can be open", () => {
  const rows = turnsOf([prompt(0, "a"), req(1, "x", { input: 5, output: 2, stop: "tool_use" }), prompt(2, "b"), req(3, "y", { input: 5, output: 2, stop: "end_turn" })]);
  assert.deepEqual(rows.map((r) => r.open), [undefined, undefined]);
});

test("runningTurn: open AND written in the last 10 minutes; a stale log is not running", () => {
  const rows = turnsOf([prompt(0, "go"), req(1, "a", { input: 5, output: 2, stop: "tool_use" })]);
  assert.equal(data.runningTurn(rows, NOW - 30_000, NOW)?.n, 1);
  assert.equal(data.runningTurn(rows, NOW - data.RUNNING_FRESH_MS - 1, NOW), null);
  assert.equal(data.runningTurn(rows, 0, NOW), null, "no mtime, no claim");
  assert.equal(data.runningTurn([], NOW, NOW), null);
});

test("a pending turn with no request has no cost, and is worded as waiting, never $0", () => {
  const rows = turnsOf([prompt(0, "go")]);
  assert.equal(rows[0].costUsd, null);
  assert.equal(rows[0].requests, 0);
  const words = data.runningWords({ ...rows[0], at: NOW - 80_000 }, NOW);
  assert.equal(words, "running · waiting for the first reply · 1m 20s");
  assert.ok(!words.includes("$"));
});

test("runningWords: cost so far, requests, elapsed; no figure when unpriced; no clock when undated", () => {
  assert.equal(data.runningWords({ costUsd: 0.42, requests: 7, at: NOW - 80_000 }, NOW), "running · $0.42 so far · 7 requests · 1m 20s");
  assert.equal(data.runningWords({ costUsd: null, requests: 1, at: 0 }, NOW), "running · no dollar figure · 1 request");
  assert.equal(data.fmtElapsed(3_900_000), "1h 05m");
  assert.equal(data.fmtAge(2 * 60_000), "2 min ago");
  assert.equal(data.fmtAge(10_000), "just now");
});

test("isLive: written in the last 2 minutes, or running", () => {
  assert.equal(data.isLive(NOW - 60_000, false, NOW), true);
  assert.equal(data.isLive(NOW - 5 * 60_000, false, NOW), false);
  assert.equal(data.isLive(NOW - 5 * 60_000, true, NOW), true);
});

test("summarize: cost, context, prompt count and the last prompt, per session", async () => {
  const p = join(tmp("sum"), "s.jsonl");
  writeFileSync(p, [prompt(0, "first"), req(1, "a", { input: 100, cw: 1000, output: 10, stop: "end_turn" }),
    prompt(2, "second\nline"), req(3, "b", { cr: 1000, input: 5, output: 20, stop: "tool_use" })].join("\n") + "\n");
  const { doc } = await data.readSession(p, null, "/f");
  const s = data.summarize(doc, 1234);
  assert.equal(s.id, "s");
  assert.equal(s.mtime, 1234);
  assert.equal(s.prompts, 2);
  assert.equal(s.lastPrompt, "second line");
  assert.ok(s.costUsd > 0);
  assert.equal(s.costNote, null);
  assert.equal(s.lastTok, 1005);
  assert.equal(s.windowTok, 200_000);
  assert.equal(s.open, true);
  assert.equal(s.openAt, doc.turnCosts[1].at);
  assert.ok(Math.abs(s.costUsd - data.sessionTotal(doc).cost.total) < 1e-12, "a row is the headline's own figure");
});

test("summarize: nothing priced is withheld words, never a zero", async () => {
  const p = join(tmp("sum0"), "s.jsonl");
  writeFileSync(p, [prompt(0, "x"), req(1, "a", { input: 10, output: 5, model: "mystery-model-9", stop: "end_turn" })].join("\n") + "\n");
  const { doc } = await data.readSession(p, null, "/f");
  const s = data.summarize(doc, 1);
  assert.equal(s.costUsd, null);
  assert.equal(s.costNote, "no price");
});

const row = (id, ageMs) => ({ id, path: `/x/${id}.jsonl`, mtime: NOW - ageMs, size: 1 });

test("recentRows: the last 24 h, newest always, the pinned one always, capped", () => {
  const H = 3_600_000;
  const rows = [row("a", 30 * H), row("b", 31 * H), row("c", 40 * H)];
  assert.deepEqual(data.recentRows(rows, NOW, null).listed.map((r) => r.id), ["a"], "the newest is listed even when old");
  assert.equal(data.recentRows(rows, NOW, null).older, 2);
  assert.deepEqual(data.recentRows(rows, NOW, "c").listed.map((r) => r.id), ["a", "c"]);
  const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`, i * 60_000));
  assert.equal(data.recentRows(many, NOW, null).listed.length, data.MAX_ROWS);
  const kept = data.recentRows(many, NOW, "s29");
  assert.equal(kept.listed.length, data.MAX_ROWS);
  assert.equal(kept.listed.at(-1).id, "s29", "a pinned session beyond the cap still has its row");
  assert.equal(kept.older, 0, "cut by the cap is not 'older'");
  assert.equal(kept.capped, 30 - data.MAX_ROWS);
  assert.deepEqual(data.recentRows([], NOW, null), { listed: [], older: 0, capped: 0, automated: 0 });
});

test("recentRows: automated (claude -p) logs are not listed unless selected, and are counted", () => {
  const H = 3_600_000;
  const rows = [row("auto1", 1000), row("human", 60_000), row("auto2", 120_000), row("old", 30 * H), row("oldauto", 31 * H)];
  const auto = (r) => r.id.includes("auto");
  const r = data.recentRows(rows, NOW, null, auto);
  assert.deepEqual(r.listed.map((x) => x.id), ["human"]);
  assert.equal(r.automated, 2, "only the recent automated ones are counted");
  assert.equal(r.older, 2, "old and oldauto are outside the window");
  assert.equal(r.capped, 0);
  assert.deepEqual(data.recentRows(rows, NOW, "auto2", auto).listed.map((x) => x.id), ["human", "auto2"], "a selected automated session keeps its row");
  assert.equal(data.recentRows(rows, NOW, "auto2", auto).automated, 1);
  // Only automated logs: nothing to list (the caller still reads the newest for the headline).
  assert.deepEqual(data.recentRows([row("auto1", 5)], NOW, null, auto).listed, []);
  // The newest interactive one is listed even when it is older than the window.
  assert.deepEqual(data.recentRows([row("auto1", 5), row("h", 40 * H)], NOW, null, auto).listed.map((x) => x.id), ["h"]);
});

test("isAutomated: only an sdk entrypoint is; absent or unknown is interactive", () => {
  for (const e of ["sdk-cli", "sdk-ts", "sdk-py"]) assert.equal(data.isAutomated(e), true, e);
  for (const e of ["cli", "claude-vscode", "", null, undefined, "mystery"]) assert.equal(data.isAutomated(e), false, String(e));
});

test("the ledger learns a log's entrypoint from its head, and caches it", async () => {
  const dir = tmp("entry");
  const mk = (id, extra) => {
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, [JSON.stringify({ type: "queue-operation" }), JSON.stringify({ type: "user", entrypoint: extra, message: { role: "user", content: "x" } })].join("\n") + "\n");
    return { id, path: p, mtime: Date.now(), size: 1 };
  };
  const a = mk("a", "sdk-cli"), b = mk("b", "cli");
  const none = { id: "n", path: join(dir, "n.jsonl"), mtime: Date.now(), size: 1 };
  writeFileSync(none.path, prompt(0, "no entrypoint field") + "\n");
  assert.equal(await data.peekEntrypoint(a.path), "sdk-cli");
  assert.equal(await data.peekEntrypoint(join(dir, "gone.jsonl")), null);
  const ledger = new data.SessionLedger();
  await ledger.peek([a, b, none]);
  assert.deepEqual([a, b, none].map(ledger.auto), [true, false, false], "absent field = interactive");
});

test("the ledger reads a log again only when its size or mtime moved", async () => {
  const dir = tmp("ledger");
  mkdirSync(dir, { recursive: true });
  const write = (id, text, ageSec) => {
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, [prompt(0, text), req(1, `m-${id}`, { input: 10, output: 5, stop: "end_turn" })].join("\n") + "\n");
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(p, t, t);
    return p;
  };
  write("one", "alpha", 30); write("two", "beta", 60); write("three", "gamma", 90);
  const ledger = new data.SessionLedger();
  const list = async () => data.recentRows(await data.listSessions(dir), Date.now(), null).listed;
  let rows = await ledger.rows(await list(), "/f", null);
  assert.deepEqual(rows.map((r) => r.lastPrompt), ["alpha", "beta", "gamma"], "newest write first");
  assert.equal(ledger.reads, 3);
  rows = await ledger.rows(await list(), "/f", null);
  assert.equal(ledger.reads, 3, "nothing changed, nothing read");
  appendFileSync(join(dir, "two.jsonl"), [prompt(5, "delta"), req(6, "m-two2", { input: 10, output: 5, stop: "tool_use" })].join("\n") + "\n");
  rows = await ledger.rows(await list(), "/f", null);
  assert.equal(ledger.reads, 4, "only the changed log was read again");
  assert.equal(rows[0].id, "two", "and it is now the newest");
  assert.equal(rows[0].lastPrompt, "delta");
  assert.equal(rows[0].prompts, 2);
  assert.equal(rows[0].open, true);
  // The selected log is the caller's: the ledger never reads it.
  const sel = rows[0];
  appendFileSync(join(dir, "two.jsonl"), req(9, "m-two3", { input: 1, output: 1, stop: "end_turn" }) + "\n");
  await ledger.rows(await list(), "/f", sel);
  assert.equal(ledger.reads, 4);
});

test("the ledger forgets a log that left the list", async () => {
  const dir = tmp("ledger2");
  writeFileSync(join(dir, "a.jsonl"), [prompt(0, "x"), req(1, "m", { input: 1, output: 1, stop: "end_turn" })].join("\n") + "\n");
  const ledger = new data.SessionLedger();
  const listed = await data.listSessions(dir);
  await ledger.rows(listed, "/f", null);
  await ledger.rows([], "/f", null);
  await ledger.rows(listed, "/f", null);
  assert.equal(ledger.reads, 2, "read again from scratch after it was dropped");
});

test("anyLive: a row written under 30 min ago counts, an older one and none do not; a running row is always recent", () => {
  const MIN = 60_000;
  assert.ok(data.RUNNING_FRESH_MS <= data.RECENT_MS, "running implies recent, so anyLive need not ask isRunning");
  assert.equal(data.anyLive([{ mtime: NOW - 29 * MIN }], NOW), true);
  assert.equal(data.anyLive([{ mtime: NOW - 31 * MIN }, { mtime: NOW - 2 * MIN }], NOW), true, "any row");
  assert.equal(data.anyLive([{ mtime: NOW - 31 * MIN }], NOW), false);
  assert.equal(data.anyLive([{ mtime: 0 }], NOW), false, "undated");
  assert.equal(data.anyLive([], NOW), false);
});
