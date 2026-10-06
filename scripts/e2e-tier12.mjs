// Tier 1/2: prompt detection, rename, recent, push key endpoint, upload cap.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { detectPrompt } from "../packages/host/dist/prompt.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

// ── unit: what is and is not a choice prompt ─────────────────────────
const uassert = (cond, m) => { if (!cond) { console.error("FAIL (unit):", m); process.exit(1); } };

const real = detectPrompt("Do you want to proceed?\n\u276f 1. Yes\n  2. No, tell Claude what to do differently\nEnter to confirm \u00b7 Esc to cancel\n");
uassert(real && real.options.length === 2 && real.options[0].label === "Yes", "real choice box detected");

// A numbered list in the assistant's own prose has no selection cursor and no
// footer. It used to surface as a phantom approve bar that flickered in and out.
uassert(!detectPrompt([
  "My recommendation:",
  "1. Now: prove the tttool round-trip on the smallest book.",
  "2. Then: the CLI pipeline on the Mac, resumable.",
  "3. Then, if it's repeat business: the Tailscale service.",
  "Want me to start on step 1?",
].join("\n")), "prose numbered list is not a prompt");

// Same list inside a markdown blockquote: ">" is NOT a selection cursor.
uassert(!detectPrompt([
  "My recommendation:",
  "> 1. Now: prove the tttool round-trip on the smallest book.",
  "> 2. Then: the CLI pipeline on the Mac, resumable.",
  "> 3. Then, if it's repeat business: the Tailscale service.",
].join("\n")), "blockquoted numbered list is not a prompt");

// An ASCII-cursor box still parses as options — the footer carries it.
const ascii = detectPrompt("Do you want to proceed?\n> 1. Yes\n  2. No\nEnter to confirm \u00b7 Esc to cancel\n");
uassert(ascii && ascii.options.length === 2 && ascii.options[0].label === "Yes", "ascii-cursor choice box still detected");

// Charset designators (ESC ( B) are not CSI — an ANSI strip that misses them
// leaves "(B" glued to the label text.
const csd = detectPrompt("\u001b(BPick one\n\u276f 1. \u001b(BYes\n  2. No\nEsc to cancel\n");
uassert(csd && csd.options[0].label === "Yes" && !JSON.stringify(csd).includes("(B"), "charset designators stripped from labels");

// Repaint garbage is long-winded; real option labels are short.
uassert(!detectPrompt("\u276f 1. " + "x".repeat(200) + "\n  2. No\nEsc to cancel\n"), "paragraph-length label rejected");

// AskUserQuestion renders a CHECKBOX box whose options are separated by their own
// (wrapped) description rows. A contiguous-run scan found only "4."/"5.", read
// "first index is not 1" and published nothing — so the phone showed no approve
// bar at all and the reader view just said "working" forever.
const multi = detectPrompt([
  "\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
  "\u2502 \u276f Which gap    Submit          \u2502",
  "\u2502                                 \u2502",
  "\u2502 Which case is missing?          \u2502",
  "\u2502                                 \u2502",
  "\u2502 \u276f 1. [ ] Prose questions        \u2502",
  "\u2502      Claude asks a free-text    \u2502",
  "\u2502      question and ends the turn \u2502",
  "\u2502   2. [ ] Not visible enough     \u2502",
  "\u2502      The red bar is easy to miss\u2502",
  "\u2502   3. [ ] Never appears          \u2502",
  "\u2502      Would be a bug.            \u2502",
  "\u2502   4. [ ] Type something         \u2502",
  "\u2502      Submit                     \u2502",
  "\u2502                                 \u2502",
  "\u2502   5. Chat about this            \u2502",
  "\u2502 Enter to select \u00b7 Esc to cancel \u2502",
  "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f",
].join("\n"));
uassert(multi && multi.options.length === 5, "multi-select box with description rows detected");
uassert(multi.options[0].label === "Prose questions", "checkbox marker stripped from the label");
uassert(multi.multi === true, "multi-select flagged (a digit toggles, it does not answer)");
uassert(multi.question === "Which case is missing?", "wrapped question captured, tab row excluded");

