/**
 * What `claude` is spawned WITH — the golden argv, per launch mode.
 *
 * This is the regression pin for moving the argv out of `SessionManager.create()`
 * and into `backends/claude.ts`. It exists because the failure it guards against
 * is silent in every way a failure can be: a `--continue` that quietly becomes a
 * fresh conversation loses nothing visible — no error, no empty screen, just a
 * session that has forgotten an afternoon of context, discovered by a person
 * wondering why the agent is asking again. Nothing in the e2e suite can see the
 * difference either; the stub binary ignores its flags.
 *
 * Four modes, because each one is a different promise to the person who asked
 * for it:
 *
 *   fresh      — a NEW conversation, whose id we mint ourselves so it stays
 *                individually resumable without any detection later.
 *   continue   — the directory's most recent conversation, or an EXACT one when
 *                its id is known (several conversations per repo restore
 *                independently only because of that branch).
 *   pick       — claude's own interactive picker, so an older same-dir
 *                conversation can be chosen by hand.
 *   fork       — a branch under a NEW id, with the original left running and
 *                separately resumable.
 *
 * The `--settings` hook blob is pinned too. It is what makes a session `hooked`,
 * i.e. what replaces silence-guessing with a positive turn boundary — and a
 * change that dropped it would degrade every session to the fallback heuristics
 * while every test still passed.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { claudeBackend, hookSettingsArg } from "../dist/backends/claude.js";
import { resolveBackend, DEFAULT_BACKEND } from "../dist/backends/index.js";
import { composerSpans } from "../dist/echo.js";
import { BRAND, envName } from "@waterplane/shared";

const PORT = 8770;
const HOOKS = hookSettingsArg(PORT);
// The repo-facing skill plugin (`reposkill.ts`) is written into the config dir on
// every launch — a temp one here, never the real per-user config dir.
process.env[envName("CONFIG_DIR")] = mkdtempSync(join(tmpdir(), `${BRAND.slug}-args-`));
const PLUGIN = ["--plugin-dir", join(process.env[envName("CONFIG_DIR")], "claude-plugin")];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One launch, with everything the caller did not care about left out. */
const plan = (req) => claudeBackend.launchArgs({ launch: {}, hookPort: PORT, ...req });

test("a fresh conversation mints its own session id", () => {
  const { args, sessionId } = plan({});
  assert.match(sessionId, UUID_RE, "a fresh launch must mint an id, not leave it to detection");
  assert.deepEqual(args, ["--session-id", sessionId, "--model", "default", "--settings", HOOKS, ...PLUGIN]);
  // Two fresh launches are two conversations.
  assert.notEqual(plan({}).sessionId, sessionId);
});

test("continue resumes the directory's most recent conversation", () => {
  const { args, sessionId } = plan({ resumeMode: "continue" });
  assert.deepEqual(args, ["--continue", "--model", "default", "--settings", HOOKS, ...PLUGIN]);
  assert.equal(sessionId, undefined, "which conversation --continue lands on is not knowable here");
});

test("continue with a known id resumes THAT conversation, and keeps the id", () => {
  const rid = "11111111-2222-3333-4444-555555555555";
  const { args, sessionId } = plan({ resumeMode: "continue", resumeSessionId: rid });
  assert.deepEqual(args, ["--resume", rid, "--model", "default", "--settings", HOOKS, ...PLUGIN]);
  assert.equal(sessionId, rid, "resuming keeps the id — only --fork-session mints a new one");
});

test("pick hands the choice to claude's own session picker", () => {
  const { args, sessionId } = plan({ resumeMode: "pick" });
  assert.deepEqual(args, ["--resume", "--model", "default", "--settings", HOOKS, ...PLUGIN]);
  assert.equal(sessionId, undefined);
});

test("fork branches the named conversation, and claims no id for the branch", () => {
  const rid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const { args, sessionId } = plan({ resumeMode: "fork", resumeSessionId: rid });
  assert.deepEqual(args, ["--resume", rid, "--fork-session", "--model", "default", "--settings", HOOKS, ...PLUGIN]);
  assert.equal(sessionId, undefined, "the fork's id is minted by the CLI and adopted from the log");
});

