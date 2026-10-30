/**
 * One notification item, built once (bughunt 2026-10-29 review A3c M1).
 *
 * The attention store files the item and enriches it (a failed push's `branch`). That stored
 * item IS what the live `notification` frame carries and what the OS push carries — never a
 * second hand-built copy that drops a field. An information item has no store; the frame and
 * the push are still the one item.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createClients } = await import("../dist/server/clients.js");
const { AttentionStore } = await import("../dist/attentionstore.js");
const { gitAttentionKey } = await import("@waterplane/shared");

function fakeWs() {
  return { OPEN: 1, readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {}, terminate() {} };
}

function wired() {
  const pushed = [];
  const c = createClients({
    auth: { passive: {} }, notifyPrefs: { enabled: () => true, pushInfo: () => true, get: () => ({}) },
    push: { notify: async (p) => { pushed.push(JSON.parse(JSON.stringify(p))); } }, sessions: { list: () => [] },
    attention: new AttentionStore(null),
  });
  const ws = fakeWs();
  c.clients.add(ws);
  const frames = () => ws.sent.filter((m) => m.t === "notification").map((m) => m.item);
  return { c, pushed, frames };
}

const key = gitAttentionKey("rid", "push");
const sha = "a".repeat(40);

test("a failed push: the live frame and the push carry the branch the store filed", () => {
  const { c, pushed, frames } = wired();
  c.notify("git", { title: "Push failed · a", body: "x", outcome: "failed", key, tag: "git-rid-push-feature", detail: "log", pushHead: { branch: "feature", sha } });
  const [stored] = c.attention.items();
  assert.equal(stored.branch, "feature");
  const [frame] = frames();
  assert.equal(frame.branch, "feature", "the live frame is the stored item, branch included");
  assert.deepEqual(frame, JSON.parse(JSON.stringify(stored)), "the frame IS the stored item");
  assert.equal(pushed[0].branch, "feature", "the OS push carries the branch too");
  assert.equal(pushed[0].key, key);
  assert.equal(pushed[0].id, stored.id);
  for (const p of [frame, pushed[0]]) {
    assert.equal("detail" in p, false, "host-only text never rides");
    assert.equal("pushHead" in p, false, "host-only head never rides");
  }
});

test("a head the store would not file under is no branch anywhere", () => {
  const { c, pushed, frames } = wired();
  c.notify("git", { title: "t", body: "x", outcome: "failed", key, pushHead: { branch: "x:y", sha } });
  assert.equal(frames()[0].branch, undefined);
  assert.equal(pushed[0].branch, undefined);
});

test("every item field the frame carries, the push carries — plus `pull`, the transport", () => {
  const { c, pushed, frames } = wired();
  c.notify("artifact", { title: "t", body: "b", tag: "x", file: { repoId: "r", relPath: ".claude/outbox/a.apk", name: "a.apk", size: 1 }, pull: "p1", open: { to: "tokens" }, key: "k:1", level: "info" });
  const [frame] = frames();
  const { pull, ...rest } = pushed[0];
  assert.equal(pull, "p1");
  assert.deepEqual(rest, frame);
});
