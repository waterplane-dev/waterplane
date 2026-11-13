// Skills Recommend (PLAN.md P5): the model's text is data; the host validates and fills the numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-skillrec-"));
const wt = join(root, "repo");
mkdirSync(join(wt, ".claude", "skills", "kept"), { recursive: true });
writeFileSync(join(wt, "CLAUDE.md"), "Use the kept skill and the docx skill.\n");
const { recommendSkills, validateSuggestions, recommendRows } = await import("../dist/skills/skillrecommend.js");
const { sidecarPlan } = await import("../dist/sidecar.js");

const sk = (id, extra = {}) => ({ kind: "skill", id, source: "personal", set: {}, effective: "on", from: "default", switchable: true, listingChars: 400, uses: { d30: 0, all: 2, typed30: 0, typedAll: 0 }, ...extra });
const doc = () => ({
  v: 1, at: 0, layers: [], totals: { unmeasured: 0 }, usage: { state: "ready", since30: 0 },
  rows: [
    sk("old"), sk("docx"), sk("kept"), sk("already", { effective: "off" }), sk("locked", { from: "locked" }),
    sk("ps1", { source: "plugin", plugin: "p@synced", switchable: false }),
    { kind: "plugin", id: "p@synced", name: "p", scope: "synced", set: {}, enabled: true, from: "default", skills: ["ps1"], listingChars: 900 },
  ],
});
const files = {};
const reply = (o) => async () => ({ text: typeof o === "string" ? o : JSON.stringify(o), failed: false, limited: false, usd: 0.001, durationMs: 1, usage: { inTok: 100, cacheRead: 0, cacheWrite: 0, outTok: 20 } });
const S = (id, to, kind = "skill", reason = "unused here") => ({ kind, id, to, reason });
const go = (run, d = doc()) => recommendSkills(wt, d, files, { run, refused: () => null });