test("fork without a known id falls back to the most recent conversation", () => {
  // Legacy sessions from before ids were minted at spawn. The fallback is what
  // keeps them forkable at all.
  const { args } = plan({ resumeMode: "fork" });
  assert.deepEqual(args, ["--continue", "--fork-session", "--model", "default", "--settings", HOOKS, ...PLUGIN]);
});

test("launch flags are appended in a fixed order, and only when asked for", () => {
  const { args, sessionId } = plan({
    launch: { model: "opus", effort: "high", permissionMode: "acceptEdits", remoteControlled: true },
  });
  assert.deepEqual(args, [
    "--session-id", sessionId,
    "--model", "opus",
    "--effort", "high",
    "--permission-mode", "acceptEdits",
    "--remote-control",
    "--settings", HOOKS,
    ...PLUGIN,
  ]);
  // An unset flag is ABSENT, never passed empty — `--model ""` is not the same
  // request as "whatever the CLI defaults to". The model is the exception: an
  // unset one is pinned to the CLI's `default`, never left to settings.json,
  // which the CLI's own `/model` rewrites.
  const bare = plan({ launch: {} }).args;
  assert.equal(bare[bare.indexOf("--model") + 1], "default");
  assert.equal(bare.includes("--effort"), false);
  assert.equal(bare.includes("--permission-mode"), false);
  assert.equal(bare.includes("--remote-control"), false);
});

test("the hook blob carries every lifecycle event the host listens for", () => {
  const settings = JSON.parse(HOOKS);
  assert.deepEqual(
    Object.keys(settings.hooks).sort(),
    ["Notification", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"],
    "dropping one of these degrades that signal to silence-guessing, invisibly",
  );
  const cmd = settings.hooks.Stop[0].hooks[0].command;
  assert.ok(cmd.includes(`http://127.0.0.1:${PORT}/api/hook`), "the sink is loopback-only");
  assert.ok(cmd.endsWith("|| true"), "hook delivery is best-effort and must never block a turn");
});

test("an absent backend id is claude; an unknown one is REFUSED in words", () => {
  assert.equal(resolveBackend(), DEFAULT_BACKEND);
  assert.equal(resolveBackend(undefined), claudeBackend);
  assert.equal(resolveBackend("claude"), claudeBackend);
  // Never `?? claudeBackend`: silently spawning a different binary than the one
  // that was asked for is the failure this whole indirection exists to prevent.
  // `cline` rather than `opencode` because this host now HAS an opencode
  // descriptor — the rule is about an id nobody registered, which is what a
  // newer phone asking an older host for a backend looks like.
  assert.throws(() => resolveBackend("cline"), (err) => {
    assert.ok(err.message.includes("cline"), "the message must name the id that failed");
    assert.ok(err.message.includes("claude"), "…and the ids that would have worked");
    return true;
  });
});

test("the descriptor's composer cursor rule agrees with echo.ts's", () => {
  // `backends/claude.ts` holds a SECOND copy of a regex `echo.ts` keeps private,
  // because `echo.ts` is the last file this refactor may touch. Two copies of a
  // rule are two opinions waiting to happen, so they are held to the same
  // answers until the copy is deleted.
  const RULE = "─".repeat(24);
  const cases = [
    ["\u276f hello", true],
    ["\u276f", true],
    ["\u276f\u00a0", true],          // the TUI pads the cursor row with an NBSP
    ["> hello", false],              // a user turn scrolled into the backlog is NOT a composer
    ["\u276fx", false],
    ["hello", false],
  ];
  for (const [row, expected] of cases) {
    assert.equal(claudeBackend.delivery.composerCursorRe.test(row), expected, `descriptor: ${JSON.stringify(row)}`);
    assert.equal(composerSpans([RULE, row, RULE]).length === 1, expected, `echo.ts: ${JSON.stringify(row)}`);
  }
});

test("every launch carries the repo-facing skill as a plugin dir, written where it is read", () => {
  const { args } = plan({});
  const dir = args[args.indexOf("--plugin-dir") + 1];
  const skill = join(dir, "skills", BRAND.skillName, "SKILL.md");
  assert.ok(existsSync(join(dir, ".claude-plugin", "plugin.json")) && existsSync(skill));
  assert.match(readFileSync(skill, "utf8"), new RegExp(`^---\\nname: ${BRAND.skillName}\\n`));
  assert.match(readFileSync(skill, "utf8"), new RegExp(`127\\.0\\.0\\.1:${PORT}`), "the port is the launch's");
});
