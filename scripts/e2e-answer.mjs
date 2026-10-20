// Answering a CLI question OFFLINE, delivered when the link comes back.
//
// The phone can hold a question it saw during a brief connectivity window and
// let you answer it with no tunnel at all; the send queue delivers the answer on
// reconnect. That delay is the point, and it is also the hazard: an answer is a
// KEYSTROKE aimed at whatever box is on screen when it lands, not text. "2" is
// "use the existing branch" at the question you read and something else entirely
// at the box that replaced it — and a digit arriving with no box up at all is a
// stray character in the composer that the next Return submits as a prompt.
//
// So an answer names the question it answers (`expectPrompt`, a fingerprint of
// the published DetectedPrompt) and the host refuses to write the bytes unless
// that exact question is still live. This pins both halves: the fingerprint
// rules (pure, no host) and the guard itself, asserted against a real PTY —
// the stub is a shell, so "did those bytes reach the terminal" is countable.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { promptFingerprint, promptStillCurrent } from "../packages/shared/dist/promptid.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

// ── Fingerprint rules (pure) ─────────────────────────────────────────
// Every field that changes what an ANSWER MEANS has to be in the id, or a
// queued keystroke will be delivered into a box it was never minted for.
{
  const base = { kind: "tool", question: "Do you want to proceed?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] };
  const fp = promptFingerprint(base);

  check(fp === promptFingerprint({ ...base, options: [...base.options] }),
    "same question, same fingerprint");
  check(fp === promptFingerprint({ ...base, question: "Do you   want to proceed?  " }),
    "whitespace a repaint re-flowed does not change the fingerprint");

  check(fp !== promptFingerprint({ ...base, question: "Delete the branch?" }),
    "a different question is a different fingerprint");
  check(fp !== promptFingerprint({ ...base, options: [{ index: 1, label: "Yes" }, { index: 2, label: "No, and stop" }] }),
    "a changed option LABEL is a different fingerprint (same digit, different meaning)");
  check(fp !== promptFingerprint({ ...base, options: [{ index: 1, label: "No" }, { index: 2, label: "Yes" }] }),
    "reordered options are a different fingerprint — the index is what gets typed");
  check(fp !== promptFingerprint({ ...base, kind: "trust" }),
    "the same box text under a different KIND is a different fingerprint");
  check(fp !== promptFingerprint({ ...base, multi: true }),
    "multi-select is a different fingerprint — a digit TOGGLES there instead of answering");

  check(promptStillCurrent(base, fp) === true, "an unchanged prompt is still current");
  check(promptStillCurrent(null, fp) === false, "no prompt at all is NOT current (the box was answered or the agent moved on)");
  check(promptStillCurrent(undefined, fp) === false, "a session with no prompt field is not current either");
}

// ── The host guard, against a real PTY ───────────────────────────────
const PORT = 8798;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-answer-`));
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
const count = (hay, needle) => hay.split(needle).length - 1;

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "answers" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, screen = "";
    /** Latest published SessionInfo for our session — where `prompt` lives. */
    let info = null;
    const acks = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "pty" && m.id === sid) screen += Buffer.from(m.dataB64, "base64").toString("utf8");
      if (m.t === "input.ack") acks.set(m.ackId, m);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));

    /** Wait until `cond()` holds, or give up. */
    const until = async (cond, ms = 6000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    await sleep(300);

    // Put a claude-style choice box on the screen.
    const raise = (q) => ws.send(JSON.stringify({ t: "session.input", id: sid, data: `printf '${q}\\n1. Yes\\n2. No\\nEsc to cancel\\n'\r` }));
    raise("Do you want to proceed?");
    const gotFirst = await until(() => info?.prompt?.options?.length === 2);
    check(gotFirst, "a choice box on the PTY is published as a DetectedPrompt");
    const fp1 = promptFingerprint(info.prompt);

    // 1. The happy path: the question is still up, so the answer is written.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo ANSWERONE\r", ackId: "ans1", expectPrompt: fp1 }));
    await until(() => acks.has("ans1"));
    check(acks.get("ans1")?.ok === true, "an answer whose question is still on screen is accepted");
    await until(() => screen.includes("ANSWERONE"));
    const afterFirst = count(screen, "ANSWERONE");
    check(afterFirst > 0, "…and the keystrokes actually reached the PTY");

    // 2. The retry that the tunnel ate the receipt for. Same ackId ⇒ re-ACKed
    //    from the ledger, NOT typed again — the guard must not have opened a
    //    second delivery path around the idempotence contract.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo ANSWERONE\r", ackId: "ans1", expectPrompt: fp1 }));
    await sleep(700);
    check(count(screen, "ANSWERONE") === afterFirst, "a re-sent answer (same ackId) is re-ACKed, not typed a second time");

    // 3. The case the whole feature turns on: the answer was minted while the
    //    box was up, the link came back later, and by then the box is gone.
    //    Nothing may be written — a stray "2" lands in the composer and the next
    //    Return submits it as a prompt.
    //    The stub is a plain shell, so the box it printed stays on the rendered
    //    screen and keeps being re-detected as the SAME question — which is
    //    correct, and means the answer would still be valid. Wipe the screen to
    //    get the state this case is about: no box at all.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "clear\r" }));
    const cleared = await until(() => !info?.prompt);
    check(cleared, "the box is gone once it leaves the rendered screen");
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo STALEMARKER\r", ackId: "ans2", expectPrompt: fp1 }));
    await until(() => acks.has("ans2"));
    const a2 = acks.get("ans2");
    check(a2?.ok === false && a2?.state === "stale", `an answer for a question that is gone is refused as stale (got ${a2?.state})`);
    check(a2?.retryable !== true, "…and is never auto-retryable — a retry can only get staler");
    await sleep(600);
    check(!screen.includes("STALEMARKER"), "…and NOTHING was written to the PTY");

    // 4. The refusal is remembered, so the phone's retry gets the same answer
    //    instead of a fresh (and by then differently-wrong) attempt.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo STALEMARKER\r", ackId: "ans2", expectPrompt: fp1 }));
    await sleep(700);
    check(acks.get("ans2")?.state === "stale", "a replayed stale ackId replays the stale verdict");
    check(!screen.includes("STALEMARKER"), "…and still writes nothing");

    // 5. A DIFFERENT question is up now. This is the dangerous one — there is a
    //    box on screen, so a guard that only checked "is anything waiting?"
    //    would type the old answer into the new dialog.
    raise("Delete the worktree?");
    const gotSecond = await until(() => info?.prompt?.question?.includes("Delete the worktree?"));
    check(gotSecond, "a second, different choice box is published");
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo WRONGBOX\r", ackId: "ans3", expectPrompt: fp1 }));
    await until(() => acks.has("ans3"));
    check(acks.get("ans3")?.state === "stale", "an answer for the PREVIOUS question is refused even though a question is up");
    await sleep(600);
    check(!screen.includes("WRONGBOX"), "…and the new dialog was not answered on the old question's behalf");

    // 6. …while the answer minted against the box that IS up goes through.
    const fp2 = promptFingerprint(info.prompt);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo RIGHTBOX\r", ackId: "ans4", expectPrompt: fp2 }));
    await until(() => acks.has("ans4"));
    check(acks.get("ans4")?.ok === true, "the answer minted against the CURRENT question is accepted");
    await until(() => screen.includes("RIGHTBOX"));
    check(screen.includes("RIGHTBOX"), "…and delivered");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 150);
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
