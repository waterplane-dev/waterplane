import test from "node:test";
import assert from "node:assert/strict";

import { FEED_CAP, backlogRepoFor, badgeText, resolvedWords, levelWords, feedCut, feedSections, handledWords, needsYouCount, needsYouItems, newlyResolved, notifTarget, pushNotif } from "./logic.ts";

test("a live push goes to the front and the feed stays capped", () => {
  const prev = Array.from({ length: FEED_CAP }, (_, i) => ({ id: `n${i}`, ts: i }));
  const next = pushNotif(prev, { id: "new", ts: 999 });
  assert.equal(next.length, FEED_CAP);
  assert.equal(next[0].id, "new");
  assert.equal(next.at(-1).id, `n${FEED_CAP - 2}`);
  assert.equal(prev.length, FEED_CAP, "never a mutation");
});

const att = (id, extra = {}) => ({ id, ts: 1, kind: "prompt", ...extra });
const inf = (id, extra = {}) => ({ id, ts: 1, kind: "artifact", ...extra });

test("the bell counts needs-you items only: info never, handled never", () => {
  const items = [att("a"), att("b", { handled: { at: 1, by: "person" } }), inf("c"), inf("d", { level: "attention" }), att("e", { level: "info" })];
  assert.equal(needsYouCount(items), 2);
  assert.deepEqual(needsYouItems(items).map((n) => n.id), ["a", "d"]);
  assert.equal(needsYouCount([inf("x")]), 0);
});

test("a tap on the count opens exactly those: the cut is the same predicate (n of N)", () => {
  const items = [att("a"), inf("c"), att("b", { handled: { at: 1, by: "person" } }), att("e")];
  const ids = needsYouItems(items).map((n) => n.id);
  const cut = feedCut(items, ids);
  assert.equal(cut.shown.length, needsYouCount(items));
  assert.equal(cut.total, 4);
  assert.ok(cut.filtered);
  assert.equal(feedCut(items, null).filtered, false);
  assert.equal(feedCut(items, null).shown.length, 4);
});

test("sections: unhandled needs-you, handled below, information apart", () => {
  const s = feedSections([att("a"), att("h", { handled: { at: 1, by: "person" } }), inf("i")]);
  assert.deepEqual([s.needs.length, s.handled.length, s.info.length], [1, 1, 1]);
});

test("the cap never drops an unhandled attention item", () => {
  const prev = [att("old-a", { ts: 0 }), ...Array.from({ length: FEED_CAP + 5 }, (_, i) => inf(`i${i}`))];
  const next = pushNotif(prev, inf("new"));
  assert.equal(next.length, FEED_CAP);
  assert.ok(next.some((n) => n.id === "old-a"));
  assert.equal(next[0].id, "new");
  const many = Array.from({ length: FEED_CAP + 3 }, (_, i) => att(`a${i}`));
  assert.equal(pushNotif(many, att("z")).length, FEED_CAP + 4, "all attention kept");
});

test("a cause going away is toasted once: only chip keys, unhandled-before, resolved-now", () => {
  const prev = [att("a", { key: "git:r:push" }), att("b"), att("c", { handled: { at: 1, by: "resolved", note: "old" } }), att("p"), att("r", { key: "build:r" })];
  const next = [att("a", { key: "git:r:push", title: "Push failed · myapp", handled: { at: 2, by: "resolved", note: "fixed by the 14:02 push" } }), att("b", { handled: { at: 2, by: "person" } }), att("c", { handled: { at: 1, by: "resolved", note: "old" } }), att("n", { handled: { at: 2, by: "resolved" } }), att("p", { handled: { at: 2, by: "resolved", note: "answered" } }), att("r", { key: "build:r", handled: { at: 2, by: "resolved", note: "replaced by a newer one" } })];
  assert.deepEqual(newlyResolved(prev, next).map((n) => n.id), ["a"], "prompts and supersedes are silent");
  assert.equal(resolvedWords(next[0]), "Push failed · myapp — fixed by the 14:02 push");
  assert.deepEqual(newlyResolved(next, next), [], "a repeat list says nothing");
  assert.deepEqual(newlyResolved([], next), [], "a first list never toasts history");
});

test("handled words: the host's note, else done HH:MM", () => {
  assert.equal(handledWords({ at: 0, by: "resolved", note: "fixed by the 14:02 push" }), "fixed by the 14:02 push");
  assert.match(handledWords({ at: Date.now(), by: "person" }), /^done \d\d:\d\d$/);
});

test("git and build opens route to their screens", () => {
  assert.deepEqual(notifTarget({ kind: "git", open: { to: "git", repoId: "r1" } }), { to: "git", repoId: "r1" });
  assert.deepEqual(notifTarget({ kind: "git", open: { to: "build", repoId: "r1", buildId: "b" } }), { to: "build", repoId: "r1", buildId: "b" });
  assert.deepEqual(notifTarget({ kind: "git", open: { to: "elsewhere" } }), { to: "row" });
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

test("an exposure push opens that repo's readings; without a repo id it lands on its row", () => {
  assert.deepEqual(notifTarget({ kind: "exposure", open: { to: "setup", repoId: "r1" } }), { to: "setup", repoId: "r1" });
  assert.deepEqual(notifTarget({ kind: "exposure", open: { to: "setup" } }), { to: "row" });
});

test("followup's level words say the launch flag is information", () => {
  assert.match(levelWords("followup"), /launch option's flag is information/);
});
