// Signing in from a phone — the one flow that cannot be finished inside this app.
//
// `/login` prints a 300-character OAuth URL. A terminal GRID has no soft wrap,
// so at phone width that URL is six separate rows with nothing marking them as
// one string: untappable, unselectable, and (base64, no word breaks) far too
// long to retype off a screenshot. The session read as `awaitingInput` for ever
// and the only honest advice was "go to the desk".
//
// What this pins, end to end:
//   • the host REJOINS the wrapped link and publishes it on the session, so the
//     phone has one string to hand to a browser;
//   • it says the CLI is waiting for the code, which is a different next action
//     from "open this" and is offered separately;
//   • the code goes in on the RAW path — text and Return as two writes — and
//     signs in, because the verified compose path would wait for a turn that a
//     login never starts;
//   • the link RETIRES once it is used. A stale sign-in URL opens a page that
//     refuses for no stated reason, so a button that outlives its link is worse
//     than no button.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { findUrls } from "../packages/shared/dist/urls.js";
import { renderCapture } from "../packages/host/dist/render.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8899;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), `${SLUG}-login-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, STUB_MODE: "login",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

bootWait(PORT, 1500, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "signin" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    let screen = "";
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "pty") screen += Buffer.from(m.dataB64, "base64").toString("utf8");
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

    check(await until(() => !!info?.login), "the sign-in link is published on the session");
    const url = info?.login?.url ?? "";
    check(url.startsWith("https://claude.example/oauth/authorize?"), "…as one URL, not the row it started on");
    check(url.length > 250, `…rejoined across every row the grid broke it into (${url.length} chars)`);
    check(url.endsWith("cQb7hRqDdxKqM6fnqs6N6jdsYfHWu9J0ZWwDdOxnhpw"), "…right down to its last row");
    check(info?.login?.awaitingCode === true, "the CLI is reported as waiting for the code");
    check(typeof info?.login?.at === "number", "…and the link is stamped, because a sign-in link expires");

    // The screen the phone would have had to read by hand: the link is on it in
    // full and is nowhere on it as one string.
    check(!screen.includes(url), "the link is nowhere on the raw screen as one string — which is the whole problem");
    // What the phone SEES is the rendered grid, not the byte stream: under tmux the
    // bytes are the tmux client's redraw, which positions the cursor between runs.
    const seen = await renderCapture(screen, 80);
    check(findUrls(seen.split("\n")).some((h) => h.url === url), "…and the SAME rejoin recovers it from what the phone sees");

    // The code goes in the way the login bar sends it: raw text, then Return as
    // a separate write. Not the verified compose path — a login starts no turn,
    // so that path would keep pressing Return into whatever came next.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "ABC-123-XYZ" }));
    await sleep(150);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\r" }));
    let landed = false;
    for (let i = 0; i < 80 && !landed; i++) { landed = (await renderCapture(screen, 80)).includes("LOGGED IN: ABC-123-XYZ"); if (!landed) await sleep(100); }
    check(landed, "the code lands in the sign-in input and submits");

    check(await until(() => !info?.login, 6000), "the used link is retired — a stale sign-in URL is worse than none");

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});
