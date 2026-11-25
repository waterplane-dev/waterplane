// The opt-in catalog: one registry, one cut feeding every count, prompts that
// carry the marker the host probes for, and a walk-through that posts rather
// than does. Reasoning: packages/shared/src/optins.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAND, OPT_INS, OPT_IN_PICKS_FILE, OPT_IN_PICK_WHY_MAX, cleanOptInPicks, cleanOptInRow, installAllowSetting, optInKind, optInLookPrompt, optInActiveWords, optInCut, optInDef, optInMarkedIds, optInMarker, optInPrompt, optInRule, optInWalkPrompt,
} from "../dist/index.js";

test("ids are unique and every agent/schedule offer has a prompt carrying its marker", () => {
  const ids = OPT_INS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of OPT_INS) {
    const runs = d.action.kind === "agent" || d.action.kind === "schedule";
    assert.equal(!!d.prompt, runs, d.id);
    if (runs) {
      const p = optInPrompt(d.id, "demo");
      assert.ok(p.endsWith(optInMarker(d.id)), d.id);
      assert.ok(!/\{(repo|marker|shared|skill)\}/.test(p), d.id);
    } else {
      assert.equal(optInPrompt(d.id, "demo"), null);
    }
  }
});

test("the security review is read-only, writes to the outbox by full path, and seeds Fable weekly", () => {
  const p = optInPrompt("security-review", "demo");
  assert.match(p, /Read-only/);
  assert.match(p, /\.claude\/outbox\/security-review-/);
  const a = optInDef("security-review").action;
  assert.equal(a.kind, "schedule");
  assert.equal(a.model, "fable");
  assert.deepEqual(optInRule("security-review", "Europe/Berlin"), { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "Europe/Berlin" });
  assert.equal(optInRule("local-ci", "UTC"), null);
});

test("optInCut: declined beats on, done is active, unfit is never offered, unknown ids dropped", () => {
  const rows = [
    { id: "requirements", relevant: true, state: "off", detail: "" },
    { id: "local-ci", relevant: true, state: "on", detail: "" },
    { id: "gcp-cleanup", relevant: true, state: "unknown", detail: "", choice: "done" },
    { id: "npm-supply-chain", relevant: false, state: "off", detail: "" },
    { id: "repo-health", relevant: true, state: "on", detail: "", choice: "declined" },
    { id: "from-a-newer-desktop", relevant: true, state: "off", detail: "" },
  ];
  const c = optInCut(rows);
  assert.deepEqual(c.offered.map((r) => r.id), ["requirements"]);
  assert.deepEqual(c.active.map((r) => r.id), ["local-ci", "gcp-cleanup"]);
  assert.deepEqual(c.declined.map((r) => r.id), ["repo-health"]);
  assert.deepEqual(c.unfit.map((r) => r.id), ["npm-supply-chain"]);
  assert.equal(optInActiveWords(c.active[0]), "on");
  assert.equal(optInActiveWords(c.active[1]), "marked done by you");
  assert.deepEqual(c.started, []);
});

test("optInCut: a sent or half-done offer is started, not offered; on, done and declined still win", () => {
  const sent = { at: 5, status: "ended" };
  const c = optInCut([
    { id: "requirements", relevant: true, state: "off", detail: "" },
    { id: "local-ci", relevant: true, state: "off", detail: "", sent },
    { id: "repo-health-own", relevant: true, state: "off", detail: "", partial: true },
    { id: "security-review", relevant: true, state: "on", detail: "", sent },
    { id: "npm-supply-chain", relevant: true, state: "off", detail: "", sent, choice: "done" },
    { id: "gcp-cleanup", relevant: true, state: "unknown", detail: "", sent, choice: "declined" },
  ]);
  assert.deepEqual(c.offered.map((r) => r.id), ["requirements"]);
  assert.deepEqual(c.started.map((r) => r.id), ["local-ci", "repo-health-own"]);
  assert.deepEqual(c.active.map((r) => r.id), ["security-review", "npm-supply-chain"]);
  assert.deepEqual(c.declined.map((r) => r.id), ["gcp-cleanup"]);
});

test("optInMarkedIds: one marker is a send, none or several (the walk-through) is not", () => {
  assert.deepEqual(optInMarkedIds(optInPrompt("local-ci", "demo")), ["local-ci"]);
  assert.deepEqual(optInMarkedIds("plain words"), []);
  const walk = optInWalkPrompt(["local-ci", "npm-supply-chain"].map((id) => ({ id, relevant: true, state: "off", detail: "" })), "demo");
  assert.deepEqual(optInMarkedIds(walk), []);
});

