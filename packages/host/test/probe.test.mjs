/**
 * The lookup probe runner (R-metrics-071, `probe.ts` + `sidecar/sidecarprobe.ts`), driven through
 * a fake `claude` (`WATERPLANE_CLAUDE_BIN`) in a real git repo with a committed pool: the argv is
 * read-only, the stream is read once per request, the start is refused while one runs, when the
 * accepted estimate no longer covers, when halted and when there is no pool; the scratch checkout
 * has no answer key and is removed after; a tool reaching outside it voids the result; a question
 * past its token cap has its process group killed; and the scratch path's transcripts can never
 * land among the repo's agent readings.
 *
 *     npm run build -w @waterplane/host && node --test packages/host/test/probe.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-probe-test-")));
const repo = join(base, "repo");
mkdirSync(join(repo, ".waterplane-shared"), { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repo, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } }).toString();
const cleanEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k]; };
cleanEnv();
const pool = {
  owner: "the test",
  questions: Array.from({ length: 24 }, (_, i) => ({ id: `q${i}`, q: `question ${i}?`, all: [`answer${i}\\b`] })),
};
writeFileSync(join(repo, ".waterplane-shared", "probe.json"), JSON.stringify(pool));
writeFileSync(join(repo, "README.md"), "hi\n");
git("init", "-q", "-b", "main");
git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

// Claude Code trusts the repo; the fake binary answers from the prompt.
const cfg = join(base, "cfg");
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
process.env.CLAUDE_CONFIG_DIR = cfg;
const bin = join(base, "claude.sh");
writeFileSync(bin, `#!/bin/sh
P=$(cat)
M=""; prev=""; for a in "$@"; do [ "$prev" = "--model" ] && M="$a"; prev="$a"; done
echo "$@" > "${base}/argv.txt"
N=$(printf '%s' "$P" | sed -n 's/.*Question: question \\([0-9]*\\)?.*/\\1/p')
ANS="answer$N"; [ -e .waterplane-shared/probe.json ] && ANS="key-was-there"
printf '{"type":"system","subtype":"init","cwd":"%s","model":"%s","claude_code_version":"9.9.9","memory_paths":{"auto":"/mem/"}}\\n' "$PWD" "$M"
if [ -n "$FAKE_BIG" ]; then
  printf '{"type":"assistant","message":{"id":"m0","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":700000,"cache_creation_input_tokens":0},"content":[]}}\\n'
  sleep 30
fi
P2='"usage":{"input_tokens":2,"output_tokens":10,"cache_read_input_tokens":50000,"cache_creation_input_tokens":1000}'
printf '{"type":"assistant","message":{"id":"m1",%s,"content":[{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"/api/x","path":"."}}]}}\\n' "$P2"
printf '{"type":"assistant","message":{"id":"m1",%s,"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/mem/note.md"}}]}}\\n' "$P2"
if [ -n "$FAKE_LEAK" ]; then
  printf '{"type":"assistant","message":{"id":"m2",%s,"content":[{"type":"tool_use","id":"t3","name":"Read","input":{"file_path":"%s/README.md"}}]}}\\n' "$P2" "${repo}"
