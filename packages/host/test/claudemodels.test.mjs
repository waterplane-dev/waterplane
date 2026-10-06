// The claude catalogue: built-ins + the optional <config dir>/models.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { claudeModels, parseModelsOverride, mergeModels, CLAUDE_BUILTIN_IDS, CLAUDE_BUILTIN_ALIASES } =
  await import("../dist/backends/claudemodels.js");
const { claudeBackend } = await import("../dist/backends/claude.js");

const file = (txt) => { const f = join(mkdtempSync(join(tmpdir(), "models-")), "models.json"); writeFileSync(f, txt); return f; };
const quiet = async (fn) => { const w = console.warn; const lines = []; console.warn = (m) => lines.push(String(m)); try { return [await fn(), lines]; } finally { console.warn = w; } };

test("no file ⇒ the built-in list, no log", async () => {
  const [m, log] = await quiet(() => claudeModels(join(tmpdir(), "nope-models.json")));
  assert.deepEqual(m.ids, [...CLAUDE_BUILTIN_IDS]);
  assert.deepEqual(m.aliases, [...CLAUDE_BUILTIN_ALIASES]);
  assert.deepEqual(log, []);
});

test("built-in shape: aliases bare words, ids claude- prefixed, no duplicates, newest first", () => {
  for (const a of CLAUDE_BUILTIN_ALIASES) assert.match(a, /^[a-z]+(?:\[1m\])?$/, a);
  for (const id of CLAUDE_BUILTIN_IDS) assert.match(id, /^claude-(?:opus|sonnet|haiku|fable)-[0-9](?:-[0-9])?(?:\[1m\])?$/, id);
  assert.equal(new Set(CLAUDE_BUILTIN_IDS).size, CLAUDE_BUILTIN_IDS.length);
  assert.equal(CLAUDE_BUILTIN_IDS[0], "claude-opus-5-5");
  assert.equal(CLAUDE_BUILTIN_ALIASES[0], "opus");
});

test("add appends and de-duplicates; hide removes built-ins and added ones", async () => {
  const f = file(JSON.stringify({ add: { aliases: ["mine"], ids: ["claude-opus-5-5", "x-corp/y"] }, hide: ["haiku", "claude-opus-4-5", "x-corp/y"] }));
  const [m, log] = await quiet(() => claudeModels(f));
  assert.deepEqual(log, []);
  assert.ok(m.aliases.includes("mine") && !m.aliases.includes("haiku"));
  assert.equal(m.ids.filter((i) => i === "claude-opus-5-5").length, 1);
  assert.ok(!m.ids.includes("claude-opus-4-5") && !m.ids.includes("x-corp/y"));
  assert.equal(m.ids.length, CLAUDE_BUILTIN_IDS.length - 1);
});

test("invalid file ⇒ built-ins and exactly one log line, never a throw", async () => {
  for (const bad of ["{nope", "[]", '{"hide":"haiku"}', '{"add":{"ids":[1]}}', '{"extra":1}', '{"hide":[""]}']) {
    const [m, log] = await quiet(() => claudeModels(file(bad)));
    assert.deepEqual(m.ids, [...CLAUDE_BUILTIN_IDS], bad);
    assert.equal(log.length, 1, bad);
    assert.match(log[0], /ignored/, bad);
  }
});

test("parse is whole-or-nothing and merge(null) is the built-ins", () => {
  assert.ok("error" in parseModelsOverride('{"hide":["a"],"add":{"zzz":[]}}'));
  assert.deepEqual(mergeModels(null).ids, [...CLAUDE_BUILTIN_IDS]);
});

test("the claude descriptor serves the merged catalogue", async () => {
  const m = await claudeBackend.models();
  assert.ok(m.ids.length > 0 && m.aliases.length > 0);
});
