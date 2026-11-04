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
const ctx = { rows: null, row: null, token: null };

async function item1_pair() {
  const n = 1;
  const m = await mintCode();
  ctx.mint = m;
  say(`minted code ${m.code}; lan ${lan}; plain :${H.port}; tls :${H.tlsPort}`);
  freshInstall(); launch();
  const pg = await pageTarget(60_000);
  if (!pg) return fail(n, "the app's page is reachable over DevTools", "no webview_devtools_remote socket");
  await sleep(3000);
  raw("first screen:\n" + (await bodyText()));
  check(n, (await evSafe("return typeof window.Capacitor.Plugins.ShellTls")) === "object", "the shell under test has ShellTls");
  await tap("pair with code");
  await sleep(600);
  const addr = `${lan}:${H.port}`;
  await setInput("desktop address", addr);
  await setInput("pairing code", m.code);
  await sleep(500);
  raw("form:\n" + (await bodyText()));
  await tap("^\\s*pair\\s*$");
  // a confirm may come up (a sealed pairing asks nothing; a plain one does)
  const outcome = await until(async () => {
    const t = await bodyText();
    const rows = await savedRows();
    if (rows && Object.values(rows).some((v) => String(v).includes(addr))) return "saved";
    if (/not sent|unreachable|cannot|refus|wrong|expired/i.test(t) && !/pair with code/i.test(t)) return "problem:" + t.slice(0, 300);
    return false;
  }, 45_000, 700);
  raw("after pair:\n" + (await bodyText()));
  raw("rows: " + JSON.stringify(await savedRows()));
  if (outcome !== "saved") return fail(n, "pair a fresh install by typed code over CPace", String(outcome));
  await sleep(2500);
  const rows = await savedRows();
  const key = Object.keys(rows).find((k) => /hosts$/i.test(k)) || Object.keys(rows)[0];
  let list = [];
  try { list = JSON.parse(rows[key]); } catch { /* shape differs */ }
  ctx.row = list.find((h) => h.base?.includes(addr)) || null;
  say("row: " + JSON.stringify(ctx.row));
  const r = ctx.row;
  check(n, !!r && r.base === `http://${addr}`, "row saved at the address that was typed", r?.base);
  check(n, !!r?.hostId, "row holds the desktop's hostId");
  const want = spkiOfPem(JSON.parse(readFileSync(keyFile(), "utf8")).cert);
  check(n, r?.tls?.spki === want && r?.tls?.port === H.tlsPort, "row holds the TLS pin (the leaf's SPKI) and port", JSON.stringify(r?.tls));
  check(n, typeof r?.updateKey?.key === "string" && r.updateKey.key.length > 40, "row holds the update key");
  const pins = await plugin("Tls", "list");
  check(n, pins?.pins?.some((p) => p.hostId === r?.id && p.spki === want), "the shell holds the pin under the row id", JSON.stringify(pins));
  return true;
}