fi
printf '{"type":"assistant","message":{"id":"m3",%s,"content":[{"type":"text","text":"ok"}]}}\\n' "$P2"
printf '{"type":"result","subtype":"success","num_turns":2,"result":"found it\\\\nANSWER: %s","usage":{"input_tokens":4,"output_tokens":20,"cache_read_input_tokens":100000,"cache_creation_input_tokens":2000},"total_cost_usd":0.01}\\n' "$ANS"
`);
chmodSync(bin, 0o755);
process.env.WATERPLANE_CLAUDE_BIN = bin;

const { ProbeRunner, scratchStaysOut, PROBE_SCRATCH_PREFIX } = await import("../dist/probe.js");
const { probeArgv, ProbeStreamReader, runProbeAsk, sidecarPlan } = await import("../dist/sidecar.js");
const { passiveAllows } = await import("../dist/passive.js");
const { probeEstimate, drawProbeQuestions, parseProbePool } = await import("@waterplane/shared");

const stateDir = join(base, "state");
const runner = (over = {}) => new ProbeRunner({ stateDir, halted: () => false, desktop: () => "testbox", ...over });
const accept = (models, n, reps) => { const e = probeEstimate(models, n, reps); return { tokens: e.tokens, usd: e.usd }; };

test("R-metrics-071 the argv is read-only, capped and has no MCP; the probe task never takes the toolless engine", () => {
  const a = probeArgv("claude-sonnet-5-5", 12);
  const at = (f) => a[a.indexOf(f) + 1];
  assert.equal(at("--tools"), "Read,Grep,Glob,Skill");
  assert.equal(at("--allowedTools"), "Read,Grep,Glob,Skill");
  assert.equal(at("--permission-mode"), "default");
  assert.equal(at("--max-turns"), "12");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(at("--output-format"), "stream-json");
  const plan = sidecarPlan("probe", { WATERPLANE_SIDECAR_PROBE: "openai-compat:http://127.0.0.1:1|m" });
  assert.equal(plan.engine, "refused");
  assert.match(plan.reason, /WATERPLANE_SIDECAR_PROBE/);
});

test("the stream reader counts a request once across its blocks and keeps tool inputs, not results", () => {
  const r = new ProbeStreamReader();
  const u = '"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":30,"cache_creation_input_tokens":4}';
  r.push(`{"type":"assistant","message":{"id":"a",${u},"content":[{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"x"}}]}}\n{"type":"assis`);
  r.push(`tant","message":{"id":"a",${u},"content":[{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"x"}}]}}\n`);
  r.push(`{"type":"user","message":{"content":[{"type":"tool_result","content":"${"z".repeat(1000)}"}]}}\n`);
  r.push(`{"type":"assistant","message":{"id":"b",${u},"content":[]}}`);
  r.end();
  assert.equal(r.requests, 2);
  assert.equal(r.tools.length, 1);
  assert.equal(r.startTok, 35);
  assert.equal(r.liveTokens(), 74);
});

test("R-metrics-071 the scratch path's transcripts can never land among the repo's agent readings", () => {
  assert.equal(scratchStaysOut(join(realpathSync(tmpdir()), `${PROBE_SCRATCH_PREFIX}abc`), repo), true);
  // A checkout under the repo would share its slug prefix: refused by the check.
  assert.equal(scratchStaysOut(join(repo, "wt"), repo), false);
});

test("R-metrics-071 the start is refused: no estimate accepted, an estimate under today's, halted, wrong models", async () => {
  const r = runner();
  assert.equal((await r.start(repo, { kind: "models", models: ["claude-sonnet-5-5", "claude-opus-5-5"] })).ok, false);
  const low = await r.start(repo, { kind: "models", models: ["claude-sonnet-5-5", "claude-opus-5-5"], repeats: 1, accepted: { tokens: 10, usd: 0.01 } });
  assert.match(low.refused, /more than was accepted/);
  const h = await runner({ halted: () => true }).start(repo, { kind: "baseline", models: ["claude-sonnet-5-5"], accepted: { tokens: 1e12, usd: 1e6 } });
  assert.equal(h.ok, false);
  assert.match((await r.start(repo, { kind: "models", models: ["m", "m"], accepted: { tokens: 1e12, usd: 1e6 } })).refused, /two different/);
  assert.match((await r.start(repo, { kind: "baseline", models: ["bad model;rm"], accepted: { tokens: 1e12 } })).refused, /characters/);
});

