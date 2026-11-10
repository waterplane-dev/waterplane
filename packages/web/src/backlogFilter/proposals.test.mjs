/**
 * The launcher's proposals strip: one call gives the number, the per-repo
 * doors and the ids each door opens — a count is a filter.
 *
 *     node --test packages/web/src/backlogFilter/proposals.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { proposalCut, proposalsCutLabel, proposalsHeadline, proposersWords } from "./proposals.ts";

const row = (id, over = {}) => ({ id, repoDir: "/r/garmin", origin: "proposed:crash-findings.py", manual: true, status: "queued", ...over });

test("only waiting proposals count, grouped by repo, and the ids ARE the count", () => {
  const items = [
    row("a"),
    row("b", { repoDir: "/r/notes", origin: "proposed:nightly" }),
    row("c"),
    row("fired", { status: "running" }),
    row("done", { status: "done" }),
    row("aside", { archived: true }),
    row("timed", { at: { rule: {}, graceMin: 5, nextAt: 1 } }),
    row("agent", { origin: "agent" }),
    row("mine", { origin: undefined, manual: undefined }),
  ];
  const cut = proposalCut(items);
  assert.equal(cut.total, 3);
  assert.deepEqual(cut.repos.map((r) => [r.dir, r.ids]), [["/r/garmin", ["a", "c"]], ["/r/notes", ["b"]]]);
  assert.equal(cut.repos.reduce((n, r) => n + r.ids.length, 0), cut.total, "the doors add up to the strip's number");
  assert.deepEqual(cut.repos[0].proposers, ["crash-findings.py"]);
});

test("nothing pending ⇒ zero, and the strip is not drawn", () => {
  assert.deepEqual(proposalCut([row("x", { status: "done" })]), { total: 0, repos: [] });
});

test("the words", () => {
  assert.equal(proposalsHeadline(1), "1 proposal waits for you");
  assert.equal(proposalsHeadline(3), "3 proposals wait for you");
  assert.equal(proposalsCutLabel(1, "garmin"), "the proposal in garmin");
  assert.equal(proposalsCutLabel(2, "garmin"), "the 2 proposals in garmin");
  assert.equal(proposersWords(["a"]), "a");
  assert.equal(proposersWords(["a", "b"]), "2 scripts");
  assert.equal(proposersWords([]), "a script");
});
