/**
 * The session-text scan, lifted out of `SessionManager` so it can be asserted
 * without a PTY.
 *
 * The two caps are the reason this is worth pinning. They exist for the link,
 * not for tidiness: a frame carrying every match of a common word across every
 * open session is exactly the payload a bad tunnel cannot deliver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_CONTEXT_LINES,
  SEARCH_HITS_PER_SESSION,
  scanHistory,
  scanPrompts,
  scanText,
  searchResult,
} from "../dist/sessionSearch.js";

const BODY = ["alpha", "beta", "gamma", "TARGET here", "delta", "epsilon"].join("\n");

test("a hit carries context on both sides, so it reads in place", () => {
  const m = [];
  const total = scanText(BODY, "target", m, 0);
  assert.equal(total, 1);
  assert.equal(m[0].hit, "TARGET here");
  assert.deepEqual(m[0].before, ["beta", "gamma"]);
  assert.deepEqual(m[0].after, ["delta", "epsilon"]);
  assert.equal(m[0].before.length, SEARCH_CONTEXT_LINES);
});

test("the match is case-insensitive but the LINE is returned verbatim", () => {
  const m = [];
  scanText("Fixing the Widget", "widget", m, 0);
  assert.equal(m[0].hit, "Fixing the Widget");
});

test("context is clipped at the edges rather than padded", () => {
  const m = [];
  scanText("hit\nafter", "hit", m, 0);
  assert.deepEqual(m[0].before, []);
  assert.deepEqual(m[0].after, ["after"]);
});

test("hits stop being COLLECTED at the cap but keep being COUNTED", () => {
  // "40 of 300" is a true sentence. "40" on its own is not, and it is what the
  // sheet would say if the cap also stopped the counter.
  const many = Array.from({ length: 300 }, () => "needle").join("\n");
  const m = [];
  const total = scanText(many, "needle", m, 0);
  assert.equal(m.length, SEARCH_HITS_PER_SESSION);
  assert.equal(total, 300);
});

test("a running total carries across several bodies", () => {
  const m = [];
  let total = scanText("needle", "needle", m, 0);
  total = scanText("needle", "needle", m, total);
  assert.equal(total, 2);
});

test("history scans the prompt AND the output, labelled by turn", () => {
  const { matches, total } = scanHistory([
    { id: "a", kind: "prompt", text: "fix the needle", sentAt: 1, output: "no needle found" },
    { id: "b", kind: "prompt", text: "unrelated", sentAt: 2 },
  ], "needle");
  assert.equal(total, 2, "the prompt and its output both count");
  assert.ok(matches.every((x) => x.turn), "every history hit says which turn it came from");
  assert.equal(matches[0].turn.sentAt, 1);
});

test("prompts scans what was SENT and never the output it got back", () => {
  // The whole reason the scope exists: "needle" is in the reply to every turn,
  // so `history` answers "where did I ask for this" with the CLI's own words.
  const turns = [
    { id: "a", kind: "prompt", text: "fix the needle", sentAt: 1, output: "needle\nneedle\nneedle" },
    { id: "b", kind: "command", text: "/needle", sentAt: 2, output: "no" },
    { id: "c", kind: "backlog", text: "unrelated", sentAt: 3, output: "needle" },
  ];
  const { matches, total } = scanPrompts(turns, "needle");
  assert.equal(total, 2, "the two prompts, and none of the four output lines");
  assert.deepEqual(matches.map((m) => m.turn.kind), ["prompt", "command"], "a slash command was sent too");
  assert.equal(scanHistory(turns, "needle").total, 6, "history still counts both sides");
});

test("a prompts hit says which turn it came from", () => {
  const { matches } = scanPrompts([{ id: "a", kind: "backlog", text: "the needle item", sentAt: 7 }], "needle");
  assert.equal(matches[0].turn.sentAt, 7);
  assert.equal(matches[0].turn.kind, "backlog");
});

test("an empty body is not a match", () => {
  const m = [];
  assert.equal(scanText("", "x", m, 0), 0);
  assert.equal(m.length, 0);
});

test("a session with no hits is absent from the results, not present and empty", () => {
  const t = { id: "s1", title: "t", cwd: "/repo/app", running: true };
  assert.equal(searchResult(t, [], 0), null);
  const r = searchResult(t, [{ before: [], hit: "x", after: [] }], 1);
  assert.equal(r.repoLabel, "app", "the label is the worktree's own folder name");
  assert.equal(r.total, 1);
});