test("R-metrics-071 a model run: single-flight, interleaved, graded, the key absent from the scratch checkout, which is removed", async () => {
  const r = runner();
  const models = ["claude-sonnet-5-5", "claude-opus-5-5"];
  const body = { kind: "models", models, repeats: 1, seed: 5, accepted: accept(models, 20, 1) };
  const s = await r.start(repo, body);
  assert.equal(s.ok, true, s.refused);
  const again = await r.start(repo, body);
  assert.match(again.refused, /already running/);
  assert.equal(r.status(repo).state, "running");
  await r.settled(repo);
  assert.equal(r.status(repo).state, "idle");
  const [{ result, analysis }] = r.resultsView(repo).results;
  assert.equal(result.desktop, "testbox");
  assert.equal(result.backend, "claude");
  assert.equal(result.runs.length, 40);
  assert.deepEqual(result.questions, drawProbeQuestions(parseProbePool(pool).pool, 5));
  assert.ok(result.runs.every((x) => x.correct), result.runs.find((x) => !x.correct)?.final);
  assert.ok(result.runs.every((x) => x.toolCalls === 2 && x.requests === 2));
  assert.equal(result.void, undefined);
  assert.equal(result.fingerprints.A.cli, "9.9.9");
  assert.equal(result.fingerprints.B.model, "claude-opus-5-5");
  assert.equal(result.fingerprints.A.startTok, 51002);
  // interleaved: question 1 asks A first, question 2 asks B first
  assert.deepEqual(result.runs.slice(0, 4).map((x) => x.arm), ["A", "B", "B", "A"]);
  assert.ok(analysis.gate.pass);
  assert.ok(analysis.paired, analysis.pairedAbsent);
  assert.ok(!git("worktree", "list").includes(PROBE_SCRATCH_PREFIX), "the scratch worktree is gone");
  assert.ok(existsSync(join(repo, ".waterplane-shared", "probe.json")), "the repo's own pool is untouched");
});

test("R-metrics-071 against a baseline reuses its draw and model; a leak voids the result and stops it", async () => {
  const r = runner();
  const b = await r.start(repo, { kind: "baseline", models: ["claude-sonnet-5-5"], repeats: 1, seed: 9, accepted: accept(["claude-sonnet-5-5"], 20, 1) });
  await r.settled(repo);
  process.env.FAKE_LEAK = "1";
  try {
    const a = await r.start(repo, { kind: "against", baselineId: b.id, accepted: accept(["claude-sonnet-5-5"], 20, 1) });
    assert.equal(a.ok, true, a.refused);
    await r.settled(repo);
  } finally { delete process.env.FAKE_LEAK; }
  const [{ result, analysis }] = r.resultsView(repo).results;
  assert.equal(result.against, b.id);
  assert.equal(result.seed, 9);
  assert.match(result.void, /outside the worktree/);
  assert.equal(result.runs.length, 1, "it stopped at the first leak");
  assert.equal(analysis.paired, undefined);
});

test("R-metrics-071 a question past its token cap has its process group killed and is an error, not a number", async () => {
  process.env.FAKE_BIG = "1";
  const t0 = Date.now();
  try {
    const a = await runProbeAsk({ cwd: repo, repo, model: "m", question: "question 1?", maxTurns: 12, tokenCap: 600_000, timeoutMs: 20_000 });
    assert.match(a.error, /cap of 600000 tokens/);
  } finally { delete process.env.FAKE_BIG; }
  assert.ok(Date.now() - t0 < 10_000, "answered at the cap, not after the sleep");
});

test("R-metrics-071 a repo with no pool gets the add-one line; passive tokens are refused every probe route", async () => {
  const empty = join(base, "empty");
  mkdirSync(empty);
  execFileSync("git", ["init", "-q"], { cwd: empty });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: empty });
  const r = runner();
  const v = await r.view(empty);
  assert.match(v.pool.absent, /has no probe questions/);
  assert.match((await r.start(empty, { kind: "baseline", models: ["m"], accepted: { tokens: 1e12 } })).refused, /no probe questions/);
  const none = () => false;
  for (const [m, p] of [["GET", "/api/repos/x/probe"], ["GET", "/api/repos/x/probe/results"], ["POST", "/api/repos/x/probe/start"]]) {
    assert.equal(passiveAllows(m, p, new URLSearchParams(), none), false, `${m} ${p}`);
  }
});

