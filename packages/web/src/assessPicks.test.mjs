/**
 * The ticks, pinned — because every way this store can fail is a way it loses a
 * decision somebody made, and none of them throws.
 *
 * Four rules, each of which is silent when broken:
 *
 *   • a run that has been ticked survives the sheet unmounting, which is what
 *     opening the plan, an item or a picture does (`App` returns early per
 *     overlay) — the whole reason the module exists;
 *   • one run's approvals never reach another run's proposal, because verdicts
 *     are re-formed by every run and an id ticked under one reasoning says
 *     nothing about the next;
 *   • what goes in and comes out is COPIED, so a component mutating a list it
 *     holds cannot change what a later apply believes was approved;
 *   • nothing is persisted — no storage key, here or anywhere but
 *     `storage.ts`.
 *
 *     node --test packages/web/src/assessPicks.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPicks, savePicks, dropPicks } from "./assessPicks.ts";

const picks = (over = {}) => ({ rows: ["a"], merges: ["g1"], news: [0], rejected: ["b"], pinRanks: false, writeNames: false, ...over });

test("a run nobody has ticked anything on comes back empty, not with somebody else's", () => {
  assert.equal(loadPicks("as_never"), null);
  assert.equal(loadPicks(""), null, "no run id is not a key");
});

test("ticks survive the sheet unmounting — the glance at a picture this exists for", () => {
  savePicks("as_1", picks());
  const back = loadPicks("as_1");
  // `writeNames` rides with them: it is a decision about THIS proposal's titles,
  // taken with them on screen, so losing it to a glance at a picture is the same
  // delete as losing a tick.
  assert.deepEqual(back, { rows: ["a"], merges: ["g1"], news: [0], rejected: ["b"], pinRanks: false, writeNames: false });
});

test("a new run is a new proposal — approvals never cross from one to another", () => {
  savePicks("as_1", picks({ rows: ["a", "b"] }));
  savePicks("as_2", picks({ rows: ["c"], merges: [], news: [], rejected: [], pinRanks: true, writeNames: true }));
  assert.deepEqual(loadPicks("as_1").rows, ["a", "b"]);
  assert.deepEqual(loadPicks("as_2").rows, ["c"]);
  assert.equal(loadPicks("as_2").pinRanks, true);
  assert.equal(loadPicks("as_2").writeNames, true);
  assert.equal(loadPicks("as_3"), null);
});

test("what is handed back is a COPY — mutating it cannot change what was approved", () => {
  savePicks("as_copy", picks());
  const first = loadPicks("as_copy");
  first.rows.push("smuggled");
  first.news.length = 0;
  first.pinRanks = true;
  first.writeNames = true;
  const second = loadPicks("as_copy");
  assert.deepEqual(second.rows, ["a"], "an apply must not retire a row nobody ticked");
  assert.deepEqual(second.news, [0]);
  assert.equal(second.pinRanks, false);
  assert.equal(second.writeNames, false);
});

test("what is handed IN is copied too — the caller's arrays stay the caller's", () => {
  const mine = picks();
  savePicks("as_in", mine);
  mine.rows.push("added after the save");
  mine.merges.length = 0;
  assert.deepEqual(loadPicks("as_in").rows, ["a"]);
  assert.deepEqual(loadPicks("as_in").merges, ["g1"]);
});

test("dropping a run's ticks makes it a run nobody has ticked again", () => {
  savePicks("as_gone", picks());
  dropPicks("as_gone");
  assert.equal(loadPicks("as_gone"), null, "after an apply the ticks are facts about the backlog, not an offer to repeat");
  dropPicks("as_gone"); // idempotent: a second apply reply must not throw
});

test("nothing here is persisted — an approval is formed against verdicts on the screen", () => {
  // Read as text rather than mocked, for `theme.test.mjs`'s reason: the claim
  // is about the FILE, and a mock only proves the paths a test happened to walk.
  const src = readFileSync(new URL("./assessPicks.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|idb/i,
    "no storage key here — `local/no-storage-key-literal`, and a reload is where the proposal is re-read");
});
