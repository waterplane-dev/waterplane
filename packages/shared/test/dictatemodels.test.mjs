// The dictation model table: a plain literal that deploy/install.sh.tmpl will mirror.
import test from "node:test";
import assert from "node:assert/strict";
import { DICTATE_MODELS, dictateModelUrl, dictateModelById } from "../dist/index.js";

test("every model has a 64-hex sha256, a positive size and a unique id and file", () => {
  assert.ok(DICTATE_MODELS.length >= 1);
  for (const m of DICTATE_MODELS) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(m.bytes) && m.bytes > 0);
    assert.match(m.file, /^ggml-[\w.-]+\.bin$/);
    assert.ok(m.note.length > 0);
  }
  assert.equal(new Set(DICTATE_MODELS.map((m) => m.id)).size, DICTATE_MODELS.length);
  assert.equal(new Set(DICTATE_MODELS.map((m) => m.file)).size, DICTATE_MODELS.length);
});

test("exactly one model is recommended", () => {
  assert.equal(DICTATE_MODELS.filter((m) => m.recommended).length, 1);
});

test("the url is built from the file, upstream only", () => {
  for (const m of DICTATE_MODELS) {
    assert.equal(dictateModelUrl(m), `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`);
  }
  assert.equal(dictateModelById("turbo-q8")?.file, "ggml-large-v3-turbo-q8_0.bin");
  assert.equal(dictateModelById("nope"), undefined);
});