test("R-metrics-071 the start needs a browser Origin and the token the read minted for that worktree; only an accepted start spends it", async () => {
  const { createConfirmGate } = await import("../dist/confirmgate.js");
  const { configureOrigins } = await import("../dist/origin.js");
  const { withProbeConfirm, probeStartRefusal } = await import("../dist/routes/apiprobe.js");
  configureOrigins({ port: 8771 });
  const gate = createConfirmGate();
  const browser = { headers: { origin: "http://127.0.0.1:8771" } };
  const script = { headers: {} };
  const idle = { ok: true, status: { state: "idle" }, pool: { count: 1, owner: "o" }, defaults: { draw: 1, repeats: 1, maxTurns: 1 }, source: "s" };
  const token = withProbeConfirm("/wt", idle, gate).confirm;
  assert.ok(token);
  // The curl case: Origin-less, an `accepted` of its own, even with a real token.
  assert.match(probeStartRefusal(script, "/wt", { kind: "models", accepted: { tokens: 1e12 }, confirm: token }, gate).refused, /no Origin/);
  assert.match(probeStartRefusal(browser, "/wt", { kind: "models", accepted: { tokens: 1e12 } }, gate).refused, /no confirm token/);
  assert.match(probeStartRefusal(browser, "/other", { kind: "models", accepted: { tokens: 1 }, confirm: token }, gate).refused, /something else/);
  assert.equal(probeStartRefusal(browser, "/wt", { kind: "models", accepted: { tokens: 1 }, confirm: token }, gate), null);
  assert.equal(probeStartRefusal(browser, "/wt", { kind: "models", accepted: { tokens: 1 }, confirm: token }, gate), null, "a check does not spend it");
  gate.consume(token);
  assert.match(probeStartRefusal(browser, "/wt", { kind: "models", accepted: { tokens: 1 }, confirm: token }, gate).refused, /already used/);
  // A live run's view mints nothing, so the progress poll never fills the gate.
  const before = gate.size();
  assert.equal(withProbeConfirm("/wt", { ...idle, status: { state: "running", id: "x", done: 0, of: 1 } }, gate).confirm, undefined);
  assert.equal(gate.size(), before);
});

// A banner phrase is built here from parts: the repo never prints one whole (CLAUDE.md).
const PHRASE = ["usage", "limit", "reached"].join(" ");
const fakeRun = (stdout, over = {}) => async (_name, opts) => { opts.onOut?.(stdout); return { stdout, stderr: "", failed: false, ...over }; };
const ok = (n) => `{"type":"result","subtype":"success","result":"x\\nANSWER: ${n}","usage":{"input_tokens":1,"output_tokens":1}}\n`;

test("R-metrics-071 a banner phrase in a tool result or the model's prose is not a usage limit when the run answered", async () => {
  const stream = `{"type":"user","message":{"content":[{"type":"tool_result","content":"## ${PHRASE}, it carries on"}]}}\n${ok(8770)}`;
  const a = await runProbeAsk({ cwd: repo, repo, model: "m", question: "q?", maxTurns: 3, tokenCap: 1e6, run: fakeRun(stream) });
  assert.equal(a.limited, undefined);
  assert.equal(a.error, undefined);
  assert.match(a.text, /ANSWER: 8770/);
});

test("R-metrics-071 an error envelope or no envelope with the banner is still a usage limit", async () => {
  const err = `{"type":"result","subtype":"success","is_error":true,"result":"${PHRASE}"}\n`;
  assert.equal((await runProbeAsk({ cwd: repo, repo, model: "m", question: "q?", maxTurns: 3, tokenCap: 1e6, run: fakeRun(err) })).limited, true);
  const none = await runProbeAsk({ cwd: repo, repo, model: "m", question: "q?", maxTurns: 3, tokenCap: 1e6, run: fakeRun("", { stderr: PHRASE, failed: true }) });
  assert.equal(none.limited, true);
});

