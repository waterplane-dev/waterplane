// A SHELL session (`backends/shell.ts`, docs/analysis/shell-plan.md), end to end:
//   1. `launch.backend: "shell"` spawns `$SHELL_BIN -l` (/bin/sh here) in tmux;
//      the session says `backend: "shell"` and wears the static tab name
//      `shell · <repo>`, and `hello` lists the shell backend with `kind: "shell"`.
//   2. `session.input` with `submit: true` goes through `deliver.ts` — ack ok,
//      the command RAN (its output is in the pane), and no "Turn finished"
//      notification follows however long the shell stays quiet (`caps.turns`).
//   3. `$BROWSER <url>` typed in the shell reaches the phone: the shim posts to
//      `/api/shell/open` and the URL lands on the session's `links`.
//   4. The route by hand: a bogus session id is 204 and stores nothing.
//   4b. A second shell: a gh-style device flow printed on screen publishes the
//      link WITH its code (`shelllinks.ts`); a gcloud-style "authorization code"
//      prompt sets `awaitingCode`, and answering it clears it.
//   2b. Never a line before the confirmed Return: a two-line send into /bin/sh
//      (no bracketed paste) is refused and nothing runs; a send while `sleep`
//      is in front of the shell is refused naming it. 4c: zsh (bracketed
//      paste on) takes the two lines as one paste.
//   5. Restart the host on the same root: the pane is re-attached, still a
//      shell, still named, and still runs a command.
// Isolated: lib-tmuxiso, a throwaway root and HOME, PREFLIGHT=0.
import "./lib-tmuxiso.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { freePort, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

if (spawnSync("tmux", ["-V"]).status !== 0) { console.log("SKIP: tmux not installed"); process.exit(0); }

const PORT = await freePort();
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-shell-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-shell-home-`));
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env, HOME, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.SHELL_BIN]: "/bin/sh",
  // Short silence windows, so "no Turn finished" is asked over several of them.
  [E.IDLE_PING_MS]: "600",
};
let host = null;
const startHost = async () => {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  await waitForHost(PORT);
};
const stopHost = async () => { if (host && host.exitCode === null) { const gone = new Promise((r) => host.once("exit", r)); host.kill(); await gone; } };
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const fail = async (m) => { console.log("FAIL:", m); await stopHost(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
setTimeout(() => fail("timeout"), 120_000).unref();

/** One socket with everything it saw, and a way to wait on it. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const st = { ws, welcome: null, created: null, sessions: new Map(), notifs: [], acks: new Map(), pane: "", attached: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") st.welcome = m;
    if (m.t === "backends") st.backends = m.list;
    if (m.t === "session.created") st.created = m.session;
    if (m.t === "session.list") { st.list = m.sessions; for (const s of m.sessions) st.sessions.set(s.id, s); }
    if (m.t === "session.updated") st.sessions.set(m.session.id, m.session);
    if (m.t === "notification") st.notifs.push(m.item);
    if (m.t === "input.ack") st.acks.set(m.ackId, m);
    if (m.t === "pty" && m.id === st.attached) st.pane += b64(m.dataB64);
  });
  st.send = (o) => ws.send(JSON.stringify(o));
  st.until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return !!pred(); };
  st.close = () => ws.close();
  return st;
}

await startHost();
const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "shellrepo" }) }).then((r) => r.json());
if (!repo.path) await fail("could not create the repo");

// ── 1. create ──
let c = client();
if (!(await c.until(() => c.welcome && c.backends))) await fail("no welcome / backends frame");
const listed = c.backends;
const shellInfo = (listed ?? []).find((b) => b.id === "shell");
check(shellInfo?.kind === "shell", `the backend list offers the shell with kind "shell" (${JSON.stringify(shellInfo?.kind)})`);
check((listed ?? []).filter((b) => b.id !== "shell").every((b) => !("kind" in b)), "every agent backend carries no kind");
c.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, launch: { backend: "shell" }, ackId: "create-1" });
if (!(await c.until(() => c.created))) await fail("session.create produced no session");
const sid = c.created.id;
check(c.created.backend === "shell", `the session says backend "shell" (${c.created.backend})`);
check(c.created.tabTitle === "shell · shellrepo", `static tab name (${JSON.stringify(c.created.tabTitle)})`);
c.attached = sid;
c.send({ t: "session.attach", id: sid });
await sleep(1200); // the login shell's first prompt

// ── 2. a command through deliver.ts ──
c.notifs.length = 0;
c.send({ t: "session.input", id: sid, data: "echo hello$((40+2))", submit: true, ackId: "in-1" });
if (!(await c.until(() => c.acks.has("in-1"), 15000))) await fail("no input.ack for the shell command");
const ack = c.acks.get("in-1");
check(ack.ok === true, `the command is acked ok (${JSON.stringify(ack)})`);
check(await c.until(() => c.pane.includes("hello42")), "the command RAN — its output is in the pane");
await sleep(3000); // five silence windows
const idlePings = c.notifs.filter((n) => n.kind === "idle" && n.sessionId === sid);
check(idlePings.length === 0, `no "Turn finished" for a quiet shell (${idlePings.map((n) => n.title).join(", ") || "none"})`);
const now = c.sessions.get(sid) ?? c.created;
check(!now.turnActive, "a shell is never mid-turn");

// ── 2b. never a line before the confirmed Return ──
// /bin/sh (bash 3.2 here) has no bracketed paste: a two-line send is refused in
// words and NOTHING runs — not even line 1.
c.send({ t: "session.input", id: sid, data: "echo early-$((1+1))\necho late-$((2+2))", submit: true, ackId: "in-ml" });
if (!(await c.until(() => c.acks.has("in-ml"), 15000))) await fail("no input.ack for the two-line send");
const ml = c.acks.get("in-ml");
check(ml.ok === false && /one line at a time/.test(ml.reason ?? ""), `a two-line send into a shell with no bracketed paste is refused in words (${JSON.stringify(ml)})`);
await sleep(800);
check(!c.pane.includes("early-2") && !c.pane.includes("late-4"), "…and line 1 never ran");
// A program in front of the shell is not typed into.
c.send({ t: "session.input", id: sid, data: "sleep 4", submit: true, ackId: "in-fg1" });
if (!(await c.until(() => c.acks.get("in-fg1")?.ok === true, 15000))) await fail("sleep 4 was not acked ok");
await sleep(300);
c.send({ t: "session.input", id: sid, data: "echo typed-into-sleep", submit: true, ackId: "in-fg2" });
if (!(await c.until(() => c.acks.has("in-fg2"), 15000))) await fail("no input.ack while sleep runs");
const fg = c.acks.get("in-fg2");
check(fg.ok === false && /the shell is running `sleep`/.test(fg.reason ?? ""), `a send while \`sleep\` runs is refused, naming it (${JSON.stringify(fg)})`);
await sleep(4500);
check(!c.pane.includes("typed-into-sleep"), "…and nothing was typed into it");

