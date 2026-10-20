import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";
// A phone's bare `/fork [title]` is answered by the HOST, never typed: from CLI
// 2.1.291 the CLI's own `/fork` hands the branch to its background daemon, in
// no tmux this host owns, so the phone never sees it. Over a real daemon and a
// stub `claude` that prints its argv: the fork is a new TAB spawned with
// `--resume <source conversation> --fork-session`, the asking socket is focused
// on it, the receipt says `forked` in words, a retried ackId forks nothing, and
// `/fork` aimed at a session that is gone is refused in words.
const PORT = 8812;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-sf-`));
const STUB = join(ROOT, "echoargs.sh");
writeFileSync(STUB, "#!/bin/bash\necho \"ARGS:$@\"\nread x\n");
chmodSync(STUB, 0o755);
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: STUB };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
const finish = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

waitForHost(PORT).then(async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sf" }) }).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  const pty = new Map();
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    seen.push(m);
    if (m.t === "pty") pty.set(m.id, (pty.get(m.id) ?? "") + b64(m.dataB64));
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const next = (pred, ms = 6000) => new Promise((res, rej) => {
    waiters.push({ pred, res });
    setTimeout(() => rej(new Error("timed out waiting")), ms);
  });
  const send = (m) => ws.send(JSON.stringify(m));
  try {
    await new Promise((r) => ws.on("open", r));
    send({ t: "hello", protocol: 1 });
    await next((m) => m.t === "welcome");
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, launch: { model: "opus" } });
    const src = (await next((m) => m.t === "session.created")).session;
    check(/^[0-9a-f-]{36}$/.test(src.claudeSessionId || ""), "the source carries a known conversation id");

    const created = next((m) => m.t === "session.created" && m.session.id !== src.id);
    const focus = next((m) => m.t === "session.focus");
    const ack = next((m) => m.t === "input.ack" && m.ackId === "sf-1");
    send({ t: "session.input", id: src.id, data: "/fork try the other schema", ackId: "sf-1", submit: true });
    const fork = (await created).session;
    const a = await ack;
    check(a.ok === true && a.state === "forked", `the receipt says forked: ${JSON.stringify(a)}`);
    check(/forked into a new session/.test(a.reason || ""), "…in words: " + a.reason);
    check(fork.title === "try the other schema", "the title after /fork names the tab: " + fork.title);
    check(fork.cwd === repo.path && fork.model === "opus", "same cwd, same launch flags");
    check((await focus).id === fork.id, "the asking socket is focused on the new tab");
    // The fork's own CLI (tmux, then the stub) prints its argv once it is up: a 4 s wait missed it
    // under a loaded parallel suite, so wait to a deadline instead.
    for (let i = 0; i < 150 && !(pty.get(fork.id) ?? "").includes("ARGS:"); i++) await sleep(100);
    const line = (pty.get(fork.id) ?? "").split("\n").find((l) => l.includes("ARGS:")) ?? "";
    check(line.includes(`--resume ${src.claudeSessionId} --fork-session`), "the fork resumes exactly the source conversation (--resume <its id> --fork-session)"
      + (line ? "" : " — no ARGS line was printed"));
    const srcLine = (pty.get(src.id) ?? "");
    check(!srcLine.includes("/fork"), "/fork was never typed into the source session");

    // The same ackId again: re-acked, never forked a second time.
    const before = seen.filter((m) => m.t === "session.created").length;
    const replay = next((m) => m.t === "input.ack" && m.ackId === "sf-1");
    send({ t: "session.input", id: src.id, data: "/fork try the other schema", ackId: "sf-1", submit: true });
    const r = await replay;
    await sleep(800);
    check(r.state === "forked" && r.reason === a.reason, "a retried ackId is re-acked with the same words");
    check(seen.filter((m) => m.t === "session.created").length === before, "…and opens no second tab");

    const gone = next((m) => m.t === "input.ack" && m.ackId === "sf-2");
    send({ t: "session.input", id: "nope", data: "/fork", ackId: "sf-2", submit: true });
    const g = await gone;
    check(g.ok === false && /session is gone/.test(g.reason || ""), "a /fork at a gone session is refused in words: " + g.reason);
  } catch (e) {
    check(false, String(e?.message || e));
  }
  ws.close();
  finish();
});
watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 60000);
