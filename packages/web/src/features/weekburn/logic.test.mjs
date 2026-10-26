import { test } from "node:test";
import assert from "node:assert/strict";
import { PICK_NOTE, lastWeekHere, runningWords, sameAsLastOffered, saveVerb, savedToast, stopChoices, toggleDir } from "./logic.ts";

const status = (over = {}) => ({
  prefs: { repos: [], weekOf: null, recurring: false, lastRepos: ["/a", "/b"], stopPct: 95 },
  available: true, weeklyPct: 40, weeklyResetAt: 1, plan: null, pickedThisWeek: false, running: [],
  ...over,
});

test("same as last week: only with no pick this week and repos that still exist", () => {
  assert.equal(sameAsLastOffered(status(), ["/a", "/c"]), true);
  assert.deepEqual(lastWeekHere(status(), ["/b", "/a"]), ["/a", "/b"]);
  assert.equal(sameAsLastOffered(status({ pickedThisWeek: true }), ["/a"]), false);
  assert.equal(sameAsLastOffered(status(), ["/z"]), false);
  assert.equal(sameAsLastOffered(status({ prefs: { ...status().prefs, lastRepos: [] } }), ["/a"]), false);
});

test("save verb: empty pick is Cancel only when there is something to cancel", () => {
  assert.equal(saveVerb(2, false).kind, "save");
  assert.equal(saveVerb(2, true).label, "Change this week's pick");
  assert.equal(saveVerb(2, false).label, "Pick these for this week");
  assert.deepEqual(saveVerb(0, true), { kind: "cancel", label: "Cancel this week" });
  const none = saveVerb(0, false);
  assert.equal(none.kind, "none");
  assert.match(none.why, /Tick a repo/);
});

test("toggle keeps pick order; stop choices include an odd saved value once", () => {
  assert.deepEqual(toggleDir(["/a"], "/b"), ["/a", "/b"]);
  assert.deepEqual(toggleDir(["/a", "/b"], "/a"), ["/b"]);
  assert.deepEqual(stopChoices(95), [80, 90, 95, 100]);
  assert.deepEqual(stopChoices(97), [80, 90, 95, 97, 100]);
});

test("receipts and running words", () => {
  assert.match(savedToast(1), /^1 repo picked for the week-end burn\.$/);
  const at = new Date(2026, 9, 28, 18, 0).getTime();
  assert.match(savedToast(2, at), /^2 repos picked for the week-end burn · starts Wed \d/);
  assert.match(savedToast(3), /3 repos/);
  assert.match(savedToast(0), /Cancelled/);
  assert.equal(runningWords({ posted: 0, live: null }), "nothing posted yet");
  assert.equal(runningWords({ posted: 2, live: "x" }), "2 posted · one running now");
  assert.equal(runningWords({ posted: 6, live: null, stoppedText: "Stopped: 6 this week." }), "6 posted · Stopped: 6 this week.");
});

test("burn rows: worktrees only when picked, twin names told apart by path", async () => {
  const { burnRows } = await import("./logic.ts");
  const repo = (worktreePath, repoName, isPrimary = true, branch = "main") => ({ worktreePath, repoName, isPrimary, branch });
  const repos = [
    repo("/u/dev/garmin/ciqkit", "ciqkit"),
    repo("/u/dev/rewrite/out-ciqkit/ciqkit", "ciqkit"),
    repo("/u/dev/gm/.claude/worktrees/agent-a7", "gm", false, "worktree-agent-a7"),
    repo("/u/dev/gm/.claude/worktrees/agent-b8", "gm", false, "worktree-agent-b8"),
    repo("/u/dev/door-bell", "door-bell"),
  ];
  const { rows, hidden } = burnRows(repos, ["/u/dev/gm/.claude/worktrees/agent-b8"]);
  assert.equal(hidden, 1);
  assert.deepEqual(rows.map((r) => [r.title, r.where]), [
    ["ciqkit", "garmin/ciqkit"],
    ["ciqkit", "out-ciqkit/ciqkit"],
    ["gm · worktree-agent-b8", undefined],
    ["door-bell", undefined],
  ]);
});

test("hidden worktrees note: singular, plural, absent", async () => {
  const { hiddenWorktreesNote } = await import("./logic.ts");
  assert.equal(hiddenWorktreesNote(0), null);
  assert.equal(hiddenWorktreesNote(1), "1 agent worktree not listed — a burn commits on a repo's own branch.");
  assert.equal(hiddenWorktreesNote(3), "3 agent worktrees not listed — a burn commits on a repo's own branch.");
});

test("start line: English weekday, relative days", async () => {
  const { startLine, inWords } = await import("./logic.ts");
  const now = new Date(2026, 9, 25, 18, 0).getTime();
  const at = new Date(2026, 9, 28, 18, 0).getTime();
  assert.match(startLine(at, now), /^Starts Wed \S.* · in 3 days$/);
  assert.equal(inWords(40 * 60000), "in 40 min");
  assert.equal(inWords(5 * 3600e3), "in 5 h");
  assert.equal(inWords(0), "now");
});

test("the sheet says what a tick does: sessions, one commit each, nothing pushed", () => {
  assert.match(PICK_NOTE, /ticked repo gets unattended sessions/);
  assert.match(PICK_NOTE, /commits/);
  assert.match(PICK_NOTE, /Nothing is pushed/);
});
