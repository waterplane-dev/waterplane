/**
 * The on-device whole-picture reader: what it says when it cannot read, and how
 * it tidies what it read. No Vision or tesseract run here — the engine is a
 * binary this test cannot assume. What is pinned is the part a phone relies on:
 * every way of not reading is a SENTENCE (the phone shows it in place of the
 * verb), and the text it does return is the engine's lines, tidied, never
 * reworded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePs, isWsl, ocrInstallHint, ocrStatus, psQuote, readImageLocal, tidyOcr, windowsOcrScript, WINDOWS_OCR_LANG_HINT } from "../dist/ocrlocal.js";

test("tidyOcr trims line ends and collapses blank runs, keeps the words", () => {
  assert.equal(tidyOcr("  Error: boom  \r\n\n\n\nat foo (x.ts:1)\n\n"), "Error: boom\n\nat foo (x.ts:1)");
  assert.equal(tidyOcr("\n\n"), "");
});

test("the install hint names a remedy per platform", () => {
  assert.match(ocrInstallHint("darwin"), /xcode-select --install|brew install tesseract/);
  assert.match(ocrInstallHint("linux"), /tesseract/);
});

test("switched off is its own sentence, before any engine is probed", async () => {
  const saved = process.env.WATERPLANE_LOCAL_OCR;
  process.env.WATERPLANE_LOCAL_OCR = "0";
  try {
    const st = await ocrStatus();
    assert.equal(st.available, false);
    assert.match(st.reason, /WATERPLANE_LOCAL_OCR=0/);
    const r = await readImageLocal(Buffer.from("x"), "image/png");
    assert.ok("error" in r && /off/.test(r.error));
  } finally {
    if (saved === undefined) delete process.env.WATERPLANE_LOCAL_OCR; else process.env.WATERPLANE_LOCAL_OCR = saved;
  }
});

test("WSL is recognised from its env or its kernel string, plain Linux is not", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, ""), true);
  assert.equal(isWsl({}, "Linux version 6.6.87.2-microsoft-standard-WSL2"), true);
  assert.equal(isWsl({}, "Linux version 7.0.14-orbstack"), false);
});

test("the Windows script takes the path verbatim, quotes doubled, and fits a command line", () => {
  assert.equal(psQuote("C:\\it's"), "'C:\\it''s'");
  const s = windowsOcrScript("\\\\wsl.localhost\\Ubuntu\\tmp\\it's\\in.png");
  assert.ok(s.includes("$src = '\\\\wsl.localhost\\Ubuntu\\tmp\\it''s\\in.png'"));
  assert.ok(s.includes("IAsyncOperation`1"), "the generic name keeps PowerShell's backtick");
  // the temp copy is removed in `finally`, and no `exit` sits inside the try that would skip it
  const body = s.slice(s.indexOf("try {"));
  assert.ok(/finally \{[\s\S]*Remove-Item/.test(body));
  assert.equal((body.match(/\bexit\b/g) || []).length, 1);
  // Windows caps a command line at 32,767 chars; the encoded script is what rides on it
  assert.ok(encodePs(s).length < 16000);
  assert.equal(Buffer.from(encodePs("é"), "base64").toString("utf16le"), "é");
});

test("the no-engine sentence on WSL names interop and tesseract, not Xcode", () => {
  assert.match(ocrInstallHint("linux", true), /interop/);
  assert.match(ocrInstallHint("linux", true), /tesseract/);
  assert.doesNotMatch(ocrInstallHint("linux", true), /xcode/i);
  assert.match(WINDOWS_OCR_LANG_HINT, /language/);
});
