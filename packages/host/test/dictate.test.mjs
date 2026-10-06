/**
 * Which model this desktop would use, and what it says when it has none.
 *
 * No whisper run here: the transcription itself is a binary this test cannot
 * assume, and the decisions worth pinning are the ones made BEFORE it — which
 * file is picked out of the model directory, and whether every way of having
 * no engine comes back as a sentence naming the fix rather than as a silent
 * false. The phone draws no microphone on a `false`, so a reason that says
 * nothing is a button that vanished for no visible cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictateStatus, modelPath, whisperSaid } from "../dist/dictate.js";

/** A model directory `dictateStatus` will scan, via XDG. */
function models(names) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-dictate-test-"));
  const dir = join(root, "waterplane", "models");
  writeFileSync(join(root, "marker"), "");
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), "x");
  return root;
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const CLEAR = { WATERPLANE_DICTATE: null, WATERPLANE_WHISPER_MODEL: null, XDG_DATA_HOME: null };

test("the kill switch is its own sentence, not a missing model", () => {
  const r = withEnv({ ...CLEAR, WATERPLANE_DICTATE: "0" }, dictateStatus);
  assert.equal(r.available, false);
  assert.match(r.reason, /WATERPLANE_DICTATE=0/);
});

test("a model named by hand that does not exist says so by name", () => {
  // Never fall through to a scan: a typo in the variable would then be
  // answered by transcribing with some other model, which is a wrong answer
  // wearing the right shape.
  const r = withEnv({ ...CLEAR, WATERPLANE_WHISPER_MODEL: "/nope/ggml-x.bin" }, dictateStatus);
  assert.equal(r.available, false);
  assert.match(r.reason, /\/nope\/ggml-x\.bin/);
});

test("turbo wins, and the unquantized one of those", () => {
  const root = models(["ggml-base.bin", "ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin"]);
  const p = withEnv({ ...CLEAR, XDG_DATA_HOME: root }, modelPath);
  assert.equal(p.endsWith("ggml-large-v3-turbo.bin"), true, p);
});

test("with no turbo, a model is still picked rather than none", () => {
  const root = models(["ggml-base.bin", "notes.txt"]);
  const p = withEnv({ ...CLEAR, XDG_DATA_HOME: root }, modelPath);
  assert.equal(p.endsWith("ggml-base.bin"), true, p);
});

test("an empty model directory names the directory and the fix", () => {
  const root = models([]);
  const r = withEnv({ ...CLEAR, XDG_DATA_HOME: root }, dictateStatus);
  assert.equal(r.available, false);
  assert.match(r.reason, /ggml-\*\.bin|WATERPLANE_WHISPER_MODEL/);
});

test("a transcriber that read no audio says so, without the temp path", () => {
  // The measured failure: whisper.cpp reads its audio BEFORE loading the model
  // and exits 0 when it cannot, leaving only the JSON it never wrote. The phone
  // was shown `ENOENT … /var/folders/…/myapp-dictate-rt7exu/out.json` for a
  // 61.4 s recording, after 250 ms — a path naming a directory this module was
  // about to delete. What whisper said is the answer; where we put the file is
  // not part of it.
  const said = whisperSaid([
    "read_audio_data: reading audio data from '/var/folders/7_/x/T/myapp-dictate-rt7exu/clip.wav' ...",
    "read_audio_data: failed to read audio data",
    "error: failed to read audio file '/var/folders/7_/x/T/myapp-dictate-rt7exu/clip.wav'",
  ].join("\n"));
  assert.equal(said, "failed to read audio file the clip");
  assert.doesNotMatch(said, /var\/folders|myapp-dictate|out\.json/);
});

test("what whisper names that is NOT a path survives the scrub", () => {
  // The first version replaced every quoted run, which turned the one complaint
  // that names its own cause — the language it was handed — into "unknown
  // language the clip". A sentence that scrubs away its own subject is worse
  // than the temp path it was written to remove.
  assert.equal(
    whisperSaid("whisper_lang_id: unknown language 'de-de'\nerror: unknown language 'de-de'"),
    "unknown language 'de-de'",
  );
});

test("a transcriber that said nothing at all does not invent a reason", () => {
  // Absent, not guessed: the caller names the binary instead, which is a fact.
  assert.equal(whisperSaid(""), "");
  assert.equal(whisperSaid("whisper_init: loading model\nsystem_info: METAL = 1"), "");
});

// ── whisperd first, whisper-cli when it cannot answer ─────────────────────────
//
// A fake whisperd on a loopback port: what it is sent, and what it answers, is
// the whole boundary. The CLI is made unavailable (a binary that is not on
// PATH), so an answer that could only have come from the CLI path shows up as
// that path's own "not on PATH" sentence — proof the fallback was taken.

import { createServer } from "node:http";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { keepDir, transcribe, whisperdUrl } from "../dist/dictate.js";

/** 0.5 s of 16 kHz mono PCM16 silence, with the header the phone writes. */
function wav(seconds = 0.5) {
  const n = Math.round(16000 * seconds) * 2;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

async function fakeWhisperd(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), bytes: Buffer.concat(chunks).length, origin: req.headers.origin });
      const [status, body] = reply(url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((ok) => server.close(ok)) };
}