// ── 3. $BROWSER → the phone ──
c.send({ t: "session.input", id: sid, data: "\"$BROWSER\" 'https://github.com/login/device?x=1'", submit: true, ackId: "in-2" });
check(await c.until(() => (c.sessions.get(sid)?.links ?? []).some((l) => l.url === "https://github.com/login/device?x=1" && l.source === "browser"), 10000),
  `$BROWSER in the shell publishes the link on the session (${JSON.stringify(c.sessions.get(sid)?.links)})`);

// ── 4. the route by hand ──
const post = (form, from) => fetch(`${base}/api/shell/open`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
const before = JSON.stringify(c.sessions.get(sid)?.links);
const bogus = await post({ session: "deadbeef", url: "https://example.com/nope" });
check(bogus.status === 204, `a bogus session id is 204 (${bogus.status})`);
const badUrl = await post({ session: sid, url: "file:///etc/passwd" });
check(badUrl.status === 204, `a non-http URL is 204 (${badUrl.status})`);
await sleep(400);
check(JSON.stringify(c.sessions.get(sid)?.links) === before, "and neither stored anything");
const live = await post({ session: sid, url: "https://example.com/by-hand" });
check(live.status === 204, "a live id is 204 too");
check(await c.until(() => (c.sessions.get(sid)?.links ?? []).some((l) => l.url === "https://example.com/by-hand")), "…and its link is on the session");
const get = await fetch(`${base}/api/shell/open`);
check(get.status !== 204, `never a GET (${get.status})`);

// ── 4b. links + codes read off the SCREEN (shelllinks.ts), in a fresh shell ──
// Every literal is split through shell variables so the typed command row
// itself carries no URL and no code — only the printed output does.
c.created = null;
c.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, launch: { backend: "shell" }, ackId: "create-2" });
if (!(await c.until(() => c.created))) await fail("second shell session.create produced no session");
const sid2 = c.created.id;
await sleep(1200);
const lk = () => c.sessions.get(sid2)?.links ?? [];
c.send({ t: "session.input", id: sid2, data: `s=https; k=ABCD; printf '%s\\n' "! First copy your one-time code: $k-1234" "Open this URL to continue in your web browser: $s://github.com/login/device"`, submit: true, ackId: "in-4" });
check(await c.until(() => lk()[0]?.code === "ABCD-1234", 10000),
  `a gh-style device flow publishes the link with its code (${JSON.stringify(lk())})`);
