import test from "node:test";
import assert from "node:assert/strict";

import { FEED_CAP, backlogRepoFor, badgeText, newestTs, pushNotif, unreadCount } from "./logic.ts";

test("a live push goes to the front and the feed stays capped", () => {
  const prev = Array.from({ length: FEED_CAP }, (_, i) => ({ id: `n${i}`, ts: i }));
  const next = pushNotif(prev, { id: "new", ts: 999 });
  assert.equal(next.length, FEED_CAP);
  assert.equal(next[0].id, "new");
  assert.equal(next.at(-1).id, `n${FEED_CAP - 2}`);
  assert.equal(prev.length, FEED_CAP, "never a mutation");
});

test("unread counts only what is newer than the seen marker", () => {
  const items = [{ ts: 5 }, { ts: 10 }, { ts: 20 }];
  assert.equal(unreadCount(items, 0), 3);
  assert.equal(unreadCount(items, 10), 1);
  assert.equal(unreadCount(items, 20), 0);
  assert.equal(newestTs(items), 20);
  assert.equal(newestTs([]), 0);
});

test("the badge says 9+ past nine", () => {
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(9), "9");
  assert.equal(badgeText(10), "9+");
});

test("a backlog alert lands on a repo only when exactly one answers to its name", () => {
  const repos = [
    { worktreePath: "/home/x/dev/myapp" },
    { worktreePath: "/home/x/dev/other/" },
    { worktreePath: "/home/x/wt/twin" },
    { worktreePath: "/home/y/twin" },
  ];
  assert.equal(backlogRepoFor("Backlog groomed · myapp", repos), "/home/x/dev/myapp");
  assert.equal(backlogRepoFor("Backlog groomed · other", repos), "/home/x/dev/other/", "trailing slash still matches");
  assert.equal(backlogRepoFor("Backlog groomed · twin", repos), null, "two repos by that name: unscoped");
  assert.equal(backlogRepoFor("Backlog groomed · nope", repos), null);
  assert.equal(backlogRepoFor("Backlog groomed ·  ", repos), null, "no name: unscoped");
});
