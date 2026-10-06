/**
 * The device-preference store (`prefStore.ts`, the machinery `prefs.ts` fills
 * with the real readers and writers), over a fake storage. What it pins is the
 * three-copies bug it replaced: App held each preference as a `useState`, a ref
 * mirror a render behind it and a write effect a render behind that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNCED_SETTING_KEYS } from "@waterplane/shared";

import { LS as LS_REGISTRY } from "../storage.ts";
import { createPrefs, flagText, onIfOne, onUnlessZero, sameList } from "./prefStore.ts";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const writes = [];
  return {
    m, writes,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); writes.push([k, v]); },
  };
}

function build(ls) {
  return createPrefs({
    autoSend: { load: () => onUnlessZero(ls.get("a")), save: (v) => ls.set("a", flagText(v)), keys: ["a"] },
    cli: { load: () => onIfOne(ls.get("c")), save: (v) => ls.set("c", flagText(v)) },
    // A writer that normalises: what is stored is lower case.
    lang: { load: () => ls.get("l") ?? "auto", save: (v) => ls.set("l", v.toLowerCase()), reread: true, keys: ["l"] },
    codes: { load: () => JSON.parse(ls.get("k") ?? "[]"), save: (v) => ls.set("k", JSON.stringify(v)), same: sameList, keys: ["k"] },
  });
}

test("defaults: ON unless an explicit 0, OFF unless an explicit 1", () => {
  assert.equal(onUnlessZero(null), true);
  assert.equal(onUnlessZero("0"), false);
  assert.equal(onUnlessZero("1"), true);
  assert.equal(onIfOne(null), false);
  assert.equal(onIfOne("0"), false);
  assert.equal(onIfOne("1"), true);
  const p = build(fakeStorage());
  assert.equal(p.get("autoSend"), true);
  assert.equal(p.get("cli"), false);
});

test("loading writes nothing — a default is not a setting somebody made", () => {
  // App's write effects ran on mount and wrote every default back, which the
  // sync patch then treated as an edit made on this device.
  const ls = fakeStorage();
  build(ls);
  assert.deepEqual(ls.writes, []);
});

test("set saves, publishes, and the ref moves in the same call", () => {
  const ls = fakeStorage();
  const p = build(ls);
  const ref = p.ref("autoSend");
  let emits = 0;
  p.subscribe(() => emits++);
  p.set("autoSend", false);
  assert.deepEqual(ls.writes, [["a", "0"]]);
  assert.equal(p.get("autoSend"), false);
  assert.equal(ref.current, false, "a callback reading the ref must never be a render behind");
  assert.equal(emits, 1);
  assert.equal(p.ref("autoSend"), ref, "one ref per key, stable");
});

test("an equal value is still saved but re-renders nothing", () => {
  const ls = fakeStorage({ a: "1" });
  const p = build(ls);
  let emits = 0;
  p.subscribe(() => emits++);
  p.set("autoSend", true);
  assert.deepEqual(ls.writes, [["a", "1"]]);
  assert.equal(emits, 0);
});

test("a normalising writer publishes what it stored, not what it was handed", () => {
  const ls = fakeStorage();
  const p = build(ls);
  p.set("lang", "DE");
  assert.equal(p.get("lang"), "de");
});

test("adopt re-reads exactly the prefs that name the key", () => {
  const ls = fakeStorage();
  const p = build(ls);
  ls.m.set("a", "0");
  ls.m.set("c", "1");
  assert.equal(p.adopt("a"), true);
  assert.equal(p.get("autoSend"), false);
  assert.equal(p.get("cli"), false, "a per-device key is not re-read on another device's adopt");
  assert.equal(p.adopt("nobody"), false);
});

test("a list rebuilt on every read re-renders only when it changed", () => {
  const ls = fakeStorage({ k: '["en","de"]' });
  const p = build(ls);
  let emits = 0;
  p.subscribe(() => emits++);
  p.reload("codes");
  assert.equal(emits, 0);
  ls.m.set("k", '["en"]');
  p.reload("codes");
  assert.equal(emits, 1);
  assert.deepEqual(p.get("codes"), ["en"]);
});

/**
 * **A synced preference names its key, or another device's edit never lands.**
 *
 * `prefs.adopt(key)` re-reads exactly the prefs whose `keys` list that key —
 * which is what replaced App's `case` per synced key in `onSettingsChange`. The
 * machinery above is tested; the TABLE is not, and a new synced pref written
 * without `keys` compiles, saves, syncs up to the host, and on the other phone
 * silently never re-reads: its store keeps the stale value until a reload.
 *
 * So the table is read back out of the source: every `LS.<name>` each entry
 * reaches — in its own text, and through the reader/writer functions it names
 * (followed through module-level `const K = LS.x` aliases and same-module
 * helpers, the way `hints.ts` and `media.ts` reach theirs) — and every one of
 * those that `SYNCED_SETTING_KEYS` lists must be in that entry's `keys`. The
 * second half keeps the reading honest: a `keys` entry the walk could not reach
 * means the walk has gone blind, not that the table is right.
 */
