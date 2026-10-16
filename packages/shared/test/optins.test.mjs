// The opt-in catalog: one registry, one cut feeding every count, prompts that
// carry the marker the host probes for, and a walk-through that posts rather
// than does. Reasoning: packages/shared/src/optins.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  OPT_INS, cleanOptInRow, optInActiveWords, optInCut, optInDef, optInMarker, optInPrompt, optInRule, optInWalkPrompt,
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
});
