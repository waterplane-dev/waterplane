/**
 * `binguard.ts`: a backend whose binary is gone — mid-upgrade or never installed — is refused in a
 * sentence before the spawn, never handed to tmux to come back as a bare `[exited]`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { binMissingRefusal, installerIn } from "../dist/binguard.js";

const PS = [
  "  101 /bin/zsh -l",
  "  202 npm install -g @anthropic-ai/claude-code@latest",
  "  303 node /opt/homebrew/bin/npm i -g othercli-ai",
  "  404 /Users/me/.local/bin/claude update",
  "  505 npm exec firebase-tools@latest mcp",
].join("\n");

test("an npm install naming the binary's package is an install of it", () => {
  assert.deepEqual(installerIn(PS, "claude"), { pid: 202, cmd: "npm install -g @anthropic-ai/claude-code@latest" });
  assert.equal(installerIn(PS, "/opt/homebrew/bin/othercli")?.pid, 303);
});

test("the CLI's own update counts; an unrelated npm exec and our own pid do not", () => {
  assert.equal(installerIn("  404 /Users/me/.local/bin/claude update", "claude")?.pid, 404);
  assert.equal(installerIn(PS, "firebase"), null, "npm exec is not an install");
  assert.equal(installerIn(PS, "claude", 202)?.pid, 404, "our own process is skipped");
  assert.equal(installerIn(PS, "gemini"), null);
});

test("a binary that resolves is never refused, whatever is installing", () => {
  const facts = { resolves: () => true, installer: () => ({ pid: 1, cmd: "npm i -g x" }) };
  assert.equal(binMissingRefusal("Claude Code", "claude", facts), null);
});

test("a missing binary with an install running says so, for every backend", () => {
  const facts = { resolves: () => false, installer: () => ({ pid: 202, cmd: "npm install -g @anthropic-ai/claude-code@latest" }) };
  const r = binMissingRefusal("Claude Code", "claude", facts, true);
  assert.match(r, /being installed or updated on this desktop right now/);
  assert.match(r, /pid 202/);
  assert.match(r, /Start the session again once it is done/);
});

test("a missing binary with nothing installing: the generic sentence, or the backend's own", () => {
  const facts = { resolves: () => false, installer: () => null };
  assert.match(binMissingRefusal("othercli", "othercli", facts), /othercli is not installed on this desktop — `othercli` is not on the PATH/);
  assert.equal(binMissingRefusal("Claude Code", "claude", facts, true), null, "claude's prepare says its own, richer sentence");
});
