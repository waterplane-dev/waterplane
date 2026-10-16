/**
 * The follow-up flag store (`sessions/roster.ts`, R-sessions-041): keyed by
 * conversation, survives a restart and a close, only an explicit clear removes
 * it, and only a flag nobody tapped asks for a push.
 *
 * A fake core: the store is the thing under test; the PTY paths are e2e's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RosterSlice } from "../dist/sessions/roster.js";

function setup({ root, closed } = {}) {
  root ??= mkdtempSync(join(tmpdir(), "waterplane-followup-"));
  if (closed) {
    mkdirSync(join(root, ".waterplane"), { recursive: true });
    writeFileSync(join(root, ".waterplane", "closed.json"), JSON.stringify(closed));
  }
  const emitted = [];
  const sessions = new Map();
  const core = { root, sessions, hasLiveTmux: () => false, checkAgents: () => {}, emit: (...a) => { emitted.push(a); return true; } };
  return { r: new RosterSlice(core), root, emitted, sessions };
}

const live = (id, cid) => ({ info: { id, cwd: "/r", title: "t", createdAt: 1, claudeSessionId: cid }, history: [] });

test("a hand flag lands on the session, pushes nothing, and survives a restart by conversation", () => {
  const { r, root, emitted, sessions } = setup();
  sessions.set("s1", live("s1", "conv-1"));
  assert.equal(r.setFollowUp("s1", { by: "hand", at: 5 }), true);
  assert.deepEqual(sessions.get("s1").info.followUp, { by: "hand", at: 5 });
  assert.ok(emitted.some(([e]) => e === "updated"));
  assert.ok(!emitted.some(([e]) => e === "followUp"), "a tap is not news to the person who tapped");

  // A new host, the same conversation under a new boot id.
  const again = setup({ root });
  const info = { id: "s9", cwd: "/r", title: "t", createdAt: 2, claudeSessionId: "conv-1" };
  again.r.applyFollowUp(info);
  assert.deepEqual(info.followUp, { by: "hand", at: 5 });
  rmSync(root, { recursive: true, force: true });
});

test("a flag nobody tapped asks for a push", () => {
  const { r, root, emitted, sessions } = setup();
  sessions.set("s1", live("s1", "conv-1"));
  r.setFollowUp("s1", { by: "agent", at: 5, reason: "read the migration" });
  const ev = emitted.find(([e]) => e === "followUp");
  assert.equal(ev[2].reason, "read the migration");
  rmSync(root, { recursive: true, force: true });
});

test("attaching never clears it; an explicit clear does, from a closed row by conversation id", () => {
  const closed = [{ id: "s1", cwd: "/r", title: "t", closedAt: 9, claudeSessionId: "conv-1" }];
  const { r, root, sessions } = setup({ closed });
  sessions.set("s1", live("s1", "conv-1"));
  r.setFollowUp("s1", { by: "launch", at: 5, item: "nightly" });
  r.setWatched(new Set(["s1"]));
  assert.equal(sessions.get("s1").info.followUp?.by, "launch");
  sessions.delete("s1");
  assert.equal(r.listClosed()[0].followUp?.item, "nightly", "the closed row still says it");
  assert.equal(r.setFollowUp("conv-1", null), true);
  assert.equal(r.listClosed()[0].followUp, undefined);
  assert.equal(r.followUpOf("conv-1"), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("an unknown id with nothing stored is a no-op", () => {
  const { r, root, emitted } = setup();
  assert.equal(r.setFollowUp("nobody", { by: "hand", at: 1 }), false);
  assert.equal(emitted.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("a stored flag with an unknown author is dropped on read, never rounded", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-followup-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  writeFileSync(join(root, ".waterplane", "followups.json"), JSON.stringify({ a: { by: "robot", at: 1 }, b: { by: "hand", at: 2 } }));
  const { r } = setup({ root });
  assert.equal(r.followUpOf("a"), undefined);
  assert.equal(r.followUpOf("b")?.by, "hand");
  rmSync(root, { recursive: true, force: true });
});
