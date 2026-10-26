/**
 * The always-on rows and sentences both ends word alike: the total never without its split, an
 * unsized row named and never 0, tokens per part only ever "about", the undocumented record labelled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { alwaysOnRows, alwaysOnTotalsWords, carriedRemainder, carriedRows, carriedWords, desktopInventory, instructionInventory } from "../dist/index.js";

function fsOf(files) {
  return {
    read: (rel) => (rel in files ? files[rel] : null),
    list: (dir) => {
      const names = new Map();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1).split("/");
        names.set(rest[0], rest.length > 1);
      }
      return [...names].map(([name, isDir]) => ({ name, dir: isDir }));
    },
  };
}
const SKILL = "---\nname: s\ndescription: does a thing when asked to\n---\nbody";

const repo = instructionInventory(fsOf({
  "CLAUDE.md": "c".repeat(4000), "CLAUDE.local.md": "l".repeat(400), ".claude/agents/x.md": SKILL,
  ".claude/skills/s/SKILL.md": SKILL, ".mcp.json": JSON.stringify({ mcpServers: { a: {}, b: {} } }),
})).files;

test("rows: inventory order, counted per D1, unsized rows carry null not 0", () => {
  const rows = alwaysOnRows(repo);
  assert.deepEqual(rows.map((r) => [r.path, r.counted]), [
    ["CLAUDE.md", true], ["CLAUDE.local.md", false], [".claude/skills/s/SKILL.md", true],
    [".claude/agents/x.md", false], [".mcp.json", false], [".mcp.json", false],
  ]);
  const mcp = rows[4];
  assert.equal(mcp.always, null);
  assert.equal(mcp.onDemand, null);
  assert.match(mcp.unsized, /connects/);
  assert.equal(rows[0].always, 4000);
  assert.equal(rows[0].scope, "repo");
});

test("totals: the whole, the threshold's share, the listed rest, and the unsized count by name", () => {
  const w = alwaysOnTotalsWords(repo, String);
  assert.match(w, /^Claude Code carries ~\d+ tokens \(\d+ chars\) from 4 repo files on every turn; the threshold row counts \d+ of those .* the other \d+ are listed beside it/);
  assert.match(w, /2 MCP servers add tool schemas nobody can size from here\./);
  assert.doesNotMatch(w, /\b0 chars/);
});

test("totals: this desktop's rows are their own sentence and never in the threshold", () => {
  const desk = desktopInventory({ fs: fsOf({ "CLAUDE.md": "u".repeat(800) }), memoryRel: null, plugins: [], userMcp: ["gh"] });
  const w = alwaysOnTotalsWords([...repo, ...desk], String);
  assert.match(w, /This desktop adds ~200 tokens \(800 chars\) from 1 file to every session, whatever the repo; the threshold row counts none of it\. 1 MCP server of this desktop's add/);
});

const carried = {
  firstRequestTok: 60911, firstRequestAt: 1, laterDeltas: 3,
  parts: [
    { kind: "skill_listing", chars: 29996, count: 136 },
    { kind: "system_prompt", chars: 40000, undocumented: true },
    { kind: "instructions", chars: 25019, count: 3, files: [{ path: "~/.claude/CLAUDE.md", type: "User", chars: 4843 }] },
    { kind: "deferred_tools", chars: 3000, count: 123 },
  ],
};

test("carried rows: CarriedKind order, labels, the undocumented record, the remainder last", () => {
  const rows = carriedRows(carried, String);
  assert.deepEqual(rows.map((r) => r.key), ["instructions", "skill_listing", "deferred_tools", "system_prompt", "remainder"]);
  assert.equal(rows[0].files[0].label, "~/.claude/CLAUDE.md · User");
  assert.equal(rows[1].label, "skill listing (136 skills)");
  assert.equal(rows[2].label, "deferred tool names (123)");
  assert.equal(rows[3].label, "system prompt (undocumented record)");
  assert.equal(rows[3].undocumented, true);
  assert.equal(rows[4].chars, null);
  assert.equal(rows[4].tok, 60911 - Math.round((29996 + 40000 + 25019 + 3000) / 4));
  assert.match(rows[4].words, /^≈/);
});

test("carried remainder: null without the anchor, clamped at 0", () => {
  assert.equal(carriedRemainder({ ...carried, firstRequestTok: null }), null);
  assert.equal(carriedRemainder({ ...carried, firstRequestTok: 10 }), 0);
  assert.equal(carriedRows({ ...carried, firstRequestTok: null }).some((r) => r.key === "remainder"), false);
});

test("carried words: whole, the documented share as 'about', the snapshot, the rest, later deltas", () => {
  const w = carriedWords(carried, String);
  assert.match(w, /^The first request carried 60911 tokens\. About \d+ of them \(58015 chars\) are the instruction files, the skill listing and deferred tool names the CLI attached;/);
  assert.match(w, /an undocumented record puts the system prompt at about 10000 tokens \(40000 chars\); the rest is tool schemas and your prompt\./);
  assert.match(w, / 3 of these changed later in the conversation and are not folded in\.$/);
  const plain = carriedWords({ ...carried, laterDeltas: 1, parts: carried.parts.filter((p) => !p.undocumented) }, String);
  assert.match(plain, /attached; the rest is the system prompt, tool schemas and your prompt\. 1 of these changed later in the conversation and is not folded in\.$/);
});

test("carried words before any answer say so, in chars", () => {
  assert.equal(carriedWords({ firstRequestTok: null, firstRequestAt: null, parts: [], laterDeltas: 0 }),
    "No request has been answered yet; these are the attachments the CLI has written so far (chars).");
});
