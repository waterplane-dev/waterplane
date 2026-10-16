/**
 * The follow-up flag as a filter and a count (`followUpFacts.ts`), and where
 * the launch option may be asked (`flagWhenDoneOffered`, sendLabels.ts).
 *
 *     node --test packages/web/src/core/sessions/followUpFacts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { flaggedByRepoOf, flaggedChipTitle, flaggedTotalOf, isFlagged } from "./followUpFacts.ts";
import { flagWhenDoneOf, flagWhenDoneOffered, targetWords } from "../../sendIntent.ts";
import { entryFrame } from "../queue/logic.ts";

const repoOf = (s) => s.cwd.split("/").pop();
const ses = (id, cwd, by) => ({ id, cwd, title: id, ...(by ? { followUp: { by, at: 1 } } : {}) });

test("the count and the cut are one predicate: whoever set it, a flag counts", () => {
  const list = [ses("a1", "/r/a", "hand"), ses("a2", "/r/a", "agent"), ses("a3", "/r/a"), ses("b1", "/r/b", "launch")];
  assert.deepEqual(list.filter(isFlagged).map((s) => s.id), ["a1", "a2", "b1"]);
  const m = flaggedByRepoOf(list, repoOf);
  assert.deepEqual(m.get("a"), { n: 2, tone: "mixed" }, "two setters: neutral");
  assert.deepEqual(m.get("b"), { n: 1, tone: "launch" });
  assert.equal(m.has("c"), false);
  // the total's number is the per-repo numbers summed, so its tap shows them all
  assert.deepEqual(flaggedTotalOf(m), { n: 3, tone: "mixed" });
  assert.equal(flaggedTotalOf(new Map()), null);
  assert.deepEqual(flaggedTotalOf(flaggedByRepoOf([ses("x", "/r/a", "agent"), ses("y", "/r/b", "agent")], repoOf)), { n: 2, tone: "agent" });
});

test("a chip's title names the cut its tap opens", () => {
  assert.equal(flaggedChipTitle(1, "app"), "1 session flagged for follow up in app — tap to show only that one");
  assert.equal(flaggedChipTitle(3), "3 sessions flagged for follow up — tap to show only those");
});

test("flag-when-done is asked only where the desktop opens the session, and rides only there", () => {
  const repo = { kind: "repo", cwd: "/r/a", flagWhenDone: true };
  const repos = { kind: "repos", dirs: ["/r/a"], flagWhenDone: true };
  const at = { kind: "at", rule: { kind: "once", at: 1 }, graceMin: 60 };
  assert.equal(flagWhenDoneOffered(repo, { kind: "now" }), false, "a repo now is a session the person opened");
  assert.equal(flagWhenDoneOffered(repo, { kind: "idle" }), true);
  assert.equal(flagWhenDoneOffered(repo, at), true);
  assert.equal(flagWhenDoneOffered(repos, { kind: "now" }), true, "the fan-out");
  assert.equal(flagWhenDoneOffered(repos, at), false, "a sweep's schedule has no field for it");
  assert.equal(flagWhenDoneOffered({ kind: "session", sessionId: "s", cwd: "/r/a" }, { kind: "idle" }), false);
  assert.equal(flagWhenDoneOf(repo, { kind: "now" }), undefined, "a left-over tick is not sent");
  assert.equal(flagWhenDoneOf(repo, { kind: "idle" }), true);
  assert.equal(flagWhenDoneOf({ ...repo, flagWhenDone: undefined }, { kind: "idle" }), undefined, "off unless ticked");
  const names = { repoName: () => "app", sessionTitle: () => "s", buildName: () => "b" };
  assert.match(targetWords(repo, names, { kind: "idle" }), /flagged when done/);
  assert.doesNotMatch(targetWords(repo, names, { kind: "now" }), /flagged/);
});

test("a queued backlog row carries the tick to backlog.add, and says nothing when off", () => {
  const row = { ackId: "a", sessionId: "/r/a", cwd: "/r/a", text: "go", ts: 1, status: "queued", mode: "backlog" };
  assert.equal(entryFrame({ ...row, flagWhenDone: true }).flagWhenDone, true);
  assert.equal("flagWhenDone" in entryFrame(row), false);
});
