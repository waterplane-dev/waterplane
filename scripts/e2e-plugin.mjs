// Plugins end to end (docs/notes/plugins.md): a real host loads the fixture
// plugin (scripts/fixtures/plugin-echo) from a temp config dir's plugin-paths.json,
// lists a broken one beside it with the reason, refuses an out-of-range
// setting in words, answers an action, puts the plugin's suggestion on the
// session, and holds its answers to the core's gate — refused while the
// session's "let Echo answer" switch is off, typed once it is on, and refused
// for a blocked box whatever the switch says.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, PLUGIN_MANIFEST, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8911;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-plugin-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-plugcfg-`));
const FIXTURE = resolve("scripts/fixtures/plugin-echo");
// A broken plugin: its manifest names an apiVersion this host does not speak.
const BROKEN = join(CONFIG, "broken-src");
mkdirSync(BROKEN);
writeFileSync(join(BROKEN, PLUGIN_MANIFEST), JSON.stringify({ id: "broken", name: "Broken", version: "0", apiVersion: 99 }));
writeFileSync(join(CONFIG, "plugin-paths.json"), JSON.stringify({ paths: [FIXTURE, BROKEN] }));

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "plugged" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null, plugins = null, screen = "";
    const replies = new Map(), pushes = [];
    const errors = [], results = new Map(), decisions = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "plugin.list") plugins = m.plugins;
      if (m.t === "plugin.error") errors.push(m);
      if (m.t === "plugin.reply") replies.set(m.ackId, m);
      if (m.t === "plugin.push") pushes.push(m);
      if (m.t === "plugin.actionResult") results.set(m.reqId, m);
      if (m.t === "decisions.log") decisions.splice(0, decisions.length, ...m.entries);
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "pty" && m.id === sid) screen += Buffer.from(m.dataB64, "base64").toString("utf8");
    });
    await new Promise((r) => ws.on("open", r));
    const send = (m) => ws.send(JSON.stringify(m));
    const until = async (cond, ms = 6000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    const action = async (reqId, m) => { send({ t: "plugin.action", reqId, ...m }); await until(() => results.has(reqId)); return results.get(reqId); };
    send({ t: "hello", protocol: 1 });

    // ── Listed: the fixture active, the broken one an error with its reason ──
    await until(() => plugins?.length === 2);
    const echo = plugins?.find((p) => p.manifest.id === "echo");
    const broken = plugins?.find((p) => p.manifest.id === "broken");
    check(echo?.state === "active", `the fixture plugin is listed active (got ${echo?.state} ${echo?.error ?? ""})`);
    check(echo?.status?.text === "listening", "its status line reached the phone");
    check(broken?.state === "error" && /apiVersion is 99/.test(broken?.error ?? ""), `a broken plugin is listed with the reason (got ${broken?.error})`);

    // ── Its own HTTP route (api.route): served, and behind the SAME origin gate ──
    const ping = await fetch(`${base}/api/plugin/echo/ping?q=hi`);
    check(ping.status === 200 && JSON.stringify(await ping.json()) === '{"pong":true,"q":"hi"}', `a plugin route answers through the host (got ${ping.status})`);
    const evil = await fetch(`${base}/api/plugin/echo/ping`, { headers: { origin: "https://evil.example" } });
    check(evil.status === 403, `a foreign Origin is refused on a plugin route, as on any /api route (got ${evil.status})`);
    const drive = await fetch(`${base}/api/plugin/echo/ping`, { headers: { "sec-fetch-site": "cross-site" } });
    check(drive.status === 403, `an Origin-less cross-site GET is refused on a plugin route (got ${drive.status})`);
    check((await fetch(`${base}/api/plugin/echo/nope`)).status === 404, "a path the plugin does not serve is the plain 404");

    // ── Settings: refused in words, accepted within range ──
    send({ t: "plugin.set", id: "echo", values: { cap: 42 } });
    await until(() => errors.length > 0);
    check(/"Cap" cannot be 42 \(allowed 0–10\)/.test(errors[0]?.error ?? ""), `an out-of-range value is refused in words (got ${errors[0]?.error})`);
    send({ t: "plugin.set", id: "echo", values: { cap: 7 } });
    await until(() => plugins?.find((p) => p.manifest.id === "echo")?.values?.cap === 7);
    check(plugins.find((p) => p.manifest.id === "echo").values.cap === 7, "an in-range value is applied and re-listed");

    // ── Action → actionResult ──
    const pong = await action("r1", { id: "echo", action: "ping" });
    check(pong?.ok === true && pong?.message === "pong (cap 7)", `a global action answers (got ${pong?.message})`);

    // ── A box → the plugin's suggestion on SessionInfo ──
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 });
    await until(() => sid);
    send({ t: "session.attach", id: sid });
    await sleep(300);
    const raise = (q) => send({ t: "session.input", id: sid, data: `clear; printf '${q}\\n1. Grid\\n2. List\\nEsc to cancel\\n'\r` });
    raise("Which layout should I use?");
    await until(() => info?.prompt?.options?.length === 2);
    check(!!info?.prompt, "a choice box is published");
    await until(() => info?.suggestion?.by === "echo");
    check(info?.suggestion?.by === "echo" && info?.suggestion?.choice === 1 && info?.suggestion?.byName === "Echo",
      `the plugin's suggestion rides on SessionInfo (got ${JSON.stringify(info?.suggestion)})`);
    await until(() => decisions.some((d) => d.source === "plugin" && d.plugin === "echo"));
    check(decisions.some((d) => d.source === "plugin" && d.plugin === "echo" && d.outcome === "suggested"), "its decision row is broadcast");

    // ── The gate: switch off ⇒ refused, nothing typed ──
    const before = screen.length;
    const off = await action("r2", { id: "echo", action: "answer", sessionId: sid });
    check(off?.ok === false && /"let Echo answer" is off/.test(off?.message ?? ""), `an answer with the switch off is refused (got ${off?.message})`);
    await sleep(400);
    check(!/\n1\r?\n|command not found: 1|1: command not found/.test(screen.slice(before)), "…and nothing was typed");

    // ── Switch on ⇒ answered through the tap's path ──
    send({ t: "plugin.sessionAnswer", id: "echo", sessionId: sid, value: true });
    await until(() => info?.pluginAnswer?.echo === true);
    check(info?.pluginAnswer?.echo === true, "the per-session switch rides on SessionInfo");
    const on = await action("r3", { id: "echo", action: "answer", sessionId: sid });
    check(on?.ok === true && on?.message === "answered", `with the switch on the answer goes through (got ${on?.message})`);
    await until(() => decisions.some((d) => d.outcome === "answered"));
    check(decisions.some((d) => d.source === "plugin" && d.outcome === "answered" && d.choice === 1), "the answer is a decision row");

    // ── A blocked box is refused whatever the switch says ──
    raise("Delete the worktree?");
    await until(() => info?.prompt?.question?.includes("Delete the worktree?"));
    await sleep(300);
    const blocked = await action("r4", { id: "echo", action: "answer", sessionId: sid });
    check(blocked?.ok === false && /destructive, permission-granting or secret/.test(blocked?.message ?? ""),
      `a blocked box is refused in words (got ${blocked?.message})`);

    // ── Toggle and answer switches refuse what the manifest did not declare ──
    errors.length = 0;
    send({ t: "plugin.sessionToggle", id: "echo", sessionId: sid, toggle: "nope", value: true });
    await until(() => errors.length > 0);
    check(/has no switch "nope"/.test(errors[0]?.error ?? ""), "an undeclared toggle is refused in words");

    // ── Generic plugin.call / plugin.reply / plugin.push ──
    const call = async (ackId, method, args) => { send({ t: "plugin.call", plugin: "echo", method, args, ackId }); await until(() => replies.has(ackId), 3000); return replies.get(ackId); };
    const e1 = await call("c-echo", "echo", { a: 1 });
    check(e1?.ok === true && e1.result?.echoed?.a === 1 && e1.plugin === "echo" && e1.method === "echo", `plugin.call echo answers (got ${JSON.stringify(e1)})`);
    const n1 = await call("c-count-1", "count");
    send({ t: "plugin.call", plugin: "echo", method: "count", ackId: "c-count-1" });
    await sleep(300);
    const n2 = await call("c-count-2", "count");
    check(n1?.ok && n2?.ok && n2.result === n1.result + 1, `the same ackId re-sent ran the handler once; a new ackId counted on (got ${n1?.result}, ${n2?.result})`);
    const bad = await call("c-nope", "nope");
    check(bad?.ok === false && /no method "nope"/.test(bad.error ?? ""), `an unknown method is a sentence (got ${bad?.error})`);
    const sh = await call("c-shout", "shout");
    await until(() => pushes.length > 0, 3000);
    check(sh?.ok === true && sh.result === "ok" && pushes[0]?.plugin === "echo" && pushes[0]?.event === "shouted", `api.push reaches the phone as plugin.push (got ${JSON.stringify(pushes[0])})`);
    send({ t: "plugin.call", plugin: "echo", method: "echo", ackId: "bad ack id!" });
    await sleep(1000);
    check(![...replies.keys()].some((k) => k.includes("bad")), "a malformed ackId gets no reply");

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill("SIGTERM");
    console.log(failed ? "\nE2E PLUGIN: FAIL" : "\nE2E PLUGIN: PASS");
    process.exit(failed ? 1 : 0);
  }
});
