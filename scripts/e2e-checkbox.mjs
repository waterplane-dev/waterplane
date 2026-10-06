// The Submit button of a MULTI-SELECT box, which is not a keystroke.
//
// An `AskUserQuestion` checkbox box is answered by ticking rows and then
// pressing Return on an unnumbered "Submit" row. Return anywhere else TOGGLES
// whatever the cursor is sitting on — and the cursor starts on option 1 and does
// not follow a digit. So the phone's Submit button, which sent a bare "\r",
// did the one thing it must never do: it re-toggled option 1 and left the box
// open. The tap looked like it worked and the session stayed blocked.
//
// The fix is host-side by necessity: where the cursor is can only be read off
// the rendered screen, and the arrow keys the client would otherwise need are
// the undurable raw-keystroke path (a Down delivered on reconnect moves a
// selection in a screen nobody is watching).
//
// What this pins, end to end: the trap is real (a bare Return does not submit),
// `promptSubmit` walks the cursor onto Submit, and the SET that is submitted is
// the one that was ticked — not the one Return happened to flip on its way past.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { promptFingerprint } from "../packages/shared/dist/promptid.js";
import { renderCapture } from "../packages/host/dist/render.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8881;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), `${SLUG}-checkbox-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, STUB_MODE: "checkbox",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

bootWait(PORT, 1500, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "box" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    /** Everything the terminal has been sent. Under tmux these are the tmux
     *  CLIENT's bytes — a diff redraw that rewrites only the cells that changed —
     *  so a check reads the RENDERED grid (`shown()`), never the raw stream. */
    let raw = "";
    const shown = () => renderCapture(raw, 80);
    const acks = [];
    ws.on("message", (frame) => {
      const m = JSON.parse(frame.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "pty") raw += Buffer.from(m.dataB64, "base64").toString("utf8");
      if (m.t === "input.ack") acks.push(m);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 40 }));

    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));

    check(await until(() => !!info?.prompt), "the checkbox box is published");
    check(info?.prompt?.multi === true, "...and is published as a MULTI-select (a digit toggles, it does not answer)");
    // The WHOLE box, trailing "Chat about this" row included, before its
    // fingerprint is taken: under tmux the first read can land on a frame the
    // client has not finished drawing, and the complete box re-published a
    // moment later is a different question — an answer naming the first one is
    // then (rightly) refused stale.
    await until(() => info?.prompt?.options?.some((o) => /Chat about this/.test(o.label)));
    const fp = promptFingerprint(info.prompt);

    // 1. The trap itself. A bare Return, exactly what the Submit button used to
    //    send, with the cursor where the box left it.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\r" }));
    await sleep(600);
    let screen = await shown();
    check(!screen.includes("SUBMITTED"), "a bare Return does not submit the box");
    check(/1\. \[✓\]/.test(screen), "...it toggles the row under the cursor — which is option 1");

    // 2. Undo that, then tick the option the user actually wants. A digit is the
    //    answer path for a checkbox row (App sends it without a Return).
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "1", ackId: "tick-1", expectPrompt: fp }));
    await sleep(400);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "2", ackId: "tick-2", expectPrompt: fp }));
    await sleep(400);   // the grid is the whole box as it stands now
    screen = await shown();
    check(/1\. \[ \]/.test(screen) && /2\. \[✓\]/.test(screen), "the digits left exactly option 2 ticked");

    // 3. Submit, the way the phone's button does it now.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\r", ackId: "submit-1", expectPrompt: fp, promptSubmit: true }));
    let done = false;
    for (let i = 0; i < 80 && !done; i++) { screen = await shown(); done = screen.includes("SUBMITTED"); if (!done) await sleep(100); }
    check(done, "the box is submitted");
    check(/SUBMITTED: 2\b/.test(screen), "...with the set that was TICKED, not one Return flipped on the way");
    const ack = acks.find((a) => a.ackId === "submit-1");
    check(ack?.ok === true, "the receipt waits for the walk and reports it landed");

    // 4. The box is gone, so the same answer must be refused rather than typed
    //    at whatever replaced it — the ordinary staleness rule, still applied to
    //    an answer that is an ACTION.
    check(await until(() => !info?.prompt, 4000), "the answered box is retired");
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\r", ackId: "submit-2", expectPrompt: fp, promptSubmit: true }));
    await until(() => acks.some((a) => a.ackId === "submit-2"), 3000);
    const stale = acks.find((a) => a.ackId === "submit-2");
    check(stale?.ok === false && stale?.state === "stale", "a Submit for a box that is gone is refused, not pressed");

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});
