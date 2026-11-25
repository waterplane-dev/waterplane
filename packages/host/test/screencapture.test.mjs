// The screenshot's two ways (`host.ts`'s `captureDesktop`): the core's own tool, then a contributed
// capture (`api.screenCapture`) when that is refused. R-desktop-022. No screen is read: the native
// tool is a fake here.
//     node --test packages/host/test/screencapture.test.mjs   (after the host build)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureDesktop, registerScreenCapture, screenshotProblem } = await import("../dist/host.js");
const WORK = mkdtempSync(join(tmpdir(), "wp-shot-"));
after(() => rmSync(WORK, { recursive: true, force: true }));
let n = 0;
const paths = () => { const stem = join(WORK, `s${n++}`); return (ext) => ({ full: stem + ext, name: ext }); };
const refused = async () => { throw new Error("Command failed: screencapture -x /x/y.png\ncould not create image from display"); };
const still = (r) => ({ still: async () => r });

test("the core's own tool first: its PNG is kept and no helper is asked", async () => {
  let asked = 0;
  const off = registerScreenCapture("helper", { still: async () => { asked++; return { note: "no" }; } });
  const d = await captureDesktop(paths(), async (p) => writeFileSync(p, "png"));
  off();
  assert.equal(d.name, ".png");
  assert.equal(asked, 0);
});

test("refused: the contributed capture's JPEG is the file, the next one when the first has none", async () => {
  const offA = registerScreenCapture("a", { still: async () => { throw new Error("boom"); } });
  const offB = registerScreenCapture("b", still({ jpeg: Buffer.from("jpeg") }));
  const d = await captureDesktop(paths(), refused);
  offA(); offB();
  assert.equal(d.name, ".jpg");
  assert.equal(readFileSync(d.full, "utf8"), "jpeg");
  assert.equal(existsSync(d.full.replace(/jpg$/, "png")), false);
});

test("both refused: one sentence with every reason, and a switched-off capture is not asked", async () => {
  registerScreenCapture("gone", still({ jpeg: Buffer.from("x") }))();
  const off = registerScreenCapture("a", still({ note: "Not granted to wp-desktop." }));
  await assert.rejects(captureDesktop(paths(), refused), (e) => /could not create|no picture of the screen|screencapture/.test(e.message) && e.message.endsWith("Not granted to wp-desktop."));
  off();
});

test("macOS's refusal is said for a person, as the usual reason; anything else stays as it was", () => {
  const err = new Error("Command failed: screencapture -x /x/y.png\ncould not create image from display");
  const s = screenshotProblem(err, "darwin", "/no/such/node");
  assert.match(s, /usual reason: Screen Recording is not granted to this node \(\/no\/such\/node\)/);
  assert.doesNotMatch(s, /Command failed/);
  assert.equal(screenshotProblem(new Error("disk full"), "darwin"), "disk full");
  assert.match(screenshotProblem(err, "linux"), /Command failed/);
});

test("a bad or taken name, or no still(), is refused", () => {
  assert.throws(() => registerScreenCapture("Bad Name", still({ note: "" })), /short lowercase word/);
  assert.throws(() => registerScreenCapture("x", {}), /no still\(\)/);
  const off = registerScreenCapture("x", still({ note: "" }));
  assert.throws(() => registerScreenCapture("x", still({ note: "" })), /already exists/);
  off();
});
