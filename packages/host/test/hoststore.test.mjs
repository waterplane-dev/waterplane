/**
 * The daemon's own store: what the report says it holds, and what a clear is
 * allowed to touch.
 *
 * `<root>/<state dir>` is the one directory this app deletes from that is NOT inside
 * a repo worktree, so `contained()` — the guard every transport delete goes
 * through — does not apply to it. What replaces that guard is a catalogue and
 * the rule that no path ever arrives from a client. These cases pin exactly
 * that, because every one of them is silent when it goes wrong:
 *
 *  - a ledger deleted by a request that named it;
 *  - a store this build has never heard of, swept because it did not match
 *    anything known;
 *  - a file written between the reading and the tap, removed although it was
 *    never on the screen the person approved;
 *  - `..json.bak` treated as a leftover because the rule stripped rather than
 *    matched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const { clearHostStore, hostStoreDir, hostStoreReport } = await import("../dist/hoststore.js");

/** A root with a populated state dir — one file of every kind the catalogue
 *  knows, plus one it does not. */
function root() {
  const dir = mkdtempSync(join(tmpdir(), "hoststore-"));
  const store = join(dir, BRAND.stateDirName);
  mkdirSync(join(store, "history"), { recursive: true });
  mkdirSync(join(store, "live"), { recursive: true });
  writeFileSync(join(store, "intents.json"), "x".repeat(100));          // live
  writeFileSync(join(store, "acks.json"), "x".repeat(50));              // live
  writeFileSync(join(store, "history", "abc.json"), "x".repeat(10));    // live, in a dir
  writeFileSync(join(store, "sent.json"), "x".repeat(200));             // bounded ledger
  writeFileSync(join(store, "usagelog.jsonl"), "x".repeat(300));        // bounded ledger
  writeFileSync(join(store, "tokenstats.json"), "x".repeat(400));       // the unbounded one
  writeFileSync(join(store, "intents.json.bak"), "x".repeat(20));       // rollback
  writeFileSync(join(store, "backlog.json.migrated"), "x".repeat(30));  // rollback
  writeFileSync(join(store, ".env"), "x".repeat(15));                   // live, and a dotfile
  writeFileSync(join(store, "something-new.json"), "x".repeat(7));      // unknown
  return dir;
}

const rowOf = (rep, id) => rep.rows.find((r) => r.id === id);

// ── the reading ────────────────────────────────────────────────────────────

test("every kind is its own row, and the store directory is named", () => {
  const dir = root();
  const rep = hostStoreReport(dir, 1_000);
  assert.equal(rep.at, 1_000);
  assert.equal(rep.dir, hostStoreDir(dir));
  assert.equal(rowOf(rep, "rollback").count, 2);
  assert.equal(rowOf(rep, "rollback").bytes, 50);
  assert.equal(rowOf(rep, "ledgers").count, 2);
  assert.equal(rowOf(rep, "ledgers").bytes, 500);
  assert.equal(rowOf(rep, "tokenstats").bytes, 400);
  // Two files plus one inside `history/`, plus `.env`.
  assert.equal(rowOf(rep, "live").count, 4);
  assert.equal(rowOf(rep, "live").bytes, 175);
});

test("`.env` is live state, not an unrecognised file", () => {
  // It is unclearable either way — `unknown` is refused too — but a row saying
  // the daemon's own credentials are "not in this catalogue" reads as something
  // nobody owns, which is an invitation to go and look at it.
  const rep = hostStoreReport(root());
  assert.equal(rowOf(rep, "unknown").count, 1);
  assert.equal(rowOf(rep, "unknown").bytes, 7);
});

test("a file this build does not know is reported, never folded into a known kind", () => {
  const rep = hostStoreReport(root());
  const unknown = rowOf(rep, "unknown");
  assert.equal(unknown.count, 1);
  assert.equal(unknown.bytes, 7);
  // And it can never be cleared: a sweep that removes what it cannot name is a
  // sweep that removes the next feature's store.
  assert.ok(unknown.cant);
});

test("only the cache and the leftovers are offered; everything else says why not", () => {
  const rep = hostStoreReport(root());
  const offered = rep.rows.filter((r) => !r.cant).map((r) => r.id).sort();
  assert.deepEqual(offered, ["rollback", "thumbs"]);
  // A blocked verb is a SENTENCE, not a missing row — and the bounded ledgers'
  // sentence has to name the bound, or the row reads as something forgotten.
  assert.match(rowOf(rep, "ledgers").cant, /bounded by whoever writes it/);
  assert.match(rowOf(rep, "tokenstats").cant, /no bound of its own/);
  assert.match(rowOf(rep, "live").cant, /run twice/);
});

test("every row carries a cost sentence, cleared or not", () => {
  for (const r of hostStoreReport(root()).rows) {
    assert.ok(r.cost && r.cost.length > 20, `${r.id} has no cost sentence`);
  }
});

