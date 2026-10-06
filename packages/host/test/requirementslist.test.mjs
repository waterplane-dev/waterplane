/**
 * The requirements extension's host methods (`summary`, `list`, `setup`, `update`) against a fixture
 * repo and a fake `HostPluginApi`: what the sheet may be told, and that `update` only ever WAITS
 * (handToAgent without `fire`). The setup row's own words are `requirementsrow.test.mjs`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-reqlist-home-")));
process.env.HOME = fakeHome;

const ext = await import("../dist/extensions/requirements/host/index.mjs");
const { updateKey, updateKeyNth } = await import("../dist/extensions/requirements/shared/methods.mjs");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const wt = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-reqlist-repo-")));
git(wt, "init", "-q");
writeFileSync(join(wt, "a.txt"), "a");
git(wt, "add", ".");
git(wt, "commit", "-q", "-m", "the shipping commit");
const REAL = git(wt, "rev-parse", "--short", "HEAD");
const FAKE = "deadbee";

const scope = {
  id: "repo1", name: "fixture", branch: "main", isPrimary: true, worktree: wt,
  readFile: (rel, max) => { try { return readFileSync(join(wt, rel), "utf8").slice(0, max ?? 1e9); } catch { return null; } },
  listDir: (rel = "") => { try { return readdirSync(join(wt, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })); } catch { return null; } },
  git: () => null,
};
const handlers = new Map();
const hand = [];
const rows = new Map(); // key -> { id, state }: what the fake store already holds
const api = {
  setupCheck: () => () => {}, setupFix: () => () => {},
  handle: (m, fn) => { handlers.set(m, fn); return () => handlers.delete(m); },
  repo: async (id) => (id === "repo1" ? scope : null),
  handToAgent: async (repoId, prompt, opts) => {
    hand.push({ repoId, prompt, opts });
    const row = rows.get(opts.key);
    if (row) return { ok: true, intentId: row.id, existing: true, state: row.state };
    return { ok: true, intentId: "i-1", existing: false };
  },
};
ext.activate(api);
const call = (m, a) => handlers.get(m)(a);

test("not set up: summary says so, update refuses in words, setup writes two files once", async () => {
  assert.deepEqual(await call("summary", { repo: "repo1" }), { setUp: false, built: false, requested: 0, total: 0 });
  await assert.rejects(call("update", { repo: "repo1" }), /not set up/);
  const a = await call("setup", { repo: "repo1" });
  assert.equal(a.applied, true);
  assert.ok(existsSync(join(wt, ".claude/skills/requirements/SKILL.md")));
  assert.ok(existsSync(join(wt, "docs/requirements/README.md")));
  assert.equal((await call("setup", { repo: "repo1" })).applied, false);
  assert.equal(hand.length, 0);
});

test("a missing or unknown repo is a sentence, not a crash", async () => {
  await assert.rejects(call("list", {}), /which repo/);
  await assert.rejects(call("list", { repo: "nope" }), /no repo "nope"/);
});

test("list: items, areas, real sha resolved, fake sha absent; summary agrees", async () => {
  writeFileSync(join(wt, "docs/requirements/ui.md"),
    `# ui\n\n### R-ui-001 · shipped\nIt works.\n- asked: 2026-09-16 (session 61c1e521)\n- shipped: ${REAL}, ${FAKE}\n\n### R-ui-002 · requested\nNot yet.\n`);
  writeFileSync(join(wt, "docs/requirements/zz.md"), "# zz\n\n### R-zz-001 · requested\nAnother.\n");
  const l = await call("list", { repo: "repo1" });
  assert.deepEqual(l.areas, ["ui", "zz"]);
  assert.deepEqual(l.items.map((i) => i.id), ["R-ui-001", "R-ui-002", "R-zz-001"]);
  assert.ok(l.setUp && l.scriptFound);
  assert.equal(l.commits[REAL].subject, "the shipping commit");
  assert.equal(l.commits[FAKE], undefined);
  const s = await call("summary", { repo: "repo1" });
  assert.equal(s.requested, l.items.filter((i) => i.status === "requested").length);
  assert.equal(s.total, 3);
});

test("update waits for a tap, keyed by build state; a new build frees the next", async () => {
  const r = await call("update", { repo: "repo1" });
  assert.equal(r.intentId, "i-1");
  const h = hand.at(-1);
  assert.equal(h.opts.fire, undefined);
  assert.equal(h.opts.key, updateKey("repo1", null));
  assert.match(h.opts.key, /\.never$/);
  assert.match(h.prompt, /Update the requirements list in fixture/);
  assert.match(h.prompt, /Do not commit it/);
  writeFileSync(join(wt, "docs/requirements/.state.json"), JSON.stringify({ lastRun: "2026-09-20T10:00:00.000Z" }));
  await call("update", { repo: "repo1" });
  assert.notEqual(hand.at(-1).opts.key, h.opts.key);
  assert.match(hand.at(-1).opts.key, /^[A-Za-z0-9._:-]{1,44}$/);
});

test("update: a settled row for this build state does not answer every later tap — a new key makes a new item", async () => {
  const base = updateKey("repo1", "2026-09-20T10:00:00.000Z");
  rows.set(base, { id: "old", state: "done" });
  const r1 = await call("update", { repo: "repo1" });
  assert.deepEqual(r1, { intentId: "i-1", existing: false });
  assert.equal(hand.at(-1).opts.key, `${base}.1`);
  assert.ok(hand.at(-1).opts.key.length <= 44);
  rows.set(`${base}.1`, { id: "new", state: "queued" });
  assert.deepEqual(await call("update", { repo: "repo1" }), { intentId: "new", existing: true });
  rows.set(`${base}.1`, { id: "new", state: "failed" });
  await call("update", { repo: "repo1" });
  assert.equal(hand.at(-1).opts.key, `${base}.2`);
  assert.equal(updateKeyNth("repo1", "2026-09-20T10:00:00.000Z", 0), base);
});

test("list is cached on what it reads: unchanged = the same answer, a new area file or commit = a fresh one", async () => {
  const a = await call("list", { repo: "repo1" });
  const b = await call("list", { repo: "repo1" });
  assert.deepEqual(a, b);
  writeFileSync(join(wt, "docs/requirements/zz.md"), "# zz\n\n### R-zz-001 · requested\nAnother.\n\n### R-zz-002 · requested\nMore.\n");
  assert.equal((await call("list", { repo: "repo1" })).items.length, a.items.length + 1);
  const before = (await call("list", { repo: "repo1" })).commitsBehind;
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "b.txt"); git(wt, "commit", "-q", "-m", "second");
  assert.equal((await call("list", { repo: "repo1" })).commitsBehind, before + 1);
});
