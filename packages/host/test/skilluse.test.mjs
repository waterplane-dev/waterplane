/** Skill use counts: Skill tool_use + typed commands, 30-day cut, dedupe, cache. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillUseStore } from "../dist/skills/skilluse.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ts = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const use = (id, skill, daysAgo) => JSON.stringify({ type: "assistant", timestamp: ts(daysAgo), message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } });
const typed = (uuid, name, daysAgo) => JSON.stringify({ type: "user", uuid, timestamp: ts(daysAgo), message: { content: `<command-name>/${name}</command-name>` } });

async function until(store, key, dirs, ids) {
  for (let i = 0; i < 200; i++) {
    const r = store.read(key, dirs, ids);
    if (r.state !== "counting") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("still counting");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "wp-skilluse-"));
  const dir = join(home, "proj");
  mkdirSync(join(dir, "conv", "subagents"), { recursive: true });
  const main = join(dir, "a.jsonl");
  writeFileSync(main, [
    use("t1", "alpha", 1), use("t1", "alpha", 1), // duplicate line from a resumed log
    use("t2", "alpha", 40),                       // 40 days ago: all-time only
    use("t3", "plug:beta", 2),
    typed("u1", "alpha", 3), typed("u2", "clear", 3), // built-in not in inventory
    "not json at all",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "conv", "subagents", "agent-x.jsonl"), use("t4", "alpha", 5) + "\n");
  return { home, dir, main };
}

test("counts: d30 vs all-time, dedupe, typed, subagent file, inventory filter", async () => {
  const { home, dir } = fixture();
  const s = new SkillUseStore({ file: join(home, "skilluse.json"), now: () => NOW });
  s.kick("r", [dir]);
  const r = await until(s, "r", [dir], ["alpha", "plug:beta", "gamma"]);
  assert.equal(r.state, "ready");
  assert.deepEqual(r.uses.alpha, { d30: 2, all: 3, typed30: 1, typedAll: 1 });
  assert.deepEqual(r.uses["plug:beta"], { d30: 1, all: 1, typed30: 0, typedAll: 0 });
  assert.deepEqual(r.uses.gamma, { d30: 0, all: 0, typed30: 0, typedAll: 0 });
  assert.equal(r.uses.clear, undefined);
});

test("counting is reported before the first scan; absent without logs", async () => {
  const { home, dir } = fixture();
  const s = new SkillUseStore({ file: join(home, "skilluse.json"), now: () => NOW });
  assert.equal(s.read("r", [dir], ["alpha"]).state, "counting");
  s.kick("none", [join(home, "missing")]);
  const r = await until(s, "none", [join(home, "missing")], ["alpha"]);
  assert.equal(r.state, "absent");
  assert.ok(r.why);
});

test("cache: unchanged file is not re-read; a grown file is; store survives a restart", async () => {
  const { home, dir, main } = fixture();
  const file = join(home, "skilluse.json");
  let s = new SkillUseStore({ file, now: () => NOW });
  s.kick("r", [dir]);
  await until(s, "r", [dir], ["alpha"]);
  // Change content but keep size and mtime: a cache hit must not see it.
  const { statSync, readFileSync } = await import("node:fs");
  const st = statSync(main);
  const body = readFileSync(main, "utf8").replace('"alpha"', '"alphb"');
  writeFileSync(main, body);
  utimesSync(main, st.atimeMs / 1000, st.mtimeMs / 1000);
  s = new SkillUseStore({ file, now: () => NOW, freshMs: 0 }); // reloaded from disk
  s.kick("r", [dir]);
  let r = await until(s, "r", [dir], ["alpha"]);
  assert.equal(r.uses.alpha.all, 3, "same mtime+size reuses the cached summary");
  appendFileSync(main, use("t9", "alpha", 0) + "\n");
  s.kick("r", [dir]);
  for (let i = 0; i < 200 && r.uses.alpha.all === 3; i++) { await new Promise((x) => setTimeout(x, 10)); r = s.read("r", [dir], ["alpha"]); }
  assert.equal(r.uses.alpha.all, 3 + 1 - 1 + 0, "re-read picks up the edit (alpha->alphb) and the new line");
});

test("tiny chunks give the same counts", async () => {
  const { home, dir } = fixture();
  const s = new SkillUseStore({ file: join(home, "skilluse.json"), now: () => NOW, chunk: 37 });
  s.kick("r", [dir]);
  const r = await until(s, "r", [dir], ["alpha"]);
  assert.deepEqual(r.uses.alpha, { d30: 2, all: 3, typed30: 1, typedAll: 1 });
});

test("a screen that kicks before every read still reaches ready", async () => {
  const { home, dir } = fixture();
  const s = new SkillUseStore({ file: join(home, "skilluse.json"), now: () => NOW });
  let r;
  for (let i = 0; i < 100; i++) {
    s.kick("r", [dir]);
    r = s.read("r", [dir], ["alpha"]);
    if (r.state === "ready") break;
    await new Promise((x) => setTimeout(x, 20));
  }
  assert.equal(r.state, "ready", "a finished scan is kept, so kick() does not start a new one under read()");
  s.kick("r", [dir]);
  assert.equal(s.read("r", [dir], ["alpha"]).state, "ready", "and stays ready on the next request");
});

test("a refresh after the fresh window keeps serving the stored counts instead of counting", async () => {
  const { home, dir, main } = fixture();
  const s = new SkillUseStore({ file: join(home, "skilluse.json"), now: () => NOW, freshMs: 0 });
  s.kick("r", [dir]);
  await until(s, "r", [dir], ["alpha"]);
  appendFileSync(main, use("t10", "alpha", 0) + "\n");
  s.kick("r", [dir]); // the window has passed: a new scan runs
  const r = s.read("r", [dir], ["alpha"]);
  assert.equal(r.state, "ready", "the finished counts answer while the refresh runs");
  assert.equal(r.uses.alpha.all, 3);
  assert.equal(r.refreshing, true, "and says they may be stale, so the screen asks again");
  let fresh = r;
  for (let i = 0; i < 200 && fresh.refreshing; i++) { await new Promise((x) => setTimeout(x, 10)); fresh = s.read("r", [dir], ["alpha"]); }
  assert.equal(fresh.refreshing, undefined);
  assert.equal(fresh.uses.alpha.all, 4, "the finished refresh serves the new counts");
});
