import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSkillState, resolvePluginEnabled, withSkillSettings, validateChange, savingsOf, skillSavingsLine, FACT_NAMES,
} from "../dist/index.js";

test("precedence: local beats project beats user; user off never beats project on", () => {
  assert.deepEqual(resolveSkillState("a", { user: { a: "off" }, project: { a: "on" } }), { state: "on", from: "repo-shared" });
  assert.deepEqual(resolveSkillState("a", { user: { a: "off" }, project: { a: "on" }, local: { a: "name-only" } }), { state: "name-only", from: "repo-local" });
  assert.deepEqual(resolveSkillState("a", { user: { a: "off" } }), { state: "off", from: "global" });
  assert.deepEqual(resolveSkillState("a", { user: { b: "off" }, local: { a: "bogus" } }), { state: "on", from: "default" });
});

test("a lock beats every level, the more restrictive of policy/flag wins", () => {
  assert.deepEqual(resolveSkillState("a", { local: { a: "on" } }, { policy: { a: "name-only" }, flag: { a: "off" } }), { state: "off", from: "locked" });
  assert.deepEqual(resolveSkillState("a", { local: { a: "off" } }, { policy: { a: "on" } }), { state: "on", from: "locked" });
});

test("plugins: first defined wins, default is the CLI's, a locked false wins", () => {
  assert.deepEqual(resolvePluginEnabled("p@m", { user: { "p@m": false }, project: { "p@m": true } }), { enabled: true, from: "repo-shared" });
  assert.deepEqual(resolvePluginEnabled("p@m", {}, {}, false), { enabled: false, from: "default" });
  assert.deepEqual(resolvePluginEnabled("p@m", { local: { "p@m": true } }, { policy: { "p@m": false } }), { enabled: false, from: "locked" });
});

test("write keeps other keys, order and indent; new keys append, existing keep place", () => {
  const src = '{\n    "theme": "dark",\n    "skillOverrides": {\n        "a": "on",\n        "b": "off"\n    },\n    "z": 1\n}';
  const r = withSkillSettings(src, [{ kind: "skill", id: "a", to: "off" }, { kind: "skill", id: "c", to: "name-only" }, { kind: "plugin", id: "s@synced", to: false }]);
  assert.ok(r.ok);
  const o = JSON.parse(r.text);
  assert.deepEqual(Object.keys(o), ["theme", "skillOverrides", "z", "enabledPlugins"]);
  assert.deepEqual(Object.keys(o.skillOverrides), ["a", "b", "c"]);
  assert.ok(r.text.startsWith('{\n    "theme"'));
  assert.ok(!r.text.endsWith("\n"), "no trailing newline habit kept");
  assert.deepEqual(r.changed, [{ id: "a", from: "on", to: "off" }, { id: "c", from: "inherit", to: "name-only" }, { id: "s@synced", from: "inherit", to: "false" }]);
});

test("tab indent kept, no file yet gives the 2-space form", () => {
  const r = withSkillSettings('{\n\t"x": 1\n}\n', [{ kind: "skill", id: "a", to: "off" }]);
  assert.ok(r.ok && r.text.includes('\n\t"skillOverrides"'));
  const n = withSkillSettings(null, [{ kind: "skill", id: "a", to: "off" }]);
  assert.ok(n.ok && n.text === '{\n  "skillOverrides": {\n    "a": "off"\n  }\n}\n');
});

test("inherit deletes the key and drops only an object it emptied", () => {
  const r = withSkillSettings('{"skillOverrides":{"a":"off"},"enabledPlugins":{}}\n', [{ kind: "skill", id: "a", to: "inherit" }, { kind: "plugin", id: "p@m", to: "inherit" }]);
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(r.text), { enabledPlugins: {} });
  assert.deepEqual(r.changed, [{ id: "a", from: "off", to: "inherit" }]);
});

test("refuses unparseable, array, non-object keys; writes nothing", () => {
  for (const bad of ["{nope", "[]", '{"skillOverrides":[]}', '{"enabledPlugins":"x"}', '{"skillOverrides":null}']) {
    const r = withSkillSettings(bad, [{ kind: "skill", id: "a", to: "off" }]);
    assert.equal(r.ok, false, bad);
  }
});

test("prototype keys, bad charset and bad values are refused", () => {
  for (const id of ["__proto__", "constructor", "prototype", "a b", "", "x".repeat(256)]) {
    assert.ok(validateChange({ kind: "skill", id, to: "off" }), id);
    assert.equal(withSkillSettings("{}", [{ kind: "skill", id, to: "off" }]).ok, false);
  }
  assert.ok(validateChange({ kind: "skill", id: "a", to: true }));
  assert.ok(validateChange({ kind: "skill", id: "a", to: "maybe" }));
  assert.ok(validateChange({ kind: "plugin", id: "nomarket", to: false }));
  assert.ok(validateChange({ kind: "plugin", id: "p@m", to: "off" }));
  assert.equal(validateChange({ kind: "plugin", id: "p@m", to: "inherit" }), null);
  assert.equal(validateChange({ kind: "skill", id: "anthropic-skills:docx", to: "user-invocable-only" }), null);
});

test("round trip is idempotent", () => {
  const ch = [{ kind: "skill", id: "a", to: "off" }, { kind: "plugin", id: "p@m", to: false }];
  const one = withSkillSettings('{"k":1}\n', ch);
  const two = withSkillSettings(one.text, ch);
  assert.ok(one.ok && two.ok);
  assert.equal(two.text, one.text);
  assert.deepEqual(two.changed, []);
});

const skill = (id, effective, listingChars) => ({ kind: "skill", id, source: "personal", set: {}, effective, from: "default", switchable: true, listingChars });
test("savingsOf: four states, plugins, unmeasured", () => {
  const rows = [
    skill("alpha", "on", 400), skill("beta", "name-only", 400), skill("gamma", "on", undefined),
    { kind: "plugin", id: "p@m", name: "p", scope: "user", set: {}, enabled: true, from: "default", skills: [], listingChars: 800 },
  ];
  const s = (changes) => savingsOf(rows, changes);
  assert.equal(s([{ kind: "skill", id: "alpha", to: "name-only" }]).chars, 400 - ("alpha".length + 2));
  assert.equal(s([{ kind: "skill", id: "alpha", to: "off" }]).chars, 400);
  assert.equal(s([{ kind: "skill", id: "alpha", to: "user-invocable-only" }]).chars, 400);
  assert.equal(s([{ kind: "skill", id: "alpha", to: "on" }]).chars, 0);
  assert.equal(s([{ kind: "skill", id: "beta", to: "on" }]).chars, -(400 - ("beta".length + 2)));
  assert.equal(s([{ kind: "plugin", id: "p@m", to: false }]).chars, 800);
  assert.equal(s([{ kind: "plugin", id: "p@m", to: false }]).tokens, 200);
  const u = s([{ kind: "skill", id: "gamma", to: "off" }, { kind: "skill", id: "alpha", to: "off" }, { kind: "skill", id: "alpha", to: "inherit" }]);
  assert.deepEqual([u.chars, u.unmeasured], [400, 2]);
  assert.match(skillSavingsLine(100, 2), /100 tokens fewer.*2 unmeasured/);
});

test("the skills fact is named", () => {
  assert.ok(FACT_NAMES.includes("skills"));
});