const srcOf = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** `LS.<name>` → the storage key string, off storage.ts's one table. */
function lsTable() {
  // The registry itself, not a parse of it: keys are `lsKey(name)` calls now
  // (the prefix is the brand's), which no regex over the source can evaluate.
  return { ...LS_REGISTRY };
}

/** The brace-matched body of `name` in `text` (function or arrow const), or "". */
function defOf(text, name) {
  const m = new RegExp(`(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`).exec(text);
  if (!m) return "";
  // An arrow with an expression body ends at the line's `;`; a block body is brace-matched.
  const open = text.indexOf("{", m.index);
  const semi = text.indexOf(";\n", m.index);
  if (semi !== -1 && (open === -1 || semi < open)) return text.slice(m.index, semi);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(m.index, i + 1);
  }
  return "";
}

/** Every `LS.<name>` a piece of `text` reaches: directly, through a module
 *  const aliasing one, and through same-module functions it calls (depth 3). */
function lsReached(text, piece, depth = 3, seen = new Set()) {
  const out = new Set([...piece.matchAll(/\bLS\.(\w+)/g)].map((m) => m[1]));
  const aliases = Object.fromEntries([...text.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=\s*LS\.(\w+)\s*;/gm)].map((m) => [m[1], m[2]]));
  for (const [alias, name] of Object.entries(aliases)) if (new RegExp(`\\b${alias}\\b`).test(piece)) out.add(name);
  if (depth > 0) {
    for (const [, fn] of piece.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      if (seen.has(fn)) continue;
      seen.add(fn);
      const body = defOf(text, fn);
      if (body) for (const n of lsReached(text, body.slice(body.indexOf(fn) + fn.length), depth - 1, seen)) out.add(n);
    }
  }
  return out;
}

test("every pref that reaches a SYNCED key lists it in `keys`, so adopt re-reads it", () => {
  const LS = lsTable();
  const synced = new Set(SYNCED_SETTING_KEYS);
  const file = stripComments(srcOf("./prefs.ts"));
  // Which module each imported name comes from.
  const origin = {};
  for (const m of file.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name) origin[name] = m[2];
    }
  }
  const moduleText = (spec) => stripComments(srcOf(`./${spec}${/\.tsx?$/.test(spec) ? "" : ".ts"}`));
  const at = file.indexOf("createPrefs<DevicePrefs>({");
  const table = file.slice(at, file.indexOf("\n});", at));
  const entries = [...table.matchAll(/^ {2}(\w+):/gm)].map((m, i, all) =>
    ({ name: m[1], text: table.slice(m.index, all[i + 1]?.index ?? table.length) }));
  assert.ok(entries.length >= 20, `read ${entries.length} prefs out of prefs.ts — has the table's shape changed?`);

  const problems = [];
  const declaredAll = [];
  for (const e of entries) {
    const reached = lsReached(file, e.text);
    for (const [, id] of e.text.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const spec = origin[id];
      if (!spec || !spec.startsWith(".") || spec.includes("prefStore")) continue;
      const text = moduleText(spec);
      const body = defOf(text, id);
      if (body) for (const n of lsReached(text, body)) reached.add(n);
    }
    const reachedKeys = [...reached].map((n) => LS[n]).filter(Boolean);
    // What the entry declares: `keys: [LS.x, …]`, or `flag(LS.x, parse, true)`.
    const declared = new Set();
    const k = /\bkeys:\s*\[([^\]]*)\]/.exec(e.text);
    if (k) for (const [, n] of k[1].matchAll(/LS\.(\w+)/g)) declared.add(LS[n]);
    const f = /\bflag\(\s*LS\.(\w+)\s*,[^,)]*,\s*true\s*\)/.exec(e.text);
    if (f) declared.add(LS[f[1]]);
    for (const key of reachedKeys) {
      if (synced.has(key) && !declared.has(key)) problems.push(`${e.name} reaches synced "${key}" but does not list it in keys`);
    }
    for (const key of declared) {
      declaredAll.push(key);
      if (!reachedKeys.includes(key)) problems.push(`${e.name} lists "${key}" in keys but the walk never reached it — the check has gone blind`);
      if (!synced.has(key)) problems.push(`${e.name} lists "${key}" in keys, which is not a synced key — nothing will ever adopt it`);
    }
  }
  assert.deepEqual(problems, [],
    "A synced preference without its key in `keys` saves and syncs up, and on the OTHER device never\n" +
    "re-reads: `prefs.adopt(key)` finds nothing naming it. Add the key to that pref's `keys`.");
  assert.ok(declaredAll.length >= 8, `only ${declaredAll.length} synced keys declared — the table used to adopt eight`);
});