test("R-metrics-071 a question with no envelope still counts its streamed tokens toward the budget", async () => {
  const stream = `{"type":"assistant","message":{"id":"a","usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0},"content":[]}}\n`;
  const a = await runProbeAsk({ cwd: repo, repo, model: "m", question: "q?", maxTurns: 3, tokenCap: 1e6, run: fakeRun(stream, { failed: true }) });
  assert.equal(a.usage, undefined);
  assert.equal(a.spent, 1012);
  const r = runner({
    ask: async () => ({ backend: "claude", tools: [], requests: 1, memoryDirs: [], ms: 1, capHit: false, text: "", error: "cap", spent: 400_000 }),
    scratch: { make: async () => join(realpathSync(tmpdir()), `${PROBE_SCRATCH_PREFIX}fake`), remove: async () => {} },
  });
  const models = ["claude-sonnet-5-5", "claude-opus-5-5"];
  const s = await r.start(repo, { kind: "models", models, repeats: 1, seed: 5, accepted: accept(models, 20, 1) });
  assert.equal(s.ok, true, s.refused);
  await r.settled(repo);
  const [{ result }] = r.resultsView(repo).results;
  assert.match(result.stopped, /token budget/);
  assert.ok(result.runs.length < 40, `stopped early, ran ${result.runs.length}`);
});

test("R-metrics-071 two starts arriving together: one runs, the other is refused, and a refusal frees the slot", async () => {
  const r = runner({
    stateDir: join(base, "state-flight"),
    ask: async () => ({ backend: "claude", tools: [], requests: 1, memoryDirs: [], ms: 1, capHit: false, text: "x", usage: { in: 1, cw: 0, cr: 0, out: 1 } }),
    scratch: { make: async () => join(realpathSync(tmpdir()), `${PROBE_SCRATCH_PREFIX}fake`), remove: async () => {} },
  });
  const models = ["claude-sonnet-5-5", "claude-opus-5-5"];
  const body = { kind: "models", models, repeats: 1, seed: 5, accepted: accept(models, 20, 1) };
  const both = await Promise.all([r.start(repo, body), r.start(repo, body)]);
  assert.deepEqual(both.map((x) => x.ok).sort(), [false, true]);
  assert.match(both.find((x) => !x.ok).refused, /already running/);
  await r.settled(repo);
  assert.equal(r.status(repo).state, "idle");
  assert.equal(r.resultsView(repo).results.length, 1);
  // a refusal after the claim frees it
  assert.equal((await r.start(repo, { kind: "models", models: ["m", "m"] })).ok, false);
  assert.equal(r.status(repo).state, "idle");
});

test("R-metrics-071 a question's token cap never exceeds what is left of the budget", async () => {
  const caps = [];
  const r = runner({
    ask: async (a) => { caps.push(a.tokenCap); return { backend: "claude", tools: [], requests: 1, memoryDirs: [], ms: 1, capHit: false, text: "", error: "cap", spent: 400_000 }; },
    scratch: { make: async () => join(realpathSync(tmpdir()), `${PROBE_SCRATCH_PREFIX}fake`), remove: async () => {} },
  });
  const models = ["claude-sonnet-5-5", "claude-opus-5-5"];
  const s = await r.start(repo, { kind: "models", models, repeats: 1, seed: 5, accepted: accept(models, 20, 1) });
  assert.equal(s.ok, true, s.refused);
  await r.settled(repo);
  assert.ok(caps.length >= 1);
  assert.ok(caps.every((c) => c >= 1 && c <= 600_000));
  assert.ok(caps.length < 2 || caps[caps.length - 1] <= caps[0], "the cap only shrinks as the budget is used");
});
