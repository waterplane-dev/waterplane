/**
 * What a "Recently closed" row says (`core/launcher/closedRowWords.ts`): headline,
 * kind, why it ended, the item's outcome, the gist, the small print — and that
 * an OLD row (no new fields) says nothing new.
 *
 *     node --test packages/web/src/core/launcher/closedRowWords.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  closedHeadline, closedSubtitle, closedKindWord, isAutoClosed, closedReason, closedOutcome,
  closedMeta, spanWords, closedCut, closedFilterWords,
} from "./closedRowWords.ts";

const NOW = 1_700_000_000_000;
const old = { id: "s1", cwd: "/r/myapp", title: "myapp · feat-x", closedAt: NOW - 60e3 };
const row = (o = {}) => ({ ...old, ...o });

test("headline: itemLabel, then tabTitle, then title", () => {
  assert.equal(closedHeadline(row({ itemLabel: "Fix the build", tabTitle: "Build fix" })), "Fix the build");
  assert.equal(closedHeadline(row({ tabTitle: "Build fix" })), "Build fix");
  assert.equal(closedHeadline(old), "myapp · feat-x");
  assert.equal(closedSubtitle(row({ tabTitle: "Build fix" })), "myapp · feat-x");
  assert.equal(closedSubtitle(old), undefined, "an old row says its title once");
});

test("kind wording", () => {
  const w = (kind) => closedKindWord(row({ kind }));
  assert.equal(w("hand"), "by hand");
  assert.equal(w("backlog"), "backlog");
  assert.equal(w("schedule"), "scheduled");
  assert.equal(w("agent"), "agent");
  assert.equal(w("fanout"), "fan-out");
  assert.equal(w("resurrect"), "reopened after limit");
  assert.equal(w("fork"), "fork");
  assert.equal(closedKindWord(old), undefined);
});

test("reason wording, auto closes marked", () => {
  const r = (o) => closedReason(row(o));
  assert.deepEqual(r({ closedBy: "you" }), { text: "closed by you", tone: "quiet" });
  assert.deepEqual(r({ closedBy: "replaced" }), { text: "replaced by a relaunch", tone: "quiet" });
  assert.deepEqual(r({ closedBy: "auto-done" }), { text: "closed automatically — work finished", tone: "auto" });
  assert.equal(r({ closedBy: "auto-slot" }).tone, "auto");
  assert.match(r({ closedBy: "auto-slot" }).text, /make room for a waiting item/);
  assert.equal(r({ closedBy: "exited", exitCode: 0 }).text, "ended on its own");
  assert.equal(r({ closedBy: "exited" }).text, "ended on its own");
  assert.equal(r({ closedBy: "exited", exitCode: 2 }).text, "ended on its own (exit 2)");
  assert.equal(r({ closedBy: "exited", exitSignal: 9 }).text, "ended on its own (signal 9)");
  assert.equal(r({ closedBy: "limit" }).text, "stopped at usage limit");
  assert.equal(r({ closedBy: "limit", resumedAs: "s9" }).text, "stopped at usage limit — reopened");
  assert.equal(closedReason(old), undefined);
  assert.ok(isAutoClosed(row({ closedBy: "auto-done" })));
  assert.ok(isAutoClosed(row({ closedBy: "auto-slot" })));
  assert.ok(!isAutoClosed(row({ closedBy: "you" })));
  assert.ok(!isAutoClosed(old));
});

test("item outcome", () => {
  assert.deepEqual(closedOutcome(row({ itemState: "done", itemOk: true, itemDetail: "3 files" })), { text: "item done: 3 files", tone: "ok" });
  assert.equal(closedOutcome(row({ itemState: "done", itemOk: false })).tone, "bad");
  assert.deepEqual(closedOutcome(row({ itemState: "failed", itemDetail: "exit 1" })), { text: "item failed: exit 1", tone: "bad" });
  assert.deepEqual(closedOutcome(row({ itemState: "canceled" })), { text: "item canceled", tone: "muted" });
  assert.equal(closedOutcome(old), undefined);
});

test("gist: summary, else last prompt, else first", () => {
});

test("meta: duration, last active, prompts (a floor), model", () => {
  const c = row({ openedAt: old.closedAt - (2 * 3600e3 + 5 * 60e3), lastActiveAt: NOW - 3 * 60e3, turns: 4, model: "opus" });
  assert.deepEqual(closedMeta(c, NOW), ["open 2h 5m", "last active 3m ago", "4 prompts sent from here", "opus"]);
  assert.deepEqual(closedMeta(row({ turns: 1 }), NOW), ["1 prompt sent from here"]);
  assert.deepEqual(closedMeta(row({ openedAt: old.closedAt + 5 }), NOW), [], "a backwards span is not drawn");
  assert.deepEqual(closedMeta(old, NOW), []);
  assert.equal(spanWords(40e3), "40s");
  assert.equal(spanWords(3600e3), "1h");
  assert.equal(spanWords(26 * 3600e3), "1d 2h");
});

test("the auto chip's count and its cut are one function", () => {
  const rows = [row({ id: "a", closedBy: "auto-done" }), row({ id: "b", closedBy: "you" }), row({ id: "c", closedBy: "auto-slot" }), old];
  assert.deepEqual(closedCut(rows, "auto").map((r) => r.id), ["a", "c"]);
  assert.equal(closedCut(rows, null).length, 4);
  assert.equal(closedCut(rows, "auto").length, rows.filter(isAutoClosed).length);
  assert.equal(closedFilterWords(2, 4), "2 of 4 shown — closed automatically");
});
