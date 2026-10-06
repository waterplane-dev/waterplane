/**
 * The claude CLI's private dir: `CLAUDE_CONFIG_DIR` replaces `~/.claude` as a
 * whole, the test knob keeps working, and a project folder the CLI truncated
 * (slug past 200 chars: first 200 + "-" + hash) is found by its head, accepted
 * only when exactly one folder holds a log naming this cwd.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDirFromEnv, claudeConfigDirOf, truncatedSlugPrefix, transcriptDirName } from "@waterplane/shared";
import { claudeConfigDir, claudeProjectDir } from "../dist/claudeconfig.js";
import { cliConfigEnv } from "../dist/sessions/tmux.js";

const KEYS = ["CLAUDE_CONFIG_DIR", "WATERPLANE_CLAUDE_HOME"];
function withEnv(vals, fn) {
  const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vals);
  try { return fn(); } finally {
    for (const k of KEYS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
}

test("pure rule: config dir beats the test home beats ~", () => {
  assert.equal(claudeConfigDirOf({ configDir: "/cfg", testHome: "/th", home: "/h" }), "/cfg");
  assert.equal(claudeConfigDirOf({ testHome: "/th/", home: "/h" }), "/th/.claude");
  assert.equal(claudeConfigDirOf({ configDir: "", home: "/h" }), "/h/.claude");
  assert.equal(claudeConfigDirFromEnv({ CLAUDE_CONFIG_DIR: "/c" }, "/h"), "/c");
  assert.equal(claudeConfigDirFromEnv({ WATERPLANE_CLAUDE_HOME: "/t" }, "/h"), "/t/.claude");
  assert.equal(claudeConfigDirFromEnv({}, "/h"), "/h/.claude");
});

test("host reader follows the env at call time", () => {
  withEnv({}, () => assert.equal(claudeConfigDir(), join(homedir(), ".claude")));
  withEnv({ WATERPLANE_CLAUDE_HOME: "/fake" }, () => assert.equal(claudeConfigDir(), "/fake/.claude"));
  withEnv({ WATERPLANE_CLAUDE_HOME: "/fake", CLAUDE_CONFIG_DIR: "/cfg" }, () => {
    assert.equal(claudeConfigDir(), "/cfg");
    assert.equal(claudeProjectDir("/a/b.c"), "/cfg/projects/-a-b-c");
  });
});

test("tmux pane carries CLAUDE_CONFIG_DIR unchanged, unset adds nothing, a launch value wins", () => {
  withEnv({}, () => assert.deepEqual(cliConfigEnv({ A: "1" }), { A: "1" }));
  withEnv({ CLAUDE_CONFIG_DIR: "/cfg" }, () => {
    assert.deepEqual(cliConfigEnv({}), { CLAUDE_CONFIG_DIR: "/cfg" });
    assert.deepEqual(cliConfigEnv({ CLAUDE_CONFIG_DIR: "/mine" }), { CLAUDE_CONFIG_DIR: "/mine" });
  });
});

test("slug truncation rule: only past 200", () => {
  const exact = "/" + "a".repeat(199); // 200 chars of slug
  assert.equal(truncatedSlugPrefix(transcriptDirName(exact)), null);
  const long = "/" + "a".repeat(250);
  assert.equal(truncatedSlugPrefix(transcriptDirName(long)), "-" + "a".repeat(199) + "-");
});

function logFor(root, folder, cwd) {
  const d = join(root, "projects", folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "11111111-1111-1111-1111-111111111111.jsonl"), JSON.stringify({ type: "user", cwd }) + "\n");
  return d;
}

test("a truncated long-path folder is found by its head, verified by the cwd it records", () => {
  const root = mkdtempSync(join(tmpdir(), "cfgdir-"));
  try {
    const base = "/" + "w".repeat(210);
    const cwdA = base + "/worktrees/agent-a";
    const cwdB = base + "/worktrees/agent-b";
    const head = truncatedSlugPrefix(transcriptDirName(cwdA));
    assert.equal(head, truncatedSlugPrefix(transcriptDirName(cwdB))); // siblings share their first 200
    const dirA = logFor(root, head + "hashA", cwdA);
    withEnv({ CLAUDE_CONFIG_DIR: root }, () => {
      assert.equal(claudeProjectDir(cwdA), dirA);
      // The only candidate belongs to A: B must NOT be handed A's folder.
      assert.equal(claudeProjectDir(cwdB), join(root, "projects", transcriptDirName(cwdB)));
    });
    const dirB = logFor(root, head + "hashB", cwdB);
    withEnv({ CLAUDE_CONFIG_DIR: root }, () => {
      assert.equal(claudeProjectDir(cwdB), dirB);
      assert.notEqual(claudeProjectDir(cwdA), dirB);
    });
    // Two folders claiming one cwd is ambiguous: absent, never a pick.
    const cwdC = base + "/worktrees/agent-c";
    logFor(root, head + "x1", cwdC);
    logFor(root, head + "x2", cwdC);
    withEnv({ CLAUDE_CONFIG_DIR: root }, () => {
      assert.equal(claudeProjectDir(cwdC), join(root, "projects", transcriptDirName(cwdC)));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a short path is exact, with no directory listing needed", () => {
  withEnv({ CLAUDE_CONFIG_DIR: "/nonexistent-cfg" }, () => {
    assert.equal(claudeProjectDir("/Users/x/dev/app"), "/nonexistent-cfg/projects/-Users-x-dev-app");
  });
});
