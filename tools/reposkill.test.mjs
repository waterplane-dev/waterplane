/**
 * The delivered repo-facing skill has to grow with the product.
 *
 * `packages/host/src/reposkilltext.ts` is what the agent in a driven repo
 * learns about the product. It goes stale silently: a new per-repo file lands in the
 * host, nobody thinks of the other repos' agents, and they never hear of it.
 * So this reads the host's source for every file it reads or writes under a
 * REPO's state dir (a `join(<repo dir>, state dir, "<name>")` — `root` and friends
 * are the host's own store, not the repo's) and fails when the skill never
 * names one, unless it is listed below with the reason the agent need not know.
 *
 * The skill reaches every session the host spawns via `--plugin-dir`
 * (`reposkill.ts`), so editing the text is the whole release process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "host", "src");
const SKILL = readFileSync(join(SRC, "reposkilltext.ts"), "utf8");

/** The host's OWN directories — a state dir under these is the daemon's store. */
const HOST_ROOTS = new Set(["root", "this.root", "ROOT", "ctx.ROOT", "core.root", "core.deps.root", "i.root"]);

/** Per-repo files the agent in that repo has no reason to touch, and why. */
const NOT_FOR_THE_AGENT = {
  "backlog.json": "legacy per-repo store, only ever migrated into the host's own on boot",
  "repohealth-scopes.json": "written by the phone's scope picker; the agent never edits it",
};

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.ts$/.test(e.name)) yield p;
  }
}

function repoStateFiles() {
  const out = new Map();
  for (const f of files(SRC)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/join\(([\w.]+), (?:"\.(?:myapp|waterplane)"|BRAND\.stateDirName), "([^"]+)"/g)) {
      if (HOST_ROOTS.has(m[1])) continue;
      out.set(m[2], f.slice(ROOT.length));
    }
    // `branddirs.ts`' resolver: `join(repoStateDir(x), "<file>")` is per-repo
    // by name (the global one is `hostStateDir`), so no HOST_ROOTS check is needed.
    for (const m of src.matchAll(/join\(repoStateDir\([\w.]+\), "([^"]+)"/g)) {
      out.set(m[1], f.slice(ROOT.length));
    }
  }
  return out;
}

test("every per-repo state-dir file the host reads is named in the repo-facing skill, or excused", () => {
  const found = repoStateFiles();
  assert.ok(found.size >= 3, `the scan found ${found.size} per-repo files — the pattern has probably drifted`);
  const missing = [...found].filter(([name]) => !SKILL.includes(name) && !(name in NOT_FOR_THE_AGENT));
  assert.deepEqual(missing, [],
    "these per-repo files are read by the host but the delivered skill never mentions them — " +
    "say in packages/host/src/reposkilltext.ts what the agent should do with each, or excuse it in " +
    "tools/reposkill.test.mjs with a reason");
});

test("every excuse is still a file the host reads", () => {
  const found = repoStateFiles();
  for (const name of Object.keys(NOT_FOR_THE_AGENT)) {
    assert.ok(found.has(name), `${name} is excused but the host no longer reads it — drop the excuse`);
  }
});
