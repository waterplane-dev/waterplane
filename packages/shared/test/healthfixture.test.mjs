/**
 * The redaction a harvested fixture is kept under (`clihealth/healthfixture.ts`):
 * a grid keeps its layout and the CLI's chrome and loses every word, a record
 * keeps its keys and names and loses every value. The fixtures land in a public
 * repo, so each leak this file could make is asserted absent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CLI_SIGNALS, ECHO_SPLIT, FIXTURE_FORMS, FIXTURE_ROWS, decodeFixture, fixtureExt, fixtureSample, maskGrid, maskRow, skeletonOf } from "../dist/clihealth.js";

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const isFooter = (r) => r.includes("Esc to cancel");

test("maskRow: letters and digits go, widths and glyphs stay, an option index is kept", () => {
  assert.equal(maskRow("Which fruits, Bob?"), "Xxxxx xxxxxx, Xxx?");
  assert.equal(maskRow("❯ 2. [✔] Banana 42"), "❯ 2. [✔] Xxxxxx 00");
  assert.equal(maskRow("  12) Größe"), "  12) Xxxxx");
  assert.equal(maskRow("╭────╮"), "╭────╮");
  assert.equal(maskRow("Wrote 2026 lines").length, "Wrote 2026 lines".length);
  assert.equal(maskRow("go [Chit #2] now", /\[Chit #\d\]/), "xx [Chit #2] xxx", "a protected span stays as drawn");
});

test("maskGrid: chrome rows verbatim but redacted, prose masked, newest rows only", () => {
  const grid = [
    "⏺ I read /Users/alice/secret/plan.md for bob@example.com",
    " Pick one?",
    "❯ 1. Yes",
    `   ${FOOTER} /Users/alice token=abcdef`,
  ].join("\n");
  const out = maskGrid(grid, isFooter).split("\n");
  assert.doesNotMatch(out.join("\n"), /alice|bob|example|secret|plan|abcdef/);
  assert.equal(out[2], "❯ 1. Xxx");
  assert.ok(out[3].startsWith(`   ${FOOTER} ~ `), "a kept row keeps its indent and its words");
  assert.match(out[3], /token=<redacted>/);
  const tall = Array.from({ length: FIXTURE_ROWS + 20 }, (_, i) => `row ${i}`).join("\n");
  assert.equal(maskGrid(tall, () => true).split("\n").length, FIXTURE_ROWS);
  assert.equal(maskGrid(tall, () => true).split("\n").at(-1), `row ${FIXTURE_ROWS + 19}`);
});

test("skeletonOf: keys and names survive, values never do, arrays are their distinct shapes", () => {
  const rec = {
    type: "assistant",
    uuid: "1b2c",
    message: { role: "assistant", content: [
      { type: "text", text: "the user's private words" },
      { type: "text", text: "more words" },
      { type: "tool_use", name: "AskUserQuestion", id: "toolu_1", input: { questions: [{ question: "Q?", multiSelect: true, options: [{ label: "A", description: "d" }] }] } },
    ] },
    files: { "/Users/alice/x.ts": 1 },
    cwd: "/Users/alice/repo",
    type2: "not a name key",
  };
  const sk = skeletonOf(rec);
  const text = JSON.stringify(sk);
  assert.doesNotMatch(text, /alice|private|words|toolu_1|1b2c|Q\?|"A"|not a name/);
  assert.equal(sk.type, "assistant");
  assert.equal(sk.message.content.length, 2, "two text blocks are one shape");
  assert.equal(sk.message.content[1].name, "AskUserQuestion");
  assert.equal(sk.message.content[1].input.questions[0].multiSelect, "<boolean>");
  assert.deepEqual(Object.keys(sk.files), ["<key>"], "a path used as a key is content");
  assert.deepEqual(skeletonOf(sk), sk, "idempotent");
  assert.equal(skeletonOf({ name: "a name with spaces" }).name, "<string>");
});

test("fixtureSample: per the signal's mode", () => {
  for (const id of Object.keys(FIXTURE_FORMS)) assert.ok(CLI_SIGNALS.some((s) => s.id === id), `${id} is a real signal`);
  const box = fixtureSample("prompt.box", `Pick?\n❯ 1. Yes\n${FOOTER}\n\n`, isFooter);
  assert.equal(box, `Xxxx?\n❯ 1. Xxx\n${FOOTER}\n`);
  assert.equal(fixtureSample("prompt.box", "   \n"), null);
  assert.equal(fixtureSample("hook.pipe", "not json"), null);
  assert.deepEqual(JSON.parse(fixtureSample("hook.pipe", JSON.stringify({ hook_event_name: "Stop", session_id: "abc", prompt: "words" }))),
    { hook_event_name: "Stop", session_id: "<string>", prompt: "<string>" });
});

test("skeletonOf: an MCP tool's name is the account's config, never kept", () => {
  assert.equal(skeletonOf({ name: "mcp__claude_ai_Docs__batch" }).name, "<mcp>");
  assert.equal(skeletonOf({ name: "Bash" }).name, "Bash");
  assert.deepEqual(skeletonOf(skeletonOf({ name: "mcp__x__y" })), { name: "<mcp>" });
});

test("skeletonOf: a map keyed by IDs keeps no ID, a schema key with digits is kept", () => {
  const sk = skeletonOf({ wireToolInputs: { toolu_014eSw5ZGDhNfrMw3JtzPhFA: { command: "rm" } }, ephemeral_5m_input_tokens: 3, run_1760000000: 1 });
  assert.deepEqual(Object.keys(sk.wireToolInputs), ["<key>"]);
  assert.ok("ephemeral_5m_input_tokens" in sk);
  assert.ok(!("run_1760000000" in sk));
});

test("an echo fixture: prompt and composer masked by the same rule, nothing else of either", () => {
  const prompt = "Fix the login bug in auth.ts\nthen run 2 tests";
  const grid = "⏺ earlier answer about Bob\n────\n❯ Fix the login bug in auth.ts\n  then run 2 tests\n────";
  const out = fixtureSample("deliver.echo", JSON.stringify({ prompt, grid }));
  const [head, tail] = out.split(`\n${ECHO_SPLIT}\n`);
  assert.equal(head, "Xxx xxx xxxxx xxx xx xxxx.xx\nxxxx xxx 0 xxxxx");
  assert.ok(tail.includes("❯ Xxx xxx xxxxx xxx xx xxxx.xx"), "the composer row masks to the masked prompt");
  assert.doesNotMatch(out, /login|auth|Bob|tests/);
  assert.equal(fixtureSample("deliver.echo", JSON.stringify({ prompt: " ", grid })), null, "no prompt, no echo to keep");
  assert.equal(fixtureSample("deliver.echo", "not json"), null);
  assert.equal(fixtureExt("deliver.echo"), "txt");
  assert.equal(fixtureExt("deliver.submit"), "json");
  assert.equal(fixtureExt("prompt.box"), "txt");
});

test("a notice fixture is stored ROT13'd: its words never sit in the file in plain bytes", () => {
  const notice = ["Your ", "quota is spent"].join("");
  const raw = `chatter about Bob\n${notice} · back at 3pm`;
  const kept = fixtureSample("limit.reset", raw, (r) => r.includes("back at"));
  assert.ok(!kept.includes("quota") && !kept.includes("Bob"));
  const plain = decodeFixture("limit.reset", kept);
  assert.equal(plain, `xxxxxxx xxxxx Xxx\n${notice} · back at 3pm\n`, "decoded: the notice row verbatim, the rest masked");
  assert.equal(decodeFixture("prompt.box", "Abc"), "Abc", "only a notice is encoded");
});