async function withEnvAsync(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const NO_CLI = { ...CLEAR, WATERPLANE_WHISPER_BIN: "waterplane-test-no-such-whisper-cli", WATERPLANE_DICTATE_KEEP: null, WATERPLANE_WHISPERD_MODEL: null };

test("whisperd answers when it is up, with the model, language and prompt it was asked for", async () => {
  const d = await fakeWhisperd(() => [200, { text: " Öffne dictate.ts bitte.", model_file: "ggml-small.bin", heard_no_speech: false }]);
  try {
    const r = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url, WATERPLANE_WHISPERD_MODEL: "small" },
      () => transcribe(wav(), { lang: "de-DE", terms: "BA3" }));
    assert.equal(r.text, "Öffne dictate.ts bitte.");
    assert.equal(r.model, "ggml-small.bin");
    assert.equal(r.engine, "whisper.cpp");
    const [call] = d.seen;
    assert.equal(call.path, "/v1/transcribe");
    assert.equal(call.query.model, "small");
    assert.equal(call.query.lang, "de", "the BCP-47 tag is normalised before it leaves");
    assert.match(call.query.prompt, /BA3/);
    assert.equal(call.origin, undefined, "whisperd refuses requests carrying an Origin");
  } finally { await d.close(); }
});

test("whisperd that is busy or failing hands the clip to whisper-cli", async () => {
  for (const status of [503, 502, 404]) {
    const d = await fakeWhisperd(() => [status, { error: "busy" }]);
    try {
      const r = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url }, () => transcribe(wav()));
      assert.match(r.error, /not on this desktop's PATH/, `status ${status} must fall back`);
      assert.equal(d.seen.length, 1);
    } finally { await d.close(); }
  }
});

test("whisperd that is not running hands the clip to whisper-cli", async () => {
  const r = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: "http://127.0.0.1:9" }, () => transcribe(wav()));
  assert.match(r.error, /not on this desktop's PATH/);
});

test("audio whisperd cannot read is final, not retried on the CLI", async () => {
  const d = await fakeWhisperd(() => [400, { error: "bad_audio", message: "ffmpeg could not read the audio" }]);
  try {
    const r = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url }, () => transcribe(wav()));
    assert.match(r.error, /read no audio/);
    assert.doesNotMatch(r.error, /PATH/);
  } finally { await d.close(); }
});

test("whisperd's inventions are refused like the CLI's", async () => {
  for (const [text, flag] of [["Untertitelung des ZDF für funk, 2017", false], ["[Musik]", true], ["  ", false]]) {
    const d = await fakeWhisperd(() => [200, { text, heard_no_speech: flag }]);
    try {
      const r = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url }, () => transcribe(wav()));
      assert.ok("error" in r, `${JSON.stringify(text)} must not come back as words`);
    } finally { await d.close(); }
  }
});

test("off means off: WATERPLANE_WHISPERD_URL=off never makes a request", async () => {
  assert.equal(withEnv({ WATERPLANE_WHISPERD_URL: "off" }, whisperdUrl), null);
  assert.equal(withEnv({ WATERPLANE_WHISPERD_URL: null }, whisperdUrl), "http://127.0.0.1:8777");
});

test("a dictation is kept only when asked, as wav + json, outside the repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-keep-test-"));
  chmodSync(dir, 0o755); // an existing, too-open directory must be tightened
  const d = await fakeWhisperd(() => [200, { text: "Hallo Welt.", model_file: "ggml-large-v3-turbo.bin" }]);
  try {
    await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url, WATERPLANE_DICTATE_KEEP_DIR: dir }, () => transcribe(wav()));
    assert.deepEqual(readdirSync(dir), [], "nothing is kept without WATERPLANE_DICTATE_KEEP=1");
    await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url, WATERPLANE_DICTATE_KEEP_DIR: dir, WATERPLANE_DICTATE_KEEP: "1" },
      () => transcribe(wav()));
    assert.equal(statSync(dir).mode & 0o777, 0o700, "the keep dir is owner-only");
    const files = readdirSync(dir).sort();
    for (const f of files) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    assert.equal(files.length, 2);
    assert.ok(files[0].endsWith(".json") && files[1].endsWith(".wav"), files.join());
    const meta = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(meta.text, "Hallo Welt.");
    assert.equal(meta.via, "whisperd");
    assert.equal(withEnv({ WATERPLANE_DICTATE_KEEP_DIR: null, XDG_DATA_HOME: "/x" }, keepDir), "/x/waterplane/dictations");
  } finally { await d.close(); }
});

test("the doctor's dictate line counts a running whisperd as a transcriber", async () => {
  const { checkDictate } = await import("../dist/doctor.js");
  const d = await fakeWhisperd(() => [200, { ok: true }]);
  try {
    const up = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: d.url }, checkDictate);
    assert.equal(up.status, "ok");
    assert.match(up.detail, /whisperd/);
    assert.equal(up.fix, undefined);
    const down = await withEnvAsync({ ...NO_CLI, WATERPLANE_WHISPERD_URL: "http://127.0.0.1:9" }, checkDictate);
    assert.match(down.detail, /not on this desktop's PATH/);
    assert.ok(down.fix);
  } finally { await d.close(); }
});