test("an unreadable store is partial, never an empty store", () => {
  const rep = hostStoreReport(join(tmpdir(), "not-a-root-" + Math.random()));
  assert.equal(rep.partial, true);
  // It still answers with rows, all empty — a screen with no rows would read as
  // "nothing here", which is the wrong fact.
  assert.ok(rep.rows.length > 0);
});

test("a symlink in the store is not followed and not counted", () => {
  const dir = root();
  const store = hostStoreDir(dir);
  const outside = join(dir, "elsewhere.json");
  writeFileSync(outside, "x".repeat(9_999));
  symlinkSync(outside, join(store, "linked.json.bak"));
  const rep = hostStoreReport(dir);
  // Would have been a 9 999-byte rollback row if the link were followed.
  assert.equal(rowOf(rep, "rollback").count, 2);
  assert.equal(rowOf(rep, "rollback").bytes, 50);
});

// ── the clear ──────────────────────────────────────────────────────────────

test("a ledger is never removed, whatever id the request names", () => {
  const dir = root();
  for (const id of ["ledgers", "tokenstats", "live", "unknown", "sent.json", "tokenstats.json"]) {
    const out = clearHostStore(dir, id, Date.now() + 1_000);
    assert.equal(out.deleted, 0, id);
    assert.ok(out.refused, `${id} should refuse in words`);
  }
  assert.ok(existsSync(join(hostStoreDir(dir), "sent.json")));
  assert.ok(existsSync(join(hostStoreDir(dir), "tokenstats.json")));
  assert.ok(existsSync(join(hostStoreDir(dir), "intents.json")));
});

test("an unknown id is refused in words, and nothing is touched", () => {
  const dir = root();
  const before = readdirSync(hostStoreDir(dir)).length;
  const out = clearHostStore(dir, "../../etc", Date.now() + 1_000);
  assert.equal(out.deleted, 0);
  assert.match(out.refused, /not something this screen removes/);
  assert.equal(readdirSync(hostStoreDir(dir)).length, before);
});

test("clearing the leftovers removes exactly those two", () => {
  const dir = root();
  const store = hostStoreDir(dir);
  const out = clearHostStore(dir, "rollback", Date.now() + 1_000);
  assert.equal(out.deleted, 2);
  assert.equal(out.bytes, 50);
  assert.equal(out.failed, 0);
  assert.ok(!existsSync(join(store, "intents.json.bak")));
  assert.ok(!existsSync(join(store, "backlog.json.migrated")));
  // The live files they shadow are untouched.
  assert.ok(existsSync(join(store, "intents.json")));
});

test("`at` protects a file written since the reading", () => {
  const dir = root();
  const store = hostStoreDir(dir);
  const at = 1_000_000;
  // Older than the reading: goes. Newer: stays, because it was never on the
  // screen the person approved.
  utimesSync(join(store, "intents.json.bak"), at / 1000 - 10, at / 1000 - 10);
  utimesSync(join(store, "backlog.json.migrated"), at / 1000 + 10, at / 1000 + 10);
  const out = clearHostStore(dir, "rollback", at);
  assert.equal(out.deleted, 1);
  assert.ok(!existsSync(join(store, "intents.json.bak")));
  assert.ok(existsSync(join(store, "backlog.json.migrated")));
});

test("the leftover rule MATCHES, it does not strip", () => {
  const dir = root();
  const store = hostStoreDir(dir);
  // Names that a strip-based rule would have accepted. None of them is a
  // leftover; all of them must survive a clear.
  const decoys = ["..json.bak", "a/b.json.bak", "x.json.bakk", ".json.migrated"];
  const written = [];
  for (const n of decoys) {
    if (n.includes("/")) continue;             // cannot be created as a name anyway
    const p = join(store, n);
    writeFileSync(p, "x");
    written.push(p);
  }
  clearHostStore(dir, "rollback", Date.now() + 1_000);
  for (const p of written) assert.ok(existsSync(p), `${p} was removed`);
});

test("a symlinked leftover is skipped rather than unlinked", () => {
  const dir = root();
  const store = hostStoreDir(dir);
  const outside = join(dir, "victim.json");
  writeFileSync(outside, "keep me");
  symlinkSync(outside, join(store, "linked.json.bak"));
  clearHostStore(dir, "rollback", Date.now() + 1_000);
  assert.ok(existsSync(outside), "a symlink target outside the store was removed");
});

test("peer-jobs.json is a named ledger, not 'not in this catalogue'", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoststore-pj-"));
  const store = join(dir, BRAND.stateDirName);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "peer-jobs.json"), "{}");
  const rep = hostStoreReport(dir);
  assert.equal(rowOf(rep, "unknown").count, 0);
  assert.equal(rowOf(rep, "live").count, 1);
});
