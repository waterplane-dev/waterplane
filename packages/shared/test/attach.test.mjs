// What became of the FILES a prompt names (`shared/src/attach.ts`). The load-
// bearing distinction: `unknown` (the host could not be asked — a dead tunnel)
// is never collapsed into `missing` (the host was asked and hasn't got it — a
// lost photo).
import test from "node:test";
import assert from "node:assert/strict";
import { attachBlockers, attachState, attachStatuses, attachmentsReady } from "../dist/index.js";

const facts = (over = {}) => ({ onHost: [], sending: [], kept: [], dead: {}, ...over });
const P = ".claude/inbox/shot-1.jpg";

test("the host's own listing outranks everything else", () => {
  assert.equal(attachState(P, facts({ onHost: [P], sending: [P], kept: [P], dead: { [P]: "canceled" } })), "host");
});

test("the ranking below the host is queue, then kept bytes, then a death record", () => {
  assert.equal(attachState(P, facts({ sending: [P], kept: [P], dead: { [P]: "x" } })), "sending");
  assert.equal(attachState(P, facts({ kept: [P], dead: { [P]: "x" } })), "kept");
  assert.equal(attachState(P, facts({ dead: { [P]: "x" } })), "dead");
});

test("unknown (host unasked) is not missing (host asked, hasn't got it)", () => {
  assert.equal(attachState(P, facts({ onHost: null })), "unknown");
  assert.equal(attachState(P, facts({ onHost: [] })), "missing");
  // A dead tunnel must not report a file the host has as gone…
  assert.equal(attachState(P, facts({ onHost: null, kept: [P] })), "kept");
});

test("attachStatuses keeps the named order and carries the death reason", () => {
  const out = attachStatuses(["a.png", "b.png"], facts({ onHost: ["a.png"], dead: { "b.png": "upload canceled" } }));
  assert.deepEqual(out.map((s) => s.relPath), ["a.png", "b.png"]);
  assert.equal(out[0].why, undefined);
  assert.equal(out[1].why, "upload canceled");
});

test("only host and sending are sendable — kept is one tap short", () => {
  assert.equal(attachmentsReady([{ relPath: "a", state: "host" }, { relPath: "b", state: "sending" }]), true);
  assert.equal(attachmentsReady([{ relPath: "a", state: "kept" }]), false);
  assert.equal(attachmentsReady([{ relPath: "a", state: "unknown" }]), false);
  assert.equal(attachmentsReady([]), true); // a prompt naming no files
});

test("blockers come back fixable-first, and never include a sendable file", () => {
  const states = [
    { relPath: "u", state: "unknown" }, { relPath: "h", state: "host" },
    { relPath: "m", state: "missing" }, { relPath: "k", state: "kept" },
    { relPath: "d", state: "dead" }, { relPath: "s", state: "sending" },
  ];
  assert.deepEqual(attachBlockers(states).map((s) => s.relPath), ["k", "d", "m", "u"]);
});
