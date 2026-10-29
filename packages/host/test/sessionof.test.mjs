/**
 * `api.sessionOf` (plugin API 2.4, `plugins/plugintoolkit/sessionof.ts`): the ladder that names the
 * live session a requesting process belongs to — pane confirmed by a ppid walk, the walk alone, a
 * scratchpad naming a conversation id, the cwd under exactly one session — and that every probe
 * failure degrades to the next rung or null, never to a wrong session. Fixture probes, no tmux.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { matchSessionOf, walkToPane, capPrompt, parsePpidTable, SESSIONOF_MAX_HOPS, SESSIONOF_PROMPT_MAX } = await import("../dist/plugins/plugintoolkit/sessionof.js");
const { parseOurPanes } = await import("../dist/sessions/haltall.js");

const CONV_A = "0fa6dfb9-c86e-4664-9ca7-6cf800bccc4e";
const CONV_B = "11111111-2222-3333-4444-555555555555";
const live = [
  { id: "a", cwd: "/Users/me/dev/atlas", claudeSessionId: CONV_A },
  { id: "b", cwd: "/Users/me/dev/garmin", claudeSessionId: CONV_B },
];
const panes = [
  { paneId: "%209", sessionId: "a", panePid: 1000 },
  { paneId: "%210", sessionId: "b", panePid: 2000 },
];
// 4242 → 4241 → 4240 → 1000 (pane a); 5252 → 2000 (pane b); 6000 → 1 (not ours)
const tree = new Map([[4242, 4241], [4241, 4240], [4240, 1000], [1000, 1], [5252, 2000], [2000, 1], [6000, 1]]);
const probes = (over = {}) => ({ panes, ppid: (p) => tree.get(p) ?? null, realpath: (p) => p, ...over });

test("tmux list-panes lines → our panes; foreign sessions and torn lines dropped", () => {
  const text = ["%209\twaterplane-a\t1000", "%3\tmy-own-tmux\t77", "%210\twaterplane-b\t2000", "garbage", "%5\twaterplane-c\tx", ""].join("\n");
  assert.deepEqual(parseOurPanes(text, "waterplane-"), panes);
});

test("rung 1: the reported pane, confirmed by the walk ⇒ pane", () => {
  assert.deepEqual(matchSessionOf({ tmuxPane: "%209", pid: 4242, cwd: "/elsewhere" }, live, probes()), { id: "a", how: "pane" });
});

test("rung 1: the pane claims a but the walk reaches b ⇒ b, how pid", () => {
  assert.deepEqual(matchSessionOf({ tmuxPane: "%209", pid: 5252 }, live, probes()), { id: "b", how: "pid" });
});

test("rung 1: a pane with no walk to back it is not believed — falls through to the cwd", () => {
  assert.deepEqual(matchSessionOf({ tmuxPane: "%209", pid: 6000, cwd: "/Users/me/dev/garmin/src" }, live, probes()), { id: "b", how: "cwd" });
  assert.equal(matchSessionOf({ tmuxPane: "%209" }, live, probes()), null);
});

test("rung 2: no pane, the walk reaches a pane pid ⇒ pid", () => {
  assert.deepEqual(matchSessionOf({ pid: 4242 }, live, probes()), { id: "a", how: "pid" });
  // The pane pid itself is not a requester (the pane's own shell or CLI, readable by `ps`): no pane, no pid match.
  assert.equal(matchSessionOf({ pid: 1000 }, live, probes()), null);
  assert.equal(matchSessionOf({ tmuxPane: "%209", pid: 1000 }, live, probes()), null);
  assert.equal(walkToPane(1000, panes, probes().ppid), null);
});

test("a pane whose session is not live is ignored", () => {
  assert.equal(matchSessionOf({ pid: 4242 }, [live[1]], probes()), null);
});

test("the walk stops at the hop limit, a loop, or an unknown parent", () => {
  const chain = new Map();
  for (let i = 0; i < SESSIONOF_MAX_HOPS; i++) chain.set(9000 + i, 9000 + i + 1);
  chain.set(9000 + SESSIONOF_MAX_HOPS, 1000);
  const ppid = (p) => chain.get(p) ?? null;
  assert.equal(walkToPane(9000 + 1, panes, ppid)?.sessionId, "a"); // 12 hops
  assert.equal(walkToPane(9000, panes, ppid), null); // 13 hops
  assert.equal(walkToPane(7, panes, (p) => p), null); // self-loop
  assert.equal(walkToPane(7, panes, () => { throw new Error("ps"); }), null);
  assert.equal(walkToPane(null, panes, ppid), null);
  assert.equal(walkToPane(1, panes, ppid), null);
});

test("tmux down (panes null) ⇒ rungs 1–2 skipped, never a guess", () => {
  assert.equal(matchSessionOf({ tmuxPane: "%209", pid: 4242 }, live, probes({ panes: null })), null);
  assert.deepEqual(matchSessionOf({ tmuxPane: "%209", pid: 4242, cwd: "/Users/me/dev/atlas" }, live, probes({ panes: null })), { id: "a", how: "cwd" });
});

test("ps failing (no parents) ⇒ falls to scratchpad", () => {
  const cwd = `/private/tmp/claude-501/-Users-me-dev-garmin/${CONV_B}/scratchpad/x`;
  assert.deepEqual(matchSessionOf({ pid: 4242, cwd }, live, probes({ ppid: () => null })), { id: "b", how: "scratchpad" });
});

test("rung 3: a scratchpad naming two live conversations ⇒ null, not a pick", () => {
  const cwd = `/tmp/${CONV_A}/${CONV_B}`;
  assert.equal(matchSessionOf({ cwd }, live, probes()), null);
});

test("rung 4: realpath'd cwd under exactly one session; two (nested worktree) or none ⇒ null", () => {
  const rp = (p) => p.replace(/^\/var\//, "/private/var/");
  const l = [{ id: "x", cwd: "/private/var/repo" }];
  assert.deepEqual(matchSessionOf({ cwd: "/var/repo/sub" }, l, probes({ realpath: rp })), { id: "x", how: "cwd" });
  assert.equal(matchSessionOf({ cwd: "/var/repository" }, l, probes({ realpath: rp })), null); // prefix is not a path segment
  const nested = [{ id: "x", cwd: "/r" }, { id: "y", cwd: "/r/.claude/worktrees/w" }];
  assert.equal(matchSessionOf({ cwd: "/r/.claude/worktrees/w/src" }, nested, probes()), null);
  assert.equal(matchSessionOf({ cwd: "/nowhere" }, live, probes()), null);
  assert.equal(matchSessionOf({ cwd: "relative/path" }, live, probes()), null);
  assert.equal(matchSessionOf({ cwd: "/Users/me/dev/atlas" }, live, probes({ realpath: () => null })).id, "a"); // unresolvable ⇒ as written
});

test("empty query ⇒ null", () => {
  assert.equal(matchSessionOf({}, live, probes()), null);
  assert.equal(matchSessionOf({ tmuxPane: null, pid: null, cwd: null }, live, probes()), null);
});

test("prompts are capped at 200 chars and absent when empty", () => {
  assert.equal(capPrompt("short"), "short");
  const long = capPrompt("x".repeat(500));
  assert.equal(long.length, SESSIONOF_PROMPT_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(capPrompt("x".repeat(200)), "x".repeat(200));
  assert.equal(capPrompt("  "), undefined);
  assert.equal(capPrompt(undefined), undefined);
});

test("ps -axo pid=,ppid= parses; junk lines drop", () => {
  assert.deepEqual([...parsePpidTable("  1     0\n 4242  4241\nPID PPID\n\n")], [[1, 0], [4242, 4241]]);
});
