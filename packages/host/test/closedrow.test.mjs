/**
 * The closed row a session leaves (`sessions/roster.ts`'s `closedRowOf`):
 * built from what the session already holds, the reason the caller named, the
 * exit code only for an exit the session made itself, the item's outcome only
 * once it settled, every string clipped — and a stack written by an older host
 * read back as it was.
 *
 * A fake core and a hand-built `Session`: the row is the thing under test, and
 * the PTY paths that call it are `e2e-archive` / `e2e-resurrect` /
 * `e2e-backlog-slots`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RosterSlice } from "../dist/sessions/roster.js";

function roster(closedFile) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-closedrow-"));
  if (closedFile !== undefined) {
    mkdirSync(join(root, ".waterplane"), { recursive: true });
    writeFileSync(join(root, ".waterplane", "closed.json"), JSON.stringify(closedFile));
  }
  const emitted = [];
  const core = { root, hasLiveTmux: () => false, emit: (...a) => { emitted.push(a); return true; } };
  return { r: new RosterSlice(core), root, emitted };
}

const session = (over = {}) => ({
  info: { id: "s1", cwd: "/r", title: "backlog · r · fix it", createdAt: 1_000, model: "claude-opus-5", tabTitle: "Flaky test fix", ...(over.info ?? {}) },
  launch: {},
  history: over.history ?? [
    { id: "h1", kind: "backlog", text: "fix the\nflaky test", sentAt: 2_000, outputAt: 3_000 },
    { id: "h2", kind: "prompt", text: "and commit it", sentAt: 4_000, outputAt: 5_000 },
  ],
  origin: over.origin,
  closeBy: over.closeBy,
});

test("a session's own exit carries its code; a close we caused does not", () => {
  const { r, root } = roster();
  const own = r.closedRowOf(session(), false, { by: "exited", exitCode: 3, signal: 0 });
  assert.equal(own.closedBy, "exited");
  assert.equal(own.exitCode, 3);
  assert.equal("exitSignal" in own, false, "signal 0 is no signal");
  const ours = r.closedRowOf(session({ closeBy: "auto-done" }), false, { exitCode: 0, signal: 15 });
  assert.equal(ours.closedBy, "auto-done", "the caller's reason, read off the session");
  assert.equal("exitCode" in ours, false, "our own kill's code says nothing about the session");
  assert.equal("exitSignal" in ours, false);
  rmSync(root, { recursive: true, force: true });
});

test("no reason named ⇒ no closedBy, never a guess", () => {
  const { r, root } = roster();
  assert.equal("closedBy" in r.closedRowOf(session(), false), false);
  rmSync(root, { recursive: true, force: true });
});

test("what it WAS: origin, item, its settled outcome, the prompts — clipped", () => {
  const { r, root } = roster();
  r.setItemLookup((id) => (id === "i1" ? { state: "done", result: { at: 1, ok: true, detail: "delivered" } } : undefined));
  const row = r.closedRowOf(session({ origin: { kind: "backlog", itemId: "i1", itemLabel: "Flaky test" }, closeBy: "auto-slot" }), false);
  assert.equal(row.kind, "backlog");
  assert.equal(row.itemId, "i1");
  assert.equal(row.itemLabel, "Flaky test");
  assert.equal(row.itemState, "done");
  assert.equal(row.itemOk, true);
  assert.equal(row.itemDetail, "delivered");
  assert.equal(row.openedAt, 1_000);
  assert.equal(row.lastActiveAt, 5_000, "the last recorded turn's capture");
  assert.equal(row.turns, 2);
  assert.equal(row.firstPrompt, "fix the flaky test", "one line");
  assert.equal(row.lastPrompt, "and commit it");
  assert.equal("summary" in row, false, "the per-turn summary is retired");
  assert.equal(row.tabTitle, "Flaky test fix");
  assert.equal(row.model, "claude-opus-5");
  rmSync(root, { recursive: true, force: true });
});

test("an item still running when its session closed says nothing about its outcome", () => {
  const { r, root } = roster();
  r.setItemLookup(() => ({ state: "running" }));
  const row = r.closedRowOf(session({ origin: { kind: "schedule", itemId: "i2" } }), false, { by: "exited", exitCode: 1 });
  assert.equal(row.kind, "schedule");
  for (const k of ["itemState", "itemOk", "itemDetail", "itemLabel"]) assert.equal(k in row, false, k);
  rmSync(root, { recursive: true, force: true });
});

test("a session with no recorded prompts has no turns, no prompts and no lastActiveAt", () => {
  const { r, root } = roster();
  const row = r.closedRowOf(session({ history: [], info: { tabTitle: undefined } }), true, { by: "you" });
  for (const k of ["turns", "firstPrompt", "lastPrompt", "lastActiveAt", "tabTitle", "kind"]) assert.equal(k in row, false, k);
  assert.equal(row.alive, true);
  rmSync(root, { recursive: true, force: true });
});

test("a stack written by an older host reads back unchanged; a broken row is dropped, not the stack", () => {
  const old = { id: "o1", cwd: "/r", title: "myapp", closedAt: 9, claudeSessionId: "u", alive: false };
  const { r, root } = roster([old, { id: "bad" }]);
  assert.deepEqual(r.listClosed(), [old]);
  rmSync(root, { recursive: true, force: true });
});

test("pushClosed persists the new fields, and a restart reads them back", () => {
  const { r, root } = roster();
  r.pushClosed(r.closedRowOf(session({ origin: { kind: "agent", itemId: "agent-k" } }), false, { by: "auto-done" }));
  const again = new RosterSlice({ root, hasLiveTmux: () => false, emit: () => true });
  const [row] = again.listClosed();
  assert.equal(row.closedBy, "auto-done");
  assert.equal(row.kind, "agent");
  assert.equal(row.itemId, "agent-k");
  rmSync(root, { recursive: true, force: true });
});

test("a typed slash command is never a row's Started or Latest", () => {
  const { r, root } = roster();
  const only = session({ history: [{ id: "c1", kind: "command", text: "/compact", sentAt: 2_000 }] });
  r.applyPromptLabels(only);
  assert.equal(only.info.firstPrompt, undefined, "a resumed session's /compact must not replace its tab name on the row");
  assert.equal(only.info.lastPrompt, undefined);
  const row = r.closedRowOf(only, false);
  assert.equal("firstPrompt" in row, false);
  assert.equal(row.turns, 1, "still a turn");
  const mixed = session({ history: [
    { id: "c1", kind: "command", text: "/model opus", sentAt: 1_500 },
    { id: "h1", kind: "prompt", text: "fix the flaky test", sentAt: 2_000 },
    { id: "c2", kind: "command", text: "/compact", sentAt: 3_000 },
  ] });
  r.applyPromptLabels(mixed);
  assert.equal(mixed.info.firstPrompt, "fix the flaky test");
  assert.equal(mixed.info.lastPrompt, "fix the flaky test");
  rmSync(root, { recursive: true, force: true });
});
