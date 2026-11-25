// A screenshot into the desktop's own clipboard (hostclip.ts). macOS writes to a PRIVATE pasteboard
// here: a test never touches what the person has copied.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAC_CLIP_SCRIPT, imageToClipboard, screenshotToClipboard, windowsClipScript } from "../dist/hostclip.js";

// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("R-desktop-023: the captured file goes to the clipboard, and no file stays", async () => {
  let seen = "";
  await screenshotToClipboard(
    async (newPath) => { const p = newPath(".png"); writeFileSync(p.full, PNG); return p; },
    async (path) => { seen = path; assert.ok(existsSync(path), "still there while it is copied"); },
  );
  assert.match(seen, /shot\.png$/);
  assert.equal(existsSync(dirname(seen)), false);
});

test("a refused capture never reaches the clipboard; a refused copy still leaves no file", async () => {
  let copied = 0, dir = "";
  await assert.rejects(screenshotToClipboard(async () => { throw new Error("no picture"); }, async () => { copied++; }), /no picture/);
  assert.equal(copied, 0);
  await assert.rejects(screenshotToClipboard(
    async (newPath) => { const p = newPath(".jpg"); dir = dirname(p.full); writeFileSync(p.full, PNG); return p; },
    async () => { throw new Error("not taken"); }), /not taken/);
  assert.equal(existsSync(dir), false);
});

test("Windows: the path is quoted, the clipboard gets an image", () => {
  const s = windowsClipScript("C:\\it's\\shot.png");
  assert.ok(s.includes("FromFile('C:\\it''s\\shot.png')"));
  assert.ok(s.includes("[System.Windows.Forms.Clipboard]::SetImage($img)"));
});

test("macOS: a PNG lands on the pasteboard; an unreadable picture leaves what was there", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-clip-"));
  const name = `waterplane-test-${process.pid}`;
  const types = () => execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e",
    `ObjC.import("AppKit"); ObjC.deepUnwrap($.NSPasteboard.pasteboardWithName("${name}").types).join(" ")`], { encoding: "utf8" });
  try {
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "bad.png"), "not a picture");
    await imageToClipboard(join(dir, "shot.png"), name);
    assert.match(types(), /public\.png/);
    await assert.rejects(imageToClipboard(join(dir, "bad.png"), name), /could not be read/);
    assert.match(types(), /public\.png/);
  } finally {
    execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); $.NSPasteboard.pasteboardWithName("${name}").releaseGlobally; 1`]);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(MAC_CLIP_SCRIPT.includes("generalPasteboard"));
});
