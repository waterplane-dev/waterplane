/**
 * `claude-local` — claude's descriptor pointed at Ollama. Pins the argv and the
 * env it launches with (incl. the measured window handed to the CLI), that a 0 is not a window, that an Ollama id prices to
 * absent, and that an unreachable Ollama LISTS the backend with a sentence.
 * The probe that measured the CLI against the real model is
 * `scripts/probe-claude-local.mjs` (opt-in); stubs only here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeLocalBackend, claudeLocalEnv, claudeLocalKeepAlive, claudeLocalLeanArgs, leanArgs, LEAN_TOOLS, warmDeps, windowFromShow,
} from "../dist/backends/claude-local.js";
import { firstRequestOf, measuredOverhead } from "../dist/backends/overhead.js";
import { backendContextWindow, backendInfos, derive, primeBackendModels, resolveBackend } from "../dist/backends/index.js";
import { claudeBackend } from "../dist/backends/claude.js";
import { costOf, rateFor, resolveContextWindow } from "@waterplane/shared";

const req = (launch, over = {}) => ({ launch, hookPort: 8770, ...over });

// Never load a real model from a unit test: every warm ping is recorded instead.
const warmed = [];
warmDeps.warm = async (model, keepAlive) => { warmed.push([model, keepAlive]); };
// Never scan the real ~/.claude for overheads.
process.env.WATERPLANE_CLAUDE_HOME = mkdtempSync(join(tmpdir(), "cl-home-"));

test("argv is claude's plus --model, and the env points the CLI at Ollama", () => {
  process.env.WATERPLANE_OLLAMA_URL = "http://127.0.0.1:11434";
  const plan = claudeLocalBackend.prepare(req({ model: "qwen3-coder:30b-64k" }));
  const claude = claudeBackend.prepare(req({ model: "qwen3-coder:30b-64k" }));
  // The session id is minted per call; the plugin dir is a best-effort write to
  // a shared config dir that a parallel test file can race (absent ⇒ no flag).
  const strip = (a) => a.filter((x, i, all) => !["--session-id", "--plugin-dir"].includes(all[i - 1]) && x !== "--session-id" && x !== "--plugin-dir");
  // claude's argv, then the lean tail — on by default, for this backend only
  assert.deepEqual(strip(plan.args), [...strip(claude.args), "--tools", "Read,Edit,Write,Bash,Grep,Glob", "--strict-mcp-config"]);
  assert.equal(claude.args.includes("--tools"), false, "plain claude is never made lean");
  assert.equal(plan.args[plan.args.indexOf("--model") + 1], "qwen3-coder:30b-64k");
  assert.deepEqual(plan.env, {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "",
  });
  assert.ok(plan.sessionId, "a fresh launch still mints its conversation id");
  assert.equal(claudeLocalBackend.spawnEnv.DISABLE_AUTOUPDATER, "1");
});

test("the base url follows the documented knob", () => {
  process.env.WATERPLANE_OLLAMA_URL = "http://10.0.0.5:9999/";
  assert.equal(claudeLocalEnv().ANTHROPIC_BASE_URL, "http://10.0.0.5:9999");
  process.env.WATERPLANE_OLLAMA_URL = "http://127.0.0.1:11434";
});

test("no model is refused in words, not launched with claude's default id", () => {
  assert.throws(() => claudeLocalBackend.prepare(req({})), /needs a model chosen first/);
});

test("caps: no account limits, no usage probe, no gauge, no health board", () => {
  const c = claudeLocalBackend.caps;
  const d = derive(claudeLocalBackend);
  assert.equal(d.screen("limits"), null);
  assert.equal(d.has("usage"), false);
  assert.equal(d.screen("context"), null);
  assert.equal(c.remoteControl, false);
  assert.equal(claudeLocalBackend.healthScope, false);
  // everything else is claude's: same hooks, jsonl, boxes
  assert.equal(d.hooksInBand, derive(claudeBackend).hooksInBand);
  assert.equal(d.store("transcript"), "claude-jsonl");
  assert.equal(d.screen("dialogs"), "claude-numbered");
  assert.equal(claudeLocalBackend.delivery, claudeBackend.delivery);
});

test("0 is not a window", () => {
  assert.equal(windowFromShow({ parameters: "num_ctx 0\n", model_info: { "x.context_length": 0 } }), null);
  assert.equal(windowFromShow({ model_info: { "x.context_length": 0 } }), null);
  assert.equal(windowFromShow({}), null);
  assert.equal(windowFromShow(null), null);
  assert.equal(windowFromShow({ model_info: { "x.context_length": "big" } }), null);
});

test("num_ctx wins over context_length; context_length is the fallback", () => {
  const info = { "qwen3moe.context_length": 262144 };
  assert.equal(windowFromShow({ parameters: "num_ctx                        65536\ntemperature 0.7", model_info: info }), 65536);
  assert.equal(windowFromShow({ parameters: "temperature 0.7", model_info: info }), 262144);
  assert.equal(windowFromShow({ parameters: "num_ctx 0", model_info: info }), 262144);
});

test("an Ollama id prices to absent and never borrows claude's window", () => {
  assert.equal(rateFor("qwen3-coder:30b-64k"), null);
  assert.equal(costOf({ input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, "qwen3-coder:30b-64k"), null);
  assert.deepEqual(resolveContextWindow({ model: "qwen3-coder:30b-64k" }), { tok: null, from: "none" });
  assert.deepEqual(resolveContextWindow({ model: "qwen3-coder:30b-64k", observedTok: 33000 }), { tok: null, from: "none" });
});

function stubOllama(handler) {
  return new Promise((resolve) => {
    const srv = createServer((rq, rs) => {
      let b = ""; rq.on("data", (c) => (b += c));
      rq.on("end", () => { rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify(handler(rq.url, b ? JSON.parse(b) : null))); });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("models come from /api/tags, windows from /api/show, embedders are left out", async () => {
  const shows = {
    "chat:64k": { parameters: "num_ctx 65536", model_info: { "a.context_length": 262144 }, capabilities: ["completion", "tools"] },
    "chat:zero": { model_info: { "a.context_length": 0 }, capabilities: ["completion"] },
    "embed": { model_info: { "b.context_length": 8192 }, capabilities: ["embedding"] },
  };
  const srv = await stubOllama((url, body) => url === "/api/tags"
    ? { models: Object.keys(shows).map((name) => ({ name })) }
    : shows[body.model]);
  process.env.WATERPLANE_OLLAMA_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const m = await claudeLocalBackend.models();
    assert.deepEqual(m.ids, ["chat:64k", "chat:zero"]);
    assert.deepEqual(m.contextWindow, { "chat:64k": 65536 });
    assert.equal(m.where["chat:64k"], "local");
    assert.deepEqual(m.zeroCost, ["chat:64k", "chat:zero"]);
    assert.equal(m.unavailable, undefined);
    // the registry cache serves the same window, and absent for the 0 one
    await primeBackendModels();
    assert.equal(backendContextWindow("claude-local", "chat:64k"), 65536);
    assert.equal(backendContextWindow("claude-local", "chat:zero"), null);
    // …and the CLI is told that window, so its auto-compact fires inside it;
    // an unmeasured model gets no variable at all, never claude's 200k guess
    const env = (model) => claudeLocalBackend.prepare(req({ model })).env;
    assert.equal(env("chat:64k").CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
    assert.equal("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in env("chat:zero"), false);
  } finally {
    srv.close();
    process.env.WATERPLANE_OLLAMA_URL = "http://127.0.0.1:11434";
  }
});

test("unreachable Ollama: the backend is LISTED, with the sentence", async () => {
  const srv = await stubOllama(() => ({}));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const url = `http://127.0.0.1:${port}`;
  process.env.WATERPLANE_OLLAMA_URL = url;
  try {
    const m = await claudeLocalBackend.models();
    assert.equal(m.unavailable, `Ollama not reachable at ${url}`);
    assert.deepEqual(m.ids, []);
    await primeBackendModels();
    const info = backendInfos().find((b) => b.id === "claude-local");
    assert.ok(info, "listed, never hidden");
    assert.equal(info.unavailable, `Ollama not reachable at ${url}`);
    assert.equal(resolveBackend("claude-local").id, "claude-local");
    assert.equal(backendInfos().find((b) => b.id === "claude").unavailable, undefined);
  } finally {
    process.env.WATERPLANE_OLLAMA_URL = "http://127.0.0.1:11434";
  }
});

test("lean argv: pinned byte for byte, a custom list, and off", () => {
  assert.equal(LEAN_TOOLS, "Read,Edit,Write,Bash,Grep,Glob");
  assert.deepEqual(leanArgs({ lean: true }), ["--tools", "Read,Edit,Write,Bash,Grep,Glob", "--strict-mcp-config"]);
  assert.deepEqual(leanArgs({ lean: true, tools: " Read, Bash  Glob " }), ["--tools", "Read,Bash,Glob", "--strict-mcp-config"]);
  assert.deepEqual(leanArgs({ lean: true, tools: " , " }), ["--tools", LEAN_TOOLS, "--strict-mcp-config"]);
  assert.deepEqual(leanArgs({ lean: false, tools: "Read" }), []);
  delete process.env.WATERPLANE_CLAUDE_LOCAL_LEAN;
  assert.deepEqual(claudeLocalLeanArgs(), ["--tools", LEAN_TOOLS, "--strict-mcp-config"], "default ON");
  process.env.WATERPLANE_CLAUDE_LOCAL_LEAN = "0";
  try {
    assert.deepEqual(claudeLocalLeanArgs(), []);
    assert.equal(claudeLocalBackend.prepare(req({ model: "m" })).args.includes("--tools"), false, "the knob turns the lean tail off");
  } finally { delete process.env.WATERPLANE_CLAUDE_LOCAL_LEAN; }
  process.env.WATERPLANE_CLAUDE_LOCAL_TOOLS = "Read,Bash";
  try { assert.deepEqual(claudeLocalLeanArgs(), ["--tools", "Read,Bash", "--strict-mcp-config"]); }
  finally { delete process.env.WATERPLANE_CLAUDE_LOCAL_TOOLS; }
});

test("keep-alive: default 30m, the off spellings, Ollama's own spellings, junk falls back", () => {
  assert.equal(claudeLocalKeepAlive(undefined), "30m");
  for (const off of ["off", "OFF", "no", "false", "0", "", "  "]) assert.equal(claudeLocalKeepAlive(off), null, off);
  for (const ok of ["30m", "1h", "90s", "-1", "3600", "1.5h"]) assert.equal(claudeLocalKeepAlive(ok), ok);
  assert.equal(claudeLocalKeepAlive("forever"), "30m");
  assert.equal(claudeLocalKeepAlive("5 m"), "30m");
});

test("a launch warms the model without waiting on it; off means no ping", async () => {
  const recorder = warmDeps.warm;
  delete process.env.WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE;
  try {
    warmed.length = 0;
    warmDeps.warm = (model, ka) => { warmed.push([model, ka]); return new Promise(() => {}); }; // never answers
    const plan = claudeLocalBackend.prepare(req({ model: "qwen3-coder:30b-64k" }));
    assert.ok(plan.args.includes("--model"), "the plan is back while the runner has not answered");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(warmed, [["qwen3-coder:30b-64k", "30m"]]);
    warmDeps.warm = async () => { throw new Error("runner down"); };
    assert.doesNotThrow(() => claudeLocalBackend.prepare(req({ model: "m" })), "a failed warm never fails a launch");
    await new Promise((r) => setImmediate(r));
    warmed.length = 0;
    warmDeps.warm = recorder;
    process.env.WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE = "off";
    claudeLocalBackend.prepare(req({ model: "m" }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(warmed, []);
  } finally {
    warmDeps.warm = recorder;
    delete process.env.WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE;
  }
});

test("first request of a log head: model + whole input; sidechains and torn rows skipped", () => {
  const row = (o) => JSON.stringify(o);
  const head = [
    row({ type: "user", message: { content: "hi" } }),
    row({ type: "assistant", isSidechain: true, message: { model: "x", usage: { input_tokens: 9 } } }),
    '{"type":"assistant","message":{"model":"torn',
    row({ type: "assistant", message: { model: "qwen", usage: { input_tokens: 5000, cache_read_input_tokens: 600, cache_creation_input_tokens: 61, output_tokens: 2 } } }),
    row({ type: "assistant", message: { model: "qwen", usage: { input_tokens: 99999 } } }),
  ].join("\n");
  assert.deepEqual(firstRequestOf(head), { model: "qwen", tok: 5661 });
  assert.equal(firstRequestOf(""), null);
  assert.equal(firstRequestOf(row({ type: "assistant", message: { model: "q", usage: { input_tokens: 0 } } })), null, "0 is not a measurement");
  assert.equal(firstRequestOf(row({ type: "assistant", message: { usage: { input_tokens: 5 } } })), null, "no model, no answer");
});

test("measured overhead: the newest conversation per model, absent when none ran it", async () => {
  const home = mkdtempSync(join(tmpdir(), "cl-oh-"));
  const proj = join(home, ".claude", "projects");
  const a = join(proj, "-repo-a"), b = join(proj, "-repo-b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const conv = (model, tok) => JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: tok } } }) + "\n";
  writeFileSync(join(a, "old.jsonl"), conv("qwen", 32392));
  writeFileSync(join(b, "new.jsonl"), conv("qwen", 5661));
  writeFileSync(join(b, "claude.jsonl"), conv("claude-opus-5", 30000));
  mkdirSync(join(b, "subagents"));
  writeFileSync(join(b, "subagents", "agent-1.jsonl"), conv("other", 7));
  const t = Date.now() / 1000;
  utimesSync(join(a, "old.jsonl"), t - 100, t - 100);
  utimesSync(join(b, "new.jsonl"), t, t);
  const before = process.env.WATERPLANE_CLAUDE_HOME;
  process.env.WATERPLANE_CLAUDE_HOME = home;
  try {
    assert.deepEqual(await measuredOverhead(["qwen", "never-ran", "other"]), { qwen: 5661 });
    assert.deepEqual(await measuredOverhead([]), {});
    process.env.WATERPLANE_CLAUDE_HOME = join(home, "nope");
    assert.deepEqual(await measuredOverhead(["qwen"]), {}, "no log directory: nothing measured, nothing thrown");
  } finally { process.env.WATERPLANE_CLAUDE_HOME = before; }
});

test("the catalogue carries the measured overhead and the window onto the wire", async () => {
  const home = mkdtempSync(join(tmpdir(), "cl-wire-"));
  const dir = join(home, ".claude", "projects", "-r");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c.jsonl"), JSON.stringify({ type: "assistant", message: { model: "chat:64k", usage: { input_tokens: 33689 } } }) + "\n");
  const srv = await stubOllama((url, body) => url === "/api/tags"
    ? { models: [{ name: "chat:64k" }, { name: "fresh" }] }
    : { parameters: body.model === "chat:64k" ? "num_ctx 65536" : "", capabilities: ["completion"] });
  const before = process.env.WATERPLANE_CLAUDE_HOME;
  process.env.WATERPLANE_CLAUDE_HOME = home;
  process.env.WATERPLANE_OLLAMA_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const m = await claudeLocalBackend.models();
    assert.deepEqual(m.overheadTok, { "chat:64k": 33689 }, "only the model a conversation ran");
    await primeBackendModels();
    const info = backendInfos().find((b) => b.id === "claude-local");
    assert.deepEqual(info.models.overheadTok, { "chat:64k": 33689 });
    assert.deepEqual(info.models.contextWindow, { "chat:64k": 65536 });
    assert.equal(backendInfos().find((b) => b.id === "claude").models.overheadTok, undefined, "absent stays absent");
  } finally {
    srv.close();
    process.env.WATERPLANE_CLAUDE_HOME = before;
    process.env.WATERPLANE_OLLAMA_URL = "http://127.0.0.1:11434";
  }
});
