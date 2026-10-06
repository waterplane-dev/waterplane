/**
 * The reading rungs a backend's `sources` add (WP1c of
 * `docs/analysis/backends-design.md` §2): the reader's document, the context
 * gauge and the per-backend ledger route — each over a FAKE source installed
 * through `livesources.ts`, with no server and no CLI.
 *
 * Every case has its control beside it: with no source installed the same call
 * answers exactly what it answered before the seam existed, because "absent
 * sources ⇒ today's behaviour" is the compatibility promise the whole design
 * rests on. (Delivery and settle are pinned in `deliversubmit` and `settle`.)
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Conversation logs for the window test are written under a temp claude home.
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), "waterplane-srcrungs-"));
process.env.WATERPLANE_CLAUDE_HOME = CLAUDE_HOME;

const { setLiveSourceLookup } = await import("../dist/livesources.js");
const { getTranscript } = await import("../dist/sessions/record.js");
const { CtxSlice } = await import("../dist/sessions/ctxseries.js");
const { claudeBackend, registerBackend, unregisterBackend, primeBackendModels } = await import("../dist/backends/index.js");
const { handleApi } = await import("../dist/api.js");

/** A backend with no core reader at all — the plugin shape the rung is for. */
function fakeBackend(id, extra = {}) {
  return {
    ...claudeBackend, id, label: id,
    caps: { ...claudeBackend.caps, transcript: "none", contextMeter: false, promptBoxes: false, hooks: "none" },
    healthScope: false,
    ...extra,
  };
}

const UP = () => ({ state: "up", since: 0 });
const attach = async () => ({ close: async () => {}, health: UP });

function install(sources) {
  setLiveSourceLookup((id) => (id === "s1" ? { session: { id, cwd: "/tmp/x", spawnedAt: 0 }, sources: { attach, ...sources }, health: UP } : null));
}

/** The smallest `SessionCore` `getTranscript` reads for a session with no store reader. */
function fakeCore(session) {
  return {
    sessions: new Map([["s1", session]]),
    storeFor: () => null,
    logFor: () => null, // `ctxseries.ts`'s answer for any backend that is not claude-jsonl
    noteLogHealth: () => {},
  };
}

function liveSession(backend, history = []) {
  return { backend, history, info: { id: "s1", cwd: "/tmp/x", running: true } };
}

const DOC = {
  turns: [{ id: "t1", n: 1, prompt: "list the files", blocks: [], sentAt: 1000 }],
  truncated: false,
  bytes: 0,
  updatedAt: 5000,
};

// ── Transcript ───────────────────────────────────────────────────────────

test("a backend with no core reader gets its source's document, labelled `backend`", (t) => {
  t.after(() => setLiveSourceLookup(null));
  const core = fakeCore(liveSession(fakeBackend("fakecli")));
  assert.equal(getTranscript(core, "s1"), null, "control: no source is today's answer for such a backend");
  install({ transcript: { updatedAt: () => 5000, read: () => DOC } });
  const doc = getTranscript(core, "s1");
  assert.equal(doc.source, "backend");
  assert.equal(doc.sessionId, "s1");
  assert.deepEqual(doc.turns.map((x) => x.prompt), ["list the files"]);
  assert.equal(getTranscript(core, "s1", 5000), "unchanged", "the source's own stamp answers the poll");
  assert.notEqual(getTranscript(core, "s1", 4999), "unchanged");
});

test("a source that cannot read falls to the approximate `history` document, never a fake exact one", (t) => {
  t.after(() => setLiveSourceLookup(null));
  const hist = [{ id: "h1", kind: "prompt", text: "what changed", sentAt: 2000 }];
  const core = fakeCore(liveSession(fakeBackend("fakecli"), hist));
  install({ transcript: { updatedAt: () => null, read: () => null } });
  assert.equal(getTranscript(core, "s1").source, "history");
  install({ transcript: { updatedAt: () => { throw new Error("x"); }, read: () => { throw new Error("gone"); } } });
  assert.equal(getTranscript(core, "s1").source, "history", "a throw is the same as no answer");
});

