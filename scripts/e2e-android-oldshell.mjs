// LAN security on a real Android WebView (emulator): pairing by typed code with no Tailscale, the
// pinned TLS route, a wrong pin, signed updates, the read ticket, <video>, the background link.
//
//   node scripts/e2e-android-lan.mjs [--only=1,2,3] [--keep]
//
// Needs: `npm run build`, a debug APK of THIS tree (`cd packages/app && npx cap sync android &&
// cd android && ./gradlew assembleDevDebug`; override with E2E_APK), the AVD `wp_p8pro_1`.
//
// Never touches the live host (:8770), the live state dir, or `emulator-5554`: the emulator is started
// here on a fixed console port (E2E_EMU_PORT, default 5700) and every adb call names its serial; the
// host is a scratch one on free ports in a temp root. A script that waits (boot, builds, timeouts):
// run it in the background and read the log. Raw log: .claude/outbox/lan-e2e/.
//
// ADDRESS ROUTE. The phone dials the Mac's own LAN address (192.168.x), not 10.0.2.2: the emulator
// NATs through the Mac, so a connection to the Mac's LAN IP arrives FROM that LAN IP and the host
// classes it `lan`; 10.0.2.2 arrives as loopback and gets no TLS listener. What this proves: the
// host/phone logic for a `lan` peer. What it does not: a real Wi-Fi hop, a real relay on the path.
import "./lib-tmuxiso.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, createPrivateKey, sign as cSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { createServer as httpCreate, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { WebSocket } from "ws";
import { freePort, waitForHost } from "./lib-e2e.mjs";
import { COMPOSER, closeSessions, delivered, personInput, tmuxPanes } from "./lib-android-input.mjs";
import { E, SLUG, STATE, WS_PROTOCOL, rootEnv, LS } from "./lib-brand.mjs";
import { BRAND, devApplicationId } from "../packages/shared/dist/brand.js";
import { lanIps } from "../packages/host/dist/net.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");
const OUT = process.env.E2E_OUT || join(dirname(fileURLToPath(import.meta.url)), "../.claude/outbox/lan-e2e");
const SDK = process.env.ANDROID_HOME || join(homedir(), "Library/Android/sdk");
const ADB = join(SDK, "platform-tools/adb");
const EMU = join(SDK, "emulator/emulator");
const AVD = "wp_p8pro_1";
const EMU_PORT = Number(process.env.E2E_EMU_PORT) || 5700;
if (EMU_PORT === 5554 || EMU_PORT === 5555) throw new Error("refusing the owner's emulator port");
const SERIAL = `emulator-${EMU_PORT}`;
const APK = process.env.E2E_APK || join(REPO, "packages/app/android/app/build/outputs/apk/dev/debug/app-dev-debug.apk");
const PKG = devApplicationId();
const OLD_PKG = BRAND.appId; // an older shell already on the AVD: no ShellTls (item 11)
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean).map(Number);
const want = (n) => only.length === 0 || only.includes(n);
const keep = process.argv.includes("--keep");

mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const logFile = createWriteStream(LOG);
const say = (s) => { console.log(s); logFile.write(s + "\n"); };
const raw = (s) => logFile.write(`  | ${String(s).replace(/\n/g, "\n  | ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
function verdict(n, kind, label, why = "") {
  if (kind === "FAIL") failed = true;
  results.push({ n, kind, label, why });
  say(`${kind}: [${n}] ${label}${why ? ` (${why})` : ""}`);
}
const pass = (n, label) => verdict(n, "PASS", label);
const fail = (n, label, why) => verdict(n, "FAIL", label, why);
const skip = (n, label, why) => verdict(n, "SKIP", label, why);
const check = (n, cond, label, why = "") => (cond ? pass(n, label) : fail(n, label, why));

/** Everything that was started here, killed at the end. */
const procs = [];
let emuStarted = false;
async function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  if (emuStarted && !keep) { adb(["emu", "kill"], 8000); }
  say(emuStarted && !keep ? `cleanup: emulator ${SERIAL} killed, scratch host stopped` : "cleanup: scratch host stopped (emulator left running: --keep)");
}
process.on("SIGINT", () => { void cleanup().then(() => process.exit(2)); });
const hang = setTimeout(() => { say("FAIL: e2e-android-lan hung (watchdog)"); void cleanup().then(() => process.exit(1)); }, Number(process.env.E2E_BUDGET_MS) || 25 * 60_000);
hang.unref();

// ── adb ──────────────────────────────────────────────────────────────────────────────────────────
function adb(args, timeout = 30_000) {
  const r = spawnSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}
const sh = (cmd, timeout) => adb(["shell", cmd], timeout);

async function bootEmulator() {
  if (spawnSync(ADB, ["-s", SERIAL, "get-state"], { encoding: "utf8" }).stdout.trim() !== "device") {
    const p = spawn(EMU, ["-avd", AVD, "-port", String(EMU_PORT), "-no-window", "-no-audio", "-no-snapshot-save", "-no-boot-anim", "-netdelay", "none", "-netspeed", "full"], { stdio: "ignore", detached: true });
    p.unref();
    emuStarted = true;
  }
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    if (sh("getprop sys.boot_completed", 5000).trim() === "1") break;
    await sleep(2000);
  }
  if (sh("getprop sys.boot_completed", 5000).trim() !== "1") throw new Error("emulator did not boot");
  await sleep(3000);
  say(`emulator ${SERIAL}: API ${sh("getprop ro.build.version.sdk")} ${sh("getprop ro.product.model")}`);
  const wv = sh("dumpsys webviewupdate | grep -i 'Current WebView package'");
  say(`webview: ${wv}`);
  return wv;
}

// ── the scratch host ─────────────────────────────────────────────────────────────────────────────
const lan = (() => {
  for (const ip of lanIps()) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return ip;
  }
  return null;
})();
const H = { proc: null, log: "", port: 0, tlsPort: 0, root: "", pw: "e2e-android-lan-pw" };
const keyFile = () => join(H.root, STATE, "lan-tls.json");
async function bootHost(knobs = {}) {
  H.log = "";
  const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(H.port), ...rootEnv(H.root), [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(H.tlsPort), [E.CLAUDE_BIN]: join(REPO, "scripts/claude-stub-tui.mjs"), [E.WS_COMPRESS]: "0", STUB_HOOKS: "1", STUB_LOG: join(H.root, "stub.log"), ...knobs }; // WS_COMPRESS=0: the relay reads the welcome frame to swap the advertised TLS port
  H.proc = spawn("node", [join(REPO, "packages/host/dist/main.js")], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(H.proc);
  H.proc.stdout.on("data", (d) => { H.log += d; });
  H.proc.stderr.on("data", (d) => { H.log += d; });
  await waitForHost(H.port);
}
const stopHost = () => new Promise((r) => { if (!H.proc || H.proc.exitCode !== null) return r(); H.proc.once("exit", r); H.proc.kill(); });
async function hostSays(re, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(H.log)) return true; await sleep(100); }
  return false;
}
const local = (p) => `http://127.0.0.1:${H.port}${p}`;
async function setPassword() {
  const ws = new WebSocket(`ws://127.0.0.1:${H.port}/ws`, [WS_PROTOCOL]);
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ t: "auth.set", password: H.pw }));
  for (let i = 0; i < 100; i++) { if ((await (await fetch(local("/api/auth/status"))).json()).enabled) break; await sleep(50); }
  ws.close();
}
async function mintCode() {
  const r = await (await fetch(local("/api/pair/mint"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  return r;
}
const spkiOfPem = (pem) => createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("hex");

// ── the page, through the WebView's DevTools socket ──────────────────────────────────────────────
const DT_PORT = 9400 + (EMU_PORT % 100);
function devtoolsSocket() {
  const app = sh(`pidof ${PKG}`, 5000).split(/\s+/).filter(Boolean);
  const unix = sh("cat /proc/net/unix", 8000);
  const m = [...unix.matchAll(/@?webview_devtools_remote_(\d+)/g)].map((x) => x[1]).filter((pid) => app.includes(pid));
  return m.length ? m[m.length - 1] : null;
}
async function pageTarget(timeout = 40_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const pid = devtoolsSocket();
    if (pid) {
      adb(["forward", `tcp:${DT_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
      try {
        const list = await (await fetch(`http://127.0.0.1:${DT_PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
        const pg = list.find((t) => t.type === "page" && /localhost/.test(t.url));
        if (pg) return pg;
      } catch { /* not up yet */ }
    }
    await sleep(700);
  }
  return null;
}
/** Evaluate in the page. A fresh socket per call: the page reloads under us more than once. */
async function ev(expr, { timeout = 30_000 } = {}) {
  const pg = await pageTarget(15_000);
  if (!pg) throw new Error("no page target");
  const ws = new WebSocket(pg.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${DT_PORT}`));
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.close(); reject(new Error("evaluate timed out")); }, timeout);
    ws.on("message", (m) => {
      const j = JSON.parse(m.toString());
      if (j.id !== 1) return;
      clearTimeout(t); ws.close();
      if (j.error) return reject(new Error(j.error.message));
      if (j.result.exceptionDetails) return reject(new Error(j.result.exceptionDetails.exception?.description || j.result.exceptionDetails.text));
      resolve(j.result.result.value);
    });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }));
  });
}
/**
 * The update manager's own `status`, read off the heap: `updates` is a module binding no global reaches, and
 * tapping through Settings for a sentence is how the earlier runs read nothing. `queryObjects` hands back every
 * object with Object.prototype on its chain; the manager is the one whose `status` has these three fields.
 */
async function updateStatus() {
  const pg = await pageTarget(15_000);
  if (!pg) throw new Error("no page target");
  const ws = new WebSocket(pg.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${DT_PORT}`));
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let id = 0;
  const waiting = new Map();
  ws.on("message", (m) => { const j = JSON.parse(m.toString()); const w = waiting.get(j.id); if (!w) return; waiting.delete(j.id); if (j.error) w.reject(new Error(j.error.message)); else w.resolve(j.result); });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const stop = setTimeout(() => { for (const w of waiting.values()) w.reject(new Error("status read timed out")); ws.close(); }, 20_000);
  try {
    const proto = await cdp("Runtime.evaluate", { expression: "Object.prototype", objectGroup: "wp" });
    const all = await cdp("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId, objectGroup: "wp" });
    const found = await cdp("Runtime.callFunctionOn", {
      objectId: all.objects.objectId, returnByValue: true,
      functionDeclaration: "function(){for(const o of this){try{const s=o&&o.status;if(s&&typeof s==='object'&&'phase' in s&&'stagedId' in s&&'lastCheckedAt' in s)return {phase:s.phase,message:s.message??null,trust:s.trust??null,current:s.current,available:s.available,stagedId:s.stagedId}}catch{/* a getter */}}return null}",
    });
    await cdp("Runtime.releaseObjectGroup", { objectGroup: "wp" });
    return found.result.value ?? null;
  } finally { clearTimeout(stop); ws.close(); }
}
const statusSafe = async () => { try { return await updateStatus(); } catch (e) { return { __error: String(e.message || e) }; } };
const evSafe = async (expr, o) => { try { return await ev(expr, o); } catch (e) { return { __error: String(e.message || e) }; } };
const bodyText = async () => (await evSafe("return document.body.innerText"))?.toString?.() ?? "";
async function until(fn, ms = 20_000, every = 400) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* page mid-reload */ } await sleep(every); }
  return false;
}
/** Tap the first visible button/link whose text matches. */
const tap = (re) => evSafe(`const re=new RegExp(${JSON.stringify(re)},'i');const el=[...document.querySelectorAll('button,a,[role=button]')].find(e=>re.test(e.innerText||e.textContent||'')&&e.offsetParent!==null);if(!el)return false;el.click();return true;`);
const setInput = (placeholderRe, value) => evSafe(`const re=new RegExp(${JSON.stringify(placeholderRe)},'i');const el=[...document.querySelectorAll('input,textarea')].find(e=>re.test(e.placeholder||''));if(!el)return false;const set=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
const savedRows = async () => evSafe(`const out={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(/hosts/i.test(k))out[k]=localStorage.getItem(k);}return out;`);
const plugin = (name, method, arg = {}) => evSafe(`return await window.Capacitor.Plugins.Shell${name}.${method}(${JSON.stringify(arg)});`);

function freshInstall() {
  sh(`am force-stop ${OLD_PKG}`);
  sh(`am force-stop ${PKG}`);
  sh(`pm clear ${PKG}`);
  sh("logcat -c");
}
const launch = () => { sh(`am start -W -n ${PKG}/${BRAND.appId}.MainActivity`, 30_000); };

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
const tapXY = ([x, y]) => sh(`input tap ${x} ${y}`);
// localStorage is flushed when the activity pauses, not on write: a force-stop straight after a patch loses it.
const blockSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const restartApp = () => { sh("input keyevent KEYCODE_HOME"); blockSleep(2500); sh(`am force-stop ${PKG}`); launch(); };
const patchRow = (patch) => evSafe(`const k=Object.keys(localStorage).find(k=>/hosts$/i.test(k));const l=JSON.parse(localStorage.getItem(k));const r=l.find(h=>h.id===${JSON.stringify(ctx.row?.id)});const p=${JSON.stringify(patch)};for(const [a,b] of Object.entries(p)){ if(b===null) delete r[a]; else r[a]=b; }localStorage.setItem(k,JSON.stringify(l));if(p.base)localStorage.setItem(k.replace(/hosts$/i,'hostBase'),p.base);return r;`);
const infoNow = () => plugin("Update", "info");
async function connected(ms = 30_000) {
  return until(async () => !/Connect to your desktop/i.test(await bodyText()) && (await evSafe("return document.body.innerText.length")) > 50, ms, 700);
}
const ctx = { row: null };
const person = personInput({ sh, ev: evSafe, until, sleep, raw, stubLog: () => join(H.root, "stub.log") });
/** Open a session on the repo row and send `words` as a person does: real taps, real keys, read off the pane. */
async function promptReaches(n, label, words) {
  try {
    await person.tap('button[title^="new session in e2erepo" i]');
    const open = await until(async () => (await evSafe(`return !!document.querySelector(${JSON.stringify(COMPOSER)})`)) === true, 20_000, 400);
    const drawn = await until(() => /[\u276f>]/.test(tmuxPanes()), 20_000, 500);
    raw(`session open ${!!open}, stub drawn ${!!drawn}`);
    await sleep(1500);
    raw("textareas in document order: " + JSON.stringify(await evSafe("return [...document.querySelectorAll('textarea')].map(e=>({cls:e.className,placeholder:e.placeholder,visible:!!e.offsetParent}))")));
    const r = await person.prompt(words);
    check(n, delivered(r), label, JSON.stringify(r));
  } catch (e) { fail(n, label, e.message || String(e)); }
  raw("pane after the prompt:\n" + tmuxPanes().slice(-800));
}
const fcp = () => evSafe("const p=performance.getEntriesByName('first-contentful-paint')[0];return p?Math.round(p.startTime):null");

// A loopback proxy in front of the host (the phone's address is the proxy's): passes everything, and in mode
// "badsig" flips one byte of the manifest's signature, so the JS layer's refusal can be seen on an old shell.
const PX = { port: 0, mode: "pass", forged: 0, log: [] };
function proxyStart() {
  const srv = httpCreate((req, res) => {
    const headers = { ...req.headers }; delete headers["accept-encoding"];
    const up = httpRequest({ host: "127.0.0.1", port: H.port, path: req.url, method: req.method, headers }, (ur) => {
      const path = req.url.split("?")[0];
      PX.log.push({ at: Date.now(), path });
      if (PX.mode === "badsig" && path === "/api/webbundle") {
        const chunks = []; ur.on("data", (c) => chunks.push(c));
        ur.on("end", () => {
          let body = Buffer.concat(chunks);
          try { const j = JSON.parse(body.toString()); if (j.sig) { const b = Buffer.from(j.sig, "base64"); b[3] ^= 1; j.sig = b.toString("base64"); body = Buffer.from(JSON.stringify(j)); PX.forged++; } } catch { /* not JSON */ }
          const h = { ...ur.headers, "content-length": String(body.length) }; delete h["transfer-encoding"];
          res.writeHead(ur.statusCode, h); res.end(body);
        });
        return;
      }
      res.writeHead(ur.statusCode, ur.headers); ur.pipe(res);
    });
    up.on("error", () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
    req.pipe(up);
  });
  srv.on("upgrade", (req, sock, head) => {
    const up = netConnect(H.port, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  return new Promise((r) => srv.listen(PX.port, "127.0.0.1", () => { procs.push({ kill: () => srv.close() }); r(); }));
}

async function main() {
  if (!lan) throw new Error("no private LAN IPv4");
  if (!existsSync(APK)) throw new Error(`no APK at ${APK}`);
  H.port = await freePort(); H.tlsPort = await freePort();
  H.root = mkdtempSync(join(tmpdir(), `${SLUG}-oldshell-`));
  mkdirSync(join(H.root, "e2erepo"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: join(H.root, "e2erepo") });
  const newBid = readFileSync(join(REPO, "packages/web/dist/build-id.txt"), "utf8").trim();
  say(`log ${LOG}\nold APK ${APK}\nscratch host root ${H.root} port ${H.port}; new web build id ${newBid}`);
  await bootEmulator();
  await bootHost();
  await setPassword();
  PX.port = await freePort(); await proxyStart();
  say(`host :${H.port} behind a loopback proxy :${PX.port}`);
  say("adb reverse: " + adb(["reverse", `tcp:${PX.port}`, `tcp:${PX.port}`]));
  say("install old APK: " + adb(["install", "-r", APK], 120_000).split("\n").pop());
  const m = await mintCode();
  say(`minted ${m.code}`);
  freshInstall();
  const t0 = Date.now(); launch(); const launchMs = Date.now() - t0;
  const pg = await pageTarget(60_000);
  if (!pg) return fail("a", "old page reachable", "no devtools socket");
  await sleep(3000);
  say(`OLD page: am start -W ${launchMs} ms, first-contentful-paint ${await fcp()} ms`);
  say("old plugins: " + JSON.stringify(await evSafe("return Object.keys(window.Capacitor.Plugins).filter(k=>/^Shell/.test(k))")));
  raw("first screen:\n" + (await bodyText()));
  await tap("pair with code");
  await sleep(600);
  raw("form:\n" + (await bodyText()));
  const addr = `127.0.0.1:${PX.port}`;
  await setInput("address", addr);
  await setInput("code", m.code);
  await sleep(500);
  await tap("^\\s*pair\\s*$");
  await sleep(8000);
  raw("after pair:\n" + (await bodyText()));
  raw("rows: " + JSON.stringify(await savedRows()));
  const info0 = await plugin("Update", "info");
  say("info after pairing: " + JSON.stringify(info0));
  const rows = await savedRows();
  const key = Object.keys(rows).find((k) => /hosts$/i.test(k));
  ctx.row = JSON.parse(rows[key])[0];
  say("row as the OLD page saved it: " + JSON.stringify(ctx.row));
  // c0: the control. The same real input on the OLD page, before the bundle changes: if this fails too, the
  // steps are at fault and not the new page. The new build is staged by now but runs only after a restart.
  await promptReaches("c0", "OLD page: a prompt typed with real keys and sent with a real tap reaches the session", "hello from the old page");
  say("closed sessions: " + await closeSessions(H.port, WS_PROTOCOL));
  // the old page stores the desktop's tailnet address; pin the row to the loopback route (the scenario's protected route)
  say("patched row: " + JSON.stringify(await patchRow({ base: `http://${addr}`, lan: null })));
  const oldPaint = { am: launchMs, fcp: await fcp() };
  // OTA: the old page staged the new bundle; restart into it (the app's own restart, as a person would)
  const t1 = Date.now();
  restartApp();
  await pageTarget(60_000);
  const amNew = Date.now() - t1;
  await sleep(3000);
  const info1 = await plugin("Update", "info");
  say("info after restart: " + JSON.stringify(info1));
  const served = await evSafe("return (await (await fetch('/build-id.txt')).text()).trim()");
  say(`page now serves build-id ${served}; expected ${newBid}`);
  const nativeFallback = !!info1?.badBuild;
  check("a", info1?.builtIn === false && String(info1?.staged).endsWith(newBid) && served === newBid && !nativeFallback, "new bundle installed into the old APK and running, no native fallback", JSON.stringify({ builtIn: info1?.builtIn, staged: info1?.staged, served, badBuild: info1?.badBuild, badReason: info1?.badReason }));
  // cold restart again: must open the bundle
  restartApp();
  await pageTarget(60_000);
  const up = await connected(45_000);
  const info2 = await plugin("Update", "info");
  const served2 = await evSafe("return (await (await fetch('/build-id.txt')).text()).trim()");
  check("a", !!up && served2 === newBid && info2?.builtIn === false && !info2?.badBuild, "cold restart opens the new bundle", JSON.stringify({ up: !!up, served2, builtIn: info2?.builtIn, badBuild: info2?.badBuild }));
  raw("page after cold restart:\n" + (await bodyText()));
  raw("rows now: " + JSON.stringify(await savedRows()));
  say("plugins now: " + JSON.stringify(await evSafe("return Object.keys(window.Capacitor.Plugins).filter(k=>/^Shell/.test(k))")));
  say(`paint: old am ${oldPaint.am} ms fcp ${oldPaint.fcp} ms; new fcp ${await fcp()} ms`);
  // b: socket + repo list
  const bt = await bodyText();
  check("b", /e2erepo/.test(bt) && !/Connect to your desktop/i.test(bt) && /synced/.test(bt), "socket connected and the desktop's repo list loaded (e2erepo shown)");
  // d: no lockout
  check("d", !/pair(ing)? (is )?needed|sign in|password|Connect to your desktop|refus|locked/i.test(bt), "no auth gate, no refusal screen, no card saying pairing is needed", bt.slice(0, 200).replace(/\n+/g, " | "));
  // e: page-held key from a protected welcome, shell holds no pin
  const r = JSON.parse((await savedRows())[key])[0];
  const shellTls = await evSafe("return typeof window.Capacitor.Plugins.ShellTls");
  check("e", typeof r.updateKey?.key === "string" && r.updateKey.key.length > 40 && shellTls === "undefined", "update key is on the row (JS pin), the shell has no ShellTls to hold a pin", JSON.stringify({ updateKey: !!r.updateKey, gen: r.updateKey?.gen, shellTls }));
  // c: a session
  const labels = await evSafe("return [...document.querySelectorAll('button,[role=button]')].filter(e=>e.offsetParent).map(e=>(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,40)).filter(Boolean)");
  raw("buttons: " + JSON.stringify(labels));
  raw("titles: " + JSON.stringify(await evSafe("return [...document.querySelectorAll('button')].filter(e=>e.offsetParent).map(e=>e.title).filter(Boolean)")));
  await promptReaches("c", "NEW page over the air: a prompt typed with real keys and sent with a real tap reaches the session", "hello from the new page");
  say("closed sessions: " + await closeSessions(H.port, WS_PROTOCOL));
  const body = (m) => JSON.parse(Buffer.from(m.signed, "base64").toString());
  const rowNow = async () => JSON.parse((await savedRows())[key])[0];
  const gen0 = (await rowNow()).updateKey?.gen;

  // g. first paint of the new page on a cold start (old page measured at the end, once the watchdog has put it back)
  const coldFcp = async () => { const t = Date.now(); restartApp(); await pageTarget(60_000); await connected(45_000); const wall = Date.now() - t; await sleep(1500); return { fcp: await fcp(), wall }; };
  const newPaints = []; for (let k = 0; k < 3; k++) newPaints.push(await coldFcp());
  say("g. new page cold starts (fcp ms, wall to connected ms): " + JSON.stringify(newPaints));

  // i. a plain LAN row on the old APK: the host addressed on the Mac's LAN address
  await patchRow({ base: `http://${lan}:${H.port}` });
  restartApp(); await pageTarget(60_000);
  const lanUp = await connected(45_000);
  await until(async () => /synced/.test(await bodyText()), 20_000, 700); const lanText = await bodyText();
  raw("plain LAN row page:\n" + lanText.slice(0, 1200));
  raw("host log (LAN dial): " + H.log.split("\n").filter((l) => /192\.168|lan/i.test(l)).slice(-3).join(" | "));
  check("i", !!lanUp && /e2erepo/.test(lanText) && /synced/.test(lanText), "a plain LAN row on the old APK connects and lists repos", lanText.slice(0, 160).replace(/\n+/g, " | "));
  say("i. LAN row warning words on screen: " + JSON.stringify(lanText.match(/[^\n]*(plain|unprotected|not encrypted|LAN|wifi|wi-fi)[^\n]*/gi)));
  await patchRow({ base: `http://${addr}` });
  restartApp(); await pageTarget(60_000); await connected(45_000);

  // h. a second desktop paired by code from the new page
  const root2 = mkdtempSync(join(tmpdir(), `${SLUG}-oldshell2-`));
  mkdirSync(join(root2, "repo2"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: join(root2, "repo2") });
  const port2 = await freePort(), px2 = port2;
  const h2 = spawn("node", [join(REPO, "packages/host/dist/main.js")], { env: { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(port2), ...rootEnv(root2), [E.ALLOW_PUBLIC]: "1", [E.TLS_PORT]: String(await freePort()), [E.CLAUDE_BIN]: join(REPO, "scripts/claude-stub.sh"), [E.WS_COMPRESS]: "0" }, cwd: REPO, stdio: "ignore" });
  procs.push(h2);
  await waitForHost(port2);
  adb(["reverse", `tcp:${px2}`, `tcp:${px2}`]);
  { const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`, [WS_PROTOCOL]); await new Promise((r) => ws.once("open", r)); ws.send(JSON.stringify({ t: "auth.set", password: H.pw })); for (let i = 0; i < 100; i++) { if ((await (await fetch(`http://127.0.0.1:${port2}/api/auth/status`)).json()).enabled) break; await sleep(50); } ws.close(); }
  const m2 = await (await fetch(`http://127.0.0.1:${port2}/api/pair/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  say(`h. second desktop :${port2}, code ${m2.code}`);
  const walk = [];
  const snap = async (l) => { walk.push(`--- ${l}\n` + (await bodyText()).slice(0, 700)); };
  await evSafe("const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent&&/^settings/i.test(e.title||''));b&&b.click();return !!b"); await sleep(1500);
  await snap("settings");
  say("h. tap hosts-ish: " + JSON.stringify(await tap("desktops|hosts|add a desktop|pair another|pair a desktop")));
  await sleep(1500); await snap("after hosts tap");
  say("h. tap add: " + JSON.stringify(await tap("^\\s*add\\s*$")));
  await sleep(1500); await snap("after add");
  say("h. tap pair with code: " + JSON.stringify(await tap("pair with code")));
  await sleep(1500); await snap("after pair-with-code");
  say("h. fill: " + JSON.stringify([await setInput("address", `127.0.0.1:${px2}`), await setInput("code", m2.code)]));
  await sleep(500);
  say("h. tap pair: " + JSON.stringify(await tap("^\\s*pair\\s*$")));
  await sleep(8000); await snap("after pair");
  raw("h walk:\n" + walk.join("\n"));
  const rows2 = JSON.parse((await savedRows())[key]);
  raw("h rows: " + JSON.stringify(rows2));
  const r2 = rows2.find((x) => String(x.base).includes(`:${px2}`));
  check("h", !!r2 && !!r2.hostId && !!r2.updateKey, "a second desktop paired by code from the new page on the old APK (CPace)", JSON.stringify(r2 ?? rows2.map((x) => x.base)));
  // back to desktop 1 as the only row, so the update steps below talk to the host they were set up for
  await evSafe(`const k=Object.keys(localStorage).find(k=>/hosts$/i.test(k));const l=JSON.parse(localStorage.getItem(k)).filter(h=>h.id===${JSON.stringify(ctx.row.id)});localStorage.setItem(k,JSON.stringify(l));localStorage.setItem(k.replace(/hosts$/i,'hostActive'),${JSON.stringify(ctx.row.id)});localStorage.setItem(k.replace(/hosts$/i,'hostBase'),${JSON.stringify(`http://${addr}`)});return 1`);
  restartApp(); await pageTarget(60_000); await connected(45_000);

  // f. a later genuine update from the same host: serve a newer build (this worktree's dist, restored after)
  const distDir = join(REPO, "packages/web/dist");
  const idx = join(distDir, "index.html"), bidFile = join(distDir, "build-id.txt");
  const orig = readFileSync(idx, "utf8"), bidOrig = readFileSync(bidFile, "utf8");
  const MARK = "e2e-oldshell";
  const serve = async (tag, html) => {
    writeFileSync(idx, html ?? orig.replace("</body>", `<!-- ${MARK} ${tag} --></body>`));
    const id = createHash("sha256").update(bidOrig.trim() + tag).digest("hex").slice(0, 16);
    writeFileSync(bidFile, id + "\n");
    await stopHost(); await bootHost(); await hostSays(/listening http:\/\/127/);
    return id;
  };
  const staged = async (id, ms = 90_000) => until(async () => { const i = await plugin("Update", "info"); return String(i?.staged ?? "").endsWith(`/${id}`) ? i : false; }, ms, 2000);
  const runs = async (tag) => (await evSafe(`return document.documentElement.outerHTML.includes(${JSON.stringify(`${MARK} ${tag}`)})`)) === true;
  try {
    const id1 = await serve("one");
    restartApp();
    const got = await staged(id1);
    const st1 = await statusSafe();
    say("f. update status after genuine offer: " + JSON.stringify(st1));
    if (got) { restartApp(); await pageTarget(60_000); await connected(45_000); }
    const gen1 = (await rowNow()).updateKey?.gen;
    const hostGen = body(await (await fetch(local("/api/webbundle"))).json()).gen;
    const iNow = await plugin("Update", "info");
    check("f", !!got && (await runs("one")) && iNow?.builtIn === false, "a later genuine update from that host installs and runs", JSON.stringify({ staged: got?.staged, st: st1 }));
    check("f", typeof gen1 === "number" && gen1 > gen0 && gen1 === hostGen, "the page's update key high-water gen rose", `gen ${gen0} -> ${gen1}, host signs gen ${hostGen}`);
    // forged: bad signature at the proxy
    const id2 = await serve("two");
    PX.mode = "badsig"; PX.forged = 0;
    restartApp();
    const st2 = await until(async () => { const s = await updateStatus(); return /signature|refus/i.test(s?.message ?? "") ? s : false; }, 60_000, 2000) || await statusSafe();
    const i2 = await plugin("Update", "info");
    say("f. forged: " + JSON.stringify(st2) + " proxy forged " + PX.forged);
    check("f", PX.forged >= 1 && !String(i2?.staged).endsWith(id2) && /signature/i.test(st2?.message ?? "") && st2?.phase === "refused", "a bundle with a bad signature is refused by the JS layer on the old shell", JSON.stringify({ st2, staged: i2?.staged, forged: PX.forged }));
    check("f", await runs("one"), "and the app keeps running the build it had");
    PX.mode = "pass";
    // j. a bundle that cannot boot: a page with no script, served genuinely; the native watchdog should roll back
    const id3 = await serve("three", "<!doctype html><html><head><title>broken</title></head><body>broken-bundle</body></html>");
    restartApp();
    const got3 = await staged(id3);
    say("j. broken bundle staged: " + !!got3);
    if (!got3) skip("j", "native watchdog rolls back a bundle that fails to boot", "the broken bundle was not staged: " + JSON.stringify(await statusSafe()));
    else {
      restartApp(); await pageTarget(30_000);
      const seen = [];
      const rolled = await until(async () => { const i = await plugin("Update", "info"); const t = await bodyText(); seen.push((i?.builtIn) + ":" + /broken-bundle/.test(t)); return i?.builtIn === true || (i?.badBuild && i.badBuild.includes(id3)) ? i : false; }, 120_000, 3000);
      const fin = await plugin("Update", "info");
      say("j. after the watchdog window: " + JSON.stringify(fin) + " seen " + seen.join(","));
      check("j", !!rolled && /Connect to your desktop|Start here|SESSIONS/.test(await bodyText()), "the native watchdog rolled back from a bundle that never booted", JSON.stringify(fin));
    }
  } finally {
    PX.mode = "pass";
    writeFileSync(idx, orig); writeFileSync(bidFile, bidOrig);
  }
  { const oldPaints = []; for (let k = 0; k < 3; k++) { const t = Date.now(); restartApp(); await pageTarget(60_000); await sleep(2500); oldPaints.push({ fcp: await fcp(), wall: Date.now() - t }); }
    say("g. OLD built-in page cold starts (fcp ms): " + JSON.stringify(oldPaints) + " | new: " + JSON.stringify(newPaints));
    const med = (a) => a.map((x) => x.fcp).filter((x) => x != null).sort((p, q) => p - q)[1];
    check("g", med(newPaints) != null && med(newPaints) < 5000 && med(newPaints) < (med(oldPaints) ?? 1e9) * 3 + 500, "the new page paints promptly on a cold start, not hung on seedRouteNet", `median fcp new ${med(newPaints)} ms vs old ${med(oldPaints)} ms`); }
  say("host log tail:\n" + H.log.slice(-300));
}
main().catch((e) => { say(`FAIL: harness: ${e.stack || e}`); failed = true; }).finally(async () => {
  say("\n── summary ──");
  for (const r of results) say(`${r.kind} [${r.n}] ${r.label}${r.why ? ` (${r.why})` : ""}`);
  await stopHost(); await cleanup();
  process.exit(failed ? 1 : 0);
});
