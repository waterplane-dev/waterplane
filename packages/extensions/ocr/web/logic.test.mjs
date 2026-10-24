import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cleanText, downloadError, keptLine, MAX_CHARS, parseManifest, progressLine, readyLine, sha256Hex, sha256HexSync, wantedFiles, wordsOf } from "./logic.ts";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const H = "a".repeat(64);
const MANIFEST = {
  format: 1,
  files: [
    { file: "worker.min.js", role: "worker", bytes: 10, sha256: H },
    { file: "core-simd.wasm.js", role: "core-simd", bytes: 30, sha256: H },
    { file: "core.wasm.js", role: "core", bytes: 31, sha256: H },
    { file: "eng.traineddata.gz", role: "lang", lang: "eng", name: "English", bytes: 20, sha256: H },
    { file: "deu.traineddata.gz", role: "lang", lang: "deu", name: "German", bytes: 15, sha256: H },
  ],
};

test("the plain-JS sha256 agrees with node's at every padding edge", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(sha256HexSync(b), sha(b), `length ${n}`);
  }
});

test("sha256Hex answers the same with or without crypto.subtle", async () => {
  const b = new Uint8Array(randomBytes(4097));
  assert.equal(await sha256Hex(b), sha(b));
});

test("a manifest this build cannot use is refused whole, never half-trusted", () => {
  assert.ok(parseManifest(MANIFEST));
  assert.equal(parseManifest({ ...MANIFEST, format: 2 }), null);
  assert.equal(parseManifest(null), null);
  const bad = (patch, i = 0) => ({ ...MANIFEST, files: MANIFEST.files.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  assert.equal(parseManifest(bad({ file: "../x" })), null, "a path is not a flat name");
  assert.equal(parseManifest(bad({ sha256: "zz" })), null);
  assert.equal(parseManifest(bad({ bytes: 0 })), null);
  assert.equal(parseManifest(bad({ role: "ui" })), null, "only engine roles");
  assert.equal(parseManifest(bad({ lang: undefined }, 3)), null, "a language names itself");
  assert.equal(parseManifest({ ...MANIFEST, files: MANIFEST.files.filter((f) => f.role !== "lang") }), null, "no language, no reader");
});

test("a phone downloads ONE core: SIMD where it runs, else the plain one", () => {
  const m = parseManifest(MANIFEST);
  assert.deepEqual(wantedFiles(m, true).map((f) => f.file), ["worker.min.js", "core-simd.wasm.js", "eng.traineddata.gz", "deu.traineddata.gz"]);
  assert.deepEqual(wantedFiles(m, false).map((f) => f.file), ["worker.min.js", "core.wasm.js", "eng.traineddata.gz", "deu.traineddata.gz"]);
  const noSimd = parseManifest({ ...MANIFEST, files: MANIFEST.files.filter((f) => f.role !== "core-simd") });
  assert.ok(wantedFiles(noSimd, true).some((f) => f.file === "core.wasm.js"), "a folder without the SIMD build still works");
});

test("the row's sentences", () => {
  assert.equal(progressLine(2, 5, 3_100_000, 7_400_000), "Downloading 2 of 5 · 3.1 of 7.4 MB");
  assert.equal(readyLine(["English", "German"], 8_296_754), "Ready · English + German · 8.3 MB, works offline");
  assert.match(keptLine(8_296_754), /8\.3 MB/);
  assert.equal(downloadError(null, null), "The desktop could not be reached to download the reader.");
  assert.equal(downloadError(403, "Text in marks is turned off"), "The desktop refused the download: Text in marks is turned off.");
  assert.match(downloadError(500, null), /500/);
});

test("the reading: confident words only, flattened, capped, null when nothing", () => {
  const blocks = [{ paragraphs: [{ lines: [
    { words: [{ text: "Hello", confidence: 95 }, { text: "%$", confidence: 30 }, { text: "World", confidence: 88 }] },
    { words: [{ text: "  new\nline ", confidence: 70 }, { text: "—", confidence: 99 }] },
  ] }] }];
  assert.equal(cleanText(wordsOf(blocks)), "Hello World new line", "low confidence and pure punctuation dropped, whitespace flattened");
  assert.equal(cleanText(wordsOf(null)), null);
  assert.equal(cleanText(wordsOf([{ paragraphs: [{ lines: [{ words: [{ text: "x", confidence: 10 }] }] }] }])), null, "nothing confident is null, not a guess");
  const long = Array.from({ length: 80 }, (_, i) => ({ text: `word${i}`, confidence: 90 }));
  const s = cleanText(long);
  assert.ok(s.length <= MAX_CHARS + 1 && s.endsWith("…"), s);
  assert.ok(s.split(" ").slice(0, -1).every((w) => /^word\d+$/.test(w)));
});