test("a source never replaces a reader this host measured", (t) => {
  t.after(() => setLiveSourceLookup(null));
  let read = 0;
  install({ transcript: { updatedAt: () => 1, read: () => { read += 1; return DOC; } } });
  const core = fakeCore(liveSession(claudeBackend));
  // claude's jsonl path is asked (`logFor` → null here, so null overall) and the
  // source is not: `source: "backend"` is only for a backend with NO core reader.
  assert.equal(getTranscript(core, "s1"), null);
  assert.equal(read, 0);
});

// ── Context ──────────────────────────────────────────────────────────────

function ctxSession(backend, model) {
  return { backend, scrollback: "", info: { id: "s1", cwd: "/tmp/x", running: true, model } };
}
function ctxSlice() {
  const emitted = [];
  const core = { emit: (ev) => emitted.push(ev), judgeBudget: () => false, noteContextHealth: () => {} };
  return { slice: new CtxSlice(core, mkdtempSync(join(tmpdir(), "waterplane-ctx-"))), emitted };
}

test("a context source fills the gauge against the CONFIGURED window, and only that", async (t) => {
  const backend = fakeBackend("ctxcli", {
    models: async () => ({ aliases: [], ids: ["big", "zero"], contextWindow: { big: 200000, zero: 0 } }),
  });
  registerBackend(backend);
  t.after(() => { unregisterBackend("ctxcli"); setLiveSourceLookup(null); });
  await primeBackendModels();

  // Control: no source, no meter ⇒ nothing is measured and nothing is said.
  const { slice, emitted } = ctxSlice();
  const s = ctxSession(backend, "big");
  slice.checkContext(s);
  assert.equal(s.info.contextUsedTok, undefined);
  assert.equal(emitted.length, 0);

  install({ context: { sample: () => ({ at: 1, usedTok: 50000 }) } });
  slice.checkContext(s);
  assert.equal(s.info.contextUsedTok, 50000, "the source's own count, as stated");
  assert.equal(s.info.contextTotalTok, 200000, "the window is the backend's configuration for that model");
  assert.equal(s.info.contextLeft, 75);
  assert.deepEqual(emitted, ["updated"]);
  slice.checkContext(s);
  assert.equal(emitted.length, 1, "an unchanged reading is not news");

  // A model whose configured window is 0 has NO window: a used count, and no
  // percentage of anything.
  install({ context: { sample: () => ({ at: 2, usedTok: 1234, model: "zero" }) } });
  slice.checkContext(s);
  assert.equal(s.info.contextUsedTok, 1234);
  assert.equal(s.info.contextTotalTok, undefined, "a 0 is not a window");
  assert.equal(s.info.contextLeft, undefined, "and no window means no percentage — never 0%");

  // A source that cannot say leaves the ladder to the old rungs (here: none).
  install({ context: { sample: () => null } });
  const fresh = ctxSession(backend, "big");
  slice.checkContext(fresh);
  assert.equal(fresh.info.contextUsedTok, undefined);
});

// ── The window a claude-jsonl series is drawn against (claude-local) ─────
//
// A claude-jsonl session whose model is NOT claude's (the `claude-local`
// backend: the claude CLI on an Ollama model) had tokens and no window: the id
// table only knows claude's ids. The backend's own configuration is the rung
// that can answer, as `windowFrom: "config"` — and a 0 or an unknown model stays
// absent rather than borrowing claude's 200k.

const { transcriptPath } = await import("../dist/transcript.js");

function writeLog(cwd, cid, model, toks) {
  const path = transcriptPath(cwd, cid);
  mkdirSync(dirname(path), { recursive: true });
  const t0 = Date.now() - 60_000;
  writeFileSync(path, toks.map((tok, i) => JSON.stringify({
    type: "assistant", timestamp: new Date(t0 + i * 1000).toISOString(), uuid: `u${cid}${i}`,
    message: { id: `m${cid}${i}`, model, role: "assistant",
      usage: { input_tokens: 2, cache_read_input_tokens: tok - 102, cache_creation_input_tokens: 100, output_tokens: 50 } },
  })).join("\n") + "\n");
}

