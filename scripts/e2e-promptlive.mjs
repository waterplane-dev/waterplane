// A choice box that is BEING REDRAWN must stay published.
//
// The TUI does not go quiet while it waits on a dialog: it keeps repainting its
// working line under the box, roughly once a second. Prompt state used to be
// dropped on every byte of output and only rebuilt after 600 ms of quiet, so a
// live box blinked in and out — on the phone the answer panel appeared for a
// fraction of a second at a time, too briefly to read and impossible to tap.
//
// The rule this pins: only the verifier (the strict re-detect against the
// rendered screen) may retire a prompt. Output alone never does — and the check
// still runs under a repaint stream, so a box that really goes away still
// clears.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

const PORT = 8813;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-promptlive-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    /** Every published prompt state, in order — this is what the phone sees. */
    const seen = [];
    /** …and the OPTIONS of each, which is the half of a box's identity a
     *  repaint has no excuse to move. */
    const fps = new Set();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) {
        info = m.session;
        seen.push(!!m.session.prompt);
        if (m.session.prompt) fps.add(JSON.stringify(m.session.prompt.options));
      }
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));

    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    await sleep(300);

    // The FIRST box of a session, painted in CHUNKS — the way tmux hands its
    // client a screen. The first chunk after a quiet spell ends mid-label
    // ("2. Yes, and don't a"), the rest lands 100 ms later: well inside the
    // quiet window, so nothing that waited for the screen to settle would
    // read the half. The check fired on that first chunk anyway (the debounce
    // ceiling had long expired over the quiet spell), published two options
    // and a cut label, and `mergeBox` — which never rewrites a published
    // label — kept the cut label for the life of the box.
    {
      const published = [];
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "session.updated" && m.session.id === sid && m.session.prompt) published.push(m.session.prompt);
      };
      ws.on("message", onMsg);
      const HEAD = "Do you want to make this edit?\\n\\xe2\\x9d\\xaf 1. Yes\\n  2. Yes, and don\\x27t a";
      const REST = "sk again this session\\n  3. No\\n\\nEnter to confirm \\xc2\\xb7 Esc to cancel\\n";
      // Typed now, painted after 2 s of quiet: the command's own echo is not the chunk under test.
      ws.send(JSON.stringify({ t: "session.input", id: sid,
        data: `clear; sleep 2; printf '${HEAD}'; sleep 0.1; printf '${REST}'\r` }));
      const full = await until(() => published.some((p) => p.options.length === 3), 8000);
      await sleep(1500);
      ws.off("message", onMsg);
      const LABELS = JSON.stringify(["Yes", "Yes, and don't ask again this session", "No"]);
      check(full, "a box painted in chunks is published");
      const wrong = published.filter((p) => JSON.stringify(p.options.map((o) => o.label)) !== LABELS);
      check(wrong.length === 0,
        `…and never before it was whole: every published state has all three labels in full (wrong: ${JSON.stringify(wrong.map((p) => p.options.map((o) => o.label)))})`);
      ws.send(JSON.stringify({ t: "session.input", id: sid, data: "clear\r" }));
      check(await until(() => !info?.prompt, 6000), "…and it retires when it leaves the screen");
    }

    // A box, then the same box redrawn every 300 ms for ~4 s: shorter than the
    // quiet window the old debounce waited for, which is the whole point.
    const BOX = "Do you want to proceed?\\n1. Yes\\n2. No\\nEsc to cancel\\n";
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: `printf '${BOX}'\r` }));
    check(await until(() => !!info?.prompt), "the box is published while the screen is quiet");

    seen.length = 0;
    fps.clear();
    ws.send(JSON.stringify({ t: "session.input", id: sid,
      data: `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '${BOX}'; sleep 0.3; done\r` }));
    // Sample the published state across the repaint stream.
    let sawNull = 0;
    for (let i = 0; i < 40; i++) { if (!info?.prompt) sawNull++; await sleep(100); }

    check(sawNull === 0, `the box stays published for every sample while it is redrawn (null samples: ${sawNull})`);
    check(!seen.includes(false), "…and no update in that window ever published a null prompt");
    check(!!info?.prompt && info.prompt.options.length === 2, "the box that survived is the box, options intact");
    // Staying published is not enough: it has to stay the SAME box. The phone's
    // card is keyed on `promptFingerprint`, so a re-publish under a new id
    // re-opens a card somebody collapsed or hid in order to answer at the desk,
    // makes an answer already queued against it read as stale, and fires a
    // push. That is the "it redraws itself whenever the console refreshes"
    // report.
    //
    // The OPTIONS are what is pinned here, not the whole fingerprint. The
    // scraped QUESTION is up to four lines joined from above option 1, and on a
    // screen that scrolls those lines are whatever happens to be there — this
    // very stub publishes the same box's question three ways in four seconds
    // ("1. Yes 2. No bash-3.2$ for i in …"). A real `AskUserQuestion` is held
    // together by `askId` instead, which the CLI mints and no repaint can move;
    // a shell stub has no such call and falls to the conservative rule, which
    // would rather publish a new box than put the wrong question over live
    // buttons (`prompt.ts`'s `sameBox`).
    check(fps.size === 1, `the options never move under the repaint stream (distinct: ${fps.size})`);

    // A capture taken MID-REPAINT is a half-drawn box: the strict re-detect
    // fails on it even though the dialog is plainly still up. Publishing null
    // there is what made the panel blink even after output stopped clearing it.
    // Simulated by leaving only the footer on screen: a dialog is evidently
    // open, nothing parses.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "clear; printf 'Enter to confirm  Esc to cancel\\n'\r" }));
    await sleep(1500);
    check(!!info?.prompt, "a strict parse that fails while a dialog footer is still up KEEPS the published box");

    // …but not for ever: a box that never parses again runs the miss counter
    // out and falls back to the weaker "a dialog is open in the CLI" signal.
    check(await until(() => !info?.prompt && info?.awaitingInput, 12000),
      "…and after the misses run out it degrades to awaitingInput, never sticks");

    // The other half: a box that really leaves the screen still clears, even
    // though output no longer clears anything by itself.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: `printf '${BOX}'\r` }));
    check(await until(() => !!info?.prompt, 6000), "the box comes back when it is on screen again");
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "clear\r" }));
    check(await until(() => !info?.prompt, 4000), "a box that leaves the rendered screen is retired");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 150);
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
