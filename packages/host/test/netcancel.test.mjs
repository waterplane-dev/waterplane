// Which writers into a session call off a PENDING net retry (`sessions/apiretry.ts`
// `typed`). Owner decision 2026-11-18 (H3): only a person's typed prompt, a
// usage-limit wall's `continue` and a sign-in `continue` cancel it; Esc, Ctrl-U, a
// mode toggle (shift-tab) and the host's own key bookkeeping must not. Driven
// through the REAL `drive.write`/`drive.input` and `writeContinue` over a fake
// core: no PTY, no daemon. Writers enumerated (file) — all end in drive.ts:
//   person input   routes/session.ts:523 -> drive.input        (cancels)
//   deliver prompt deliver/deliverrun.ts:235,339 -> drive.write (cancels: text)
//   deliver Return deliver/deliverreturn.ts:133.. "\r"          (cancels; text came first)
//   deliver Esc    deliver/deliverrun.ts:105                    (must not)
//   deliver Ctrl-U deliver/deliverrun.ts:109                    (must not)
//   budget Esc     server/sessionEvents.ts:382                  (must not)
//   mode toggle    sessions/livemode.ts:180 shift-tab           (must not)
//   mode source keys sessions/livemode.ts:241                   (escape seq: must not)
//   box nav arrows sessions/boxes.ts:59,104 -> drive.input      (escape seq: must not)
//   limit continue sessions/wall.ts:628 via writeContinue       (cancels)
//   sign-in continue sessions/signinwait.ts:253 via writeContinue (cancels)
//   net's own continue sessions/apiretry.ts:500                 (netWriting: must not)
//   limit menu answer recover/recoverwrite.ts menu.press -> s.proc.write (bypasses typed: must not)
//   composer draft park/restore: none — the draft reader only READS the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-netcancel-"));
process.env.WATERPLANE_ROOT = root;
const { NetRetrySlice, cancelsNetRetry } = await import("../dist/sessions/apiretry.js");
const drive = await import("../dist/sessions/drive.js");
const { writeContinue } = await import("../dist/recover/recoverwrite.js");

function rig() {
  const sessions = new Map();
  let slice;
  const core = {
    sessions,
    emit() {}, loadLive: () => null, persistLive() {}, recordPrompt() {},
    setAsking() {}, setCliSuggestion() {}, setTurn() {}, armPromptCheck() {},
    netTyped: (s, data) => slice.typed(s, data),
    write: (id, data) => drive.write(core, id, data),
    input: (id, data) => drive.input(core, id, data),
  };
  slice = new NetRetrySlice(core);
  const s = {
    info: { id: "s1", title: "t", running: true, remoteControl: true, cwd: root, claudeSessionId: "c" },
    hooksActive: true, turnActive: false, lastDataAt: 0, stopCount: 0,
    proc: { write() {} },
  };
  s.info.netRetry = { state: "waiting", attempt: 1, max: 8, nextAt: Date.now() + 60_000, error: "x", at: 1 };
  sessions.set("s1", s);
  return { core, slice, s };
}
const sleep = async () => {};
const sentNoop = () => {};

const ROWS = [
  ["person input: a typed prompt (drive.input)", ({ core }) => core.input("s1", "hello\r"), true],
  ["deliver.ts: the prompt text (drive.write)", ({ core }) => core.write("s1", "do the thing"), true],
  ["deliver.ts: the submit Return", ({ core }) => core.write("s1", "\r"), true],
  ["deliver.ts: the miss sweep's Esc", ({ core }) => core.write("s1", "\x1b"), false],
  ["deliver.ts: the miss sweep's Ctrl-U", ({ core }) => core.write("s1", "\x15"), false],
  ["budget trip: the one Esc (sessionEvents)", ({ core }) => core.write("s1", "\x1b"), false],
  ["mode toggle: shift-tab (livemode)", ({ core }) => core.write("s1", "\x1b[Z"), false],
  ["box navigation: an arrow key (boxes.ts)", ({ core }) => core.input("s1", "\x1b[B"), false],
  ["focus-in report (passive input)", ({ core }) => core.input("s1", "\x1b[I"), false],
  ["usage-limit wall: the auto continue (wall.ts)", async ({ core }) => {
    await writeContinue({ sessionId: "s1", kind: "limit", detail: "t", stillOurs: () => true, write: (d) => core.write("s1", d), recordPrompt() {} }, { sleep, recordSent: sentNoop });
  }, true],
  ["sign-in wait: the continue after the tap (signinwait.ts)", async ({ core }) => {
    await writeContinue({ sessionId: "s1", kind: "auth", actor: "user", detail: "t", stillOurs: () => true, write: (d) => core.write("s1", d), recordPrompt() {} }, { sleep, recordSent: sentNoop });
  }, true],
  ["usage-limit menu answer (raw press, bypasses typed)", async ({ s }) => {
    await writeContinue({ sessionId: "s1", kind: "limit", detail: "t", stillOurs: () => false, write() {}, recordPrompt() {}, menu: { index: 2, press: (d) => s.proc.write(d) } }, { sleep, recordSent: sentNoop });
  }, false],
  ["net retry's own continue (netWriting mark, apiretry.ts)", ({ core, s }) => {
    s.netWriting = true; try { core.write("s1", "continue"); } finally { s.netWriting = false; }
  }, false],
];

for (const [name, run, cancels] of ROWS) {
  test(`${cancels ? "cancels" : "keeps"} a pending net retry: ${name}`, async (t) => {
    const r = rig();
    t.after(() => r.slice.clear(r.s));
    await run(r);
    assert.equal(r.s.info.netRetry == null, cancels);
  });
}

test("cancelsNetRetry: words and Return cancel, key sequences do not", () => {
  for (const d of ["continue", "\r", "1\r", "a", "\x1b[200~fix the bug\x1b[201~"]) assert.equal(cancelsNetRetry(d), true, JSON.stringify(d));
  for (const d of ["\x1b", "\x15", "\x1b[Z", "\x1b[A", "\x1b[C"]) assert.equal(cancelsNetRetry(d), false, JSON.stringify(d));
});
