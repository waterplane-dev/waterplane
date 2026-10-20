// Resumable PTY replay: a reconnecting client that passes `resumeSeq` gets ONLY
// the delta since it last saw, not the whole scrollback — the mechanism that
// makes a mobile wake/reconnect a near-invisible append instead of a full redraw.
// Also asserts a fresh attach (no resumeSeq) still gets a flagged FULL replay.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8792;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-resume-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARK_A = "MARK_ALPHA";
const MARK_B = "MARK_BRAVO";
// Typed as `printf 'MARK_%s\n' ALPHA`: the shell's echo of the typed line never
// holds the mark, so seeing it means the COMMAND RAN — not that tmux echoed
// the keystrokes, which a loaded machine can do long before the output.
const emit = (word) => `printf 'MARK_%s\\n' ${word}\r`;

// Every wait is on the condition itself, never a fixed sleep: in a ten-script
// parallel suite a 500 ms sleep elapsed before the shell had printed MARK_B,
// and the delta replay (correctly) did not hold it yet. The deadline is sized
// for a loaded machine; the watchdog still catches a real hang.
const DEADLINE_MS = 15_000;
async function until(what, ok) {
  const end = Date.now() + DEADLINE_MS;
  while (!ok()) {
    if (Date.now() > end) fail(`timed out after ${DEADLINE_MS} ms waiting for ${what}`);
    await sleep(25);
  }
}

bootWait(PORT, 800, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "resume" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));

  let sid = null;
  let lastSeq = 0;           // client's high-water mark (as the app tracks it)
  let capture = "";          // pty text for the CURRENT phase
  let phase = "boot";
  const frames = [];         // { seq, full } of pty frames in the current phase

  let bootId = null;
  let histories = 0;         // session.history follows an attach's replay frame on the same socket
  const onPty = (m) => { if (m.id !== sid) return; capture += b64(m.dataB64); frames.push({ seq: m.seq, full: !!m.full }); if (m.seq != null) lastSeq = m.seq; };

  // A second client attached the whole time: the witness that MARK_B reached
  // the host's stream while the client under test is detached.
  let observed = "";
  const observer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  observer.on("error", (e) => fail("observer ws error " + e.message));
  observer.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "pty" && m.id === sid) observed += b64(m.dataB64);
  });
  const observerUp = new Promise((r) => observer.on("message", (raw) => { if (JSON.parse(raw.toString()).t === "welcome") r(); }));
  observer.on("open", () => observer.send(JSON.stringify({ t: "hello", protocol: 1 })));

  // Attach and wait for its replay to have ARRIVED: the host sends the pty
  // frame (when there is one) and then session.history, in order.
  async function attach(msg, what) {
    const before = histories;
    send({ t: "session.attach", id: sid, ...msg });
    await until(`the ${what} attach's replay`, () => histories > before);
  }

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("error", (e) => fail("ws error " + e.message));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      bootId = m.bootId;
      if (!bootId) fail("welcome carried no bootId (the resume point's validity stamp)");
      send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 });
      return;
    }
    if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      await runScript();
      return;
    }
    if (m.t === "pty") onPty(m);
    if (m.t === "session.history" && m.id === sid) histories++;
  });

  async function runScript() {
    await observerUp;
    observer.send(JSON.stringify({ t: "session.attach", id: sid }));

    // 1) Produce MARK_A, wait for it to stream, snapshot the seq the client would remember.
    send({ t: "session.input", id: sid, data: emit("ALPHA") });
    await until("MARK_A to stream while attached", () => capture.includes(MARK_A));
    const seqAtDetach = lastSeq;
    if (!seqAtDetach) fail("no seq carried on live PTY frames");
    console.log("seq at detach:", seqAtDetach);

    // 2) Detach (reconnect/background), then produce MARK_B while not streaming.
    send({ t: "session.detach", id: sid });
    await sleep(150);
    phase = "detached"; capture = ""; frames.length = 0;
    send({ t: "session.input", id: sid, data: emit("BRAVO") });
    await until("the observer to see MARK_B (it is in the host's stream)", () => observed.includes(MARK_B));
    await sleep(150); // a frame the host sent us anyway would have landed by now
    if (capture.includes(MARK_B)) fail("received PTY while detached — detach not honored");

    // 3) Re-attach WITH resumeSeq → expect only the delta (MARK_B), NOT MARK_A,
    //    and the replay frame flagged full:false.
    phase = "resume"; capture = ""; frames.length = 0;
    await attach({ resumeSeq: seqAtDetach }, "resume");
    if (!capture.includes(MARK_B)) fail("delta replay missing MARK_B (new output since resumeSeq)");
    if (capture.includes(MARK_A)) fail("delta replay re-sent MARK_A — resume streamed the whole scrollback, not the delta");
    const replay = frames.find((f) => f.seq != null);
    if (!replay || replay.full !== false) fail("resume replay should be flagged full:false (a delta), got: " + JSON.stringify(frames));
    console.log("PASS(resume): delta-only replay, MARK_B present, MARK_A absent, full=false");

    // 4) Fresh attach WITHOUT resumeSeq → full replay (flagged), includes MARK_A.
    send({ t: "session.detach", id: sid });
    await sleep(150);
    phase = "full"; capture = ""; frames.length = 0;
    await attach({}, "fresh");
    if (!frames.some((f) => f.full === true)) fail("fresh attach should send a full-flagged replay, got: " + JSON.stringify(frames));
    if (!capture.includes(MARK_A)) fail("full replay missing MARK_A (whole scrollback expected)");
    console.log("PASS(full): fresh attach got a full replay including MARK_A");

    // 5) A resume point stamped with a FOREIGN boot id is refused: a tmux session
    //    outlives the daemon and is re-registered with seq 0, so a seq persisted
    //    by the phone across a restart can land inside the new stream's window and
    //    stitch a delta out of bytes that no longer exist. Same seq as step 3 —
    //    only the boot stamp differs — so a full replay here proves the guard,
    //    not the seq.
    send({ t: "session.detach", id: sid });
    await sleep(150);
    phase = "boot"; capture = ""; frames.length = 0;
    await attach({ resumeSeq: seqAtDetach, resumeBoot: "not-this-boot" }, "foreign-boot");
    if (!frames.some((f) => f.full === true)) fail("attach with a foreign resumeBoot must fall back to a FULL replay, got: " + JSON.stringify(frames));
    if (!capture.includes(MARK_A)) fail("boot-mismatch replay should carry the whole scrollback (MARK_A)");
    console.log("PASS(boot): a resume point from another host boot is refused, full replay instead");

    // …and the CURRENT boot id still resumes as a delta, so the guard isn't just
    // refusing everything.
    send({ t: "session.detach", id: sid });
    await sleep(150);
    phase = "boot-ok"; capture = ""; frames.length = 0;
    await attach({ resumeSeq: lastSeq, resumeBoot: bootId }, "this-boot");
    if (frames.some((f) => f.full === true)) fail("attach with THIS boot's id should still be a delta, got: " + JSON.stringify(frames));
    console.log("PASS(boot): the live boot id still gets a delta replay");

    send({ t: "session.kill", id: sid });
    console.log("PASS: resumable replay verified");
    observer.close();
    host.kill();
    process.exit(0);
  }
});

watchdog(() => fail("timeout"));