test("well-formed answer: host fills savings and counts", async () => {
  const r = await go(reply({ suggestions: [S("old", "off"), S("p@synced", "off", "plugin")], note: "n" }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.suggestions.map((s) => s.id), ["old", "p@synced"]);
  assert.equal(r.suggestions[0].savedChars, 400);
  assert.equal(r.suggestions[0].usesAll, 2);
  assert.equal(r.suggestions[1].savedChars, 900);
  assert.equal(r.note, "n");
  assert.equal(r.spend.inputTokens, 100);
});

test("fenced block tolerated; garbage refused with nothing changed", async () => {
  const fenced = "```json\n" + JSON.stringify({ suggestions: [S("old", "name-only")] }) + "\n```";
  assert.equal((await go(reply(fenced))).suggestions.length, 1);
  const g = await go(reply("sure! here you go"));
  assert.equal(g.ok, false);
  assert.deepEqual(g.suggestions, []);
});

test("unknown ids, bad values, never-on, plugin skills, referenced, already-off, locked, duplicates are dropped and counted", async () => {
  const r = await go(reply({ suggestions: [
    S("ghost", "off"), S("old", "on"), S("old", "weird"), S("ps1", "off"), S("docx", "off"), S("kept", "off"),
    S("already", "name-only"), S("locked", "off"), S("p@synced", "name-only", "plugin"),
    S("old", "off"), S("old", "off"),
  ] }));
  assert.deepEqual(r.suggestions.map((s) => s.id), ["old"]);
  assert.equal(r.dropped, 10);
});

test("cap of 30 and reason clipped to 140", () => {
  const many = Array.from({ length: 40 }, (_, i) => sk("s" + i));
  const d = doc(); d.rows = many;
  const rows = recommendRows(d, {}, wt);
  const v = validateSuggestions(JSON.stringify({ suggestions: many.map((m) => S(m.id, "off", "skill", "x".repeat(300))) }), d, rows);
  assert.equal(v.suggestions.length, 30);
  assert.equal(v.dropped, 10);
  assert.equal(v.suggestions[0].reason.length, 140);
});

test("referencedBy rows reach the model as file NAMES only", () => {
  const rows = recommendRows(doc(), files, wt);
  assert.deepEqual(rows.find((r) => r.id === "docx").referencedBy, ["CLAUDE.md"]);
  assert.equal(rows.find((r) => r.id === "locked"), undefined);
  assert.equal(rows.find((r) => r.id === "ps1"), undefined);
});

test("limited, signed out and failed answer a sentence and no suggestions", async () => {
  const base = { text: "", durationMs: 1 };
  const l = await go(async () => ({ ...base, failed: false, limited: true, detail: "limit" }));
  assert.equal(l.limited, true); assert.deepEqual(l.suggestions, []);
  const o = await go(async () => ({ ...base, failed: true, limited: false, signedOut: true, detail: "signed out" }));
  assert.equal(o.error, "signed out");
  assert.equal((await go(async () => ({ ...base, failed: true, limited: false }))).ok, false);
});

test("gates: counting, refused route; no call is made", async () => {
  let called = 0;
  const run = async () => { called++; return { text: "{}", failed: false, limited: false, durationMs: 1 }; };
  const d = doc(); d.usage = { state: "counting", since30: 0 };
  assert.match((await recommendSkills(wt, d, files, { run, refused: () => null })).error, /Counting uses/);
  assert.equal((await recommendSkills(wt, doc(), files, { run, refused: () => "route refused" })).error, "route refused");
  assert.equal(called, 0);
});

test("routing: the skills task is claude by default and has its own knob", () => {
  assert.equal(sidecarPlan("skills", {}).engine, "claude-p");
  assert.equal(sidecarPlan("skills", { WATERPLANE_SIDECAR_SKILLS: "openai-compat:http://localhost:1/v1|m" }).engine, "openai-compat");
});

test("an absent usage reading says why nothing can be recommended, not to try again", async () => {
  let called = 0;
  const run = async () => { called++; return { text: "{}", failed: false, limited: false, durationMs: 1 }; };
  const d = doc(); d.usage = { state: "absent", why: "No Claude logs for this repo on this desktop.", since30: 0 };
  const r = await recommendSkills(wt, d, files, { run, refused: () => null });
  assert.equal(r.ok, false);
  assert.match(r.error, /No Claude logs for this repo/);
  assert.doesNotMatch(r.error, /Try again|still running/);
  assert.equal(called, 0);
});

test("both levers: All repos lowered with this repo kept, since this repo uses it", async () => {
  const d = doc();
  d.rows[0] = sk("old", { uses: { d30: 3, all: 9, typed30: 0, typedAll: 0 }, usesEverywhere: { d30: 3, all: 9, typed30: 0, typedAll: 0 } });
  const r = await go(reply({ suggestions: [{ kind: "skill", id: "old", allRepos: "off", thisRepo: "on", reason: "Only this repo uses it." }] }), d);
  assert.deepEqual(r.suggestions.map((s) => [s.id, s.toAll, s.to]), [["old", "off", "on"]]);
  assert.equal(r.suggestions[0].savedChars, undefined, "this repo keeps it, so it saves nothing here");
  assert.equal(r.suggestions[0].everywhereAll, 9);
});

test("All repos is never raised, and never set without all-repos counts", async () => {
  const d = doc();
  d.rows[0] = sk("old", { set: { global: "off" }, effective: "off", from: "global", usesEverywhere: { d30: 0, all: 0, typed30: 0, typedAll: 0 } });
  const up = await go(reply({ suggestions: [{ kind: "skill", id: "old", allRepos: "on", reason: "r" }] }), d);
  assert.equal(up.suggestions.length, 0);
  const blind = await go(reply({ suggestions: [{ kind: "skill", id: "docx", allRepos: "off", reason: "r" }, { kind: "skill", id: "old", allRepos: "off", reason: "r" }] }));
  assert.equal(blind.suggestions.length, 0, "no usesEverywhere on the fixture rows");
});

test("a referenced item lowered for All repos is kept in this repo; an empty reason is dropped", async () => {
  const d = doc();
  for (const r of d.rows) if (r.kind === "skill") r.usesEverywhere = { d30: 0, all: 0, typed30: 0, typedAll: 0 };
  const r = await go(reply({ suggestions: [
    { kind: "skill", id: "docx", allRepos: "off", reason: "Unused elsewhere." },
    { kind: "skill", id: "old", allRepos: "name-only", reason: "  " },
  ] }), d);
  assert.deepEqual(r.suggestions.map((s) => [s.id, s.toAll, s.to]), [["docx", "off", "on"]]);
  assert.equal(r.dropped, 1);
});

test("a plugin takes on/off at both levels; All repos off leaves this repo following", async () => {
  const d = doc();
  d.rows[1].usesEverywhere = { d30: 0, all: 0, typed30: 0, typedAll: 0 };
  d.rows[5].usesEverywhere = { d30: 0, all: 0, typed30: 0, typedAll: 0 };
  const r = await go(reply({ suggestions: [{ kind: "plugin", id: "p@synced", allRepos: "off", reason: "Unused anywhere." }] }), d);
  assert.deepEqual(r.suggestions.map((s) => [s.id, s.toAll, s.to, s.savedChars]), [["p@synced", "off", undefined, 900]]);
});