function seriesFor(backend, model, cid) {
  const cwd = `/tmp/waterplane-srcrungs-${cid}`;
  writeLog(cwd, cid, model, [20_000, 30_000]);
  const s = { backend, scrollback: "", info: { id: "s1", cwd, running: true, model, claudeSessionId: cid } };
  const core = {
    sessions: new Map([["s1", s]]),
    closedRow: () => undefined,
    detectClaudeId: () => cid,
    emit: () => {}, judgeBudget: () => false, noteContextHealth: () => {},
  };
  const slice = new CtxSlice(core, mkdtempSync(join(tmpdir(), "waterplane-ctx-")));
  return slice.getContextSeries("s1");
}

test("a claude-jsonl series on a non-claude model takes the BACKEND's configured window", async (t) => {
  const local = { ...claudeBackend, id: "localcli", label: "localcli",
    models: async () => ({ aliases: [], ids: ["qwen3-coder:30b", "zeroctx"], contextWindow: { "qwen3-coder:30b": 65536, zeroctx: 0 } }) };
  registerBackend(local);
  t.after(() => { unregisterBackend("localcli"); rmSync(CLAUDE_HOME, { recursive: true, force: true }); });
  await primeBackendModels();

  const doc = seriesFor(local, "qwen3-coder:30b", "c1");
  assert.equal(doc.windowTok, 65536, "the configuration states it");
  assert.equal(doc.windowFrom, "config", "and the caption is told where it came from");

  const zero = seriesFor(local, "zeroctx", "c2");
  assert.equal(zero.windowTok, null, "a 0 is not a window");
  assert.equal(zero.windowFrom, "none");

  const unknown = seriesFor(local, "mystery-model", "c3");
  assert.equal(unknown.windowTok, null, "an unconfigured model is absent — never claude's window");
  assert.equal(unknown.windowFrom, "none");

  // Control: claude's own backend on claude's model is exactly as before.
  const claude = seriesFor(claudeBackend, "claude-opus-5", "c4");
  assert.notEqual(claude.windowFrom, "config");
  assert.ok(claude.windowTok >= 200_000);
});

// ── Tokens: GET /api/tokenstats/<backendId> ──────────────────────────────

async function get(path) {
  const server = createServer((req, res) => { handleApi(req, res, {}).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test("a backend's TokenSource answers its own route; failures are sentences at 200", async (t) => {
  let asked = null;
  const ledger = {
    available: true,
    totals: { kinds: { input: 10, output: 5 }, turns: 2 },
    days: [], models: [], sessions: 1,
    unit: { name: "premium requests", perDay: { "2026-10-01": 3 } },
    firstAt: null, lastAt: null, scannedAt: 1,
  };
  registerBackend(fakeBackend("ledgercli", { sources: { attach, tokens: { ledger: async (maxAge) => { asked = maxAge; return ledger; } } } }));
  registerBackend(fakeBackend("brokencli", { sources: { attach, tokens: { ledger: async () => { throw new Error("otel file missing"); } } } }));
  registerBackend(fakeBackend("plaincli"));
  t.after(() => { unregisterBackend("ledgercli"); unregisterBackend("brokencli"); unregisterBackend("plaincli"); });

  const ok = await get("/api/tokenstats/ledgercli");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, ledger, "the backend's document, in its own unit, untouched");
  assert.ok(asked > 0, "a cached answer is allowed by default");
  await get("/api/tokenstats/ledgercli?fresh=1");
  assert.equal(asked, 0, "`fresh=1` forces a re-read");

  const broken = await get("/api/tokenstats/brokencli");
  assert.equal(broken.status, 200);
  assert.equal(broken.body.available, false);
  assert.match(broken.body.reason, /otel file missing/);

  const plain = await get("/api/tokenstats/plaincli");
  assert.equal(plain.body.available, false, "no ledger is an answer, not an error");

  const unknown = await get("/api/tokenstats/nope");
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /no backend called "nope"; this host has: claude, claude-local/);
});
