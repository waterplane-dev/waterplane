/**
 * The setup check's first-seen ledger (`setupcheck/seen.ts`): a finding keeps the date it was first
 * produced across runs and restarts; one already open at a repo's first check is `atLeast`; a source's
 * own earlier date (the exposure watch's) wins; an entry unseen for 30 days is forgotten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seenWords } from "@waterplane/shared";

const { FindingSeenLedger } = await import("../dist/setupcheck/seen.js");
const DAY = 24 * 60 * 60_000;
const f = (id, extra = {}) => ({ id, rule: id, scope: "repo", repo: "r", kind: "install", weight: "finding", what: id, backends: { understood: [], unread: [] }, evidence: null, remedy: { kind: "howto", text: "" }, waive: { via: "none" }, ...extra });

test("first run is atLeast; a later new finding is not; dates survive a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "seen-")), "s.json");
  const t0 = Date.UTC(2026, 10, 1, 9, 0);
  const a = new FindingSeenLedger(path).stamp([f("a")], t0);
  assert.deepEqual(a[0].seen, { at: t0, from: "desktop", atLeast: true });
  const l2 = new FindingSeenLedger(path);
  const b = l2.stamp([f("a"), f("b")], t0 + DAY);
  assert.equal(b[0].seen.at, t0);
  assert.deepEqual(b[1].seen, { at: t0 + DAY, from: "desktop" });
  assert.match(seenWords(b[1].seen), /^first seen \d+ \w{3}/);
  assert.match(seenWords(b[0].seen), /may|first look/);
});

test("the watch's own earlier date wins; a later one does not", () => {
  const l = new FindingSeenLedger(null);
  const t0 = Date.UTC(2026, 10, 10);
  l.stamp([f("x")], t0);
  const [early] = l.stamp([f("x", { seen: { at: t0 - 5 * DAY, from: "watch" } })], t0 + 1);
  assert.deepEqual(early.seen, { at: t0 - 5 * DAY, from: "watch" });
  const [late] = l.stamp([f("x", { seen: { at: t0 + DAY, from: "watch" } })], t0 + 2);
  assert.equal(late.seen.from, "desktop");
});

test("forgotten after 30 days unseen: it is new again", () => {
  const l = new FindingSeenLedger(null);
  const t0 = Date.UTC(2026, 9, 1);
  l.stamp([f("a")], t0);
  l.stamp([f("other")], t0 + 31 * DAY);
  const [again] = l.stamp([f("a")], t0 + 31 * DAY + 1);
  assert.equal(again.seen.at, t0 + 31 * DAY + 1);
});
