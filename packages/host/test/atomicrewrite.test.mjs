/**
 * A file that belongs to someone else (a repo's `.gitignore`, `CLAUDE.md`) is rewritten atomically
 * and keeps its mode, and the state files that used to be loaded with `try { JSON.parse } catch
 * { fresh }` move a corrupt copy aside instead of leaving it for the next save to erase.
 *
 * Why it matters: a plain `writeFileSync` truncates first, so a SIGTERM (`npm run restart`) or a
 * full disk mid-write left half of the user's own file. The output bytes below are the contract —
 * the atomic write must be byte-identical to what the truncating one produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const home = mkdtempSync(join(tmpdir(), "atomicrewrite-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
for (const k of Object.keys(process.env)) if (/CONFIG_DIR$/.test(k)) delete process.env[k];

const { fixRepoCompliance } = await import("../dist/compliance.js");
const { setSecret } = await import("../dist/secrets.js");
const { linkKey } = await import("../dist/signkey.js");
const { writeTextAtomicKeepMode } = await import("../dist/jsonstore.js");
const { loadHistory } = await import("../dist/sessions/record.js");
const { LocalUsageLedger } = await import("../dist/localusage.js");

const mode = (p) => statSync(p).mode & 0o777;
const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atomicrewrite-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
};
const target = (dir) => ({ id: "t", repoName: "demo", branch: "main", isPrimary: true, worktreePath: dir, outboxCount: 0, changedCount: 0 });
const noTmp = (dir) => assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no tmp file lingers");
const quietly = (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};
const corruptSiblings = (dir, name) => readdirSync(dir).filter((n) => n.startsWith(`${name}.corrupt-`));

test("gitignore fix: a file with no trailing newline gets one, the block lands byte-for-byte, the mode survives", () => {
  const d = repo();
  const gi = join(d, ".gitignore");
  writeFileSync(gi, "node_modules");
  chmodSync(gi, 0o640);
  const r = fixRepoCompliance(target(d), ["gitignore"]);
  assert.equal(r.ok, true, r.error);
  const body = readFileSync(gi, "utf8");
  assert.ok(body.startsWith("node_modules\n\n# "), "the missing newline is added before the block");
  assert.ok(body.endsWith("\n"));
  const lines = body.split("\n");
  assert.ok(lines.includes(".claude/outbox") && lines.includes(".claude/inbox"), body);
  assert.equal(mode(gi), 0o640, "a rename must not swap in the umask's mode");
  noTmp(d);
  // Idempotent: a second run adds nothing and leaves the bytes alone.
  const again = fixRepoCompliance(target(d), ["gitignore"]);
  assert.equal(again.ok, true);
  assert.equal(readFileSync(gi, "utf8"), body);
});

test("gitignore fix: a missing .gitignore is created with the default mode", () => {
  const d = repo();
  const r = fixRepoCompliance(target(d), ["gitignore"]);
  assert.equal(r.ok, true, r.error);
  const body = readFileSync(join(d, ".gitignore"), "utf8");
  assert.ok(body.startsWith("\n# "), "an empty file gets the block as before: a blank line, then the comment");
  assert.equal(mode(join(d, ".gitignore")), 0o666 & ~process.umask());
});

test("a symlinked .gitignore is written THROUGH, not replaced", () => {
  const d = repo();
  const real = join(d, "shared-ignore");
  writeFileSync(real, "a\n");
  symlinkSync("shared-ignore", join(d, ".gitignore"));
  assert.equal(fixRepoCompliance(target(d), ["gitignore"]).ok, true);
  assert.ok(lstatSync(join(d, ".gitignore")).isSymbolicLink(), "still a link");
  assert.match(readFileSync(real, "utf8"), /^a\n\n# /);
});

test("claude-md fix: appends exactly the block with the mode kept, and never scaffolds a bare CLAUDE.md", () => {
  const d = repo();
  const none = fixRepoCompliance(target(d), ["claude-md"]);
  assert.equal(none.ok, true);
  assert.deepEqual(readdirSync(d).filter((n) => n === "CLAUDE.md"), [], "no CLAUDE.md is created");
  assert.match(none.notes.join(" "), /\/init/);

  const p = join(d, "CLAUDE.md");
  writeFileSync(p, "# mine");
  chmodSync(p, 0o600);
  const r = fixRepoCompliance(target(d), ["claude-md"]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.applied, ["claude-md"]);
  const body = readFileSync(p, "utf8");
  assert.ok(body.startsWith("# mine\n\n"), "one newline to finish the line, one blank line, then the block");
  assert.equal(mode(p), 0o600);
  noTmp(d);
  // Marker present now: a second run leaves it alone.
  assert.deepEqual(fixRepoCompliance(target(d), ["claude-md"]).applied, []);
  assert.equal(readFileSync(p, "utf8"), body);
});

test("setSecret: the .gitignore it must add before writing keeps its mode and ends in a newline", () => {
  const d = repo();
  const gi = join(d, ".gitignore");
  writeFileSync(gi, "dist");
  chmodSync(gi, 0o640);
  const r = setSecret({ root: d, scope: "repo", worktree: d, file: ".env", key: "K", value: "v" });
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(gi, "utf8"), "dist\n.env\n");
  assert.equal(mode(gi), 0o640);
  noTmp(d);
});

test("linkKey: the .gitignore it extends keeps its mode; the pointer file is 0600", () => {
  mkdirSync(join(home, ".android"), { recursive: true });
  writeFileSync(join(home, ".android", "debug.keystore"), "x");
  const d = repo();
  const gi = join(d, ".gitignore");
  writeFileSync(gi, "build");
  chmodSync(gi, 0o640);
  const r = linkKey(d, "debug");
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(gi, "utf8"), "build\n\n# signing key pointer — never commit\nkeystore.properties\n*.jks\n");
  assert.equal(mode(gi), 0o640);
  assert.equal(mode(join(d, "keystore.properties")), 0o600);
  noTmp(d);
});

test("writeTextAtomicKeepMode: an executable bit survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomicrewrite-x-"));
  const p = join(dir, "run.sh");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  writeTextAtomicKeepMode(p, "#!/bin/sh\necho hi\n");
  assert.equal(mode(p), 0o755);
  assert.equal(readFileSync(p, "utf8"), "#!/bin/sh\necho hi\n");
});

// ── guarded loads ───────────────────────────────────────────────────────────

test("loadHistory: absent is empty and silent; a good file loads; garbage is moved aside, not kept in place", () => {
  const root = mkdtempSync(join(tmpdir(), "atomicrewrite-root-"));
  const core = { root };
  const dir = join(root, BRAND.stateDirName, "history");
  assert.deepEqual(loadHistory(core, "s1"), []);
  mkdirSync(dir, { recursive: true });
  const entry = { id: "e1", kind: "prompt", text: "hi", sentAt: 5 };
  writeFileSync(join(dir, "s1.json"), JSON.stringify([entry]));
  assert.deepEqual(loadHistory(core, "s1"), [entry]);

  writeFileSync(join(dir, "s2.json"), '[{"id":"e1","kind":"pro'); // torn write
  assert.deepEqual(quietly(() => loadHistory(core, "s2")), []);
  assert.equal(corruptSiblings(dir, "s2.json").length, 1, "the torn bytes are kept for a person");
  assert.ok(!readdirSync(dir).includes("s2.json"), "so the next save does not overwrite them");

  writeFileSync(join(dir, "s3.json"), '{"not":"an array"}'); // parses, wrong shape
  assert.deepEqual(quietly(() => loadHistory(core, "s3")), []);
  assert.equal(corruptSiblings(dir, "s3.json").length, 1);
});

test("localusage: a ledger that is not v1 is moved aside, never left for the first save", () => {
  const root = mkdtempSync(join(tmpdir(), "atomicrewrite-lu-"));
  const dir = join(root, BRAND.stateDirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "localusage.json"), '{"v":1,"since":'); // torn
  quietly(() => new LocalUsageLedger(root, 20_000, async () => ({ models: [] })));
  assert.equal(corruptSiblings(dir, "localusage.json").length, 1);
  assert.ok(!readdirSync(dir).includes("localusage.json"));

  const root2 = mkdtempSync(join(tmpdir(), "atomicrewrite-lu-"));
  const dir2 = join(root2, BRAND.stateDirName);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "localusage.json"), '{"v":2,"since":1}'); // a newer build's
  quietly(() => new LocalUsageLedger(root2, 20_000, async () => ({ models: [] })));
  assert.equal(corruptSiblings(dir2, "localusage.json").length, 1);
});
