/**
 * The engine axis for the daemon's unattended calls (`sidecar.ts`).
 *
 * Three things are pinned here, and each of them is a way this could quietly
 * cost something:
 *
 *  1. **The routing spec parser.** A value that mis-splits sends the summary at
 *     a server that does not exist — and the whole reason a person sets it is
 *     to STOP a call going to Anthropic, so a spec that silently fell back to
 *     claude would defeat the only thing it was for. The values are hostile by
 *     construction: the URL carries colons (scheme, port) and the model carries
 *     one in its tag (`gemma4:e4b`).
 *  2. **What a local completion may be believed.** A reasoning model was
 *     measured spending 421 of 451 tokens on `reasoning_content` and returning
 *     an EMPTY `content`; a 500, a dead socket and a half-written body all
 *     happen too. Every one of them must be the same "" the existing callers
 *     already read as "no summary" — never a persisted paragraph of a model
 *     thinking out loud.
 *  3. **That the claude engine did not change.** The envelope is unwrapped and
 *     an account block still yields nothing at all. This is the path every host
 *     takes with no new environment variables set.
 *
 * Real banner phrasing appears in one fixture here, under the same carve-out
 * `headlesslimit.test.mjs` takes: nothing in this file is ever rendered into a
 * terminal — it is written to a temp stub whose stdout is read by `execFile`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  chatCompletion, claudeConfigPath, completionText, parseSidecarSpec, runNameTask, runSummaryTask, runToolTask, sidecarPlan, SIDECAR_ENV,
  trustRefusal, workspaceTrust,
} from "../dist/sidecar.js";

// ── 1. the routing spec ────────────────────────────────────────────────────

test("nothing set is the claude engine — today's behaviour, unchanged", () => {
  assert.equal(parseSidecarSpec(undefined).engine, "claude-p");
  assert.equal(parseSidecarSpec("").engine, "claude-p");
  assert.equal(parseSidecarSpec("  ").engine, "claude-p");
  assert.equal(parseSidecarSpec("claude").engine, "claude-p");
  assert.equal(parseSidecarSpec("claude-p").engine, "claude-p");
});

test("the pipe form splits exactly, model tag colon and all", () => {
  const p = parseSidecarSpec("openai-compat:http://localhost:11434/v1|gemma4:e4b");
  assert.equal(p.engine, "openai-compat");
  assert.equal(p.baseURL, "http://localhost:11434/v1");
  assert.equal(p.model, "gemma4:e4b");
});

test("the colon form splits after the path, so the PORT is not read as a model", () => {
  // The value the plan documents, typed by a person: three colons in it, and
  // only the third one separates anything.
  const p = parseSidecarSpec("openai-compat:http://localhost:11434/v1:gemma4:e4b");
  assert.equal(p.engine, "openai-compat");
  assert.equal(p.baseURL, "http://localhost:11434/v1", "the port stayed on the URL");
  assert.equal(p.model, "gemma4:e4b", "the model kept its tag");
});

test("a colon form with no path is REFUSED rather than guessed", () => {
  // `http://host:11434:model` could equally be port-then-model or host-then-model.
  const p = parseSidecarSpec("openai-compat:http://localhost:11434:gemma4", "WATERPLANE_SIDECAR_SUMMARY");
  assert.equal(p.engine, "refused");
  assert.match(p.reason, /WATERPLANE_SIDECAR_SUMMARY/);
  assert.match(p.reason, /pipe/i, "the sentence says how to write it instead");
});

test("a trailing slash never doubles up on /chat/completions", () => {
  const p = parseSidecarSpec("openai-compat:http://localhost:11434/v1/|m");
  assert.equal(p.baseURL, "http://localhost:11434/v1");
});

test("junk is refused in words, never treated as claude", () => {
  for (const spec of ["gpt5", "openai", "openai-compat", "openai-compat:", "openai-compat:not a url|m", "openai-compat:http://h/v1|"]) {
    const p = parseSidecarSpec(spec, "WATERPLANE_SIDECAR_SUMMARY");
    assert.equal(p.engine, "refused", `"${spec}" must not resolve to an engine`);
    assert.ok(p.reason.includes("WATERPLANE_SIDECAR_SUMMARY"), "the refusal names the variable a person can unset");
  }
});

test("a task that needs TOOLS refuses the toolless engine — and says why", () => {
  const env = { WATERPLANE_SIDECAR_SUMMARY: "openai-compat:http://localhost:11434/v1|gemma4:e4b" };
  assert.equal(sidecarPlan("summary", env).engine, "openai-compat", "the summary carries no tools by contract");

  for (const task of ["assess", "review"]) {
    const name = task === "assess" ? "WATERPLANE_SIDECAR_ASSESS" : "WATERPLANE_SIDECAR_REVIEW";
    const p = sidecarPlan(task, { [name]: "openai-compat:http://localhost:11434/v1|gemma4:e4b" });
    assert.equal(p.engine, "refused");
    assert.match(p.reason, new RegExp(name));
    assert.match(p.reason, /no tools/);
  }
});

test("an unset task is claude even when a SIBLING task is routed elsewhere", () => {
  const env = { WATERPLANE_SIDECAR_SUMMARY: "openai-compat:http://localhost:11434/v1|gemma4:e4b" };
  assert.equal(sidecarPlan("assess", env).engine, "claude-p");
  assert.equal(sidecarPlan("review", env).engine, "claude-p");
  assert.equal(sidecarPlan("name", env).engine, "claude-p");
});

test("the naming pass may take the toolless engine — the items' own words are the whole input", () => {
  // The summary's side of the line, for the summary's reason and no weaker one:
  // a naming pass is handed the item text and asked what to CALL it. There is
  // no file to read, no repo to open, and nothing a tool could contribute. It is
  // also the cheapest task here, so it is the one most worth being able to move
  // off the account entirely.
  const env = { WATERPLANE_SIDECAR_NAME: "openai-compat:http://localhost:11434/v1|gemma4:e4b" };
  const p = sidecarPlan("name", env);
  assert.equal(p.engine, "openai-compat");
  assert.equal(p.model, "gemma4:e4b");
  // …and it does not drag the tool-using tasks across with it.
  assert.equal(sidecarPlan("assess", env).engine, "claude-p");
  assert.equal(sidecarPlan("review", env).engine, "claude-p");
});

test("every task's routing variable is spelled exactly once, and `name` has one", () => {
  // `SIDECAR_ENV` is what the refusal sentences quote, so a task whose variable
  // is missing or misspelled refuses by naming something a person cannot unset.
  assert.equal(SIDECAR_ENV.name, "WATERPLANE_SIDECAR_NAME");
  assert.equal(new Set(Object.values(SIDECAR_ENV)).size, Object.keys(SIDECAR_ENV).length,
    "two tasks sharing a variable would route both wherever one was pointed");
  for (const [task, v] of Object.entries(SIDECAR_ENV)) {
    assert.match(v, /^WATERPLANE_SIDECAR_[A-Z]+$/, `${task}'s variable follows the one naming rule .env.example documents`);
  }
});

test("a naming spec that cannot be read is refused BY NAME, never run as claude", () => {
  for (const spec of ["ollama", "openai-compat", "openai-compat:", "openai-compat:http://localhost:11434:m"]) {
    const p = sidecarPlan("name", { WATERPLANE_SIDECAR_NAME: spec });
    assert.equal(p.engine, "refused", `${spec} is refused`);
    assert.ok(p.reason.includes("WATERPLANE_SIDECAR_NAME"), "the refusal names the variable a person can unset");
  }
});

// ── 2. reading a /chat/completions body ────────────────────────────────────

const body = (msg) => ({ choices: [{ index: 0, message: msg, finish_reason: "stop" }] });

test("the ordinary case: content is the answer", () => {
  assert.equal(completionText(body({ role: "assistant", content: "Fixing the echo window." })), "Fixing the echo window.");
});

test("a reasoning model that spent its budget thinking yields NOTHING", () => {
  // Measured: 421 of 451 tokens went to reasoning_content and content came back
  // empty. The thinking is never the summary — the row keeps what it had.
  assert.equal(completionText(body({ role: "assistant", content: "", reasoning_content: "Okay, so the user wants…" })), "");
  assert.equal(completionText(body({ role: "assistant", content: null, reasoning: "…" })), "");
});

test("inline thinking is stripped, closed or not", () => {
  assert.equal(completionText(body({ content: "<think>hmm, the screen shows a build</think>Running the build." })), "Running the build.");
  // Cut off mid-thought: everything from the tag on is thinking, so nothing is left.
  assert.equal(completionText(body({ content: "<think>hmm, the screen shows" })), "");
});

test("a content ARRAY (some servers) is joined, other shapes are nothing", () => {
  assert.equal(completionText(body({ content: [{ type: "text", text: "Two " }, { type: "text", text: "sentences." }] })), "Two sentences.");
  assert.equal(completionText({}), "");
  assert.equal(completionText({ choices: [] }), "");
  assert.equal(completionText(null), "");
  assert.equal(completionText("not an envelope"), "");
  assert.equal(completionText(body({ content: { unexpected: true } })), "");
});

// ── 3. the local engine over a real socket ─────────────────────────────────

/** A stub speaking /chat/completions. `reply(req)` decides what comes back. */
function stubServer(reply) {
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      seen.push({ url: req.url, body: parsed });
      const r = reply(parsed);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const route = { engine: "openai-compat", baseURL: `http://127.0.0.1:${srv.address().port}/v1`, model: "gemma4:e4b" };
      resolve({ route, seen, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

const ok = (content) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) });

