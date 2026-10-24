/**
 * `backends/derive.ts` — every reader gate the host used to read off a v1 cap, asked of the
 * provider table instead (backend contract v2). Pure: no registry, no session. The wire bytes
 * this feeds are pinned separately (`backendinfos.pin.test.mjs`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { derive, walk, factProblems } = await import("../dist/backends/derive.js");
const { claudeBackend, claudeLocalBackend, claudeEndpointBackend, shellBackend } = await import("../dist/backends/index.js");

const NONE = { screen: new Set(), store: new Set() };
const caps = { turns: true, slash: "none", remoteControl: false, permissionModes: [] };

test("walk: a provider answering null passes, the first answer stops, an empty walk is null", async () => {
  const asked = [];
  const d = { caps, facts: { context: [{ source: true }, { screen: "context-meter" }, { store: "claude-jsonl" }] }, sources: { context: {}, attach() {} } };
  const v = await walk(d, "context", (p) => { asked.push(Object.keys(p)[0]); return "screen" in p ? 42 : null; });
  assert.equal(v, 42);
  assert.deepEqual(asked, ["source", "screen"]); // stopped: the store was never asked
  assert.equal(await walk(d, "dialogs", () => 1), null);
  assert.equal(await walk({ caps, facts: {} }, "turns", () => 1), null);
});

test("walk: a throwing provider passes; a {source} whose slot is missing is skipped unasked", async () => {
  const asked = [];
  const d = { caps, facts: { turns: [{ source: true }, { screen: "silence" }] } }; // no sources at all
  assert.equal(await walk(d, "turns", (p) => { asked.push(p); return "silence"; }), "silence");
  assert.deepEqual(asked, [{ screen: "silence" }]);
  const t = { caps, facts: { turns: [{ screen: "silence" }, { screen: "silence" }] } };
  let n = 0;
  assert.equal(await walk(t, "turns", () => { if (n++ === 0) throw new Error("boom"); return "second"; }), "second");
});

test("factProblems refuses an unknown screen name with the sentence naming the known ones", () => {
  const [why] = factProblems({ dialogs: [{ screen: "copilot-numbered" }] }, { screen: new Set(["acme-highlight"]), store: new Set() });
  assert.match(why, /no screen reader called `copilot-numbered` answers dialogs; this host has: claude-numbered, acme-highlight/);
  assert.deepEqual(factProblems({ dialogs: [{ screen: "acme-highlight" }] }, { screen: new Set(["acme-highlight"]), store: new Set() }), []);
  // a contributed screen reader answers dialogs only
  assert.match(factProblems({ context: [{ screen: "acme-highlight" }] }, { screen: new Set(["acme-highlight"]), store: new Set() })[0], /this host has: context-meter/);
  assert.match(factProblems({ transcript: [{ store: "nope" }] }, NONE)[0], /no store reader called `nope` answers transcript; this host has: claude-jsonl/);
  assert.match(factProblems({ delivery: [{ screen: "x" }] }, NONE)[0], /delivery takes no screen reader here, only \{source:true\}/);
  assert.match(factProblems({ hooks: [] }, NONE)[0], /there is no fact called `hooks`; the facts are: turns, dialogs/);
  assert.match(factProblems({ turns: "silence" }, NONE)[0], /facts\.turns must be a list/);
  assert.match(factProblems({ turns: [{ source: false }] }, NONE)[0], /not a provider/);
  assert.match(factProblems(null, NONE)[0], /must be an object/);
  for (const b of [claudeBackend, claudeLocalBackend, claudeEndpointBackend, shellBackend]) assert.deepEqual(factProblems(b.facts, NONE), [], b.id);
});

test("hooksInBand is true only for claude's table (its hook pipe rides the CLI)", () => {
  assert.equal(derive(claudeBackend).hooksInBand, true);
  assert.equal(derive(claudeLocalBackend).hooksInBand, true); // the same CLI, the same hooks
  assert.equal(derive(shellBackend).hooksInBand, false);
  const ownChannel = { caps, facts: { turns: [{ source: true }] }, sources: { turns: { watch() {} }, attach() {} } };
  assert.equal(derive(ownChannel).hooksInBand, false);
  assert.equal(derive(ownChannel).askSource("turns"), true);
  assert.equal(derive({ ...ownChannel, facts: {} }).askSource("turns"), false); // a slot nobody listed is never asked
});

test("claude's table answers today's gates", () => {
  const d = derive(claudeBackend);
  assert.equal(d.keepsClaudeLog, true);
  assert.equal(d.screen("dialogs"), "claude-numbered");
  assert.equal(d.screen("limits"), "limit-ts");
  assert.equal(d.screen("context"), "context-meter");
  assert.equal(d.store("context"), "claude-jsonl");
  assert.equal(d.screen("asking"), "question-ts");
  assert.equal(d.has("usage"), true);
  const local = derive(claudeLocalBackend);
  assert.equal(local.screen("limits"), null);
  assert.equal(local.screen("context"), null);
  assert.equal(local.has("usage"), false);
  assert.equal(local.keepsClaudeLog, true);
  const sh = derive(shellBackend);
  for (const f of ["turns", "dialogs", "transcript", "context", "limits"]) assert.equal(sh.has(f), false, f);
});

test("has() counts a {source} only while its slot exists; a getter flip is seen at once", () => {
  let on = true;
  const src = { dialogs: { watch() {}, pending: async () => [] }, attach() {} };
  const d = { caps, facts: { dialogs: [{ source: true }] }, get sources() { return on ? src : undefined; } };
  assert.equal(derive(d).has("dialogs"), true);
  assert.equal(derive(d).wireCaps().promptBoxes, true);
  on = false;
  assert.equal(derive(d).has("dialogs"), false);
  assert.equal(derive(d).wireCaps().promptBoxes, false);
});

test("wireCaps: effort is true exactly when a ladder is declared; fork follows forkVia or claude's jsonl", () => {
  assert.equal(derive({ caps: { ...caps, effort: ["low", "high"] }, facts: {} }).wireCaps().effort, true);
  assert.equal(derive({ caps, facts: {} }).wireCaps().effort, false);
  assert.equal(derive({ caps, facts: {}, forkVia: "server" }).wireCaps().fork, true);
  assert.equal(derive({ caps, facts: { transcript: [{ store: "acme-db" }] } }).wireCaps().fork, false);
  assert.equal(derive(claudeBackend).wireCaps().fork, true);
});

test("wireCaps v2 fields: sent only where a provider answers, ABSENT otherwise (never false)", () => {
  const c = derive(claudeBackend).wireCaps();
  assert.deepEqual(c.efforts, ["low", "medium", "high", "xhigh", "max"]);
  for (const k of ["plan", "usage", "agents", "conversations"]) assert.equal(c[k], true, k);
  assert.equal("questions" in c, false); // question-ts is a screen reader, not a phone-answerable slot
  assert.equal("usage" in derive(claudeLocalBackend).wireCaps(), false); // no claude.ai account behind it
  const sh = derive(shellBackend).wireCaps();
  for (const k of ["efforts", "questions", "plan", "usage", "agents", "conversations"]) assert.equal(k in sh, false, k);
  const src = { questions: { watch() {}, pending: async () => [] }, attach() {} };
  assert.equal(derive({ caps, facts: { questions: [{ source: true }] }, sources: src }).wireCaps().questions, true);
  assert.equal("questions" in derive({ caps, facts: { questions: [{ source: true }] } }).wireCaps(), false);
  assert.deepEqual(derive({ caps: { ...caps, effort: ["low", "high"] }, facts: {} }).wireCaps().efforts, ["low", "high"]);
});

test("2.2 wireCaps: modes / commands sent only while a source answers, ABSENT otherwise; claude's caps carry neither", () => {
  for (const b of [claudeBackend, claudeLocalBackend, claudeEndpointBackend, shellBackend]) {
    const c = derive(b).wireCaps();
    assert.equal("modes" in c, false, b.id);
    assert.equal("commands" in c, false, b.id);
  }
  const src = { mode: { current: () => null, set: async () => ({ ok: true }) }, commands: { list: async () => [] }, attach() {} };
  const facts = { mode: [{ source: true }], commands: [{ source: true }] };
  const on = derive({ caps: { ...caps, permissionModes: ["default", "plan"] }, facts, sources: src }).wireCaps();
  assert.equal(on.modes, true);
  assert.equal(on.commands, true);
  // after the v2 additions, in that order (the wire's key order is the pin's)
  assert.deepEqual(Object.keys(on).slice(-2), ["modes", "commands"]);
  const declaredOnly = derive({ caps, facts }).wireCaps(); // {source:true} listed, no slot ⇒ absent
  assert.equal("modes" in declaredOnly, false);
  assert.equal("commands" in declaredOnly, false);
  const slotOnly = derive({ caps, facts: {}, sources: src }).wireCaps(); // a slot nobody listed ⇒ absent
  assert.equal("modes" in slotOnly, false);
  assert.equal("commands" in slotOnly, false);
});

test("2.2 factProblems: mode and commands take {source:true} only, refused in words otherwise", () => {
  assert.deepEqual(factProblems({ mode: [{ source: true }], commands: [{ source: true }] }, NONE), []);
  assert.match(factProblems({ mode: [{ screen: "permmode" }] }, NONE)[0], /facts\.mode: no screen reader called `permmode` answers mode; mode takes no screen reader here, only \{source:true\}/);
  assert.match(factProblems({ commands: [{ store: "claude-jsonl" }] }, NONE)[0], /commands takes no store reader here, only \{source:true\}/);
  // a contributed reader does not reach them either
  const mine = { screen: new Set(["acme"]), store: new Set(["acme-db"]) };
  assert.match(factProblems({ mode: [{ screen: "acme" }] }, mine)[0], /only \{source:true\}/);
  assert.match(factProblems({ commands: [{ store: "acme-db" }] }, mine)[0], /only \{source:true\}/);
});
