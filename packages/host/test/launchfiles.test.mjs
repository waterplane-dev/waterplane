/**
 * The files a launch's plan asks the HOST to write before the spawn (`launchfiles.ts`), and the
 * `session:` names its `env` points at them by — backend contract v2. A CLI that reads its
 * instructions from a DIRECTORY (Copilot: `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>` holding
 * `<dir>/AGENTS.md`) gets a dir of its own per session, under the host's state dir: never the
 * repo, never `~/.<cli>`. A plan naming anywhere else is refused WHOLE, in words, and writes
 * nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const { finishLaunch, launchDir, resolveLaunchFiles, resolveSessionEnv, sweepLaunchDirs } = await import("../dist/launchfiles.js");

const root = () => mkdtempSync(join(tmpdir(), "launchfiles-"));
const plan = (over = {}) => ({ args: ["x"], instructionsVia: "env-file", askRulesVia: "gate", ...over });
const backend = (over = {}) => ({ label: "Stub CLI", ...over });

test("session:<name> lands in <state dir>/launch/<hostSessionId>/, written before anything spawns; the env names it", () => {
  const r = root();
  const out = finishLaunch(backend(), plan({
    files: [{ path: "session:instructions/AGENTS.md", content: "put pictures in the outbox" }],
    env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/theirs,session:instructions", OTHER: "plain" },
  }), r, "ab12cd34");
  const dir = launchDir(r, "ab12cd34");
  assert.equal(dir, join(r, BRAND.stateDirName, "launch", "ab12cd34"));
  const file = join(dir, "instructions", "AGENTS.md");
  assert.equal(readFileSync(file, "utf8"), "put pictures in the outbox");
  assert.equal(statSync(file).mode & 0o777, 0o600, "a launch file is the owner's only");
  assert.equal(out.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, `/theirs,${join(dir, "instructions")}`, "a session: item is resolved, the daemon's own value kept");
  assert.equal(out.env.OTHER, "plain");
  assert.deepEqual([out.args, out.instructionsVia, out.askRulesVia], [["x"], "env-file", "gate"], "the rest of the plan passes as it was");
});

test("a file outside the launch dir is refused in words, and NOTHING is written", () => {
  const r = root();
  const repo = join(r, "repo");
  mkdirSync(repo);
  const refusals = [
    [{ path: "session:../escape.md", content: "x" }, /leaves its session's launch dir/],
    [{ path: "session:", content: "x" }, /leaves its session's launch dir/],
    [{ path: "session:/etc/passwd", content: "x" }, /leaves its session's launch dir/],
    [{ path: join(repo, "AGENTS.md"), content: "x" }, /never the repo, never the CLI's own config/],
    [{ path: join(homedir(), ".copilot", "copilot-instructions.md"), content: "x" }, /never the repo, never the CLI's own config/],
    [{ path: "relative/AGENTS.md", content: "x" }, /is refused/],
    [{ path: "session:a.md" }, /has no text/],
  ];
  for (const [bad, re] of refusals) {
    const files = [{ path: "session:ok.md", content: "fine" }, bad];
    assert.throws(() => finishLaunch(backend(), plan({ files }), r, "s1"), (e) => re.test(e.message) && /Stub CLI/.test(e.message), JSON.stringify(bad));
  }
  assert.equal(existsSync(launchDir(r, "s1")), false, "a refused plan wrote nothing — not even the good file before the bad one");
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
});

test("an absolute path is accepted only inside the plugin's own dataDir, realpath-contained", () => {
  const r = root();
  const data = join(r, "plugin-data");
  mkdirSync(data);
  const ok = resolveLaunchFiles([{ path: join(data, "sub", "a.md"), content: "x" }], { launchDir: launchDir(r, "s2"), dataDir: data, who: "P" });
  assert.equal(ok.ok, true);
  // A symlink inside dataDir pointing out of it is outside, whatever its spelling.
  const outside = join(r, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(data, "link"));
  const viaLink = resolveLaunchFiles([{ path: join(data, "link", "a.md"), content: "x" }], { launchDir: null, dataDir: data, who: "P" });
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.reason, /is refused/);
  // No dataDir (a core backend) ⇒ no absolute path at all.
  assert.equal(resolveLaunchFiles([{ path: join(data, "a.md"), content: "x" }], { launchDir: null, who: "P" }).ok, false);
});

test("an env item naming a path outside the launch dir refuses the launch; no files, no env ⇒ the plan unchanged", () => {
  assert.throws(() => resolveSessionEnv({ X: "session:../up" }, "/s/launch/a", "P"), /P's launch variable X names "session:\.\.\/up", which is not inside its session's launch dir/);
  assert.equal(resolveSessionEnv(undefined, "/d", "P"), undefined);
  const r = root();
  const p = plan({ instructionsVia: "plugin-dir", askRulesVia: "native" });
  const out = finishLaunch(backend(), p, r, "s3");
  assert.deepEqual(out, p, "claude's plan (no files, no session: env) passes byte for byte");
  assert.equal(existsSync(launchDir(r, "s3")), false, "and creates no launch dir");
  assert.equal(launchDir(r, "../x"), null, "a session id that is not a plain id has no launch dir");
});

test("an env key that is not a variable name refuses the launch in words, before any file is written", () => {
  // `/usr/bin/env K=V` takes no shell, but a key like `-u` or `` would be read as an option to env.
  for (const bad of ["-u", "", "A B", "1X", "A=B", "--", "X\n"]) {
    assert.throws(() => resolveSessionEnv({ OK: "1", [bad]: "v" }, "/s/launch/a", "P"), (e) => /P's launch variable .* is not a variable name/.test(e.message), JSON.stringify(bad));
  }
  assert.deepEqual(resolveSessionEnv({ _A1: "x", Path: "y" }, null, "P"), { _A1: "x", Path: "y" });
  const r = root();
  assert.throws(() => finishLaunch(backend(), plan({ files: [{ path: "session:a.md", content: "x" }], env: { "-i": "1" } }), r, "s5"), /Stub CLI's launch variable "-i" is not a variable name/);
  assert.equal(existsSync(launchDir(r, "s5")), false, "nothing written");
});

test("a plugin backend's launch dir EXISTS before the spawn even with no files — api.sessionFiles(id) answers it only once it does", () => {
  const r = root();
  const data = mkdtempSync(join(tmpdir(), "launchfiles-data-"));
  const p = plan({ instructionsVia: "none", askRulesVia: "none" });
  const out = finishLaunch(backend({ dataDir: data }), p, r, "pl1");
  assert.deepEqual(out, p, "the plan itself is unchanged");
  const d = launchDir(r, "pl1");
  assert.equal(statSync(d).isDirectory(), true, "the dir is made");
  assert.equal(statSync(d).mode & 0o777, 0o700, "owner-only");
});

test("the boot sweep takes the launch dirs of sessions gone for over a week, never a live one, nothing when alive is unknown", () => {
  const r = root();
  const mk = (id, ageDays) => {
    const d = launchDir(r, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "AGENTS.md"), "x");
    const t = (Date.now() - ageDays * 86_400_000) / 1000;
    utimesSync(d, t, t);
    return d;
  };
  const old = mk("old1", 9), live = mk("live1", 9), fresh = mk("new1", 1);
  assert.deepEqual(sweepLaunchDirs(r, null), { deleted: 0, kept: 0, skipped: true });
  assert.equal(existsSync(old), true);
  const res = sweepLaunchDirs(r, new Set(["live1"]));
  assert.equal(res.deleted, 1);
  assert.deepEqual([existsSync(old), existsSync(live), existsSync(fresh)], [false, true, true]);
});