check(lk()[0]?.url === "https://github.com/login/device" && lk()[0]?.source === "screen", "…as a screen-sourced link to the device page");
check(!c.sessions.get(sid2)?.awaitingCode, "…and nothing is awaiting a code");
c.send({ t: "session.input", id: sid2, data: `clear; s=https; printf '%s\\n' "Go to the following link in your browser:" "  $s://accounts.google.com/o/oauth2/auth?response_type=code&client_id=325559.apps.googleusercontent.com"; printf 'Enter the authorization %s: ' code; read x`, submit: true, ackId: "in-5" });
check(await c.until(() => c.sessions.get(sid2)?.awaitingCode === true && lk().some((l) => l.url === "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=325559.apps.googleusercontent.com"), 10000),
  `a gcloud-style code prompt sets awaitingCode beside its link, rejoined across the terminal's own wrap (${JSON.stringify(c.sessions.get(sid2)?.awaitingCode)}, ${JSON.stringify(lk())})`);
c.send({ t: "session.input", id: sid2, data: "4/0Abc", submit: true, ackId: "in-6" });
check(await c.until(() => !c.sessions.get(sid2)?.awaitingCode, 10000), "answering the prompt retires awaitingCode");
c.send({ t: "session.kill", id: sid2 });

// ── 4c. a shell WITH bracketed paste (zsh): the two lines go in as one paste,
// held until the one Return — so neither line's output precedes the other's echo.
if (existsSync("/bin/zsh")) {
  c.created = null;
  c.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, launch: { backend: "shell" }, ackId: "create-3" });
  if (!(await c.until(() => c.created))) await fail("third shell session.create produced no session");
  const sid3 = c.created.id;
  c.attached = sid3; c.pane = "";
  c.send({ t: "session.attach", id: sid3 });
  await sleep(1200);
  c.send({ t: "session.input", id: sid3, data: `exec env ZDOTDIR=${HOME} /bin/zsh -f`, submit: true, ackId: "in-z0" });
  if (!(await c.until(() => c.acks.get("in-z0")?.ok === true, 15000))) await fail("could not exec zsh");
  await sleep(1500);
  c.pane = "";
  c.send({ t: "session.input", id: sid3, data: "echo one-$((1+1))\necho two-$((2+2))", submit: true, ackId: "in-z1" });
  check(await c.until(() => c.acks.get("in-z1")?.ok === true, 15000), `a two-line send into zsh is acked ok (${JSON.stringify(c.acks.get("in-z1"))})`);
  check(await c.until(() => c.pane.includes("one-2") && c.pane.includes("two-4")), "…both lines ran");
  check(c.pane.indexOf("two-$((2+2))") >= 0 && c.pane.indexOf("two-$((2+2))") < c.pane.indexOf("one-2"),
    "…and line 1 ran only after line 2 was on the line — one paste, one Return");
  c.send({ t: "session.kill", id: sid3 });
} else console.log("SKIP: no /bin/zsh — the bracketed-paste path is pinned by deliversubmit.test.mjs");

// ── 4d. a companion shell: temporary, closed with the session it belongs to ──
c.created = null;
c.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, launch: { backend: "shell" }, companionOf: sid, ackId: "create-comp" });
if (!(await c.until(() => c.created))) await fail("companion session.create produced no session");
const compId = c.created.id;
check(c.created.companionOf === sid, `the companion names its parent (${JSON.stringify(c.created.companionOf)})`);
c.created = null;
c.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, launch: { backend: "shell" }, companionOf: "nosuchid", ackId: "create-orphan" });
await sleep(800);
check(!c.created, "a companion of a session that is not open is refused, never opened as a shell nothing closes");
c.close();

// ── 5. restart ──
await stopHost();
await sleep(500);
await startHost();
c = client();
if (!(await c.until(() => c.sessions.has(sid), 10000))) await fail("the shell session was not re-attached after the restart");
const back = c.sessions.get(sid);
check(back.running && back.backend === "shell", `re-attached as a running shell (${back.backend}, running=${back.running})`);
check(back.tabTitle === "shell · shellrepo", `still named (${JSON.stringify(back.tabTitle)})`);
c.attached = sid;
c.send({ t: "session.attach", id: sid });
await sleep(500);
c.send({ t: "session.input", id: sid, data: "echo again$((6*7))", submit: true, ackId: "in-3" });
check(await c.until(() => c.acks.get("in-3")?.ok === true, 15000), "a command after the restart is acked ok");
check(await c.until(() => c.pane.includes("again42")), "…and runs");
check(c.sessions.get(compId)?.companionOf === sid, `the companion link survives the restart (${JSON.stringify(c.sessions.get(compId)?.companionOf)})`);
c.send({ t: "session.remove", id: sid });
const listed2 = () => (c.list ?? []).map((s) => s.id);
check(await c.until(() => !listed2().includes(sid) && !listed2().includes(compId)), `closing the session closes its companion shell with it (${JSON.stringify(listed2())})`);
c.close();

await stopHost();
process.exit(failed ? 1 : 0);