test("a completion comes back, and the request carries NO tools", async () => {
  const s = await stubServer(() => ok("Wiring the sidecar into the summary path."));
  const text = await chatCompletion(s.route, { prompt: "summarise this", system: "you summarise" });
  assert.equal(text, "Wiring the sidecar into the summary path.");
  const req = s.seen[0];
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.body.model, "gemma4:e4b");
  assert.equal(req.body.tools, undefined, "the local engine is toolless by construction");
  assert.equal(req.body.stream, false);
  assert.ok(req.body.max_tokens >= 1024, "the budget is generous — a tight one is spent entirely on thinking");
  assert.deepEqual(req.body.messages.map((m) => m.role), ["system", "user"]);
  await s.close();
});

test("an HTTP error is no summary, not an error to persist", async () => {
  const s = await stubServer(() => ({ status: 500, body: JSON.stringify({ error: "model not found" }) }));
  assert.equal(await chatCompletion(s.route, { prompt: "x" }), "");
  await s.close();
});

test("a malformed body is no summary", async () => {
  const s = await stubServer(() => ({ status: 200, body: "{\"choices\": [" }));
  assert.equal(await chatCompletion(s.route, { prompt: "x" }), "");
  await s.close();
});

test("an empty content over the wire is no summary", async () => {
  const s = await stubServer(() => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "thinking…" } }] }) }));
  assert.equal(await chatCompletion(s.route, { prompt: "x" }), "");
  await s.close();
});

