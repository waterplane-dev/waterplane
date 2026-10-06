// The brand table (`shared/src/brand.ts`), the env resolver that reads across
// renames (`envresolve.ts`) and the localStorage copy (`brandmigrate.ts`).
// Every name is derived from BRAND/LEGACY so no brand word is spelled here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAND, LEGACY, BRAND_WORDS, lsKey, legacyLsKeys, envName, legacyEnvNames, tmuxName, logTag,
  resolveEnv, makeEnvReader, legacyEnvText,
  migrateLegacyStorage, currentKeyFor, BRAND_MIGRATED_KEY,
} from "../dist/index.js";

const OLD = LEGACY[0];

test("the brand differs from every legacy identity in every id", () => {
  assert.ok(LEGACY.length >= 1);
  for (const l of LEGACY) {
    for (const k of Object.keys(l)) {
      if (k === "words") continue;
      assert.notEqual(BRAND[k], l[k], `BRAND.${k} still equals a legacy value`);
    }
  }
  assert.equal(BRAND.displayName, BRAND.displayName.toLowerCase(), "the display name is lowercase by decision");
});

test("helpers derive from the table", () => {
  assert.equal(lsKey("pad"), BRAND.storagePrefix + "pad");
  assert.deepEqual(legacyLsKeys("pad"), LEGACY.map((l) => l.storagePrefix + "pad"));
  assert.equal(envName("PORT"), BRAND.envPrefix + "PORT");
  assert.deepEqual(legacyEnvNames("PORT"), LEGACY.map((l) => l.envPrefix + "PORT"));
  assert.equal(tmuxName("ab12"), `${BRAND.tmuxServer}_ab12`);
  assert.equal(logTag, `[${BRAND.slug}]`);
  assert.ok(BRAND_WORDS.includes(BRAND.slug));
  for (const w of OLD.words) assert.ok(BRAND_WORDS.includes(w));
  assert.equal(new Set(BRAND_WORDS).size, BRAND_WORDS.length);
});

test("resolveEnv: current name wins, then each legacy name, else unset", () => {
  const cur = envName("PORT"), old = OLD.envPrefix + "PORT";
  assert.deepEqual(resolveEnv({ [cur]: "1", [old]: "2" }, "PORT"), { value: "1", name: cur, legacy: false });
  assert.deepEqual(resolveEnv({ [old]: "2" }, "PORT"), { value: "2", name: old, legacy: true });
  assert.deepEqual(resolveEnv({}, "PORT"), { value: undefined, name: cur, legacy: false });
  // An empty string is SET, as process.env reads it — it never falls through to a legacy value.
  assert.deepEqual(resolveEnv({ [cur]: "", [old]: "2" }, "PORT"), { value: "", name: cur, legacy: false });
});

test("the reader warns once per legacy name, naming the file", () => {
  const warns = [];
  const src = { [OLD.envPrefix + "PORT"]: "9000", [OLD.envPrefix + "TMUX"]: "0" };
  const r = makeEnvReader(src, (t) => warns.push(t), (n) => (n.endsWith("PORT") ? "/x/.env" : undefined));
  assert.equal(r.env("PORT"), "9000");
  assert.equal(r.env("PORT"), "9000");
  assert.equal(r.envBool("TMUX", true), false);
  assert.equal(r.envBool("TMUX", true), false);
  assert.equal(warns.length, 2);
  assert.equal(warns[0], legacyEnvText(OLD.envPrefix + "PORT", "PORT", "/x/.env"));
  assert.ok(warns[0].includes(envName("PORT")) && warns[0].includes("/x/.env"));
  assert.ok(!warns[1].includes("set in"));
});

test("the reader reads at call time and never warns for a current name", () => {
  const warns = [];
  const src = {};
  const r = makeEnvReader(src, (t) => warns.push(t));
  assert.equal(r.env("X"), undefined);
  src[envName("X")] = "late";
  assert.equal(r.env("X"), "late");
  assert.equal(warns.length, 0);
});

test("typed readers degrade to the default, never to NaN", () => {
  const n = (k) => envName(k);
  const r = makeEnvReader({
    [n("A")]: "42", [n("B")]: "4x", [n("C")]: "", [n("D")]: " yes ", [n("E")]: "maybe", [n("F")]: "off",
  }, () => {});
  assert.equal(r.envInt("A", 7), 42);
  assert.equal(r.envInt("B", 7), 7);
  assert.equal(r.envInt("C", 7), 7);
  assert.equal(r.envInt("Z", 7), 7);
  assert.equal(r.envBool("D", false), true);
  assert.equal(r.envBool("E", true), true);
  assert.equal(r.envBool("F", true), false);
  assert.equal(r.envBool("C", true), true);
  assert.equal(r.envStr("C", "d"), "d");
  assert.equal(r.envStr("A", "d"), "42");
});

/** A Storage over a Map, in insertion order. */
function fakeStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test("currentKeyFor rewrites the prefix only, any shape under it", () => {
  const p = OLD.storagePrefix, q = BRAND.storagePrefix;
  assert.equal(currentKeyFor(p + "pad"), q + "pad");
  assert.equal(currentKeyFor(p + "h.ab12cd34.outbox"), q + "h.ab12cd34.outbox");
  assert.equal(currentKeyFor(p + "trSeen.s1"), q + "trSeen.s1");
  assert.equal(currentKeyFor(q + "pad"), null);
  assert.equal(currentKeyFor("other"), null);
});

test("migration copies, never overwrites, never deletes, runs once", () => {
  const p = OLD.storagePrefix;
  const s = fakeStore({
    [p + "pad"]: "typed words",
    [p + "outbox"]: "old queue",
    [lsKey("outbox")]: "new queue",
    [p + "h.ab12cd34.compose"]: "parked draft",
    unrelated: "x",
  });
  const r = migrateLegacyStorage(s, 1000);
  assert.equal(r.ran, true);
  assert.equal(s.getItem(lsKey("pad")), "typed words");
  assert.equal(s.getItem(lsKey("outbox")), "new queue", "a value under the new name is never overwritten");
  assert.equal(s.getItem(lsKey("h.ab12cd34.compose")), "parked draft");
  assert.equal(s.getItem(p + "pad"), "typed words", "legacy keys stay for an older bundle");
  assert.deepEqual(r.kept, [p + "outbox"]);
  assert.equal(r.copied.length, 2);
  assert.deepEqual(JSON.parse(s.getItem(BRAND_MIGRATED_KEY)), { from: LEGACY.map((l) => l.slug), at: 1000 });
  assert.equal(s.getItem(lsKey("unrelated")), null);

  // A person clears the draft under the new name; a second boot must not resurrect it.
  s.m.delete(lsKey("pad"));
  const again = migrateLegacyStorage(s, 2000);
  assert.equal(again.ran, false);
  assert.equal(s.getItem(lsKey("pad")), null);
  assert.equal(JSON.parse(s.getItem(BRAND_MIGRATED_KEY)).at, 1000);
});

test("migration on an empty store still marks", () => {
  const s = fakeStore();
  const r = migrateLegacyStorage(s, 5);
  assert.deepEqual(r, { ran: true, copied: [], kept: [] });
  assert.notEqual(s.getItem(BRAND_MIGRATED_KEY), null);
});
