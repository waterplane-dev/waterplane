/**
 * A deterministic `~/.claude/projects` tree for `tokenscan.test.mjs`.
 *
 * Every trap the per-file scan defends is in here at least once: a duplicate
 * message id NON-adjacent, a `<synthetic>` turn, an all-zero usage row, a
 * compaction boundary before a big write, a cold rebuild, the 1-hour write
 * tier, fast mode, multi-byte text on both sides of where a chunked reader
 * would cut, a last line with no newline, a subagent transcript, an empty
 * file, a log with no usage at all, and a non-`.jsonl` file. The models are
 * made-up ids no price table names, so the expected document cannot move
 * when a price does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const T0 = Date.UTC(2026, 6, 1, 8, 0, 0);
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

function assistant({ id, model = "claude-test-a", at, cwd = "/fx/repo-one", input = 0, output = 0, read = 0, write = 0, w1h, speed, text = "ok" }) {
  return JSON.stringify({
    type: "assistant", cwd, timestamp: iso(at),
    message: {
      id, model, content: [{ type: "text", text }],
      usage: {
        input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
        ...(w1h != null ? { cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: write - w1h } } : {}),
        ...(speed ? { speed } : {}),
      },
    },
  });
}
const user = (at, text) => JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: text } });

/** Write the tree under `home` (so `<home>/.claude/projects/...`). Returns the projects dir. */
export function writeFixture(home) {
  const projects = join(home, ".claude", "projects");
  const one = join(projects, "-fx-repo-one");
  const two = join(projects, "-fx-repo-two");
  mkdirSync(join(one, "conv-a", "subagents"), { recursive: true });
  mkdirSync(two, { recursive: true });

  const a = [
    user(0, "héllo — ünïcode ✓ 🙂"),
    assistant({ id: "m1", at: 1, input: 1200, output: 300, read: 0, write: 30_000, w1h: 30_000, text: "größer 🙂" }),
    assistant({ id: "m2", at: 2, input: 10, output: 200, read: 30_000, write: 500, w1h: 0 }),
    // streaming repeat of m1, NON-adjacent: counted once
    assistant({ id: "m1", at: 3, input: 1200, output: 300, read: 0, write: 30_000, w1h: 30_000 }),
    assistant({ id: "syn", model: "<synthetic>", at: 4, input: 0, output: 0 }),
    assistant({ id: "zero", at: 5 }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(6), compactMetadata: { trigger: "auto", preTokens: 31_000 } }),
    assistant({ id: "m3", at: 7, input: 5, output: 90, read: 4_000, write: 12_000, w1h: 12_000 }),
    // a long gap, then a cold rebuild: reads the preamble, re-writes the rest
    assistant({ id: "m4", model: "claude-test-b", at: 24 * 60, input: 3, output: 400, read: 1_000, write: 15_000, w1h: 15_000, speed: "fast" }),
    assistant({ id: "m5", model: "claude-test-b", at: 24 * 60 + 61, input: 7, output: 80, read: 16_000, write: 100, w1h: 100, text: "ß".repeat(5000) }),
  ];
  // Many rows of multi-byte text so the file spans several reads of any chunk size.
  for (let i = 0; i < 400; i++) {
    a.push(assistant({ id: `bulk${i}`, model: i % 3 ? "claude-test-a" : "qwen-test:7b", at: 2 * 24 * 60 + i * 7, input: i, output: 2 * i + 1, read: 100 * i, write: i % 5 ? 0 : 50, w1h: i % 10 ? 0 : 50, text: `€${"✓".repeat(i % 37)}${i}` }));
    if (i % 50 === 0) a.push(user(2 * 24 * 60 + i * 7, "next ✓"));
  }
  // The last line has NO trailing newline.
  writeFileSync(join(one, "conv-a.jsonl"), a.join("\n"));

  writeFileSync(join(one, "conv-a", "subagents", "agent-x.jsonl"), [
    assistant({ id: "s1", model: "claude-test-b", at: 30, input: 50, output: 60, read: 2_000, write: 3_000, w1h: 0 }),
    assistant({ id: "s2", model: "claude-test-b", at: 31, input: 1, output: 2, read: 5_000, write: 0 }),
  ].join("\n") + "\n");

  writeFileSync(join(two, "conv-b.jsonl"), [
    user(10, "only words"),
    assistant({ id: "b1", cwd: "/fx/repo-two", model: "qwen-test:7b", at: 3 * 24 * 60, input: 900, output: 90 }),
    "not json at all {",
    "{\"type\":\"assistant\",\"usage\": broken",
  ].join("\n") + "\n");
  writeFileSync(join(two, "conv-empty.jsonl"), "");
  writeFileSync(join(two, "conv-users.jsonl"), user(1, "no usage here") + "\n");
  writeFileSync(join(two, "notes.txt"), "not a log");
  return projects;
}