test("a server that is not there is no summary, and no throw", async () => {
  // Port 1 on loopback refuses instantly — the dead-runtime case.
  const dead = { engine: "openai-compat", baseURL: "http://127.0.0.1:1/v1", model: "m" };
  assert.equal(await chatCompletion(dead, { prompt: "x", timeoutMs: 2000 }), "");
});

test("the summary task routes at the local engine and normalises one line", async () => {
  const s = await stubServer(() => ok("  Reviewing   the\n  delivery path.  "));
  const prev = process.env.WATERPLANE_SIDECAR_SUMMARY;
  process.env.WATERPLANE_SIDECAR_SUMMARY = `openai-compat:${s.route.baseURL}|${s.route.model}`;
  try {
    const out = await runSummaryTask({ cwd: process.cwd(), prompt: "p", system: "s", model: "haiku" });
    assert.equal(out, "Reviewing the delivery path.");
  } finally {
    if (prev === undefined) delete process.env.WATERPLANE_SIDECAR_SUMMARY; else process.env.WATERPLANE_SIDECAR_SUMMARY = prev;
    await s.close();
  }
});

// ── 4. the claude engine, unchanged ────────────────────────────────────────

const BIN_DIR = mkdtempSync(join(tmpdir(), "waterplane-sidecar-"));

