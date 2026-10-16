/**
 * `healFromPane` — when reattach may move a live record's cwd to the tmux
 * pane's `#{pane_current_path}`. Only the legacy orphan-rediscover corruption
 * (cwd missing or gone, title the id or empty) is healed; a healthy SHELL
 * record whose pane has `cd`'d into a subfolder keeps its home, or the
 * launcher lists it as a fake repo named after that subfolder.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { healFromPane } from "../dist/sessions/tmux.js";

test("a healthy record keeps its cwd and title when the pane cd'd elsewhere", () => {
  const m = { id: "abc123", cwd: "/dev/notes", title: "shell · notes" };
  assert.deepEqual(healFromPane(m, "/dev/trading/backend", true), { cwd: "/dev/notes", title: "shell · notes" });
});

test("the legacy corruption (title = id) is healed from the pane, title re-derived", () => {
  const m = { id: "abc123", cwd: "/dev", title: "abc123" };
  assert.deepEqual(healFromPane(m, "/dev/app", true), { cwd: "/dev/app", title: "app" });
});

test("a cwd that no longer exists is healed, a real title kept", () => {
  const m = { id: "abc123", cwd: "/gone", title: "fix the build" };
  assert.deepEqual(healFromPane(m, "/dev/app", false), { cwd: "/dev/app", title: "fix the build" });
});

test("no pane path, or the same one, changes nothing", () => {
  const m = { id: "abc123", cwd: "/dev", title: "abc123" };
  assert.deepEqual(healFromPane(m, null, true), { cwd: "/dev", title: "abc123" });
  assert.deepEqual(healFromPane(m, "/dev", true), { cwd: "/dev", title: "abc123" });
});
