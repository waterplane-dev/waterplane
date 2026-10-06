/**
 * Which autoCompactWindow a spawned session sees, and what the checklist may
 * SAY about it: env > repo local > repo > user > unset, a value it cannot read
 * is stated as unreadable (never guessed into a number), and the one write
 * keeps every other key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAutoCompactWindow,
  resolveAutoCompact,
  autoCompactVerdict,
  cleanAutoCompactDefault,
  AUTO_COMPACT_CHOICES,
  withAutoCompactWindow,
  formatTokenWindow,
} from "../dist/autocompact.js";

const L = (path, obj) => ({ path, text: obj === undefined ? null : typeof obj === "string" ? obj : JSON.stringify(obj) });
const none = { local: L("l"), project: L("p"), user: L("u") };

test("parses the CLI's spellings", () => {
  assert.deepEqual(parseAutoCompactWindow("400k"), { kind: "size", tokens: 400_000 });
  assert.deepEqual(parseAutoCompactWindow("400K"), { kind: "size", tokens: 400_000 });
  assert.deepEqual(parseAutoCompactWindow("1M"), { kind: "size", tokens: 1_000_000 });
  assert.deepEqual(parseAutoCompactWindow("1.5m"), { kind: "size", tokens: 1_500_000 });
  assert.deepEqual(parseAutoCompactWindow("250000"), { kind: "size", tokens: 250_000 });
  assert.deepEqual(parseAutoCompactWindow(300000), { kind: "size", tokens: 300_000 });
  assert.deepEqual(parseAutoCompactWindow("auto"), { kind: "auto" });
  assert.deepEqual(parseAutoCompactWindow(" AUTO "), { kind: "auto" });
});

test("garbage is unparseable, carrying what was there — never a number", () => {
  for (const g of ["lots", "400kb", "", "0", "-5k", "1G"]) {
    const v = parseAutoCompactWindow(g);
    assert.equal(v.kind, "unparseable", g);
    assert.equal(v.raw, g);
  }
  assert.equal(parseAutoCompactWindow(true).kind, "unparseable");
  assert.equal(parseAutoCompactWindow({ a: 1 }).kind, "unparseable");
});

test("precedence: env > local > project > user > unset", () => {
  const all = { env: "200k", local: L("l", { autoCompactWindow: "300k" }), project: L("p", { autoCompactWindow: "400k" }), user: L("u", { autoCompactWindow: "1M" }) };
  assert.equal(resolveAutoCompact(all).source, "env");
  assert.equal(resolveAutoCompact({ ...all, env: undefined }).source, "local");
  assert.equal(resolveAutoCompact({ ...all, env: "  ", local: L("l", { other: 1 }) }).source, "project");
  const u = resolveAutoCompact({ ...none, user: L("u", { autoCompactWindow: "1M" }) });
  assert.equal(u.source, "user");
  assert.deepEqual(u.value, { kind: "size", tokens: 1_000_000 });
  const n = resolveAutoCompact(none);
  assert.equal(n.source, "unset");
  assert.deepEqual(n.value, { kind: "auto" });
});

test("an unreadable settings file is named and decides nothing", () => {
  const r = resolveAutoCompact({ ...none, local: L("l", "{ nope"), user: L("u", { autoCompactWindow: "400k" }) });
  assert.equal(r.source, "user");
  assert.deepEqual(r.unreadable, ["l"]);
  assert.match(autoCompactVerdict(r).detail, /Not valid JSON.*l\./);
});

test("verdict: pass at ≤500k, warn for auto/unset/above/unparseable, never fail", () => {
  const v = (x) => autoCompactVerdict(resolveAutoCompact({ ...none, project: L("p", { autoCompactWindow: x }) }));
  assert.equal(v("400k").status, "pass");
  assert.equal(v("500k").status, "pass");
  assert.equal(v("600k").status, "warn");
  assert.equal(v("auto").status, "warn");
  assert.match(v("auto").detail, /1M on a 1M model/);
  const g = v("lots");
  assert.equal(g.status, "warn");
  assert.match(g.detail, /"lots", which is not a size/);
  const un = autoCompactVerdict(resolveAutoCompact(none));
  assert.equal(un.status, "warn");
  assert.match(un.detail, /unset.*auto/);
  assert.match(v("400k").detail, /this repo's \.claude\/settings\.json/);
});

test("a chosen default raises the pass line and is range-checked", () => {
  const r = resolveAutoCompact({ ...none, project: L("p", { autoCompactWindow: "700k" }) });
  assert.equal(autoCompactVerdict(r).status, "warn");
  assert.equal(autoCompactVerdict(r, "700k").status, "pass");
  assert.equal(autoCompactVerdict(r, "300k").status, "warn", "a smaller choice never lowers the 500k line");
  assert.deepEqual(cleanAutoCompactDefault("300k"), { ok: true, value: "300k" });
  assert.deepEqual(cleanAutoCompactDefault(250000), { ok: true, value: "250k" });
  assert.equal(cleanAutoCompactDefault("5k").ok, false);
  assert.equal(cleanAutoCompactDefault("1M").ok, false);
  assert.equal(cleanAutoCompactDefault("auto").ok, false);
  for (const c of AUTO_COMPACT_CHOICES) assert.equal(cleanAutoCompactDefault(c).ok, true, c);
});

test("the write keeps every other key and the 2-space + newline form", () => {
  const before = JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, model: "opus" }, null, 2) + "\n";
  const r = withAutoCompactWindow(before, "400k");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.text), { permissions: { allow: ["Bash(ls)"] }, model: "opus", autoCompactWindow: "400k" });
  assert.ok(r.text.endsWith("}\n"));
  assert.match(r.text, /\n  "model": "opus",\n/);
  // An existing key keeps its place.
  const again = withAutoCompactWindow(JSON.stringify({ autoCompactWindow: "auto", z: 1 }), "400k");
  assert.deepEqual(Object.keys(JSON.parse(again.text)), ["autoCompactWindow", "z"]);
  // No file yet.
  assert.equal(withAutoCompactWindow(null, "400k").text, '{\n  "autoCompactWindow": "400k"\n}\n');
  // A file that is not a JSON object is refused, never overwritten.
  assert.equal(withAutoCompactWindow("{ broken", "400k").ok, false);
  assert.equal(withAutoCompactWindow("[1]", "400k").ok, false);
});

test("formats windows the way they are written", () => {
  assert.equal(formatTokenWindow(400_000), "400k");
  assert.equal(formatTokenWindow(1_000_000), "1M");
  assert.equal(formatTokenWindow(1_500_000), "1.5M");
});
