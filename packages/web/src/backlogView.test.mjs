/**
 * The backlog's text search and its default draw order.
 *
 *     node --test packages/web/src/backlogView.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { searchBacklog } from "./backlogFilter/rowSearch.ts";
import { sortFromStored } from "./backlogFilter/sortDefault.ts";
import { matchesBacklogFilter, NO_BACKLOG_FILTER, sortRows } from "./backlogFilter.ts";

const row = (id, text, extra = {}) => ({ id, text, label: text.slice(0, 40), status: "queued", createdAt: 1, ...extra });
const NOW = Date.now();

test("search matches headline, label and text, case-insensitively (R-queue-010)", () => {
  const rows = [
    row("h", "prose that never says it", { headline: "Flaky upload test" }),
    row("l", "other prose", { label: "Deploy Script" }),
    row("t", "Rotate the TOKEN weekly"),
    row("n", "nothing relevant"),
  ];
  assert.deepEqual(searchBacklog(rows, "FLAKY").map((x) => x.id), ["h"]);
  assert.deepEqual(searchBacklog(rows, "deploy script").map((x) => x.id), ["l"]);
  assert.deepEqual(searchBacklog(rows, "token").map((x) => x.id), ["t"]);
});

test("search with a filter on is the intersection: a text match outside the filter stays hidden (R-queue-010)", () => {
  const rows = [row("q1", "fix login", { status: "queued" }), row("d1", "fix login too", { status: "done" }), row("q2", "other", { status: "queued" })];
  const filter = { ...NO_BACKLOG_FILTER, status: "queued" };
  const cut = rows.filter((it) => matchesBacklogFilter(it, filter, NOW));
  assert.deepEqual(cut.map((x) => x.id), ["q1", "q2"], "the filter really cuts");
  assert.deepEqual(searchBacklog(cut, "login").map((x) => x.id), ["q1"], "done row matching the text is not shown");
});

test("an empty or blank search returns the filtered set untouched (R-queue-010)", () => {
  const cut = [row("a", "one"), row("b", "two")];
  assert.deepEqual(searchBacklog(cut, "").map((x) => x.id), ["a", "b"]);
  assert.deepEqual(searchBacklog(cut, "   ").map((x) => x.id), ["a", "b"]);
  assert.deepEqual(searchBacklog(cut, " TWO ").map((x) => x.id), ["b"], "the query is trimmed");
});

test("the default draw order is newest first, with the latest add on top (R-queue-016)", () => {
  assert.equal(sortFromStored(null), "newest");
  assert.equal(sortFromStored(undefined), "newest");
  const runOrder = [row("old", "a", { createdAt: 1 }), row("mid", "b", { createdAt: 2 }), row("new", "c", { createdAt: 3 })];
  assert.equal(sortRows(runOrder, sortFromStored(null))[0].id, "new");
});

test("run order is the one tap away, and the only stored answer (R-queue-016)", () => {
  assert.equal(sortFromStored("1"), "run");
  const runOrder = [row("old", "a", { createdAt: 1 }), row("new", "c", { createdAt: 3 })];
  assert.deepEqual(sortRows(runOrder, sortFromStored("1")).map((x) => x.id), ["old", "new"]);
  assert.equal(sortFromStored("0"), "newest", "anything but the run marker is the default");
});
