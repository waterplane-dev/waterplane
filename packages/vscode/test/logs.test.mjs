// Finding a folder's conversations: the CLI's slug rule (the host's, bundled),
// newest log first, and a sentence when there is nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, PROJECT, data, tmp } from "./helpers.mjs";

test("the fixture folder resolves to its project dir; the env is left as it was", async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  const r = await data.projectDirFor(FIXTURES, "/Users/x/repo");
  assert.equal(r.dir, PROJECT);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
});

test("override wins for the config dir", () => {
  assert.equal(data.claudeConfigDir("/somewhere/else"), "/somewhere/else");
  assert.ok(data.claudeConfigDir().length > 0);
});

test("no project dir, or no projects dir at all: null with a why", async () => {
  const a = await data.projectDirFor(FIXTURES, "/Users/x/never-ran-here");
  assert.equal(a.dir, null);
  assert.match(a.why, /has not recorded a conversation/);
  const b = await data.projectDirFor(tmp("cfg"), "/Users/x/repo");
  assert.equal(b.dir, null);
  assert.match(b.why, /does not exist/);
});

test("newest mtime wins; an empty dir has no session", async () => {
  const dir = tmp("proj");
  writeFileSync(join(dir, "old.jsonl"), "{}\n");
  writeFileSync(join(dir, "new.jsonl"), "{}\n");
  writeFileSync(join(dir, "notes.txt"), "x");
  mkdirSync(join(dir, "new", "subagents"), { recursive: true });
  writeFileSync(join(dir, "new", "subagents", "agent-1.jsonl"), "{}\n");
  utimesSync(join(dir, "old.jsonl"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(dir, "new.jsonl"), new Date(2026, 5, 1), new Date(2026, 5, 1));
  const rows = await data.listSessions(dir);
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
  assert.equal((await data.newestSession(dir)).id, "new");
  assert.equal(await data.newestSession(tmp("emptyproj")), null);
  assert.deepEqual(await data.listSessions(join(dir, "missing")), []);
});

test("a 210-char path: the truncated slug is found by its head and its recorded cwd", async () => {
  const cfg = tmp("long");
  const cwd = "/" + "a".repeat(209);
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  assert.ok(slug.length > 200);
  const dir = join(cfg, "projects", `${slug.slice(0, 200)}-1x2y3z`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c.jsonl"), JSON.stringify({ type: "user", cwd, message: { content: "hi" } }) + "\n");
  const r = await data.projectDirFor(cfg, cwd);
  assert.equal(r.dir, dir);
  // A sibling sharing the head but naming another cwd is not this folder.
  const other = "/" + "a".repeat(208) + "b";
  const r2 = await data.projectDirFor(cfg, other);
  assert.equal(r2.dir, null);
});

test("a folder reached through a symlink (/var vs /private/var) is found under its realpath", async (t) => {
  const folder = tmp("real");
  const real = realpathSync(folder);
  if (real === folder) { t.skip("tmpdir has no symlink in its path on this machine"); return; }
  const cfg = tmp("realcfg");
  mkdirSync(join(cfg, "projects", real.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true });
  const r = await data.projectDirFor(cfg, folder);
  assert.ok(r.dir);
});