test("walk-through posts each pick as its own item and only quotes postable prompts", () => {
  const offered = ["requirements", "security-review", "local-ci"].map((id) => ({ id, relevant: true, state: "off", detail: "" }));
  const p = optInWalkPrompt(offered, "demo");
  assert.match(p, /Do NOT set any of them up in this session/);
  assert.match(p, /own new-session work item/);
  assert.ok(p.includes(optInMarker("security-review")));
  assert.ok(p.includes(optInMarker("local-ci")));
  assert.ok(!p.includes(optInMarker("requirements")));
  assert.match(p, /Requirements list: /);
  assert.match(p, /weekly, Monday 09:00, model fable/);
  assert.equal(optInWalkPrompt([], "demo"), null);
});

test("cleanOptInRow drops what it cannot read, never rounds", () => {
  assert.equal(cleanOptInRow({ id: "x", relevant: true, state: "maybe" }), null);
  assert.equal(cleanOptInRow({ id: "x", state: "on" }), null);
  assert.deepEqual(cleanOptInRow({ id: "x", relevant: true, state: "on", choice: "later" }), { id: "x", relevant: true, state: "on", detail: "" });
  const base = { id: "x", relevant: true, state: "off", detail: "" };
  assert.deepEqual(cleanOptInRow({ ...base, sent: { at: 7, status: "open" }, partial: true }), { ...base, sent: { at: 7, status: "open" }, partial: true });
  assert.deepEqual(cleanOptInRow({ ...base, sent: { at: 7, status: "soon" }, partial: "yes" }), base);
  assert.deepEqual(cleanOptInRow({ ...base, sent: { at: 0, status: "open" } }), base);
});

test("the Android offers are taps: no prompt, and the walk-through names them without posting them", () => {
  const rows = ["apk-download", "apk-install", "local-ci"].map((id) => ({ id, relevant: true, state: "off", detail: "" }));
  const p = optInWalkPrompt(rows, "demo");
  assert.match(p, /- Android app: download by itself: /);
  assert.match(p, /- Android app: install by itself: /);
  assert.deepEqual(optInDef("apk-install").action, { kind: "open", to: "install" });
});

test("installAllowSetting: absent or unreadable is null, never an empty list", () => {
  for (const raw of [undefined, null, "", "{", "{}"]) assert.equal(installAllowSetting(raw), null);
  assert.deepEqual(installAllowSetting("[]"), []);
  assert.deepEqual(installAllowSetting('["a.b",3,""]'), ["a.b"]);
});

test("the look prompt: read-only, one named file, only the offers drawn with a tick, and never an offer being sent", () => {
  const p = optInLookPrompt(OPT_INS.map((d) => ({ id: d.id, relevant: true, state: "off", detail: "" })), "demo");
  assert.match(p, /Set NONE of them up/);
  assert.ok(p.includes(`${BRAND.stateDirName}/${OPT_IN_PICKS_FILE}`));
  for (const d of OPT_INS) assert.equal(p.includes(`\`${d.id}\``), optInKind(d) !== "door", d.id);
  assert.deepEqual(optInMarkedIds(p), []);
  assert.equal(optInLookPrompt([], "demo"), null);
  assert.equal(optInLookPrompt([{ id: "links", relevant: true, state: "off", detail: "" }], "demo"), null);
});

test("cleanOptInPicks drops unknown ids, bad rows and repeats; why is one capped line", () => {
  const ok = { id: "local-ci", want: true, why: "has\n  tests" };
  assert.deepEqual(cleanOptInPicks([
    ok, { ...ok, want: false }, { id: "nope", want: true, why: "x" }, { id: "links", want: "yes", why: "x" },
    { id: "links", want: true }, { id: "links", want: true, why: " \n" }, null, 4, "x",
  ]), [{ id: "local-ci", want: true, why: "has tests" }]);
  const long = cleanOptInPicks([{ ...ok, why: "w".repeat(999) }])[0].why;
  assert.equal(long.length, OPT_IN_PICK_WHY_MAX);
  assert.ok(long.endsWith("…"));
  for (const x of [null, {}, "x", { picks: [] }]) assert.deepEqual(cleanOptInPicks(x), []);
});
