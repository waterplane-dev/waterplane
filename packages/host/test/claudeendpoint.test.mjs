/**
 * `claude-endpoint` — the claude binary pointed at any Anthropic-compatible URL.
 * Pins the config parsing, the env and argv byte for byte, that the API KEY is
 * in NEITHER (it reaches the CLI only through `apiKeyHelper`, a command naming
 * where the key lives), the key-file permission refusal, the catalogue's three
 * sources and their failures, and that an unconfigured backend is LISTED with a
 * sentence. Measured against the real CLI: `docs/analysis/spikes/2026-10-02-claude-local-lean.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKeyHelperCommand, claudeEndpointBackend, claudeEndpointEnv, endpointConfig, endpointLaunch, endpointModels,
  idsFromCatalogue, keychainReadProblem, keyProblem, parseModelList, withSettings,
} from "../dist/backends/claude-endpoint.js";
import { backendInfos, derive, primeBackendModels } from "../dist/backends/index.js";
import { claudeBackend } from "../dist/backends/claude.js";

const SECRET = "sk-ant-THIS-MUST-NEVER-APPEAR-0123456789";
const req = (launch) => ({ launch, hookPort: 8770 });
const noOverhead = async () => ({});
process.env.WATERPLANE_CLAUDE_HOME = mkdtempSync(join(tmpdir(), "ce-home-"));

function keyFile(mode = 0o600, body = `${SECRET}\n`) {
  const p = join(mkdtempSync(join(tmpdir(), "ce-key-")), "key with 'quote");
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

const cfg = (over = {}) => ({ url: "https://llm.example.net", models: ["glm-4.6", "qwen3-coder:480b"], windows: { "qwen3-coder:480b": 262144 }, key: null, lean: false, tools: "", ...over });

test("model list: ids and id=window, separators, duplicates, junk windows", () => {
  assert.equal(parseModelList(undefined), null);
  assert.equal(parseModelList(" , "), null);
  assert.deepEqual(parseModelList("a, b=131072 c=0 d=big\nqwen3-coder:480b=262144,a=5"), {
    ids: ["a", "b", "c", "d", "qwen3-coder:480b"],
    windows: { b: 131072, "qwen3-coder:480b": 262144 },
  });
});

test("config is read from the knobs; a key file wins over a keychain service", () => {
  const keys = ["URL", "MODELS", "KEY_FILE", "KEYCHAIN", "LEAN", "TOOLS"].map((k) => `WATERPLANE_CLAUDE_ENDPOINT_${k}`);
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert.deepEqual(endpointConfig(), { url: "", models: null, windows: {}, key: null, lean: false, tools: "" });
    process.env.WATERPLANE_CLAUDE_ENDPOINT_URL = " http://gpu.tail1234.ts.net:11434/ ";
    process.env.WATERPLANE_CLAUDE_ENDPOINT_MODELS = "m1=65536";
    process.env.WATERPLANE_CLAUDE_ENDPOINT_KEYCHAIN = "waterplane-endpoint";
    process.env.WATERPLANE_CLAUDE_ENDPOINT_LEAN = "1";
    assert.deepEqual(endpointConfig(), {
      url: "http://gpu.tail1234.ts.net:11434", models: ["m1"], windows: { m1: 65536 },
      key: { kind: "keychain", service: "waterplane-endpoint" }, lean: true, tools: "",
    });
    process.env.WATERPLANE_CLAUDE_ENDPOINT_KEY_FILE = "/k";
    assert.deepEqual(endpointConfig().key, { kind: "file", path: "/k" });
    process.env.WATERPLANE_CLAUDE_ENDPOINT_KEY_FILE = "~/ep.key";
    assert.deepEqual(endpointConfig().key, { kind: "file", path: join(homedir(), "ep.key") }, "~/ is the home directory");
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});

test("env: no key ⇒ a placeholder token (a claude.ai login is never sent there); a key ⇒ both blank for the helper", () => {
  assert.deepEqual(claudeEndpointEnv(cfg()), { ANTHROPIC_BASE_URL: "https://llm.example.net", ANTHROPIC_AUTH_TOKEN: "none", ANTHROPIC_API_KEY: "" });
  assert.deepEqual(claudeEndpointEnv(cfg({ key: { kind: "file", path: "/k" } }), 262144), {
    ANTHROPIC_BASE_URL: "https://llm.example.net", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
  });
  assert.equal("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in claudeEndpointEnv(cfg(), 0), false, "0 is not a window");
});

test("apiKeyHelper names WHERE the key is, quoted, never the key", () => {
  assert.equal(apiKeyHelperCommand(null), null);
  assert.equal(apiKeyHelperCommand({ kind: "file", path: "/a/it's" }), `cat '/a/it'\\''s'`);
  assert.equal(apiKeyHelperCommand({ kind: "keychain", service: "wp ep" }), `security find-generic-password -w -s 'wp ep'`);
});

test("withSettings merges into the hook blob, leaves other args alone", () => {
  const base = claudeBackend.prepare(req({ model: "m" })).args;
  const merged = withSettings(base, { apiKeyHelper: "cat '/k'" });
  const at = merged.indexOf("--settings");
  const blob = JSON.parse(merged[at + 1]);
  assert.equal(blob.apiKeyHelper, "cat '/k'");
  assert.ok(blob.hooks?.Stop, "the hooks are still there");
  assert.deepEqual(merged.filter((_, i) => i !== at + 1), base.filter((_, i) => i !== at + 1));
  assert.deepEqual(withSettings(["--model", "m"], { a: 1 }), ["--model", "m", "--settings", '{"a":1}']);
});

test("a launch: claude's argv + the helper, the configured window, and the KEY NOWHERE in argv or env", async () => {
  const path = keyFile();
  for (const key of [{ kind: "file", path }, { kind: "keychain", service: "svc" }]) {
    for (const lean of [false, true]) {
      const plan = endpointLaunch(req({ model: "qwen3-coder:480b" }), cfg({ key, lean }));
      const all = JSON.stringify(plan);
      assert.equal(all.includes(SECRET), false, "the key is not in the plan");
      assert.equal(all.includes("sk-ant"), false);
      for (const [k, v] of Object.entries(plan.env)) {
        assert.equal(v.includes(SECRET), false, `env ${k}`);
      }
      const blob = JSON.parse(plan.args[plan.args.indexOf("--settings") + 1]);
      assert.equal(blob.apiKeyHelper, apiKeyHelperCommand(key));
      assert.equal(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
      assert.equal(plan.args[plan.args.indexOf("--model") + 1], "qwen3-coder:480b");
      assert.equal(plan.args.includes("--tools"), lean, "lean only when configured");
    }
  }
  const keyless = endpointLaunch(req({ model: "glm-4.6" }), cfg());
  assert.equal("apiKeyHelper" in JSON.parse(keyless.args[keyless.args.indexOf("--settings") + 1]), false);
  assert.equal("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in keyless.env, false, "an unconfigured window is absent, never borrowed");
});

test("a launch is refused in words: unconfigured, or no model", () => {
  assert.throws(() => endpointLaunch(req({ model: "m" }), cfg({ url: "" })), /not configured on this desktop — set WATERPLANE_CLAUDE_ENDPOINT_URL/);
  assert.throws(() => endpointLaunch(req({}), cfg()), /needs a model chosen first/);
});

test("key problems: missing, readable by others, empty, a directory; keychain present/absent/not macOS", async () => {
  assert.equal(await keyProblem(null), null);
  assert.equal(await keyProblem({ kind: "file", path: keyFile() }), null);
  assert.match(await keyProblem({ kind: "file", path: "/nonexistent/key" }), /does not exist/);
  const loose = keyFile(0o644);
  const said = await keyProblem({ kind: "file", path: loose });
  assert.match(said, /can be read by other users \(mode 644\); chmod 600 it/);
  assert.equal(said.includes(SECRET), false);
  assert.match(await keyProblem({ kind: "file", path: keyFile(0o600, "") }), /is empty/);
  assert.match(await keyProblem({ kind: "file", path: tmpdir() }), /is not a file/);
  assert.equal(await keyProblem({ kind: "keychain", service: "s" }, { platform: "darwin", keychainHas: async () => true }), null);
  assert.match(await keyProblem({ kind: "keychain", service: "s" }, { platform: "darwin", keychainHas: async () => false }), /no generic password for service "s"/);
  assert.match(await keyProblem({ kind: "keychain", service: "s" }, { platform: "linux" }), /needs macOS/);
});

test("catalogue documents: Ollama tags, /v1/models, anything else is null", () => {
  assert.deepEqual(idsFromCatalogue({ models: [{ name: "a" }, { name: "" }, { name: 3 }, { name: "a" }, { name: "b" }] }), ["a", "b"]);
  assert.deepEqual(idsFromCatalogue({ data: [{ id: "gpt-oss-120b" }, { id: "claude-x" }] }), ["gpt-oss-120b", "claude-x"]);
  assert.equal(idsFromCatalogue({ object: "list" }), null);
  assert.equal(idsFromCatalogue(null), null);
  assert.equal(idsFromCatalogue("x"), null);
});

function stub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((rq, rs) => {
      let b = ""; rq.on("data", (c) => (b += c));
      rq.on("end", () => {
        seen.push({ url: rq.url, auth: rq.headers.authorization, xkey: rq.headers["x-api-key"] });
        const [status, doc] = handler(rq.url, b ? JSON.parse(b) : null);
        rs.statusCode = status; rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify(doc));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("models: static list wins, all hosted (loopback too), configured windows, no zeroCost", async () => {
  const m = await endpointModels(cfg({ url: "http://127.0.0.1:4000" }), { overhead: async (ids) => ({ [ids[1]]: 9000 }) });
  assert.deepEqual(m.ids, ["glm-4.6", "qwen3-coder:480b"]);
  assert.deepEqual(m.where, { "glm-4.6": "hosted", "qwen3-coder:480b": "hosted" });
  assert.deepEqual(m.contextWindow, { "qwen3-coder:480b": 262144 });
  assert.deepEqual(m.overheadTok, { "qwen3-coder:480b": 9000 });
  assert.equal(m.zeroCost, undefined);
  assert.equal(m.unavailable, undefined);
});

test("models: an Ollama endpoint is asked with the key, windows from /api/show", async () => {
  const s = await stub((url, body) => url === "/api/tags" ? [200, { models: [{ name: "gpt-oss:120b" }, { name: "qwen3-coder:480b" }] }]
    : url === "/api/show" ? [200, body.model === "gpt-oss:120b" ? { parameters: "num_ctx 131072" } : {}] : [404, {}]);
  try {
    const m = await endpointModels(cfg({ url: s.url, models: null, windows: {}, key: { kind: "file", path: "/k" } }), {
      keyProblem: async () => null, readKey: async () => SECRET, overhead: noOverhead,
    });
    assert.deepEqual(m.ids, ["gpt-oss:120b", "qwen3-coder:480b"]);
    assert.deepEqual(m.contextWindow, { "gpt-oss:120b": 131072 });
    assert.equal(m.overheadTok, undefined);
    assert.ok(s.seen.every((r) => r.auth === `Bearer ${SECRET}` && r.xkey === SECRET), "the host's own request carries the key");
    assert.equal(JSON.stringify(m).includes(SECRET), false, "the catalogue never does");
  } finally { s.srv.close(); }
});

test("models: no Ollama ⇒ /v1/models; nothing answers ⇒ unavailable sentence without the key", async () => {
  const s = await stub((url) => url === "/v1/models" ? [200, { data: [{ id: "bedrock/llama4" }] }] : [404, {}]);
  try {
    const m = await endpointModels(cfg({ url: s.url, models: null, windows: {} }), { overhead: noOverhead });
    assert.deepEqual(m.ids, ["bedrock/llama4"]);
    assert.deepEqual(m.contextWindow, {}, "an OpenAI-style list names no window, and none is guessed");
  } finally { s.srv.close(); }
  const d = await stub(() => [401, { error: "no" }]);
  try {
    const m = await endpointModels(cfg({ url: d.url, models: null, windows: {}, key: { kind: "file", path: "/k" } }), {
      keyProblem: async () => null, readKey: async () => SECRET, overhead: noOverhead,
    });
    assert.deepEqual(m.ids, []);
    assert.equal(m.unavailable, `${d.url} did not answer a model list (/api/tags: HTTP 401; /v1/models: HTTP 401). Name the models in WATERPLANE_CLAUDE_ENDPOINT_MODELS.`);
    assert.equal(m.unavailable.includes(SECRET), false);
  } finally { d.srv.close(); }
});

test("a key the HOST could not read is blamed on the key read, never on the endpoint (which is not asked)", async () => {
  const s = await stub(() => [401, { error: "no" }]);
  try {
    const keychain = { kind: "keychain", service: "wp ep" };
    const timedOut = keychainReadProblem("wp ep", { killed: true, signal: "SIGTERM" });
    const m = await endpointModels(cfg({ url: s.url, models: null, windows: {}, key: keychain }), {
      keyProblem: async () => null, readKey: async () => ({ problem: timedOut }), overhead: noOverhead,
    });
    assert.deepEqual(m.ids, []);
    assert.equal(m.unavailable, timedOut);
    assert.match(m.unavailable, /from the macOS keychain did not finish within 5 s — .*permission prompt/);
    assert.doesNotMatch(m.unavailable, /did not answer a model list/);
    assert.equal(s.seen.length, 0, "the endpoint was not asked keyless");
    assert.match(keychainReadProblem("x", { code: 51 }), /keychain failed \(security exited 51\)/);
  } finally { s.srv.close(); }
});

test("unconfigured / bad key: LISTED with a sentence, never hidden", async () => {
  const none = await endpointModels(cfg({ url: "" }));
  assert.match(none.unavailable, /^Not configured on this desktop: set WATERPLANE_CLAUDE_ENDPOINT_URL/);
  const bad = await endpointModels(cfg({ key: { kind: "file", path: keyFile(0o640) } }), { overhead: noOverhead });
  assert.match(bad.unavailable, /chmod 600/);
  assert.deepEqual(bad.ids, []);
  const saved = process.env.WATERPLANE_CLAUDE_ENDPOINT_URL;
  delete process.env.WATERPLANE_CLAUDE_ENDPOINT_URL;
  try {
    await primeBackendModels();
    const info = backendInfos().find((b) => b.id === "claude-endpoint");
    assert.ok(info, "listed");
    assert.equal(info.label, "Claude Code (custom endpoint)");
    assert.match(info.unavailable, /Not configured/);
    assert.equal(info.caps.usageLimits, false);
    assert.equal(info.caps.transcript, true);
  } finally { if (saved !== undefined) process.env.WATERPLANE_CLAUDE_ENDPOINT_URL = saved; }
});

test("caps: claude's TUI readers, no account features, off the health board", () => {
  const c = claudeEndpointBackend.caps;
  const d = derive(claudeEndpointBackend);
  assert.equal(d.screen("limits"), null);
  assert.equal(d.has("usage"), false);
  assert.equal(d.screen("context"), null);
  assert.equal(c.remoteControl, false);
  assert.equal(d.store("transcript"), "claude-jsonl");
  assert.equal(claudeEndpointBackend.healthScope, false);
  assert.equal(claudeEndpointBackend.spawnEnv.DISABLE_AUTOUPDATER, "1");
  assert.equal(claudeEndpointBackend.delivery, claudeBackend.delivery);
});

// ── The no-key claim, MEASURED against the real CLI ────────────────────────
//
// `claudeEndpointEnv` says `ANTHROPIC_AUTH_TOKEN=none` keeps the person's
// claude.ai OAuth token off a third-party URL. An env map cannot prove that;
// only what the endpoint RECEIVES can. So: the real `claude -p`, pointed at a
// stub, with this desktop's normal login present. A CONTROL run with the token
// UNSET first proves the login is there and WOULD be sent (otherwise the
// measurement proves nothing and the test SKIPS saying so). Measured
// 2026-10-02 on 2.1.287: control ⇒ `Bearer sk-ant-oat…`; endpoint env ⇒
// `Bearer none`; a key helper ⇒ the helper's key. No tokens are spent: the
// stub answers every request with a 400, and it is loopback in this process.

/** Classify a header without ever keeping a credential in a test message. */
const credClass = (v) => v === undefined ? "absent" : /sk-ant-/.test(v) ? "sk-ant" : v;

