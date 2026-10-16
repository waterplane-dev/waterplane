/**
 * Pins for splitting `ctxlog.ts` and `transcript.ts` into `ctxlog/` and
 * `transcript/` (docs/notes/host-architecture.md, "Ledger readers").
 *
 *  1. The EXPORT SURFACE of both barrels, read off the type checker (values and
 *     types alike), so no importer has to change.
 *  2. A GOLDEN over a deterministic synthetic conversation (parent log with a
 *     streaming duplicate, a synthetic rejection, a compaction, a cold rebuild,
 *     a queued prompt and a local command, plus two subagent logs): every
 *     exported reader is digested and compared with `ledgerpins.golden.json`,
 *     recorded BEFORE the move. Regenerate with `WATERPLANE_REGOLDEN=1` only for
 *     a deliberate behaviour change, named as such in its commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { observe } from "./ledgerpins.golden.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const GOLDEN = here("./ledgerpins.golden.json");

function surface(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${file} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

const SURFACES = {
  "ctxlog.ts": [
    "AgentFile:type", "AgentRunRaw:type", "AgentUsage:type", "ContextLog:type", "MAX_SAMPLES:value", "SPARK_MARKS:value", "SPARK_POINTS:value", "SeriesCursor:type", "agentCumOf:value", "agentEnvelope:value", "agentSpendAt:value", "agentUsage:value", "downsample:value", "liveAgentOf:value", "projectContextLog:value", "readContextLog:value", "sparkOf:value", "thinMax:value", "updateContextLog:value", "withAgentRuns:value",
  ],
  "transcript.ts": [
    "MAX_TURNS:value", "TEXT_CAP:value", "TOOL_INPUT_CAP:value", "TOOL_RESULT_CAP:value", "absorbedOpeners:value", "boxAnswersOf:value", "claudeConfigDir:value", "claudeProjectDir:value", "foldRepaints:value", "lastTurnAt:value", "localCommandOf:value", "localOutputOf:value", "logMtime:value", "mergeLocalTurns:value", "opensTurn:value", "parseTranscript:value", "promptLabel:value", "promptOf:value", "queuedPromptOf:value", "queuedTurns:value", "screenCommandTurns:value", "scrollHintTrimmed:value", "sliceToCommand:value", "summarize:value", "toolDetails:value", "transcriptFromHistory:value", "transcriptPath:value", "trimTuiChrome:value",
  ],
};

for (const [file, want] of Object.entries(SURFACES)) {
  test(`${file} exports exactly its pinned surface, values and types alike`, () => {
    assert.deepEqual(surface(here(`../src/${file}`)), [...want].sort());
  });
}

// ── the golden ──────────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const iso = (m) => new Date(T0 + m * 60_000).toISOString();
const usage = (inp, read, write, out) => ({ input_tokens: inp, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });
const asst = (m, id, model, u, content = [{ type: "text", text: `answer ${id}` }], extra = {}) =>
  JSON.stringify({ type: "assistant", timestamp: iso(m), uuid: `u-${id}`, ...extra, message: { id, model, role: "assistant", content, usage: u } });
const user = (m, text) => JSON.stringify({ type: "user", timestamp: iso(m), uuid: `p-${m}`, userType: "external", message: { role: "user", content: text } });
const toolUse = (m, id, name, input) => asst(m, id, "claude-opus-5", usage(2, 20_000, 100, 80), [{ type: "tool_use", id: `t-${id}`, name, input }]);
const toolResult = (m, id, text) => JSON.stringify({ type: "user", timestamp: iso(m), uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t-${id}`, content: text }] } });

function parentLines() {
  return [
    user(0, "first prompt"),
    asst(1, "a1", "claude-opus-5", usage(2, 10_000, 5_000, 300)),
    asst(1.1, "a1", "claude-opus-5", usage(2, 10_000, 5_000, 300)),
    toolUse(2, "a2", "Read", { file_path: "/work/repo/src/x.ts" }),
    toolResult(2.5, "a2", "file body"),
    toolUse(3, "a3", "Bash", { command: "ls -la", description: "list" }),
    toolResult(3.5, "a3", "total 0"),
    user(4, "second prompt"),
    asst(5, "a4", "claude-sonnet-5", usage(2, 30_000, 2_000, 900)),
    JSON.stringify({ type: "assistant", timestamp: iso(6), message: { id: "s1", model: "<synthetic>", role: "assistant", usage: usage(0, 0, 0, 0) }, quotaLimits: { status: "rejected", resetsAt: Math.floor((T0 + 3_600_000) / 1000), rateLimitType: "five_hour" } }),
    user(400, "after a long gap"),
    asst(401, "a5", "claude-opus-5", usage(2, 600, 60_000, 700)),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(402), compactMetadata: { trigger: "auto", preTokens: 90_000, postTokens: 8_000, durationMs: 900 } }),
    asst(403, "a6", "claude-opus-5", usage(2, 7_000, 3_000, 400)),
    asst(404, "a7", "claude-opus-5", usage(2, 10_000, 500, 400)),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: iso(405), content: "queued words" }),
    JSON.stringify({ type: "user", timestamp: iso(406), message: { role: "user", content: "<command-name>/cost</command-name><command-args></command-args>" } }),
    JSON.stringify({ type: "user", timestamp: iso(406.1), message: { role: "user", content: "<local-command-stdout>total cost $1</local-command-stdout>" } }),
    "{ not json",
  ];
}
const agentLines = (id, model, base) => [
  JSON.stringify({ type: "user", timestamp: iso(base), isSidechain: true, message: { role: "user", content: "task" } }),
  asst(base + 1, `${id}-1`, model, usage(2, 5_000, 1_000, 200), undefined, { isSidechain: true }),
  asst(base + 2, `${id}-2`, model, usage(2, 6_000, 500, 250), undefined, { isSidechain: true }),
];

test("the readers' outputs over a synthetic conversation match the recorded golden", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-ledgerpins-"));
  try {
    const log = join(dir, "00000000-0000-4000-8000-000000000001.jsonl");
    writeFileSync(log, parentLines().join("\n") + "\n");
    const sub = join(dir, "00000000-0000-4000-8000-000000000001", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a.jsonl"), agentLines("ga", "claude-haiku-4-5", 10).join("\n") + "\n");
    writeFileSync(join(sub, "agent-b.jsonl"), agentLines("gb", "claude-sonnet-5", 20).join("\n") + "\n");
    // The cursor records the file's mtime: pin it.
    for (const f of [log, join(sub, "agent-a.jsonl"), join(sub, "agent-b.jsonl")]) utimesSync(f, 1_780_000_000, 1_780_000_000);
    // observe() keys by basename; the uuid is fixed, so keys are stable.
    const got = observe([log]);
    if (process.env.WATERPLANE_REGOLDEN) writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    assert.deepEqual(got, JSON.parse(readFileSync(GOLDEN, "utf8")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