// ── a relay between the phone and the host: sees every request by route, forges what it is told ──
// THE RELAY HOLDS THE PORT THE HOST ADVERTISES. The page re-learns `tls.port` from the host's welcome frame
// after every reload, so a relay on its own port is bypassed the moment the page dials the host's real TLS
// port. The relay therefore (1) terminates TLS with the HOST'S OWN key and leaf, so the phone's SPKI pin
// holds on the relay (a forger cannot hold that key in life; this test is about the SIGNATURE check on the
// update, not TLS, so the relay holding the leaf is fine), and (2) rewrites `"tlsPort":<real>` in the
// welcome frame to the relay's own port (same digit count, so the WebSocket frame length is unchanged).
// Every dial then lands on the relay however often the page re-learns the port.
const R = { plain: 0, tls: 0, mode: "pass", log: [], servers: [], m1: null, m2: null, snap: null, badPath: null, forged: 0, ws: [], welcomes: 0, socks: new Set() };
async function relayPorts() {
  if (R.tls) return;
  for (let i = 0; i < 50 && !R.tls; i++) { const p = await freePort(); if (String(p).length === String(H.tlsPort).length && p !== H.tlsPort) R.tls = p; }
  if (!R.tls) throw new Error("no free port with the digit count of the advertised TLS port");
}
/** A server -> client byte stream with the advertised TLS port swapped for the relay's. */
function welcomeRewrite(sock) {
  const real = Buffer.from(`"tlsPort":${H.tlsPort}`), mine = Buffer.from(`"tlsPort":${R.tls}`);
  return new Transform({ transform(chunk, _e, cb) {
    let b = chunk;
    const i = b.indexOf(real);
    if (i >= 0) { b = Buffer.from(b); mine.copy(b, i); R.welcomes++; }
    cb(null, b);
  } }).on("error", () => sock.destroy());
}
function relayStart() {
  const cert = JSON.parse(readFileSync(keyFile(), "utf8"));
  const fwd = (route) => (req, res) => {
    const tlsRoute = route === "tls";
    R.log.push({ route, method: req.method, path: req.url, auth: !!req.headers.authorization, at: Date.now() });
    const headers = { ...req.headers, host: `${lan}:${tlsRoute ? H.tlsPort : H.port}` };
    delete headers["accept-encoding"]; // the host brotli-compresses a manifest for a WebView, and a compressed body is one this relay can neither read nor forge
    const mk = tlsRoute ? httpsRequest : httpRequest;
    const up = mk({ host: lan, port: tlsRoute ? H.tlsPort : H.port, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (ur) => {
      const chunks = [];
      ur.on("data", (d) => chunks.push(d));
      ur.on("end", () => {
        let body = Buffer.concat(chunks);
        const h = { ...ur.headers };
        const isManifest = /^\/api\/webbundle(\?|$)/.test(req.url);
        const isFile = /^\/api\/webbundle\/file/.test(req.url);
        if (isManifest && ur.statusCode === 200) {
          try {
            const j = JSON.parse(body.toString());
            if (!R.m1 && j.signed) R.m1 = j;
            if (R.mode === "pass" && j.signed) R.m2 = j;
            if (R.mode === "strip") { delete j.signed; delete j.sig; body = Buffer.from(JSON.stringify(j)); R.forged++; }
            if (R.mode === "badsig" && j.sig) { const b = Buffer.from(j.sig, "base64"); b[3] ^= 1; j.sig = b.toString("base64"); body = Buffer.from(JSON.stringify(j)); R.forged++; }
            if (R.mode === "old" && R.m1) { body = Buffer.from(JSON.stringify(R.m1)); R.forged++; }
          } catch (e) { raw(`relay: a manifest it cannot read, so nothing was forged: ${e.message}`); }
        }
        if (isFile && R.mode === "old" && R.snap) {
          // the OLD manifest's own files (from before the host's bundle changed), so only the gen can be wrong
          try { const rel = new URL(req.url, "http://x").searchParams.get("path") || ""; if (!rel.includes("..")) body = readFileSync(join(R.snap, rel)); } catch { /* keep the host's */ }
        }
        if (isFile && R.mode === "badbyte" && body.length > 0 && new URL(req.url, "http://x").searchParams.get("path") === R.badPath) { body = Buffer.from(body); body[Math.floor(body.length / 2)] ^= 1; R.forged++; } // ONE byte of ONE file: the last, so every file before it passes its hash
        delete h["content-length"]; delete h["transfer-encoding"];
        res.writeHead(ur.statusCode, { ...h, "content-length": body.length });
        res.end(body);
      });
    });
    up.on("error", () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
    req.pipe(up);
  };
  const upgrade = (route) => (req, sock, head) => {
    const tlsRoute = route === "tls";
    R.ws.push({ route, path: req.url, at: Date.now(), ua: String(req.headers["user-agent"] || "") });
    R.socks.add(sock); sock.on("close", () => R.socks.delete(sock)); // an upgraded socket is no longer the server's: closeAllConnections misses it
    const onUp = (u) => {
      const hh = { ...req.headers, host: `${lan}:${tlsRoute ? H.tlsPort : H.port}` };
      u.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(hh).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head?.length) u.write(head);
      u.pipe(welcomeRewrite(sock)).pipe(sock); sock.pipe(u);
      u.on("error", () => sock.destroy()); sock.on("error", () => u.destroy());
    };
    const u = tlsRoute ? tlsConnect({ host: lan, port: H.tlsPort, rejectUnauthorized: false }, () => onUp(u)) : netConnect({ host: lan, port: H.port }, () => onUp(u));
    u.on("error", () => sock.destroy());
  };
  const plain = httpCreate(fwd("plain")); plain.on("upgrade", upgrade("plain"));
  const tls = httpsServer({ key: cert.key, cert: cert.cert }, fwd("tls")); tls.on("upgrade", upgrade("tls"));
  return relayPorts().then(() => new Promise((resolve) => {
    plain.listen(R.plain || 0, "0.0.0.0", () => {
      tls.listen(R.tls || 0, "0.0.0.0", () => {
        R.plain = plain.address().port; R.tls = tls.address().port;
        R.servers = [plain, tls];
        resolve();
      });
    });
  }));
}
const relayStop = () => new Promise((res) => {
  for (const k of [...R.socks]) { try { k.destroy(); } catch { /* gone */ } }
  R.socks.clear();
  const all = R.servers; R.servers = [];
  if (!all.length) return res();
  let n = all.length;
  for (const s of all) { try { s.closeAllConnections?.(); s.close(() => { if (--n === 0) res(); }); } catch { if (--n === 0) res(); } }
  setTimeout(res, 3000);
});
const since = (t) => R.log.filter((r) => r.at >= t);

// ── the native dialog (AlertDialog is page-proof: drive it from outside, with uiautomator) ──
function uiDump() {
  sh("uiautomator dump /sdcard/wp-ui.xml", 20_000);
  return sh("cat /sdcard/wp-ui.xml", 10_000);
}
function dialogButtons() {
  const x = uiDump();
  const btn = (id) => {
    const m = x.match(new RegExp(`resource-id="android:id/${id}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)) || x.match(new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*?resource-id="android:id/${id}"`));
    return m ? [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)] : null;
  };
  return { yes: btn("button1"), no: btn("button2"), text: [...x.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(" | ") };
}
const tapXY = ([x, y]) => sh(`input tap ${x} ${y}`);
// localStorage is flushed when the activity pauses, not on write: a force-stop straight after a patch loses it.
const blockSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const restartApp = () => { sh("input keyevent KEYCODE_HOME"); blockSleep(2500); sh(`am force-stop ${PKG}`); launch(); };
const patchRow = (patch) => evSafe(`const k=Object.keys(localStorage).find(k=>/hosts$/i.test(k));const l=JSON.parse(localStorage.getItem(k));const r=l.find(h=>h.id===${JSON.stringify(ctx.row?.id)});const p=${JSON.stringify(patch)};for(const [a,b] of Object.entries(p)){ if(b===null) delete r[a]; else r[a]=b; }localStorage.setItem(k,JSON.stringify(l));if(p.base)localStorage.setItem(k.replace(/hosts$/i,'hostBase'),p.base);return r;`);
const infoNow = () => plugin("Update", "info");
async function connected(ms = 30_000) {
  return until(async () => !/Connect to your desktop/i.test(await bodyText()) && (await evSafe("return document.body.innerText.length")) > 50, ms, 700);
}
async function step(n, label, fn) {
  if (!want(n)) return;
  try { await fn(); } catch (e) { fail(n, label, `harness error: ${e.message || e}`); }
}

async function main() {
  if (!lan) throw new Error("this machine has no private LAN IPv4");
  if (!existsSync(APK)) throw new Error(`no APK at ${APK}`);
  H.port = await freePort(); H.tlsPort = await freePort();
  H.root = mkdtempSync(join(tmpdir(), `${SLUG}-andlan-`));
  say(`log ${LOG}`);
  say(`scratch host root ${H.root}  (plain :${H.port}, tls :${H.tlsPort}); phone dials the Mac's LAN address ${lan}`);
  // an artifact for items 7 and 8
  const repo = join(H.root, "e2erepo");
  mkdirSync(join(repo, ".claude/outbox"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(repo, ".claude/outbox/clip.mp4")]);
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", join(repo, ".claude/outbox/pic.png")]);
  await bootEmulator();
  await bootHost();
  await setPassword();
  check(0, await hostSays(/listening https:/), "scratch host: TLS listener up");
  say("install: " + adb(["install", "-r", APK], 120_000).split("\n").pop());
  await item1_pair();
  if (!ctx.row) return;
  const origKey = readFileSync(keyFile(), "utf8");

  // from here the phone reaches the host through the relay (same key, so the pin is the real one)
  await relayStart();
  say(`relay: plain :${R.plain} tls :${R.tls}`);
  await patchRow({ base: `http://${lan}:${R.plain}`, tls: { port: R.tls, spki: ctx.row.tls.spki } });

  await step(6, "native key dialog", async () => {
    const n = 6;
    restartApp();
    await pageTarget(40_000);
    let d = null;
    await until(async () => { d = dialogButtons(); return d.yes && d.no; }, 40_000, 1500);
    raw("dialog: " + JSON.stringify(d));
    if (!d?.yes) return fail(n, "the native dialog for a new update key appears", "no AlertDialog found; " + (d?.text || "").slice(0, 200));
    pass(n, "the native dialog for a new update key appears: " + (d.text || "").slice(0, 120));
    tapXY(d.no);
    await sleep(2500);
    const alive = sh(`pidof ${PKG}`).trim() !== "" && (await evSafe("return document.body.innerText.length")) > 0;
    const info = await infoNow();
    check(n, alive && (info?.updateKeys?.length ?? 0) === 0, "declining it leaves the app running and the key unpinned", JSON.stringify(info?.updateKeys));
    restartApp();
    await pageTarget(40_000);
    d = null;
    await until(async () => { d = dialogButtons(); return d.yes && d.no; }, 40_000, 1500);
    if (d?.yes) { tapXY(d.yes); await sleep(2500); }
    const info2 = await infoNow();
    check(n, (info2?.updateKeys?.length ?? 0) === 1, "accepting it pins the desktop's update key in the shell", JSON.stringify(info2?.updateKeys));
  });

  await step(2, "route", async () => {
    const n = 2;
    await connected();
    await sleep(8000);
    const viaTls = R.log.filter((r) => r.route === "tls");
    const viaPlain = R.log.filter((r) => r.route === "plain");
    const wsTls = R.ws.filter((r) => r.route === "tls").length, wsPlain = R.ws.filter((r) => r.route === "plain").length;
    raw(`relay since the pairing: tls ${viaTls.length} requests, ws ${wsTls}; plain ${viaPlain.length} requests, ws ${wsPlain}`);
    raw("plain paths: " + viaPlain.map((r) => `${r.method} ${r.path.split("?")[0]} auth=${r.auth}`).join("; "));
    check(n, wsTls >= 1, "the WebSocket is dialled over https:// with the pin held", `ws over tls ${wsTls}`);
    check(n, viaTls.some((r) => /^\/api\//.test(r.path)), "/api/* goes over the TLS port");
    check(n, wsPlain === 0, "no WebSocket on the plain port", `plain ws ${wsPlain}`);
    check(n, !viaPlain.some((r) => r.auth || /[?&]wt=/.test(r.path)), "no token (Authorization or ticket) ever crosses the plain port");
    check(n, !viaPlain.some((r) => /^\/api\/(?!health|pair|lan)/.test(r.path)), "no /api/* call on the plain port", viaPlain.map((r) => r.path.split("?")[0]).join(","));
  });

  await step(12, "a prompt through the pinned link", async () => {
    const n = 12, words = "hello through the pinned link";
    const person = personInput({ sh, ev: evSafe, until, sleep, raw, stubLog: () => join(H.root, "stub.log") });
    const t = Date.now();
    await person.tap('button[title^="new session in e2erepo" i]');
    await until(async () => (await evSafe(`return !!document.querySelector(${JSON.stringify(COMPOSER)})`)) === true, 20_000, 400);
    await until(() => /[\u276f>]/.test(tmuxPanes()), 20_000, 500);
    await sleep(1500);
    const r = await person.prompt(words);
    raw("pane after the prompt:\n" + tmuxPanes().slice(-800));
    check(n, delivered(r), "a prompt typed with real keys and sent with a real tap reaches the session", JSON.stringify(r));
    const plainWs = R.ws.filter((w) => w.route === "plain" && w.at >= t).length;
    const plainApi = R.log.filter((q) => q.route === "plain" && q.at >= t && /^\/api\/(?!health|pair|lan)/.test(q.path)).length;
    check(n, plainWs === 0 && plainApi === 0, "it went over the pinned TLS port: no socket and no /api/* on the plain port while it was sent", `plain ws ${plainWs}, plain api ${plainApi}`);
    say("closed sessions: " + await closeSessions(H.port, WS_PROTOCOL));
  });

  await step(7, "read ticket + media", async () => {
    const repos = await (await fetch(local("/api/repos"))).json().catch(() => null);
    raw("repos: " + JSON.stringify(repos)?.slice(0, 300));
    const list = repos?.targets ?? (Array.isArray(repos) ? repos : []);
    const id = list.find((x) => /e2erepo/.test(JSON.stringify(x)))?.id ?? "e2erepo";
    const tok = await evSafe(`const o={};for(const k of Object.keys(localStorage)){const v=localStorage.getItem(k);if(/^[0-9a-f]{40,}$/i.test(v)||/^[A-Za-z0-9_-]{40,}$/.test(v))o[k]=v;}return o`);
    raw("token-ish keys: " + Object.keys(tok || {}).join(","));
    const bearer = Object.values(tok || {})[0];
    const base = `https://${lan}:${R.tls}`;
    let wt = null;
    if (bearer) wt = await evSafe(`const r=await fetch(${JSON.stringify(base + "/api/auth/read-ticket")},{method:"POST",headers:{authorization:"Bearer "+${JSON.stringify(bearer)}}});return (await r.json()).ticket`);
    if (!wt || wt.__error) { skip(7, "read ticket <img>", "could not mint a ticket from the page: " + JSON.stringify(wt)); skip(8, "<video> over the pinned TLS port", "no ticket"); return; }
    const url = (name) => `${base}/api/repos/${id}/artifact?path=${encodeURIComponent(".claude/outbox/" + name)}&wt=${encodeURIComponent(wt)}`;
    const img = await evSafe(`return await new Promise(r=>{const i=new Image();i.onload=()=>r('ok '+i.naturalWidth);i.onerror=()=>r('error');i.src=${JSON.stringify(url("pic.png"))};setTimeout(()=>r('timeout'),15000)})`);
    check(7, /^ok/.test(String(img)), "<img> of an artifact loads over the pinned TLS port with a read ticket", String(img));
    const vid = await evSafe(`return await new Promise(r=>{const v=document.createElement('video');v.muted=true;v.preload='auto';v.onloadeddata=()=>r('ok '+v.videoWidth+'x'+v.videoHeight+' dur '+v.duration);v.onerror=()=>r('error '+(v.error&&v.error.code));v.src=${JSON.stringify(url("clip.mp4"))};setTimeout(()=>r('timeout'),20000)})`);
    check(8, /^ok/.test(String(vid)), "<video> loads its first frame over the pinned TLS port", String(vid));
    const pu = `http://${lan}:${R.plain}/api/repos/${id}/artifact?path=${encodeURIComponent(".claude/outbox/pic.png")}&wt=${encodeURIComponent(wt)}`;
    const plainImg = await evSafe(`return await new Promise(r=>{const i=new Image();i.onload=()=>r('ok');i.onerror=()=>r('error');i.src=${JSON.stringify(pu)};setTimeout(()=>r('timeout'),15000)})`);
    check(7, String(plainImg) !== "ok", "the same ticket on the plain port does not serve the image", String(plainImg));
  });

  // ── 5: signed updates, forged at the relay (a-f) ──
  await step(5, "signed update", async () => {
    const n = 5;
    const distDir = join(REPO, "packages/web/dist"); // THIS worktree's dist, never the live checkout's
    const idx = join(distDir, "index.html");
    const orig = readFileSync(idx, "utf8");
    const bidFile = join(distDir, "build-id.txt"); // the host's buildId is this file, NOT a hash of the files: a changed index alone is "no new build"
    const bidOrig = readFileSync(bidFile, "utf8");
    const MARK = "e2e-android-lan";
    const snap = mkdtempSync(join(tmpdir(), `${SLUG}-snap-`));
    cpSync(distDir, snap, { recursive: true }); // the OLD bundle's files, for the replayed old manifest
    R.snap = snap;
    const runs = async (tag) => (await evSafe(`return document.documentElement.outerHTML.includes(${JSON.stringify(`${MARK} ${tag}`)})`)) === true;
    const seen = async () => ((await bodyText()) + " | " + String(await evSafe("return localStorage.getItem('" + LS + "toastLog')"))).replace(/\n+/g, " / ");
    const opens = async (label) => { // a cold restart: the app must come up and show the app, not a blank page
      restartApp();
      await pageTarget(40_000);
      const ok = await connected(40_000);
      check(n, !!ok, `${label}: after a cold restart the app opens`);
    };
    /**
     * Serve a newer build. The host's buildId is `build-id.txt`, NOT a hash of the files, and the id has to be one
     * a phone accepts: `readSigned` and `ShellBundleVerify` both hold it to /^[a-f0-9]{8,64}$/. A suffix like
     * "-e2e" is refused as bad-manifest, and that refusal once read as a product fault for two whole runs.
     */
    const serve = async (tag) => {
      writeFileSync(idx, orig.replace("</body>", `<!-- ${MARK} ${tag} --></body>`));
      const id = createHash("sha256").update(bidOrig.trim() + tag).digest("hex").slice(0, 16);
      writeFileSync(bidFile, id + "\n");
      await stopHost(); await bootHost(); await hostSays(/listening https:/);
      return id;
    };
    const body = (m) => JSON.parse(Buffer.from(m.signed, "base64").toString());
    const askedSince = (t) => since(t).filter((r) => /^\/api\/webbundle/.test(r.path));
    const filesSince = (t) => since(t).filter((r) => /^\/api\/webbundle\/file/.test(r.path));
    /**
     * How far GENUINE traffic got. Every forged mode refuses to pass until this says the same steps work unforged:
     * a phone that refuses everything looks exactly like one that refuses forgeries, and did, for three PASS lines.
     */
    const reached = { files: 0, runs: false };
    const genuine = async (id, tag, label) => {
      R.mode = "pass";
      const t = Date.now();
      restartApp();
      const got = await until(async () => { const i = await infoNow(); return String(i?.staged ?? "").endsWith(`/${id}`) ? i : false; }, 90_000, 2000);
      const st = await statusSafe();
      say(`${label}: update status ${JSON.stringify(st)}`);
      raw(`${label}: ${askedSince(t).length} bundle requests, ${filesSince(t).length} of them files; info ${JSON.stringify(await infoNow())}`);
      check(n, !!got, `${label}: downloaded, verified and staged`, JSON.stringify(st));
      if (!got) return false;
      await opens(label);
      const i = await infoNow();
      const on = i?.builtIn === false && await runs(tag);
      check(n, on, `${label}: the app runs it (its marker is in the page)`, JSON.stringify({ builtIn: i?.builtIn, basePath: i?.basePath }));
      const pinGen = (i?.updateKeys || [])[0]?.gen;
      check(n, R.m2 && pinGen === body(R.m2).gen, `${label}: the shell's high-water mark rose to the signed gen`, `pin ${pinGen}, signed ${R.m2 && body(R.m2).gen}`);
      if (on) { reached.files = Math.max(reached.files, filesSince(t).length); reached.runs = true; }
      ctx.stagedNow = i?.staged; ctx.builtInNow = i?.builtIn; ctx.dir = i?.staged ? dirname(i.staged) : null;
      return on;
    };
    /** `re` is the refusal's own sentence, read off the update manager: the toast alone is one line for every cause. */
    const refusedWith = async (mode, label, { tag, re, phase, trust = null, files = 0, told = true }) => {
      if (!reached.runs) return fail(n, label, "genuine traffic never got this far, so a refusal here proves nothing");
      R.mode = mode;
      R.forged = 0;
      const t = Date.now();
      await evSafe("localStorage.setItem('" + LS + "toastLog','[]');return 1"); // so the toast checked below is this mode's own
      restartApp();
      const st = await until(async () => { const s = await updateStatus(); return re.test(s?.message ?? "") || s?.phase === "staged" ? s : false; }, 60_000, 1500) || await statusSafe();
      say(`${label}: ${JSON.stringify(st)}`);
      const asked = askedSince(t), got = filesSince(t).length, info = await infoNow(), text = await seen();
      raw(`${mode}: relay saw ${since(t).map((r) => r.route + " " + r.path.split("?")[0]).join(", ")} | welcomes rewritten ${R.welcomes} | info ${JSON.stringify({ builtIn: info?.builtIn, staged: info?.staged, badReason: info?.badReason })}\n  person sees: ${text.slice(0, 700)}`);
      if (since(t).length === 0) return skip(n, label, "the forgery never reached the phone: it bypassed the relay");
      check(n, asked.some((r) => r.route === "tls"), `${label}: the phone asked for the bundle through the relay over the pinned TLS port`, `asked ${asked.length}`);
      check(n, re.test(st?.message ?? "") && st?.phase === phase && (st?.trust ?? null) === trust, `${label}: refused for this reason and no other`, JSON.stringify(st));
      check(n, R.forged >= 1, `${label}: the relay really changed what it passed on`, `${R.forged} forged`);
      if (files) check(n, got >= files, `${label}: admitted by the signature, stopped at the file it changed`, `${got} of ${files} files`);
      else check(n, got === 0, `${label}: refused before any file was fetched`, `${got} files`);
      check(n, info?.staged === ctx.stagedNow && info?.builtIn === ctx.builtInNow && await runs(tag), `${label}: the app keeps running what it had`, JSON.stringify({ staged: info?.staged, builtIn: info?.builtIn }));
      if (told) check(n, /update was refused/i.test(text), `${label}: the person is told (toast pointing at Settings > App version)`, text.slice(0, 240));
      await opens(label);
      check(n, await runs(tag), `${label}: and it is still the build it had`);
    };
    try {
      raw("relay tls paths so far: " + R.log.filter((r) => r.route === "tls").map((r) => r.path.split("?")[0]).join(" "));
      if (!R.m1) {
        const bearer = await evSafe("return localStorage.getItem('" + LS + "deviceToken')");
        await new Promise((res) => { const q = httpsRequest({ host: lan, port: R.tls, path: "/api/webbundle", headers: { authorization: "Bearer " + bearer }, rejectUnauthorized: false }, (rs) => { rs.resume(); rs.on("end", res); }); q.on("error", res); q.end(); });
      }
      if (!R.m1) return skip(n, "signed update", "the phone never fetched a manifest to copy");
      const g1 = body(R.m1).gen;
      raw("M1 (current bundle) " + JSON.stringify({ ...body(R.m1), files: undefined }));
      const info0 = await infoNow();
      ctx.stagedNow = info0?.staged; ctx.builtInNow = info0?.builtIn;
      check(n, (info0?.updateKeys?.length ?? 0) === 1, "precondition: the phone already pinned the update key", JSON.stringify(info0?.updateKeys));
      const rows0 = await savedRows();
      raw("the row before: " + JSON.stringify(rows0).slice(0, 700));

      // a. genuine first: nothing below means anything until this has worked
      const id1 = await serve("one");
      if (!await genuine(id1, "one", "a. a genuine newer bundle")) return;
      say(`   gen before ${g1}, pinned gen after ${(await infoNow())?.updateKeys?.[0]?.gen}`);

      // the forged modes offer a build this phone does not hold yet, so each has something to refuse
      const id2 = await serve("two");
      const served = await (await fetch(local("/api/webbundle"))).json();
      R.badPath = served.files.at(-1).path;
      await refusedWith("badbyte", `b. one byte changed in ${R.badPath}`, { tag: "one", re: /arrived corrupted/, phase: "error", files: served.files.length, told: false });
      await refusedWith("badsig", "c. a manifest with a bad signature", { tag: "one", re: /signature does not match the key this phone holds/, phase: "refused" });
      await refusedWith("old", `d. a valid old signature with gen ${g1}`, { tag: "one", re: /older than one this phone already took/, phase: "refused", trust: "restored" });
      await refusedWith("strip", "e. a manifest with signed and sig removed, key pinned", { tag: "one", re: /with no signature, and this phone holds its key/, phase: "refused" });

      // the same offer, unforged: the refusals above left nothing behind that stops a good update
      if (!await genuine(id2, "two", "a. the same offer, no longer forged")) return;

      // f. past the JS layer: the native check, called straight from the page
      R.mode = "pass";
      const mb = R.m2 ? body(R.m2) : null;
      if (!mb) return skip(n, "f. native check", "no genuine manifest captured");
      const forged = Buffer.from(`<html><body>forged ${MARK}</body></html>`).toString("base64");
      const call = (extra) => evSafe(`const U=window.Capacitor.Plugins.ShellUpdate;const id=${JSON.stringify(mb.buildId)};
        await U.beginBundle({id});await U.writeFile({id,path:'index.html',dataBase64:${JSON.stringify(forged)}});
        try{const r=await U.finishBundle(Object.assign({id},${JSON.stringify(extra)}));return 'ACCEPTED '+JSON.stringify(r)}catch(e){return 'refused: '+(e.message||e)+' code='+(e.code||'')}`);
      const f1 = await call({ signed: R.m2.signed, sig: R.m2.sig });
      say("f. finishBundle(forged index, the genuine signature): " + f1);
      check(n, /^refused.*code=BAD_FILES/.test(String(f1)), "f. finishBundle with a forged file under a genuine signature is refused by the native check", String(f1));
      const f2 = await call({});
      say("f. finishBundle(forged index, unsigned): " + f2);
      check(n, /^refused.*code=UNSIGNED/.test(String(f2)), "f. finishBundle with no signature is refused natively once a key is pinned", String(f2));
      const f3 = await call({ signed: R.m2.signed, sig: Buffer.from(R.m2.sig, "base64").map((b, i) => (i === 3 ? b ^ 1 : b)).toString("base64") });
      say("f. finishBundle(forged index, bad signature): " + f3);
      check(n, /^refused.*code=BAD_SIGNATURE/.test(String(f3)), "f. finishBundle with a bad signature is refused natively", String(f3));
      const ls = sh(`run-as ${PKG} ls files/bundles`);
      const kept = sh(`run-as ${PKG} cat files/bundles/${mb.buildId}/index.html`);
      raw("bundles on disk: " + ls.replace(/\n/g, " ") + " | genuine index still holds marker: " + kept.includes(MARK) + ", forged text present: " + /forged/.test(kept));
      check(n, kept.includes(`${MARK} two`) && !/forged/.test(kept), "f. the refused forged bundle did not replace the installed directory", ls.replace(/\n/g, " "));

      // f2. repoint the WebView at an unverified directory from page code, then cold-restart
      if (!ctx.dir) return skip(n, "f. repoint", "no bundle directory known");
      const page = `<!doctype html><html><head><title>forged-page</title></head><body>forged-repoint<script>setTimeout(function(){try{window.Capacitor.Plugins.WebView.persistServerBasePath().then(function(){document.title='persisted'},function(e){document.title='persist-failed '+e});}catch(e){document.title='no-webview-plugin '+e}},800)</script></body></html>`;
      const FORGED = "f0f0f0f0f0f0f0f0"; // hex, or `beginBundle` refuses it and the WebView is repointed at nothing
      const part = `${ctx.dir}/${FORGED}.part`;
      await evSafe(`const U=window.Capacitor.Plugins.ShellUpdate;await U.beginBundle({id:${JSON.stringify(FORGED)}});await U.writeFile({id:${JSON.stringify(FORGED)},path:'index.html',dataBase64:${JSON.stringify(Buffer.from(page).toString("base64"))}});return 1`);
      const rp = evSafe(`await window.Capacitor.Plugins.WebView.setServerBasePath({path:${JSON.stringify(part)}});return 'set'`, { timeout: 8000 });
      await rp;
      await sleep(6000);
      const title = await evSafe("return document.title + ' | ' + document.body.innerText.slice(0,60)");
      const mid = await infoNow();
      raw("page code repointed the WebView: " + JSON.stringify(title) + " info " + JSON.stringify({ builtIn: mid?.builtIn, basePath: mid?.basePath, staged: mid?.staged }));
      const repointed = /forged-repoint/.test(String(title));
      say(`   repoint from page code: the live WebView ${repointed ? "DID" : "did not"} switch to the unverified directory (${String(title).slice(0, 80)})`);
      restartApp();
      await pageTarget(40_000);
      const okOpen = await connected(40_000);
      const after = await infoNow();
      const t3 = await bodyText();
      raw("after the cold restart: " + JSON.stringify({ builtIn: after?.builtIn, staged: after?.staged, badReason: after?.badReason }) + " | page " + t3.slice(0, 160).replace(/\n+/g, " / "));
      if (!repointed) skip(n, "f. launch check catches a persisted unverified directory", "setServerBasePath from page code did not take effect: " + String(title).slice(0, 100));
      else check(n, !/forged-repoint/.test(t3) && !String(after?.staged).includes(FORGED) && /not signed by a desktop this phone trusts/.test(after?.badReason ?? "") && !!okOpen, "f. a persisted unverified directory is dropped at the next cold start and the app opens", JSON.stringify({ staged: after?.staged, builtIn: after?.builtIn, badReason: after?.badReason }));
      say("f. launch check: " + JSON.stringify({ staged: after?.staged, builtIn: after?.builtIn, badReason: after?.badReason }));
    } finally {
      R.mode = "pass";
      R.snap = null;
      try { rmSync(snap, { recursive: true, force: true }); } catch { /* gone */ }
      writeFileSync(idx, orig);
      writeFileSync(bidFile, bidOrig);
    }
  });

  // ── 3: wrong pin ──
  await step(3, "wrong pin", async () => {
    const n = 3;
    await stopHost();
    rmSync(keyFile());
    await bootHost();
    await hostSays(/listening https:/);
    const newSpki = spkiOfPem(JSON.parse(readFileSync(keyFile(), "utf8")).cert);
    check(n, newSpki !== ctx.row.tls.spki, "the scratch host now presents a different TLS key");
    await relayStop(); await relayStart();
    const t = Date.now();
    restartApp();
    await pageTarget(40_000);
    await sleep(15_000);
    const base = `https://${lan}:${R.tls}`;
    const probe = await evSafe(`const out={};
      out.ws=await new Promise(r=>{try{const w=new WebSocket(${JSON.stringify(base.replace("https", "wss") + "/ws")},${JSON.stringify(WS_PROTOCOL)});w.onopen=()=>{r('open');w.close()};w.onerror=()=>r('refused');setTimeout(()=>r('timeout'),10000)}catch(e){r('threw')}});
      out.fetch=await fetch(${JSON.stringify(base + "/api/health")}).then(r=>'status '+r.status,()=>'refused');
      out.img=await new Promise(r=>{const i=new Image();i.onload=()=>r('loaded');i.onerror=()=>r('refused');i.src=${JSON.stringify(base + "/api/health")};setTimeout(()=>r('timeout'),10000)});
      return out;`);
    raw("probe: " + JSON.stringify(probe));
    check(n, probe?.ws === "refused" && probe?.fetch === "refused" && probe?.img === "refused", "WebSocket, fetch and <img> to the TLS port are all refused", JSON.stringify(probe));
    const app = since(t);
    check(n, !app.some((r) => r.route === "plain" && /^\/api\/(?!health|pair|lan)/.test(r.path)) && !R.ws.some((w) => w.route === "plain" && w.at >= t), "the phone did not fall back to plain HTTP", app.filter((r) => r.route === "plain").map((r) => r.path.split("?")[0]).join(","));
    const text = (await bodyText()) + " " + String(await evSafe("return localStorage.getItem('" + LS + "toastLog')"));
    raw("page text + toast log after a wrong pin:\n" + text.slice(0, 1200));
    check(n, /key (has )?changed|different key|pair again|someone/i.test(text), "the page says the desktop's key changed", text.replace(/\n+/g, " | ").slice(0, 200));
    const ref = await plugin("Tls", "lastRefusal");
    check(n, !!ref?.spki, "the shell remembers the refused certificate", JSON.stringify(ref));
    await stopHost();
    writeFileSync(keyFile(), origKey, { mode: 0o600 });
    await bootHost();
    await hostSays(/listening https:/);
    await relayStop(); await relayStart();
  });

  // ── 4: a plain route refuses updates and the fingerprint wrap ──
  await step(4, "plain route refusals", async () => {
    const n = 4;
    await patchRow({ tls: null, tlsOff: true });
    const t = Date.now();
    restartApp();
    await pageTarget(40_000);
    await sleep(25_000);
    const asked = since(t).filter((r) => r.route === "plain" && /^\/api\/webbundle/.test(r.path));
    check(n, asked.length === 0, "an unpinned row at the plain LAN address never fetches a bundle manifest", `${asked.length} requests`);
    raw("page text on a plain row:\n" + (await bodyText()).slice(0, 600));
    const st = JSON.stringify(await plugin("Link", "status"));
    raw("ShellLink.status on a plain row whose desktop still has a pin in the shell: " + st);
    skip(n, "fingerprint / Keystore wrap on the pinned route", "the refusal lives in the page wrapper (nativeKeystore.ts:143), unreachable from outside the bundle, and the emulator has no enrolled fingerprint; covered by nativeKeystore.test.mjs");
    await patchRow({ tls: { port: R.tls, spki: ctx.row.tls.spki }, tlsOff: null });
  });

  // ── 9: the background link. Off on a fresh install, so the script starts it (ShellLink.start). ──
  await step(9, "background service", async () => {
    const n = 9;
    let PV = 1;
    try { PV = (await import("../packages/shared/dist/index.js")).PROTOCOL_VERSION ?? 1; } catch { /* keep 1 */ }
    restartApp();
    await pageTarget(40_000);
    await connected();
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    const tok = await evSafe("return localStorage.getItem('" + LS + "deviceToken')");
    const hostId = ctx.row.id;
    const start = (url) => plugin("Link", "start", { url, protocol: PV, label: "e2e", wsProtocol: WS_PROTOCOL, links: [{ hostId, url, label: "e2e", token: typeof tok === "string" ? tok : undefined }] });
    raw("ShellLink.status before: " + JSON.stringify(await plugin("Link", "status")));

    // a plain address on a row the shell holds a pin for: refused, nothing dialled
    let t = Date.now();
    const s0 = await start(`ws://${lan}:${R.plain}/ws`);
    raw("start(plain): " + JSON.stringify(s0));
    await sleep(7000);
    const s1 = await plugin("Link", "status");
    raw("status after start(plain): " + JSON.stringify(s1));
    check(n, /locked: open the app/.test(JSON.stringify(s1)), 'a plain address on a pinned row is refused with "locked: open the app"', JSON.stringify(s1).slice(0, 300));
    check(n, /^locked/.test(String(s1?.links?.[0]?.state)), 'its state is "locked"', JSON.stringify(s1?.links?.[0]));
    check(n, !R.ws.some((w) => w.route === "plain" && w.at >= t) && !R.log.some((r) => r.route === "plain" && r.at >= t && (r.auth || /[?&]wt=/.test(r.path))), "the service sent nothing, no token, to the plain port");

    // the pinned TLS address: it connects
    await plugin("Link", "stop");
    t = Date.now();
    const s2 = await start(`wss://${lan}:${R.tls}/ws`);
    raw("start(pinned): " + JSON.stringify(s2));
    const up = await until(() => R.ws.some((w) => w.at >= t && w.route === "tls" && /okhttp/i.test(w.ua)), 40_000, 500);
    await sleep(2000);
    const s3 = await plugin("Link", "status");
    raw("status after start(pinned): " + JSON.stringify(s3));
    check(n, !!up, "ShellLinkService connects to the pinned TLS address (okhttp WebSocket through the relay, pin held)", JSON.stringify(R.ws.filter((w) => w.at >= t)));
    check(n, /"state":"(connected|open|live)"/.test(JSON.stringify(s3)) || s3?.links?.[0]?.state === "connected", "its state says connected", JSON.stringify(s3?.links?.[0] ?? s3).slice(0, 240));

    // the page gone: finish the activity, drop every socket, the service has to dial again by itself
    sh("input keyevent KEYCODE_BACK");
    await sleep(4000);
    const resumed = sh("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'");
    raw("after BACK: " + resumed.trim().slice(0, 200) + " | pid " + sh(`pidof ${PKG}`).trim());
    check(n, !new RegExp(PKG.replace(/\./g, "\\.") + "/").test(resumed), "the app's page is gone (no resumed activity of the app)");
    t = Date.now();
    await relayStop(); await relayStart();
    await until(() => R.ws.some((w) => w.at >= t && w.route === "tls" && /okhttp/i.test(w.ua)), 70_000, 1000);
    const proc = sh(`pidof ${PKG}`).trim();
    const after = R.ws.filter((w) => w.at >= t);
    raw("ws after the drop: " + JSON.stringify(after));
    check(n, !!proc && after.some((w) => w.route === "tls" && /okhttp/i.test(w.ua)), "with the page gone, ShellLinkService re-dials the pinned TLS address by itself", `proc ${proc || "none"}, ws ${after.length}`);
    check(n, !after.some((w) => w.route === "plain") && !R.log.some((r) => r.route === "plain" && r.at >= t && r.auth), "it never fell back to plain");
    launch();
    await pageTarget(40_000);
    raw("status with the page back: " + JSON.stringify(await plugin("Link", "status")));
    await plugin("Link", "stop");
  });

  skip(10, "a user-installed CA does not defeat the pin", "needs a root shell to put a CA in the user store and a CA-valid relay on the pinned address; not built in this pass");
  skip(11, "old-APK degrade (no ShellTls)", "an older shell sits on the AVD but loads its own old built-in page, not this tree's; no older debug build was made");
}

main().catch((e) => { say(`FAIL: harness: ${e.stack || e}`); failed = true; }).finally(async () => {
  say("\n── summary ──");
  for (const r of results) say(`${r.kind} [${r.n}] ${r.label}${r.why ? ` (${r.why})` : ""}`);
  await relayStop();
  await stopHost(); await cleanup();
  process.exit(failed ? 1 : 0);
});