function messagesStub() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((rq, rs) => {
      rq.resume();
      rq.on("end", () => {
        seen.push({ path: rq.url, auth: credClass(rq.headers.authorization), xkey: credClass(rq.headers["x-api-key"]) });
        rs.statusCode = 400; rs.setHeader("content-type", "application/json");
        rs.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "waterplane stub" } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port }));
  });
}

/** Run the CLI once with `env` laid over this process's own (the person's login comes along). */
function runCli(bin, args, env) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete base[k];
    let child;
    try { child = spawn(bin, args, { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { resolve({ error: e }); return; }
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (e) => { clearTimeout(t); resolve({ error: e }); });
    child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

const messagesOf = (seen) => seen.filter((r) => r.path.startsWith("/v1/messages"));
const settingsOf = (plan) => plan.args[plan.args.indexOf("--settings") + 1];

test("REAL CLI: no key ⇒ the endpoint sees `Bearer none`, never the claude.ai login (a control proves the login is there)", { timeout: 200_000 }, async (t) => {
  const bin = claudeBackend.bin();
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error || probe.status !== 0) {
    t.skip(`the real claude CLI is not runnable here (${bin}: ${probe.error?.message ?? `exit ${probe.status}`}) — the no-key leak check was NOT measured`);
    return;
  }
  const s = await messagesStub();
  try {
    const model = "glm-4.6";
    const once = ["-p", "hi", "--model", model, "--max-turns", "1"];
    // Control: the token UNSET — what a claude.ai login does to this URL.
    const ctl = await runCli(bin, once, { ANTHROPIC_BASE_URL: s.url, ANTHROPIC_API_KEY: "" });
    if (ctl.error) { t.skip(`claude would not start: ${ctl.error.message} — NOT measured`); return; }
    const ctlMsgs = messagesOf(s.seen);
    if (!ctlMsgs.some((r) => r.auth === "sk-ant" || r.xkey === "sk-ant")) {
      t.skip(`no claude.ai login on this desktop (the control sent ${JSON.stringify(ctlMsgs.map((r) => r.auth))}) — nothing to leak, so the no-key path was NOT measured`);
      return;
    }
    // The backend's own launch: its env and its --settings blob, hooks pointed at the stub.
    s.seen.length = 0;
    const plan = endpointLaunch({ launch: { model }, hookPort: s.port }, cfg({ url: s.url, key: null }));
    const run = await runCli(bin, [...once, "--settings", settingsOf(plan)], plan.env);
    assert.equal(run.error, undefined);
    const msgs = messagesOf(s.seen);
    assert.ok(msgs.length > 0, `the CLI reached the stub (output: ${String(run.out).slice(0, 200)})`);
    for (const r of s.seen) {
      assert.notEqual(r.auth, "sk-ant", `${r.path}: an sk-ant credential reached a third-party URL in Authorization`);
      assert.notEqual(r.xkey, "sk-ant", `${r.path}: an sk-ant credential reached a third-party URL in x-api-key`);
    }
    for (const r of msgs) assert.ok(r.auth === "Bearer none" || r.auth === "absent", `${r.path}: auth was ${r.auth}`);

    // A key configured: the helper's key arrives, and still no login.
    s.seen.length = 0;
    const key = "wp-endpoint-test-key-0123456789";
    const kp = join(mkdtempSync(join(tmpdir(), "ce-key-")), "k");
    writeFileSync(kp, `${key}\n`); chmodSync(kp, 0o600);
    const kplan = endpointLaunch({ launch: { model }, hookPort: s.port }, cfg({ url: s.url, key: { kind: "file", path: kp } }));
    await runCli(bin, [...once, "--settings", settingsOf(kplan)], kplan.env);
    const kmsgs = messagesOf(s.seen);
    assert.ok(kmsgs.length > 0, "the keyed run reached the stub");
    for (const r of s.seen) assert.ok(r.auth !== "sk-ant" && r.xkey !== "sk-ant", `${r.path}: the login leaked beside a configured key`);
    assert.ok(kmsgs.every((r) => r.auth === `Bearer ${key}` || r.xkey === key), "the helper's key is what arrived");
  } finally { s.srv.close(); }
});
