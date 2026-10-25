import test from "node:test";
import assert from "node:assert/strict";

import { FEED_CAP, backlogRepoFor, badgeText, newestTs, notifTarget, pushNotif, unreadCount } from "./logic.ts";

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

test("every tapped alert lands somewhere — its own target, else its row in the feed", () => {
  const f = { repoId: "r", relPath: "a.md", name: "a.md", size: 1 };
  assert.deepEqual(notifTarget({ kind: "artifact", file: f, sessionId: "s1" }), { to: "file" });
  assert.deepEqual(notifTarget({ kind: "approval", plugin: "vault" }), { to: "plugin", id: "vault" });
  assert.deepEqual(notifTarget({ kind: "plugin", plugin: "vault", sessionId: "s1" }), { to: "session", sessionId: "s1" }, "a session beats the plugin screen");
  assert.deepEqual(notifTarget({ kind: "image", image: { repoId: "r", relPath: "x.png" }, sessionId: "s1" }), { to: "image" });
  assert.deepEqual(notifTarget({ kind: "prompt", sessionId: "s1" }), { to: "session", sessionId: "s1" });
  assert.deepEqual(notifTarget({ kind: "backlog", backlog: { cwd: "/d/x", ids: ["a"] } }), { to: "backlog", cwd: "/d/x", ids: ["a"] });
  assert.deepEqual(notifTarget({ kind: "backlog" }), { to: "backlogByName" }, "an older backlog alert: by name");
  assert.deepEqual(notifTarget({ kind: "health", open: { to: "repohealth", repoId: "r1" } }), { to: "repohealth", repoId: "r1" });
  assert.deepEqual(notifTarget({ kind: "burn", open: { to: "tokens" } }), { to: "tokens" });
  assert.deepEqual(notifTarget({ kind: "info", open: { to: "plugin", id: "someplugin" } }), { to: "plugin", id: "someplugin" });
  // The floor: nothing named, an older host, or a `to` this bundle does not know.
  assert.deepEqual(notifTarget({ kind: "health" }), { to: "row" });
  assert.deepEqual(notifTarget({ kind: "info" }), { to: "row" });
  assert.deepEqual(notifTarget({ kind: "info", open: { to: "somewhere-new" } }), { to: "row" });
  assert.deepEqual(notifTarget({ kind: "health", open: { to: "repohealth" } }), { to: "row" }, "no repo id: the row");
});

test("a week-end burn alert opens its sheet, by kind", () => {
  assert.deepEqual(notifTarget({ kind: "weekburn" }), { to: "weekburn" });
});
