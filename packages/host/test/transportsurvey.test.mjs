/**
 * The cross-repo transport survey: the ranking, and what it does when it
 * cannot count.
 *
 * The survey's whole job is to say which repo to go and delete things in, so
 * the two ways it can be wrong both end in somebody deleting from the wrong
 * place: a repo ranked by a number that is not its size, or a number that is a
 * floor presented as a total.
 *
 * It walks nothing of its own — every tally is `listTransport`, the same
 * function the per-repo sweep serves its rows from — so what is pinned here is
 * the loop, the ranking and the bound, not the listing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { surveyTransport } = await import("../dist/transportsurvey.js");
const { summarizeSurvey } = await import("@waterplane/shared");

/** A root holding real git repos — `discoverTargets` enumerates worktrees, so a
 *  plain directory is not a repo and would not appear. */
function root(spec) {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-survey-"));
  for (const [name, files] of Object.entries(spec)) {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    for (const [rel, size] of Object.entries(files)) {
      const full = join(repo, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "x".repeat(size));
    }
  }
  return dir;
}

test("repos are ranked by what their transport directories hold", async () => {
  const dir = root({
    small: { ".claude/outbox/a.apk": 10 },
    big: { ".claude/outbox/a.apk": 1_000, ".claude/inbox/p.jpg": 500 },
    middling: { ".claude/inbox/p.jpg": 100 },
  });
  const s = await surveyTransport(dir, 42);
  assert.equal(s.at, 42);
  assert.deepEqual(s.repos.map((r) => r.repoName), ["big", "middling", "small"]);
  assert.equal(s.total.count, 4);
  assert.equal(s.total.bytes, 1_610);
  assert.equal(s.partial, false);
});

test("the two scopes are separate numbers — the survey never folds them", async () => {
  const dir = root({ one: { ".claude/outbox/a.apk": 1_000, ".claude/inbox/p.jpg": 5 } });
  const s = await surveyTransport(dir);
  const row = s.repos[0];
  // Each is its own tap target into its own scope; a combined figure could not
  // say which sweep it would open.
  assert.deepEqual(row.outbox, { count: 1, bytes: 1_000 });
  assert.deepEqual(row.inbox, { count: 1, bytes: 5 });
});

test("a repo with no transport directories is 0, and still a row", async () => {
  const dir = root({ empty: { "src/main.ts": 20 }, full: { ".claude/outbox/a.apk": 10 } });
  const s = await surveyTransport(dir);
  const empty = s.repos.find((r) => r.repoName === "empty");
  // Zero, not null: "this repo is clean" is an answer, and a missing row reads
  // as a repo the survey failed to see.
  assert.deepEqual(empty.outbox, { count: 0, bytes: 0 });
  assert.deepEqual(empty.inbox, { count: 0, bytes: 0 });
  assert.equal(s.repos.length, 2);
});

test("source files are never counted — only the two transport directories", async () => {
  const dir = root({ one: { "src/huge.bin": 100_000, ".claude/outbox/a.apk": 7 } });
  const s = await surveyTransport(dir);
  assert.equal(s.total.bytes, 7);
});

// ── the ranking and the totals, pinned without a disk ──────────────────────

test("an uncounted repo sorts last and makes the total absent", () => {
  const rows = [
    { repoId: "a", repoName: "a", branch: "main", isPrimary: true, outbox: { count: 1, bytes: 10 }, inbox: { count: 0, bytes: 0 } },
    { repoId: "b", repoName: "b", branch: "main", isPrimary: true, outbox: null, inbox: { count: 0, bytes: 0 } },
    { repoId: "c", repoName: "c", branch: "main", isPrimary: true, outbox: { count: 2, bytes: 99 }, inbox: { count: 0, bytes: 0 } },
  ];
  const s = summarizeSurvey(rows);
  assert.deepEqual(s.repos.map((r) => r.repoId), ["c", "a", "b"]);
  // Not 109. A floor printed as a total is the one lie a screen about deleting
  // must not tell — the flag is what lets it say "at least" instead.
  assert.equal(s.total, null);
  assert.equal(s.partial, true);
});

test("with everything counted the total is the sum and partial is false", () => {
  const s = summarizeSurvey([
    { repoId: "a", repoName: "a", branch: "main", isPrimary: true, outbox: { count: 1, bytes: 10 }, inbox: { count: 1, bytes: 1 } },
    { repoId: "b", repoName: "b", branch: "main", isPrimary: true, outbox: { count: 0, bytes: 0 }, inbox: { count: 3, bytes: 30 } },
  ]);
  assert.equal(s.partial, false);
  assert.deepEqual(s.total, { count: 5, bytes: 41 });
});
