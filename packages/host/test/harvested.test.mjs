/**
 * Harvested fixtures: real captures of the installed CLI, kept by the host the
 * first time a signal was seen to WORK on that version (`src/clifixtures.ts`)
 * and copied in by `tools/harvestfixtures.mjs --write`. Every
 * `fixtures/signals.json` entry naming this file is run through its signal's
 * reader (`signalreaders.mjs`) and must read as its role says; and none may
 * carry what the redaction exists to keep out of a public repo.
 *
 * The first tests hold the redaction itself to the 2.1.301 hand captures: a
 * screen put through the harvest's masking must still read as what it was —
 * a mask that broke the reader would file every harvested box as a guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFixture, fixtureSample } from "@waterplane/shared";
import { chromeRow, chromeSpans } from "../dist/clifixtures.js";
import { readSignal } from "./signalreaders.mjs";
import { opaqueRun } from "../../../tools/harvestfixtures.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (p) => readFileSync(join(FIXTURES, p), "utf8");
const harvest = (id, text) => fixtureSample(id, text, chromeRow(id), chromeSpans(id));

test("masking keeps a real box a box, its Submit row reachable, and its words gone", () => {
  for (const name of ["checkbox-submit", "checkbox-toggled", "checkbox-on-submit", "checkbox-46col"]) {
    const raw = read(`screens/${name}.txt`);
    assert.equal(readSignal("prompt.box", raw), true, `${name}: the hand capture reads`);
    const kept = harvest("prompt.box", raw);
    assert.equal(readSignal("prompt.box", kept), true, `${name}: …and so does its harvest`);
    assert.equal(readSignal("prompt.submit", harvest("prompt.submit", raw)), true, name);
    assert.doesNotMatch(kept, /fruits|salad|Banana/, `${name}: no word of the question or a label survives`);
    assert.match(kept, /Esc to cancel/, `${name}: the footer is chrome, kept verbatim`);
  }
});

test("masking keeps the context gauge row and a local command's name", () => {
  const ctx = harvest("context.meter", read("screens/context-view.txt"));
  assert.equal(readSignal("context.meter", ctx), true);
  const slash = harvest("slash.local", `/usage\n${read("screens/slash-usage-open.txt")}`);
  assert.equal(readSignal("slash.local", slash), true);
  assert.equal(readSignal("slash.local", harvest("slash.local", `/btwx\n${read("screens/slash-usage-open.txt")}`)), false);
});

test("a skeleton reads by its keys: a renamed field is a non-match", () => {
  const ask = { type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion", id: "t", input: { questions: [{ question: "q", options: [{ label: "a" }] }] } }] } };
  assert.equal(readSignal("askbox.enrich", harvest("askbox.enrich", JSON.stringify(ask))), true);
  ask.message.content[0].input.questions[0].choices = ask.message.content[0].input.questions[0].options;
  delete ask.message.content[0].input.questions[0].options;
  assert.equal(readSignal("askbox.enrich", harvest("askbox.enrich", JSON.stringify(ask))), false);
  assert.equal(readSignal("hook.pipe", harvest("hook.pipe", JSON.stringify({ hook_event_name: "Stop", session_id: "s" }))), true);
  assert.equal(readSignal("hook.pipe", harvest("hook.pipe", JSON.stringify({ event: "Stop", session_id: "s" }))), false);
  const turn = (type) => ({ type, uuid: "u", timestamp: "t", message: { content: "c" } });
  assert.equal(readSignal("transcript.jsonl", harvest("transcript.jsonl", JSON.stringify([turn("user"), turn("assistant")]))), true);
  assert.equal(readSignal("transcript.jsonl", harvest("transcript.jsonl", JSON.stringify([turn("user")]))), false);
});

test("masking keeps a real paste's echo findable, and the prompt's words gone", () => {
  for (const name of ["paste-chain", "paste-blankrow"]) {
    const kept = harvest("deliver.echo", JSON.stringify({ prompt: read(`screens/${name}.prompt`), grid: read(`screens/${name}.txt`) }));
    assert.equal(readSignal("deliver.echo", kept), true, name);
    assert.match(kept, /\[Pasted text #\d/, `${name}: the chits are chrome`);
    assert.doesNotMatch(kept, /STEP/, `${name}: the prompt's words are not`);
  }
});

test("a notice keeps its block and its reset, and only ROT13'd", () => {
  // Built from halves, as every notice in this repo is: printed, it would read as a block.
  const notice = ["You've hit your", " limit · resets 3pm (UTC)"].join("");
  const kept = harvest("limit.reset", `⏺ some answer\n${notice}\n❯ `);
  assert.ok(!kept.includes(notice.slice(0, 12)), "not in plain bytes");
  assert.equal(readSignal("limit.reset", kept), true);
  assert.equal(readSignal("limit.reset", harvest("limit.reset", "⏺ nothing blocked here")), false);
});

test("deliver.submit reads a UserPromptSubmit skeleton, and only that", () => {
  const sk = (p) => harvest("deliver.submit", JSON.stringify(p));
  assert.equal(readSignal("deliver.submit", sk({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "secret words" })), true);
  assert.doesNotMatch(sk({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "secret words" }), /secret/);
  assert.equal(readSignal("deliver.submit", sk({ hook_event_name: "Stop", session_id: "s" })), false);
});

const ME = "packages/host/test/harvested.test.mjs";
const entries = Object.entries(JSON.parse(read("signals.json")).signals)
  .flatMap(([id, list]) => list.filter((e) => e.test === ME).map((e) => ({ id, ...e })));

test("every harvested fixture reads as its role says, and says which CLI drew it", () => {
  for (const e of entries) {
    assert.match(e.cli ?? "", /^\d+\.\d+\.\d+$/, `${e.path}: a harvested entry names its version`);
    assert.equal(readSignal(e.id, read(e.path)), e.role === "match", `${e.path}: ${e.id} as a ${e.role}`);
  }
});

test("no harvested fixture carries a home path, an address or an opaque run", () => {
  for (const e of entries) {
    const t = decodeFixture(e.id, read(e.path));
    assert.doesNotMatch(t, /\/(?:Users|home)\/[^/\s~<]/, e.path);
    assert.doesNotMatch(t, /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, e.path);
    assert.equal(opaqueRun(t), null, e.path);
  }
});
