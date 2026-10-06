/**
 * The requirements list's shared half: which transcript lines count as the
 * person's prompts, and how items are counted.
 *
 * The build script and the host's setup row both read through these. If they
 * disagreed, the row's "N prompts since" would never reach zero after a build —
 * so the filter is pinned here, once, rather than in either consumer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REQ_STALE_PROMPTS, askedRef, countRequirements, parseRequirementsArea, promptSeen, requirementsSkillText, transcriptDirName, transcriptPrompt,
} from "../dist/index.js";

const user = (content, o = {}) => ({
  type: "user", timestamp: "2026-09-01T10:00:00.000Z", uuid: "u1", sessionId: "abcdef1234",
  entrypoint: "cli", message: { content }, ...o,
});

test("a typed prompt counts, with its session shortened to 8", () => {
  const p = transcriptPrompt(user("Add a square selection tool like mspaint"));
  assert.deepEqual(p, { ts: "2026-09-01T10:00:00.000Z", uuid: "u1", session: "abcdef12", text: "Add a square selection tool like mspaint" });
});

test("text blocks are joined; a tool result is never a prompt", () => {
  assert.equal(transcriptPrompt(user([{ type: "text", text: "Make the riddle" }, { type: "text", text: "much simpler" }])).text,
    "Make the riddle\nmuch simpler");
  assert.equal(transcriptPrompt(user([{ type: "tool_result", content: "ok" }])), null);
});

test("headless calls, meta, sidechains, echoes and one-word replies are not the person", () => {
  const long = "Summarize what this session is working on";
  assert.equal(transcriptPrompt(user(long, { entrypoint: "sdk-cli" })), null);
  assert.equal(transcriptPrompt(user(long, { isMeta: true })), null);
  assert.equal(transcriptPrompt(user(long, { isSidechain: true })), null);
  assert.equal(transcriptPrompt(user("<command-name>/model</command-name> something")), null);
  assert.equal(transcriptPrompt(user("New apk")), null);
  assert.equal(transcriptPrompt({ type: "assistant", message: { content: long } }), null);
});

test("a resumed session's copy of a prompt is seen once, under either uuid", () => {
  const seen = new Set();
  const a = transcriptPrompt(user("Add a square selection tool like mspaint"));
  const b = transcriptPrompt(user("Add a square selection tool like mspaint", { uuid: "u2" }));
  assert.equal(promptSeen(seen, a), false);
  assert.equal(promptSeen(seen, b), true);
});

test("the transcript folder name matches the CLI's encoding", () => {
  assert.equal(transcriptDirName("/Users/j/dev/child-paint"), "-Users-j-dev-child-paint");
  assert.equal(transcriptDirName("/a/b.c_d"), "-a-b-c-d");
});

test("items are counted by the status in their heading; an unknown status counts nowhere", () => {
  const md = "# ui\n\n### R-ui-001 · shipped\nx\n\n### R-ui-002 · requested\ny\n\n### R-ui-003 · superseded\nz\n\n### R-ui-004 · maybe\nw\n";
  assert.deepEqual(countRequirements(md), { requested: 1, shipped: 1, superseded: 1, dropped: 0 });
});

test("the preset names the command and declares it is machine-written", () => {
  const t = requirementsSkillText("node /x/update.mjs .");
  assert.match(t, /^---\nname: requirements\n/);
  assert.match(t, /^generated-by:\s*\S/m);
  assert.match(t, /node \/x\/update\.mjs \./);
  assert.ok(REQ_STALE_PROMPTS > 0);
});

test("parseRequirementsArea: bullets, several shipped, superseded-by, multi-line text", () => {
  const md = `# x

### R-x-001 · shipped
First line
second line.
- asked: 2026-09-16 (session 61c1e521), c40d28d7
- shipped: 3f9e2a1, 4aa0b22

### R-x-002 · superseded
Old way.
- superseded-by: R-x-003

### R-x-003 · bogus
Dropped: not a status.

### R-x-004 · requested
New.
`;
  const it = parseRequirementsArea("x", md);
  assert.deepEqual(it.map((i) => i.id), ["R-x-001", "R-x-002", "R-x-004"]);
  assert.equal(it[0].text, "First line second line.");
  assert.deepEqual(it[0].asked, ["2026-09-16 (session 61c1e521)", "c40d28d7"]);
  assert.deepEqual(it[0].shipped, ["3f9e2a1", "4aa0b22"]);
  assert.equal(it[0].area, "x");
  assert.equal(it[1].supersededBy, "R-x-003");
  assert.equal(it[2].supersededBy, null);
});

test("askedRef reads the forms (a bare hash is a note, never a session) and guesses nothing", () => {
  assert.deepEqual(askedRef("2026-09-16 (session 61c1e521)"), { date: "2026-09-16", session: "61c1e521", note: null });
  assert.deepEqual(askedRef("c40d28d7"), { date: null, session: null, note: "c40d28d7" });
  assert.deepEqual(askedRef("2026-09-27 (user request)"), { date: "2026-09-27", session: null, note: "user request" });
  assert.deepEqual(askedRef("whenever"), { date: null, session: null, note: null });
});

test("the list and the row's count agree on every real area file in this repo", () => {
  const dir = fileURLToPath(new URL("../../../docs/requirements/", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const md = readFileSync(dir + f, "utf8");
    const tally = { requested: 0, shipped: 0, superseded: 0, dropped: 0 };
    for (const i of parseRequirementsArea(f, md)) tally[i.status]++;
    assert.deepEqual(tally, countRequirements(md), f);
  }
});
