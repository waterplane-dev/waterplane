// claude 2.1.293's first-launch trust box, answered from the phone.
//
// The box is UNNUMBERED ("❯ No, exit" / "  Yes, I trust this folder") with the
// cursor on "No, exit", and the detector read it as nothing: a new user's very
// first session sat "waiting" with no buttons, passable only with the key bar's
// arrows. Now it is published as a `nav` trust box, and a tap is a WALK — the
// host presses Down, re-reads the screen, and presses Return only once the
// cursor is on the option tapped (`sessions/boxes.ts`'s `chooseClaudeNavBox`).
//
// Against `claude-stub-tui.mjs`'s STUB_MODE=welcome + STUB_TRUST=1, which draws
// the box as the binary does (packages/host/test/fixtures/permmode/trust-box.txt).
// What this pins end to end: the box is published (trust, nav, both options in
// order), the phone's answer (`promptChoice`, as `PromptAnswer.tsx` sends for a
// nav box) walks the cursor onto "Yes" before Return, the session is let in
// (the welcome header) and the box retires.
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

const PORT = 8941;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), `${SLUG}-trustbox-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, STUB_MODE: "welcome", STUB_TRUST: "1",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

bootWait(PORT, 1500, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "trust" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    /** tmux CLIENT bytes (diff redraws), so checks read the RENDERED grid. */
    let raw = "";
    const shown = () => renderCapture(raw, 100);
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
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 100, rows: 40 }));

    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));

    check(await until(() => info?.prompt?.options?.length === 2), "the trust box is published");
    const p = info?.prompt;
    check(p?.kind === "trust", `...as a trust box (kind ${p?.kind})`);
    check(p?.nav === true, "...with no numbers: answered by a walk, never a digit");
    check(p?.options?.[0]?.label === "No, exit" && p?.options?.[1]?.label === "Yes, I trust this folder",
      `...its options in order (${JSON.stringify(p?.options?.map((o) => o.label))})`);
    check(/trust\?/.test(p?.question ?? ""), `...with the CLI's own question (${p?.question})`);
    check(info?.awaitingInput !== true, "...as buttons, not the bare 'open the CLI' signal");

    // The phone's tap on "Yes, I trust this folder": option 2 by `promptChoice`.
    const fp = promptFingerprint(p);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "", ackId: "yes-1", expectPrompt: fp, promptChoice: 2 }));
    let sawCursorOnYes = false;
    const landed = await until(async () => {
      const screen = await shown();
      if (/❯ Yes, I trust this folder/.test(screen)) sawCursorOnYes = true;
      return /Claude Code/.test(screen) && !/Accessing workspace/.test(screen);
    }, 10000);
    check(sawCursorOnYes, "the walk moved the cursor onto Yes before pressing Return");
    check(landed, "Return there let the session in (the welcome header)");
    await until(() => acks.some((a) => a.ackId === "yes-1"), 3000);
    check(acks.find((a) => a.ackId === "yes-1")?.ok === true, "the receipt says it landed");
    check(await until(() => !info?.prompt, 5000), "the answered box is retired");
    check(info?.running === true, "the session is alive — 'No, exit' was not what was pressed");

    // A PROMPT sent at a fresh session still on the trust box — what the phone does
    // when the first thing in a new repo is a message. The delivery auto-accepts the
    // box, and its keys must be a walk to Yes: the bare `1⏎` it used to press
    // answered "No, exit" on this unnumbered box, and claude quit at the first prompt
    // of every new repo. The "2" in the text is a digit too.
    const repo2 = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "trust2" }),
    }).then((r) => r.json());
    sid = null; info = null; raw = "";
    ws.send(JSON.stringify({ t: "session.create", cwd: repo2.path, cols: 100, rows: 40 }));
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    check(await until(() => info?.prompt?.kind === "trust"), "a second fresh session shows the trust box");
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "I want 2 cameras at the door", ackId: "first-1", submit: true }));
    await until(() => acks.some((a) => a.ackId === "first-1"), 30000);
    const first = acks.find((a) => a.ackId === "first-1");
    check(first?.ok === true, `a prompt into the trust box lands (${JSON.stringify(first)})`);
    check(info?.running === true, "...and the session is alive — the auto-accept did not choose 'No, exit'");
    check(/I want 2 cameras at the door/.test(await shown()), "...and the prompt ran in the session it let in");

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});