/** A stub `claude` that prints `out` on stdout and exits `code`. */
function stubClaude(name, out, code = 0) {
  const p = join(BIN_DIR, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null\ncat <<'WATERPLANE_EOF'\n${out}\nWATERPLANE_EOF\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

const withBin = async (bin, fn) => {
  const prev = process.env.WATERPLANE_CLAUDE_BIN;
  process.env.WATERPLANE_CLAUDE_BIN = bin;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.WATERPLANE_CLAUDE_BIN; else process.env.WATERPLANE_CLAUDE_BIN = prev;
  }
};

test("the claude engine still unwraps the --output-format json envelope", async () => {
  const bin = stubClaude("claude-ok", JSON.stringify({ type: "result", result: "Refactoring the host's route table.", session_id: "x" }));
  const out = await withBin(bin, () => runSummaryTask({ cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku" }));
  assert.equal(out, "Refactoring the host's route table.");
});

test("an account block through the envelope is NO summary, exactly as before", async () => {
  // The carve-out this file documents at the top: written to a stub's stdout,
  // read by execFile, never drawn on a screen.
  const bin = stubClaude("claude-limited", JSON.stringify({
    type: "result", is_error: true,
    result: "You've hit your session limit · resets 5:10pm (Europe/Berlin)",
    session_id: "x",
  }), 1);
  const out = await withBin(bin, () => runSummaryTask({ cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku" }));
  assert.equal(out, "", "the quota banner is never paraphrased back onto a session row");
});

test("an errored envelope is no summary — its result is the error, not a name", async () => {
  const bin = stubClaude("claude-autherr", JSON.stringify({
    type: "result", is_error: true,
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    session_id: "x",
  }), 1);
  const out = await withBin(bin, () => runSummaryTask({ cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku" }));
  assert.equal(out, "", "an auth failure never lands as a tab title");
});

test("a binary that fails outright is no summary either", async () => {
  const out = await withBin(join(BIN_DIR, "does-not-exist"), () => runSummaryTask({ cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku" }));
  assert.equal(out, "");
});

test("runNameTask: persist:false adds --no-session-persistence, and only then", async () => {
  // A stub that answers with its own argv, one per line, so the flags are read off the result.
  const p = join(BIN_DIR, "claude-argv");
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
  chmodSync(p, 0o755);
  const req = { cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku", timeoutMs: 10_000 };
  const off = await withBin(p, () => runNameTask({ ...req, persist: false }));
  const on = await withBin(p, () => runNameTask(req));
  assert.ok(off.text.split("\n").includes("--no-session-persistence"), off.text);
  assert.ok(!on.text.split("\n").includes("--no-session-persistence"), "absent = the default, a transcript as before");
  for (const f of ["--setting-sources", "--tools", "--thinking"]) assert.ok(off.text.split("\n").includes(f), f);
});

test("a raw (un-enveloped) line still comes through, squashed to one line", async () => {
  const bin = stubClaude("claude-raw", "Just   a  plain\nsentence.");
  const out = await withBin(bin, () => runSummaryTask({ cwd: BIN_DIR, prompt: "p", system: "s", model: "haiku" }));
  assert.equal(out, "Just a plain sentence.");
});

test("the commit-message draft may take the toolless engine, and routes on its OWN knob", () => {
  // Same side of the line as the summary and the naming pass, for the same
  // reason: the diff, the file list and the repo's recent subjects are IN the
  // prompt. It opens no file and runs no git of its own.
  const env = { WATERPLANE_SIDECAR_COMMIT: "openai-compat:http://localhost:11434/v1|gemma4:e4b" };
  const p = sidecarPlan("commit", env);
  assert.equal(p.engine, "openai-compat");
  assert.equal(p.model, "gemma4:e4b");
  // One knob per task: pointing the naming pass somewhere must not move this.
  assert.equal(sidecarPlan("commit", { WATERPLANE_SIDECAR_NAME: "openai-compat:http://x/v1|m" }).engine, "claude-p");
  assert.equal(sidecarPlan("name", env).engine, "claude-p");
  assert.equal(SIDECAR_ENV.commit, "WATERPLANE_SIDECAR_COMMIT");
});

// ── 5. workspace trust: a tool task never runs where the CLI would have asked ──
//
// Measured on claude 2.1.289: `claude -p` in a folder nobody trusted loads the
// repo's own hooks and asks nothing. The gate reads the CLI's own answer in
// `.claude.json` and never writes it; the inheritance rule below is the CLI's,
// measured the same day (a folder under a trusted parent opened with no dialog
// while its own entry said false).

const TRUST_DIR = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-trust-")));

/** A `.claude.json` with these entries; returns its path. */
function trustConfig(name, projects) {
  const dir = join(TRUST_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ projects }));
  return join(dir, ".claude.json");
}
const folder = (name) => { const d = join(TRUST_DIR, "repos", name); mkdirSync(d, { recursive: true }); return d; };

test("a folder whose own entry is trusted is trusted", async () => {
  const repo = folder("own");
  assert.equal(await workspaceTrust(repo, trustConfig("c-own", { [repo]: { hasTrustDialogAccepted: true } })), true);
});

test("a trusted PARENT trusts the folder, and the folder's own false vetoes nothing", async () => {
  const parent = folder("parent");
  const repo = join(parent, "child");
  mkdirSync(repo);
  const cfg = trustConfig("c-parent", {
    [parent]: { hasTrustDialogAccepted: true },
    [repo]: { hasTrustDialogAccepted: false },
  });
  assert.equal(await workspaceTrust(repo, cfg), true);
});

test("no trusted entry on the way up is NOT trusted — the case the CLI would have asked about", async () => {
  const repo = folder("stranger");
  const cfg = trustConfig("c-none", { [repo]: { hasTrustDialogAccepted: false }, "/somewhere/else": { hasTrustDialogAccepted: true } });
  assert.equal(await workspaceTrust(repo, cfg), false);
});

test("a trusted SIBLING with a shared prefix trusts nothing — ancestry is by path segment, not string prefix", async () => {
  const mine = folder("proj");
  const evil = folder("proj-evil");
  assert.equal(await workspaceTrust(evil, trustConfig("c-prefix", { [mine]: { hasTrustDialogAccepted: true } })), false);
});

test("a path reached through a symlink is judged by its realpath too", async () => {
  const real = folder("real");
  const link = join(TRUST_DIR, "link-to-real");
  symlinkSync(real, link);
  assert.equal(await workspaceTrust(link, trustConfig("c-link", { [real]: { hasTrustDialogAccepted: true } })), true);
});

test("only a literal true counts — a truthy string is not the CLI's answer", async () => {
  const repo = folder("truthy");
  assert.equal(await workspaceTrust(repo, trustConfig("c-truthy", { [repo]: { hasTrustDialogAccepted: "yes" } })), false);
});

test("an unreadable or unparseable config CANNOT TELL — null, never a guess", async () => {
  const repo = folder("unknown");
  assert.equal(await workspaceTrust(repo, join(TRUST_DIR, "missing", ".claude.json")), null);
  const bad = join(TRUST_DIR, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.equal(await workspaceTrust(repo, bad), null);
});

test("the refusal is a sentence, and cannot-tell refuses too", () => {
  assert.equal(trustRefusal("/r", true), undefined);
  const no = trustRefusal("/r", false);
  assert.match(no, /does not trust \/r/);
  assert.match(no, /trust question/, "it says what the person does about it");
  assert.match(trustRefusal("/r", null), /Could not read .*\.claude\.json/);
});

test("the config path follows CLAUDE_CONFIG_DIR, as the CLI does", () => {
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" }), "/cfg/.claude.json");
  assert.ok(claudeConfigPath({}).endsWith("/.claude.json"));
});

/** A stub `claude` that leaves a marker if it is ever started. */
function markerClaude(name, marker) {
  const p = join(BIN_DIR, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\necho '{"type":"result","result":"ran"}'\n`);
  chmodSync(p, 0o755);
  return p;
}

const withConfigDir = async (dir, fn) => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
};

for (const task of ["assess", "review"]) {
  test(`${task}: an untrusted repo is refused in words and the binary is NEVER started`, async () => {
    const repo = folder(`untrusted-${task}`);
    const marker = join(TRUST_DIR, `ran-${task}`);
    const cfg = trustConfig(`c-run-no-${task}`, {});
    const run = await withConfigDir(dirname(cfg), () => withBin(markerClaude(`claude-mark-${task}`, marker), () =>
      runToolTask(task, { cwd: repo, args: ["-p"], prompt: "p", timeoutMs: 5000, maxBuffer: 1 << 20 })));
    assert.equal(run.failed, true);
    assert.match(run.refused ?? "", /does not trust/);
    assert.equal(existsSync(marker), false, "nothing ran — so no hook of the repo's ran either");
  });

  test(`${task}: a trusted repo runs exactly as before`, async () => {
    const repo = folder(`trusted-${task}`);
    const marker = join(TRUST_DIR, `ran-ok-${task}`);
    const cfg = trustConfig(`c-run-ok-${task}`, { [repo]: { hasTrustDialogAccepted: true } });
    const run = await withConfigDir(dirname(cfg), () => withBin(markerClaude(`claude-mark-ok-${task}`, marker), () =>
      runToolTask(task, { cwd: repo, args: ["-p"], prompt: "p", timeoutMs: 5000, maxBuffer: 1 << 20 })));
    assert.equal(run.refused, undefined);
    assert.equal(run.failed, false);
    assert.equal(existsSync(marker), true);
  });
}
