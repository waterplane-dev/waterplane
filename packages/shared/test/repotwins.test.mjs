/**
 * Two discovered repos with one name (`repotwins.ts`) — the 2026-10-28 week-end
 * burn went to a history-rewrite leftover that read exactly like the real repo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REPO_DISPLAY_NAME_MAX, cleanRepoDisplayName, repoBranchLabel, repoLabel, repoNameMatches, repoShown, shownTitle, shownTitleIn, shownTitleOf, twinWheres, withShownName } from "../dist/index.js";

test("twins get the shortest parent tail that tells them apart; a lone name gets nothing", () => {
  const w = twinWheres([
    { name: "ciqkit", dir: "/Users/j/dev/garmin/ciqkit" },
    { name: "ciqkit", dir: "/Users/j/dev/waterplane-rewrite/out-ciqkit/ciqkit" },
    { name: "door-bell", dir: "/Users/j/dev/door-bell" },
  ]);
  assert.equal(w.get("/Users/j/dev/garmin/ciqkit"), "garmin/");
  assert.equal(w.get("/Users/j/dev/waterplane-rewrite/out-ciqkit/ciqkit"), "out-ciqkit/");
  assert.equal(w.has("/Users/j/dev/door-bell"), false);
});

test("a shared last parent reaches one segment further back", () => {
  const w = twinWheres([
    { name: "app", dir: "/a/work/app" },
    { name: "app", dir: "/b/work/app" },
  ]);
  assert.equal(w.get("/a/work/app"), "a/work/");
  assert.equal(w.get("/b/work/app"), "b/work/");
});

test("one parent ending the other: the short one says its whole path, never a label that repeats", () => {
  const w = twinWheres([
    { name: "x", dir: "/dev/x" },
    { name: "x", dir: "/home/dev/x" },
  ]);
  assert.equal(w.get("/home/dev/x"), "home/dev/");
  assert.equal(w.get("/dev/x"), "/dev/");
  assert.notEqual(w.get("/dev/x"), w.get("/home/dev/x"));
});

test("the same dir listed twice is one clone, not a twin", () => {
  assert.equal(twinWheres([{ name: "x", dir: "/a/x" }, { name: "x", dir: "/a/x" }]).size, 0);
});

test("repoLabel: bare name without `where`, name · where with it", () => {
  assert.equal(repoLabel({ repoName: "door-bell" }), "door-bell");
  assert.equal(repoLabel({ repoName: "ciqkit", where: "garmin/" }), "ciqkit · garmin/");
});

// ── a name a person gave the repo, SHOWN instead of the folder's ─────────────

test("repoShown prints the display name, else the folder name; a twin keeps its `where`; repoLabel stays the KEY", () => {
  assert.equal(repoShown({ repoName: "myapp" }), "myapp");
  assert.equal(repoShown({ repoName: "myapp", displayName: "waterplane" }), "waterplane");
  assert.equal(repoShown({ repoName: "ciqkit", where: "garmin/", displayName: "kit" }), "kit · garmin/");
  // The key never moves: colours, folds, focus and filters group by it.
  assert.equal(repoLabel({ repoName: "myapp", displayName: "waterplane" }), "myapp");
});

test("withShownName feeds a printer of `repoName` without touching the stored one", () => {
  const r = { repoName: "myapp", displayName: "waterplane", branch: "feature", isPrimary: true };
  assert.equal(repoBranchLabel(withShownName(r)), "waterplane · feature");
  assert.equal(repoBranchLabel(r), "myapp · feature");
  assert.equal(r.repoName, "myapp");
  const bare = { repoName: "myapp" };
  assert.equal(withShownName(bare), bare);
});

test("cleanRepoDisplayName: empty is 'use the folder name'; a bad name is refused in words, never cut", () => {
  assert.deepEqual(cleanRepoDisplayName("  waterplane  "), { ok: true, value: "waterplane" });
  assert.deepEqual(cleanRepoDisplayName("a   b"), { ok: true, value: "a b" });
  assert.deepEqual(cleanRepoDisplayName("   "), { ok: true, value: null });
  assert.deepEqual(cleanRepoDisplayName(null), { ok: true, value: null });
  const long = cleanRepoDisplayName("x".repeat(REPO_DISPLAY_NAME_MAX + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /at most 40/);
  assert.equal(cleanRepoDisplayName("two\nlines").ok, false);
  assert.equal(cleanRepoDisplayName(7).ok, false);
});

test("shownTitle rewords only a whole leading folder name, never a longer word or the middle of a title", () => {
  assert.equal(shownTitle("myapp", "myapp", "waterplane"), "waterplane");
  assert.equal(shownTitle("myapp · main", "myapp", "waterplane"), "waterplane · main");
  assert.equal(shownTitle("myapp · garmin/ · feat", "myapp", "waterplane"), "waterplane · garmin/ · feat");
  assert.equal(shownTitle("myappx · main", "myapp", "waterplane"), "myappx · main");
  assert.equal(shownTitle("fix myapp lint", "myapp", "waterplane"), "fix myapp lint");
  assert.equal(shownTitle("myapp · main", "myapp", "myapp"), "myapp · main");
  assert.equal(shownTitleOf({ repoName: "myapp" }, "myapp · main"), "myapp · main");
  assert.equal(shownTitleOf(null, "myapp · main"), "myapp · main");
});

test("shownTitleIn finds the repo by its leading folder name, the longest one winning", () => {
  const repos = [{ repoName: "app", displayName: "A" }, { repoName: "app · web", displayName: "W" }, { repoName: "other" }];
  assert.equal(shownTitleIn(repos, "app · web · main"), "W · main");
  assert.equal(shownTitleIn(repos, "app · main"), "A · main");
  assert.equal(shownTitleIn(repos, "other · main"), "other · main");
});

test("a search finds a repo by either name", () => {
  const r = { repoName: "myapp", displayName: "waterplane" };
  assert.equal(repoNameMatches(r, "mya"), true);
  assert.equal(repoNameMatches(r, "WATER"), true);
  assert.equal(repoNameMatches(r, "garmin"), false);
  assert.equal(repoNameMatches(r, "  "), true);
  assert.equal(repoNameMatches({ repoName: "myapp" }, "water"), false);
});

test("cleanRepoDisplayName: invisible, format and bidi characters are not a name", () => {
  assert.equal(cleanRepoDisplayName("​".repeat(40)).ok, false, "zero-width spaces");
  assert.equal(cleanRepoDisplayName("a\ufeffb").ok, false, "BOM inside");
  assert.equal(cleanRepoDisplayName("\u200d\u200d").ok, false, "joiners only");
  assert.equal(cleanRepoDisplayName("a\u0085b").ok, false, "NEL (C1)");
  assert.equal(cleanRepoDisplayName("a‮b").ok, false, "right-to-left override");
  assert.equal(cleanRepoDisplayName("a‏b").ok, false, "RLM");
  assert.deepEqual(cleanRepoDisplayName("a 　b"), { ok: true, value: "a b" }, "other spaces collapse to one space");
  assert.deepEqual(cleanRepoDisplayName("Ünï".normalize("NFD")), { ok: true, value: "Ünï" }, "normalised to NFC");
  assert.deepEqual(cleanRepoDisplayName("水面"), { ok: true, value: "水面" });
});
