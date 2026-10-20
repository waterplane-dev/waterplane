// The tmux client's start-up terminal queries are answered by the HOST, so a
// session behaves the same whether or not a phone is attached
// (`packages/host/src/termqueries.ts`).
//
// A fresh tmux client asks its outer terminal eight questions (DA1, DA2,
// XTVERSION, OSC 10/11, the colour scheme, the size in pixels and cells).
// Unanswered, it holds a lone Esc and at ~5 s repaints the whole pane —
// which is what every scheduled, backlog, fan-out and resumed session got,
// because those run with the phone off. With a phone attached its xterm.js
// answered some of them as typed input. Three cases:
//
//  1. NO PHONE: a session left alone draws no full repaint at the 5 s mark.
//     Seen by an observer that attaches 2.5 s in and never sends a byte, so the
//     tmux client is as unattended as a scheduled session's.
//  2. NO PHONE: an Esc sent ~1 s after start reaches the CLI at once (a client
//     still waiting on its queries holds it ~0.5 s).
//  3. A FAKE PHONE attached from the first byte, answering every query it sees
//     the way xterm.js would: it sees none, so nothing is typed on its behalf,
//     and none of the host's own replies leaks into the pane as text.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERIES = ["\x1b[c", "\x1b[>c", "\x1b[>q", "\x1b]10;?", "\x1b]11;?", "\x1b[?996n", "\x1b[14t", "\x1b[18t"];
// What any of the answers would look like typed into the pane.
const REPLY_BITS = ["[?1;2c", "[>0;276;0c", ">|xterm", "rgb:", "997;", "[8;", "[4;"];

const scratch = mkdtempSync(join(tmpdir(), `${SLUG}-termq-`));
const log = join(scratch, "stub-input.log");
writeFileSync(log, "");
const keys = () => { try { return readFileSync(log, "utf8").split("/usage\r").join(""); } catch { return ""; } };

const h = await bootHost({
  tag: "termq",
  env: { [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs", [E.IDLE_MS]: "1000", STUB_MODE: "menu", STUB_LOG: log },
});
try {
  const repo = await fetch(`${h.base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tq" }),
  }).then((r) => r.json());

  /** One socket. `phone` says whether it plays the phone: a socket that
   *  creates a session is attached to it, so a phone-less one detaches at once
   *  and never answers anything. */
  const socket = async (phone) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    const st = { ws, id: null, raw: "", frames: [], idle: [], answered: 0 };
    ws.on("message", (b) => {
      const m = JSON.parse(b.toString());
      if (m.t === "session.created" && !st.id) {
        st.id = m.session.id;
        if (!phone) ws.send(JSON.stringify({ t: "session.detach", id: st.id }));
      }
      if (m.t === "session.updated" && m.session.id === st.id) st.idle.push([Date.now(), !!m.session.idle]);
      if (m.t === "pty" && m.id === st.id && phone) {
        const s = Buffer.from(m.dataB64, "base64").toString("utf8");
        st.raw += s;
        // Play xterm.js: answer what a phone would. If the host stripped the
        // queries there is nothing to answer, and this never fires.
        for (const q of QUERIES) {
          if (s.includes(q)) { st.answered++; ws.send(JSON.stringify({ t: "session.input", id: st.id, data: q === "\x1b[c" ? "\x1b[?1;2c" : "\x1b[>0;276;0c" })); }
        }
      }
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    return st;
  };

  // ── 1. no phone: no full repaint at the client's 5 s timeout ───────────────
  {
    const a = await socket(false);
    const t0 = Date.now();
    a.ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "quiet", cols: 80, rows: 24 }));
    for (let i = 0; i < 60 && !a.id; i++) await sleep(100);
    check(!!a.id, "a session opened with no phone attached");
    await sleep(2500);
    // Nobody has typed, resized or answered anything. To SEE what the client
    // draws next, an observer attaches now — passively: it sends nothing, so
    // the tmux client is exactly as unattended as before.
    const frames = [];
    const ob = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    // The attach's own replay (`full`) is the screen so far, not something the
    // client drew: under the loaded pre-push run the observer attached past
    // 4.5 s and its replay (`ESC[?1049h` and every row) read as the repaint.
    ob.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.t === "pty" && m.id === a.id && !m.full) frames.push([Date.now(), Buffer.from(m.dataB64, "base64").toString("utf8")]); });
    await new Promise((r) => ob.on("open", r));
    ob.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ob.send(JSON.stringify({ t: "session.attach", id: a.id }));
    await sleep(Math.max(0, t0 + 8000 - Date.now()));
    const firstIdle = a.idle.find(([, idle]) => idle);
    check(!!firstIdle, `it went idle (output stopped) — ${firstIdle ? firstIdle[0] - t0 : "never"} ms after create`);
    // What tmux 3.6 still draws when its query timer fires, answered or not, is
    // a cursor reset (`ESC[?25l ESC[?12l ESC[?25h`, 18 bytes). What it drew
    // UNANSWERED was the whole pane again: row after row of `ESC[K`.
    const late = frames.filter(([at]) => at > t0 + 4500).map(([, s]) => s).join("");
    check(late.length < 64 && !late.includes("\x1b[K"), late.length < 64 && !late.includes("\x1b[K")
      ? `no full repaint around the 5 s mark (${late.length} bytes after 4.5 s${late ? ": " + JSON.stringify(late) : ""})`
      : `FULL REPAINT: ${late.length} bytes after 4.5 s with nobody typing: ${JSON.stringify(late.slice(0, 120))}`);
    ob.close();
    a.ws.close();
  }

  // ── 2. no phone: an Esc is not held ─────────────────────────────────────────
  {
    const b = await socket(false);
    b.ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "esc", cols: 80, rows: 24 }));
    for (let i = 0; i < 60 && !b.id; i++) await sleep(100);
    await sleep(1000);
    const before = keys().split("\x1b").length;
    const sent = Date.now();
    b.ws.send(JSON.stringify({ t: "session.input", id: b.id, data: "\x1b" }));
    let at = 0;
    for (let i = 0; i < 80 && !at; i++) { if (keys().split("\x1b").length > before) at = Date.now(); else await sleep(50); }
    check(at > 0 && at - sent < 400, `an Esc reaches the CLI promptly (${at ? at - sent + " ms" : "never"}; held by the waiting client it took ~600 ms)`);
    b.ws.close();
  }

  // ── 3. a phone attached from the start sees no query, types no reply ────────
  {
    const before = keys();
    const c = await socket(true);
    c.ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "phone", cols: 80, rows: 24 }));
    for (let i = 0; i < 60 && !c.id; i++) await sleep(100);
    await sleep(3000);
    c.ws.send(JSON.stringify({ t: "session.resize", id: c.id, cols: 100, rows: 30 })); // tmux asks the size again
    await sleep(1500);
    check(c.raw.length > 0, `the phone received the session's output (${c.raw.length} chars)`);
    const leaked = QUERIES.filter((q) => c.raw.includes(q));
    check(leaked.length === 0, `no terminal query reached the phone (${leaked.map((q) => JSON.stringify(q)).join(" ") || "none"})`);
    check(c.answered === 0, "…so the phone's terminal answered nothing");
    const typed = keys().slice(before.length);
    const bits = REPLY_BITS.filter((b) => typed.includes(b));
    check(bits.length === 0, `no reply was typed into the pane as text (${bits.join(" ") || "none"})`);
    c.ws.close();
  }
} finally {
  await h.stop();
}
process.exit(failed ? 1 : 0);