// The gap tolerance must not glue a numbered line from the conversation above onto
// a run — prose still needs cursor/footer evidence, and it has neither.
uassert(!detectPrompt([
  "1. Now: prove the round-trip.",
  "2. Then: the CLI pipeline.",
  "",
  "Some prose in between that is not an option row at all.",
  "",
  "3. Then, if it's repeat business: the service.",
].join("\n")), "prose numbered list across gaps is still not a prompt");

// ── the two-stage contract ───────────────────────────────────────────
// Stage 1 scans an ANSI-stripped BYTE WINDOW, and a repaint can leave the
// cursor row and the footer row outside it while the option rows sit inside.
// So stage 1 runs lenient (a candidate, worth paying for a VT render) and only
// stage 2 — over the RENDERED screen — is strict enough to publish.
const cursorless = "Do you want to proceed?\n  1. Yes\n  2. No\n";
uassert(detectPrompt(cursorless, { lenient: true }), "cheap stage keeps a cursorless/footerless box as a candidate");
uassert(!detectPrompt(cursorless), "strict stage still refuses it (that is what gets published)");

// Leniency is only about the cursor/footer evidence: structural nonsense must
// still be dropped, or every prose numbered list would pay for a VT render.
uassert(!detectPrompt("1. " + "x".repeat(200) + "\n2. No\n", { lenient: true }), "lenient still rejects paragraph-length labels");
uassert(!detectPrompt("2. second\n3. third\n", { lenient: true }), "lenient still requires indices starting at 1");


const PORT = 8797;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-t12-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.MAX_UPLOAD]: "10" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

bootWait(PORT, 900, async () => {
  try {
    // new repo to host the session
    const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t12" }) }).then((r) => r.json());
    const id = (await fetch(`${base}/api/repos`).then((r) => r.json())).targets[0].id;

    // push key
    const key = await fetch(`${base}/api/push/key`).then((r) => r.json());
    check(typeof key.key === "string" && key.key.length > 20, "push VAPID public key served");

    // upload cap (content-length 100 > MAX 10) → 413
    const big = await fetch(`${base}/api/repos/${id}/inbox`, { method: "POST", headers: { "x-file-name": "big.png", "content-type": "image/png", "content-length": "100" }, body: Buffer.alloc(100) });
    check(big.status === 413, "oversized upload rejected 413");

    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      let sid = null, gotPrompt = false, gotRecent = false, gotRename = false;
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "recent.list" && m.recent.some((r) => r.cwd === repo.path)) gotRecent = true;
        if (m.t === "session.created") {
          sid = m.session.id;
          // produce a claude-style choice prompt, then stay idle
          setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: sid, data: "printf 'Do you want to proceed?\\n1. Yes\\n2. No\\nEsc to cancel\\n'\r" })), 300);
        }
        if (m.t === "session.updated" && m.session.id === sid) {
          if (m.session.prompt && m.session.prompt.options?.length === 2 && !gotPrompt) {
            gotPrompt = true;
            check(m.session.prompt.options[0].label.includes("Yes") && m.session.prompt.kind === "tool", "prompt detected with Yes/No options (kind=tool)");
            ws.send(JSON.stringify({ t: "session.rename", id: sid, title: "renamed sess" }));
          }
          if (m.session.tabTitle === "renamed sess" && !gotRename) { gotRename = true; check(true, "session rename round-trips"); }
        }
        if (gotPrompt && gotRename && !done1) { done1 = true; setTimeout(() => { check(gotRecent, "recent list includes new session cwd"); ws.close(); finish(); }, 200); }
      });
      let done1 = false;
      const finish = () => resolve();
      // kick a session
      setTimeout(() => ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 })), 150);
      setTimeout(resolve, 9000);
    });
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 15000);
