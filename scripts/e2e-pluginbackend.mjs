// A BACKEND from a plugin, end to end (docs/analysis/backends-design.md §3,
// docs/notes/plugins.md "Backends"). A real host loads the fixture plugin
// scripts/fixtures/plugin-backend-stub, which registers `stubcli` — the claude
// stub TUI with its hooks posted to the plugin's own sink — and asserts:
//
//  - the backend is in `backends` once the plugin has activated;
//  - a session spawns on it, and goes `hooked` off the PLUGIN's sink (its
//    SessionStart, posted to /api/plugin/stubcli/hook), not the core's;
//  - its prepare() is AWAITED: a create re-sent under the same ackId while it waits
//    opens ONE session; the plan's file (the core's instructions) is written into
//    the session's launch dir, and the session publishes `told`/`askRulesVia`;
//  - a held hook (a permission request) publishes a box with the CLI's own id,
//    and a tap (`promptChoice` → `answerBox` → the dialog's `answer`) is the
//    hook's HTTP response;
//  - an untapped one is answered `{}` by the core at the hold, and withdrawn;
//  - a dialog in the CLI's own TUI, answered `{ keys: "1" }` by the plugin:
//    the HOST types exactly "1" (no Return) into that session, once;
//  - an unknown plugin's sink is a 404 in words;
//  - switching the plugin off releases a held hook with `{}`, removes the
//    backend, refuses the next create on it in words, and 404s its sink;
//  - switching it back on registers the backend again.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { bootWait, freePort } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = await freePort();
const HOLD_MS = 2500;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-plugbackend-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-plugbackendcfg-`));
const FIXTURE = resolve("scripts/fixtures/plugin-backend-stub");
writeFileSync(join(CONFIG, "plugin-paths.json"), JSON.stringify({ paths: [FIXTURE] }));

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  STUBCLI_HOLD_MS: String(HOLD_MS),
  STUB_LOG: join(ROOT, "stub-keys.log"),
  STUB_MODE: undefined, STUB_VARIANT: undefined, STUB_HOOKS: undefined, STUB_HOOK_URL: undefined, STUB_SESSION_ID: undefined,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const SINK = `${base}/api/plugin/stubcli/hook`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), at: Date.now() }));

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "plugbackend" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let backends = null, plugins = null;
    const sessions = new Map(), ops = new Map(), inputs = new Map(), created = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "backends") backends = m.list;
      if (m.t === "plugin.list") plugins = m.plugins;
      if (m.t === "session.created") { created.push(m.session); sessions.set(m.session.id, m.session); }
      if (m.t === "session.updated") sessions.set(m.session.id, m.session);
      if (m.t === "op.ack") ops.set(m.ackId, m);
      if (m.t === "input.ack") inputs.set(m.ackId, m);
    });
    await new Promise((r) => ws.on("open", r));
    const send = (m) => ws.send(JSON.stringify(m));
    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    const has = (id) => !!backends?.some((b) => b.id === id);
    send({ t: "hello", protocol: 1 });

    // ── 1. The backend appears once the plugin is active ───────────────
    check(await until(() => plugins?.find((p) => p.manifest.id === "stubcli")?.state === "active"),
      `the fixture plugin is active (got ${JSON.stringify(plugins?.map((p) => [p.manifest.id, p.state, p.error]))})`);
    check(await until(() => has("stubcli")), `"stubcli" is in the backends list (got ${backends?.map((b) => b.id).join(", ")})`);
    const info = backends?.find((b) => b.id === "stubcli");
    check(info?.label === "Stub CLI" && info?.caps?.hooks === true && info?.caps?.promptBoxes === true,
      `its wire caps are derived from its sources (hooks/promptBoxes true): ${JSON.stringify(info?.caps)}`);
    check(await until(() => backends?.find((b) => b.id === "stubcli")?.models?.ids?.includes("stub-1")),
      "a backend registered after boot has its catalogue asked and re-broadcast");

    // ── 2. A session spawns on it, hooked off the plugin's sink ────────
    // Sent TWICE under one ackId while the plugin's prepare() is still waiting (400 ms):
    // the retry joins the first create, so exactly one session opens.
    send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, ackId: "create-1", launch: { backend: "stubcli" } });
    await sleep(100);
    send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, ackId: "create-1", launch: { backend: "stubcli" } });
    check(await until(() => ops.has("create-1")), "the create is answered");
    check(ops.get("create-1")?.ok === true, `…ok (${ops.get("create-1")?.reason ?? ""})`);
    check(await until(() => created.some((s) => s.backend === "stubcli")), "a session is created on stubcli");
    await sleep(800);
    const made = created.filter((s) => s.backend === "stubcli").length;
    check(made === 1, `one ackId sent twice opens ONE session (${made})`);
    const sid = created.find((s) => s.backend === "stubcli")?.id;
    const cur = () => sessions.get(sid);
    check(cur()?.told === "env-file" && cur()?.askRulesVia === "gate", `the session says how it was told and how its rules hold (${cur()?.told}, ${cur()?.askRulesVia})`);
    const agentsMd = join(ROOT, STATE, "launch", sid ?? "-", "instructions", "AGENTS.md");
    const toldText = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "";
    check(/outbox/.test(toldText), `the host wrote the core's instructions where the plan asked, before the spawn (${agentsMd}: ${toldText.length} chars)`);
    check(typeof cur()?.backendSessionId === "string", `the launch's own id rides on the session (${cur()?.backendSessionId})`);
    check(await until(() => cur()?.hooked === true && cur()?.sideChannel?.state === "up", 10000),
      `hooked goes true off the plugin's sink (hooked=${cur()?.hooked} sideChannel=${JSON.stringify(cur()?.sideChannel)})`);
    const bsid = cur()?.backendSessionId;

    // ── 3. A held hook answered by a tap ───────────────────────────────
    const t0 = Date.now();
    const held = post(SINK, { hook_event_name: "permissionRequest", session_id: bsid, toolCallId: "call-1", toolName: "bash" });
    check(await until(() => cur()?.prompt?.askId === "call-1"), `the held request is a box with the CLI's own id (${JSON.stringify(cur()?.prompt)})`);
    check(cur()?.prompt?.nav === true && cur()?.prompt?.options?.length === 2, "…answered by choice (nav), two options");
    send({ t: "session.input", id: sid, data: "", promptChoice: 1, ackId: "tap-1" });
    check(await until(() => inputs.has("tap-1")), "the tap is acknowledged");
    check(inputs.get("tap-1")?.ok === true, `…ok (${inputs.get("tap-1")?.reason ?? ""})`);
    const r1 = await held;
    check(r1.status === 200 && r1.body?.behavior === "allow", `the tap IS the hook's response: ${JSON.stringify(r1)}`);
    check(r1.at - t0 < HOLD_MS, `…before the hold ran out (${r1.at - t0} ms < ${HOLD_MS})`);
    check(await until(() => !cur()?.prompt), "the box is retired once answered");

    // ── 4. An untapped one expires to {} and is withdrawn ──────────────
    const t1 = Date.now();
    const lapsed = post(SINK, { hook_event_name: "permissionRequest", session_id: bsid, toolCallId: "call-2", toolName: "edit" });
    check(await until(() => cur()?.prompt?.askId === "call-2"), "a second request is published");
    const r2 = await lapsed;
    check(r2.status === 200 && r2.body && Object.keys(r2.body).length === 0, `no tap ⇒ the core answers {} (${JSON.stringify(r2.body)})`);
    check(r2.at - t1 >= HOLD_MS - 200, `…at the hold, not before (${r2.at - t1} ms)`);
    check(await until(() => !cur()?.prompt, 3000), "…and the plugin withdraws its box");
    send({ t: "session.input", id: sid, data: "", promptChoice: 1, ackId: "tap-late" });
    await until(() => inputs.has("tap-late"));
    check(inputs.get("tap-late")?.ok === false, `a tap after expiry is refused in words (${inputs.get("tap-late")?.reason})`);

    // ── 4b. A dialog in the CLI's own TUI: the plugin answers { keys } ──
    const keyLog = join(ROOT, "stub-keys.log");
    const logged = () => (existsSync(keyLog) ? readFileSync(keyLog, "utf8") : "");
    const before = logged().length;
    const tui = await post(SINK, { hook_event_name: "tuiDialog", session_id: bsid, toolCallId: "call-tui" });
    check(tui.status === 200, `a TUI dialog is posted (${JSON.stringify(tui)})`);
    check(await until(() => cur()?.prompt?.askId === "call-tui"), "…and published with its own id");
    send({ t: "session.input", id: sid, data: "", promptChoice: 1, ackId: "tap-keys" });
    check(await until(() => inputs.has("tap-keys")), "the tap on it is acknowledged");
    check(inputs.get("tap-keys")?.ok === true, `…ok (${inputs.get("tap-keys")?.reason ?? ""})`);
    check(await until(() => logged().length > before, 3000), "the stub TUI received keystrokes");
    await sleep(400);
    check(logged().slice(before) === "1", `…exactly "1", no Return, once (${JSON.stringify(logged().slice(before))})`);
    check(await until(() => !cur()?.prompt, 3000), "…and the plugin retires the dialog when the CLI confirms");

    // ── 4c. "Don't ask again": a PERSON's tap makes the host's rule; the plugin asks the gate ──
    const rem = post(SINK, { hook_event_name: "rememberRequest", session_id: bsid, toolCallId: "call-r1", command: "touch r.txt" });
    check(await until(() => cur()?.prompt?.askId === "call-r1"), "a request with a remember option is published");
    check(cur()?.prompt?.options?.every((o) => !("remember" in o)), "…`remember` never reaches the wire");
    check(cur()?.prompt?.options?.[1]?.remembers?.label === "touch r.txt" && !cur()?.prompt?.options?.[0]?.remembers,
      `…but option 2 says, in the host's label, the rule a tap makes (${JSON.stringify(cur()?.prompt?.options)})`);
    send({ t: "session.input", id: sid, data: "", promptChoice: 2, ackId: "tap-rem" });
    check(await until(() => inputs.get("tap-rem")?.ok === true), `the tap on "don't ask again" is ok (${inputs.get("tap-rem")?.reason ?? ""})`);
    check((await rem).body?.behavior === "allow", "…and allows this one");
    check(await until(() => cur()?.pluginRules?.stubcli?.[0]?.label === "touch r.txt"), `the session lists the rule from host state (${JSON.stringify(cur()?.pluginRules)})`);
    const tA = Date.now();
    const again = await post(SINK, { hook_event_name: "rememberRequest", session_id: bsid, toolCallId: "call-r2", command: "touch r.txt" });
    check(again.body?.behavior === "allow" && again.body?.byRule === true && again.at - tA < 1000, `the identical request is allowed by the host's rule, no box (${JSON.stringify(again.body)})`);
    const otherCmd = post(SINK, { hook_event_name: "rememberRequest", session_id: bsid, toolCallId: "call-r3", command: "touch s.txt" });
    check(await until(() => cur()?.prompt?.askId === "call-r3"), "another command is NOT covered: asked as a box");
    send({ t: "session.input", id: sid, data: "", promptChoice: 3, ackId: "tap-r3" });
    check((await otherCmd).body?.behavior === "deny", "…and answered by the tap");
    const forgot = await post(SINK, { hook_event_name: "forgetRules", session_id: bsid });
    check(forgot.body?.forgot === 1 && forgot.body?.rules === 0, `forgetRules drops it (${JSON.stringify(forgot.body)})`);
    check(await until(() => !cur()?.pluginRules), "…and the session's list goes with it");
    const asked = post(SINK, { hook_event_name: "rememberRequest", session_id: bsid, toolCallId: "call-r4", command: "touch r.txt" });
    check(await until(() => cur()?.prompt?.askId === "call-r4"), "forgotten: the same command is asked again");
    send({ t: "session.input", id: sid, data: "", promptChoice: 1, ackId: "tap-r4" });
    check((await asked).body?.behavior === "allow", "…and answered by the tap");
    await until(() => !cur()?.prompt, 3000);

    // ── 5. An unknown plugin's sink ────────────────────────────────────
    const nope = await post(`${base}/api/plugin/nope/hook`, { hook_event_name: "x" });
    check(nope.status === 404 && /no plugin "nope"/.test(nope.body?.error ?? ""), `unknown plugin ⇒ 404 in words (${JSON.stringify(nope)})`);

    // ── 6. Switched off: hold released, backend gone, create refused ───
    const t2 = Date.now();
    const orphan = post(SINK, { hook_event_name: "permissionRequest", session_id: bsid, toolCallId: "call-3" });
    check(await until(() => cur()?.prompt?.askId === "call-3"), "a third request is held");
    send({ t: "plugin.enable", id: "stubcli", enabled: false });
    const r3 = await orphan;
    check(r3.status === 200 && Object.keys(r3.body ?? { x: 1 }).length === 0 && r3.at - t2 < HOLD_MS,
      `switching off answers a held hook {} at once (${JSON.stringify(r3.body)} after ${r3.at - t2} ms)`);
    check(await until(() => backends && !has("stubcli")), `the backend leaves the list (${backends?.map((b) => b.id).join(", ")})`);
    send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30, ackId: "create-2", launch: { backend: "stubcli" } });
    check(await until(() => ops.has("create-2")), "a create on it is answered");
    const refused = ops.get("create-2");
    check(refused?.ok === false && /stubcli/.test(refused?.reason ?? "") && /claude/.test(refused?.reason ?? ""),
      `…refused in words, naming it and what would work (${refused?.reason})`);
    const off = await post(SINK, { hook_event_name: "Stop", session_id: bsid });
    check(off.status === 404 && /turned off/.test(off.body?.error ?? ""), `its sink is a 404 in words (${JSON.stringify(off)})`);

    // ── 7. Back on: registered again ───────────────────────────────────
    send({ t: "plugin.enable", id: "stubcli", enabled: true });
    check(await until(() => has("stubcli")), "switching it back on registers the backend again");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  } finally {
    host.kill("SIGTERM");
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});

watchdog(() => { console.log("FAIL: timeout"); host.kill("SIGKILL"); process.exit(1); }, 90_000);
