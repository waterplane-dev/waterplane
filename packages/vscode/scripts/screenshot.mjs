// The Marketplace / Open VSX listing pictures: the packaged .vsix in a real VS Code, over a fictional
// repo (`todo-garden`) and a generated Claude Code session whose token shape is scaled from real
// use — cache reads dwarfing output, a subagent, a cold start after a long break, a compaction —
// and sixteen weeks of generated git history for the Repo health view to measure.
// Names are fictional; nothing is read from your own ~/.claude or VS Code profile.
//
//   node scripts/screenshot.mjs [file.vsix]   (default: the newest waterplane-*.vsix here)
//
// With `--app <dir>` (a `vite build --outDir <dir>` of packages/web, never packages/web/dist) it adds
// `listing2-app.png`: the app tab over a stand-in host on loopback that answers `/api/health` and
// serves that bundle in its own demo mode, so every repo and session in it is fictional.
// `--only a,b` re-shoots just those views.
//
// Writes media/listing2-<view>.png (not shipped in the .vsix; README links them by URL, on the mirror's
// `main`, so a published listing shows whatever file has that name there: pictures of a version that is
// not out yet get a new set name, and the old set stays while its version is the live one). Same
// launch as test/integration/run.mjs; the window is posed by scripts/screenshot-suite.cjs and
// captured over DevTools.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { E } from "../../../scripts/lib-brand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
// The extension's ids are the ones its package.json declares; the suite reads them from the env.
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
// Opt-in real mode: `--workspace <dir> --real-home [--out <dir>] [--views a,b,...]` opens that folder and
// leaves HOME / CLAUDE_CONFIG_DIR as they are, so the extension reads the real ~/.claude logs (read-only).
// VS Code still gets a throwaway user-data-dir and extensions-dir; no desktopUrl is set. Names are then
// vscode-setupcheck-<view>.png in --out (default media/ is for the fictional listing mode only, unchanged).
// Extra views there: findings-end (Findings scrolled to its end) and tree (the sidebar tree focused).
// Each shot's first ~300 chars of visible text are printed (webview DOM text, or the sidebar for tree).
const ARGS = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--real-home") ARGS.realHome = true;
  else if (["--workspace", "--out", "--views", "--app", "--only"].includes(a)) ARGS[a.slice(2)] = process.argv[++i];
  else ARGS._.push(a);
}
const REAL = Boolean(ARGS.workspace && ARGS.realHome);
if (ARGS.workspace && !ARGS.realHome) { console.error("--workspace needs --real-home (it reads your real ~/.claude)"); process.exit(2); }
const VIEWS = REAL ? (ARGS.views ?? "findings,findings-end,tree,all,always-on,session").split(",") : ["session", "prompts", "all", "health", ...(ARGS.app ? ["app"] : [])].filter((v) => !ARGS.only || ARGS.only.split(",").includes(v));
const WIDTH = 1600, HEIGHT = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vscodeBin() {
  const cands = [
    process.env[E.VSCODE_BIN],
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    join(process.env.HOME ?? "", "Applications/Visual Studio Code.app/Contents/MacOS/Code"),
    "/usr/share/code/code",
    "/usr/bin/code",
  ].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) { console.error(`No VS Code found. Set ${E.VSCODE_BIN}.`); process.exit(2); }
  return hit;
}

function vsixFile() {
  if (ARGS._[0]) return resolve(ARGS._[0]);
  const all = readdirSync(pkg).filter((n) => n.startsWith(`${manifest.name}-`) && n.endsWith(".vsix"))
    .map((n) => join(pkg, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!all.length) { console.error("No .vsix here. Run `npm run package` first."); process.exit(2); }
  return all[0];
}

// Deterministic, so a re-run draws the same picture.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (a, b) => Math.round(a + rnd() * (b - a));

const PROMPTS = [
  "Add a watering schedule to each plant card",
  "The reminders fire twice after a reload — find out why",
  "Write tests for the schedule store",
  "Move the plant photos to lazy loading",
  "Why does the build take 40 seconds now?",
  "Split PlantList.tsx, it is past 900 lines",
  "Add an offline banner when the sync fails",
  "Review the diff before I commit",
  "Dark mode for the calendar view",
  "Make the watering streak survive a timezone change",
  "Add a CSV export of the garden log",
  "Fix the flaky e2e test for the photo upload",
];

const OTHER = [
  "Add a search box to the notes list", "Sync conflicts lose the newer edit", "Write the release notes",
  "Port the map view to MapLibre", "Why is the GPX import so slow?", "Add elevation to the trail summary",
  "Tag notes from the share sheet", "Fix the date picker on Android", "Cache the tiles offline",
];

/**
 * One session as the CLI writes it. The headline one (`long`) runs ~4 h with a lunch break (a cold
 * start), a compaction and an Explore subagent; the rest are shorter days that fill the week.
 */
function writeSession(dir, cwd, conv, { start, prompts, long = false, model = "claude-opus-4-8" }) {
  const rows = [];
  const base = { sessionId: conv, cwd, version: "2.1.0" };
  let t = start;
  let ctx = 0, n = 0;
  const ts = () => new Date(t).toISOString();
  const call = (model, read, write, out, input = between(2, 12)) => {
    n++;
    rows.push({ ...base, timestamp: ts(), type: "assistant", uuid: `a-${n}`, message: { id: `msg_${n}`, model, role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out,
        cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 }, service_tier: "standard" } } });
  };
  const user = (content) => rows.push({ ...base, timestamp: ts(), type: "user", uuid: `u-${++n}`, message: { role: "user", content } });
  prompts.forEach((p, i) => {
    if (long && i === 5) t += 75 * 60_000; // lunch: the cache has expired, the next turn writes it all again
    if (long && i === 9) {
      user("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>");
      t += 25_000;
      call(model, 0, 0, 3_400, ctx);
      rows.push({ ...base, timestamp: ts(), type: "system", subtype: "compact_boundary", content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: ctx, postTokens: 31_000 } });
      ctx = 0;
      t += 60_000;
    }
    user(p);
    t += 4_000;
    const calls = between(9, 22);
    for (let c = 0; c < calls; c++) {
      const fresh = ctx === 0 || (long && c === 0 && i === 5);
      const grow = fresh ? (ctx || 31_000) + between(4_000, 9_000) : between(1_500, 7_500);
      call(model, fresh ? 0 : ctx, grow, between(150, c === calls - 1 ? 2_400 : 900));
      ctx = (fresh ? 0 : ctx) + grow;
      user([{ type: "tool_result", tool_use_id: `t${n}`, content: "…" }]);
      t += between(6_000, 40_000);
    }
    t += between(2, 9) * 60_000;
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${conv}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (!long) return;

  // The subagent the build-time question sent off.
  const sub = join(dir, conv, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find what slowed the build" }));
  const srows = [];
  let st = Date.now() - 3.1 * 3600_000, sctx = 0;
  const sb = { ...base, isSidechain: true, agentId: "1" };
  srows.push({ ...sb, timestamp: new Date(st).toISOString(), type: "user", uuid: "su-0", message: { role: "user", content: "Find what slowed the build" } });
  for (let c = 0; c < 26; c++) {
    st += between(3_000, 12_000);
    const grow = c === 0 ? 18_000 : between(2_000, 9_000);
    srows.push({ ...sb, timestamp: new Date(st).toISOString(), type: "assistant", uuid: `sa-${c}`, message: { id: `msg_s${c}`, model: "claude-sonnet-4-6", role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: between(2, 9), cache_creation_input_tokens: grow, cache_read_input_tokens: sctx, output_tokens: between(120, 700),
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: grow }, service_tier: "standard" } } });
    sctx += grow;
  }
  writeFileSync(join(sub, "agent-1.jsonl"), srows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** One DevTools session on a target. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { call, close: () => ws.close() };
}

async function workbench(port) {
  for (;;) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page" && x.url.includes("workbench"));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(300);
  }
}

/** The stand-in host for the app tab: health, the demo bundle, nothing else. Loopback, gone with this run. */
async function demoHost(dir) {
  const root = realpathSync(dir);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const demo = `<script>try{var u=new URL(location.href);if(!u.searchParams.has("demo")){u.searchParams.set("demo","first-look");history.replaceState(null,"",u)}}catch(e){}</script>`;
  const srv = createHttpServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/api/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, protocol: 1, root: "/demo" })); }
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
    res.end(file.endsWith("index.html") ? readFileSync(file, "utf8").replace("<head>", `<head>${demo}`) : readFileSync(file));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const host = ARGS.app && VIEWS.includes("app") ? await demoHost(ARGS.app) : null;
const vsix = vsixFile();
const bin = vscodeBin();
const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-vscode-shot-")));
const dirs = Object.fromEntries(["unpacked", "user", "exts", "claude", "sig"].map((d) => [d, join(root, d)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const work = REAL ? resolve(ARGS.workspace) : join(root, "todo-garden");
if (!REAL) mkdirSync(work);
execFileSync("unzip", ["-q", vsix, "-d", dirs.unpacked]);

if (!REAL) { // the fictional repo, its history and its generated sessions (skipped over a real folder)
const gitEnv = { ...process.env };
delete gitEnv.GIT_DIR; delete gitEnv.GIT_WORK_TREE; delete gitEnv.GIT_INDEX_FILE;
const git = (a, env = {}) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore", env: { ...gitEnv, ...env } });
const DAY = 86_400_000;
git(["init", "-q", "-b", "main"]);
{ const s0 = seed; writeGardenHistory(); seed = s0; } // the sessions keep the numbers they drew before the history

/**
 * Sixteen weeks of todo-garden's history, a commit most days, for the Repo health view to measure:
 * PlantList.tsx grows past 900 lines and is split in week 14, a helper is pasted into two files
 * (duplication), a few exports go unused and CLAUDE.md gains a rule now and then.
 */
function writeGardenHistory() {
  const DAYS = 112;
  const src = join(work, "src");
  mkdirSync(src, { recursive: true });
  const fn = (file, i) => `export function ${file}${i}(n: number): number {\n  const step = ${i} * n + ${(i * 7) % 13};\n  return step > ${i * 3} ? step - ${i} : step + ${i};\n}\n`;
  const body = (file, n, from = 0) => Array.from({ length: n }, (_, i) => fn(file, from + i)).join("\n");
  const pasted = "export function wateringLabel(days: number): string {\n  if (days <= 0) return \"water today\";\n  if (days === 1) return \"water tomorrow\";\n" +
    "  if (days < 7) return `water in ${days} days`;\n  const weeks = Math.round(days / 7);\n  return weeks === 1 ? \"water next week\" : `water in ${weeks} weeks`;\n}\n";
  const files = { list: 20, schedule: 6, sync: 0, calendar: 0, exporter: 0, card: 0 };
  let rules = 8;
  for (let d = 0; d < DAYS; d++) {
    if (d % 7 === 5 || (d % 7 === 6 && d % 3)) continue; // most weekends off
    if (d < 92) files.list += between(1, 4); else if (d === 92) { files.card = Math.round(files.list * 0.45); files.list = Math.round(files.list * 0.35); }
    else files.list += between(0, 1);
    files.schedule += between(0, 2);
    if (d >= 20) files.sync += between(0, 2);
    if (d >= 45) files.calendar += between(0, 2);
    if (d >= 70) files.exporter += between(0, 1);
    if (d % 9 === 0) rules += between(1, 4);
    const write = (name, key) => { if (files[key]) writeFileSync(join(src, name), body(key, files[key]) + (key === "calendar" || key === "exporter" ? "\n" + pasted : "")); };
    write("PlantList.tsx", "list"); write("schedule.ts", "schedule"); write("sync.ts", "sync");
    write("calendar.tsx", "calendar"); write("exportCsv.ts", "exporter"); write("PlantCard.tsx", "card");
    // Tests reach some modules (calendar and the export never get one), so the health index has a week to score.
    const test = (name, mod) => writeFileSync(join(work, "test", `${name}.test.ts`), `import { ${mod}0 } from "../src/${name}.ts";\n\ntest("${name}", () => expect(${mod}0(1)).toBeDefined());\n`);
    mkdirSync(join(work, "test"), { recursive: true });
    test("schedule", "schedule");
    if (d >= 30) test("sync", "sync");
    writeFileSync(join(work, "test", "PlantList.test.ts"), `import { list0 } from "../src/PlantList.tsx";\n${d >= 92 ? "import { card0 } from \"../src/PlantCard.tsx\";\n" : ""}\ntest("list", () => expect(list0(1)).toBeDefined());\n`);
    writeFileSync(join(src, "index.ts"),"export { list0 } from \"./PlantList.tsx\";\nexport { schedule0 } from \"./schedule.ts\";\n");
    writeFileSync(join(work, "CLAUDE.md"), "# todo-garden\n\nA plant-care to-do app (React, Vite, IndexedDB).\n\n" +
      Array.from({ length: rules }, (_, i) => `- Rule ${i + 1}: keep the schedule store the one place a watering date is computed.`).join("\n") + "\n");
    const when = new Date(Date.now() - (DAYS - d) * DAY + between(9, 18) * 3600_000).toISOString();
    git(["add", "-A"]);
    git(["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "commit", "-q", "--allow-empty", "-m", PROMPTS[d % PROMPTS.length]],
      { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  }
}

const slugDir = (cwd) => join(dirs.claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
// The week before: shorter sessions in todo-garden and two other fictional repos.
for (let d = 6; d >= 1; d--) {
  for (const [k, name] of ["todo-garden", "pocket-notes", "trail-log"].entries()) {
    if ((d + k) % 3 === 0) continue;
    const cwd = join(root, name);
    const n = between(2, 6);
    const prompts = Array.from({ length: n }, (_, i) => (name === "todo-garden" ? PROMPTS : OTHER)[(d * 3 + k + i) % (name === "todo-garden" ? PROMPTS.length : OTHER.length)]);
    const id = `${String(d).padStart(8, "0")}-0000-4000-8000-${String(k).padStart(12, "0")}`;
    writeSession(slugDir(cwd), cwd, id, { start: Date.now() - d * DAY - between(2, 9) * 3600_000, prompts, model: k === 1 ? "claude-sonnet-4-6" : "claude-opus-4-8" });
  }
}
writeSession(slugDir(work), work, "3f2a9c41-7b1e-4d2a-9c3e-5a6b7c8d9e0f", { start: Date.now() - 4.2 * 3600_000, prompts: PROMPTS, long: true });
}

mkdirSync(join(dirs.user, "User"), { recursive: true });
writeFileSync(join(dirs.user, "User", "settings.json"), JSON.stringify({
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true,
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
}));

const port = await new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env, ...(REAL ? { WP_SHOT_REAL: "1" } : {}), ...(REAL ? {} : { CLAUDE_CONFIG_DIR: dirs.claude }), WP_SHOT_SIG: dirs.sig, ...(host ? { WP_SHOT_APP_URL: host.url } : {}), WP_SHOT_VIEWS: VIEWS.join(","), WP_SHOT_EXT: manifest.name, WP_SHOT_PUBLISHER: manifest.publisher,
  WP_SHOT_STORAGE: join(dirs.user, "User", "globalStorage", `${manifest.publisher}.${manifest.name}`.toLowerCase()) };
for (const k of Object.keys(env)) if (k.startsWith("VSCODE_") || k === "ELECTRON_RUN_AS_NODE") delete env[k];

const proc = spawn(bin, [
  `--extensionDevelopmentPath=${join(dirs.unpacked, "extension")}`,
  `--extensionTestsPath=${join(here, "screenshot-suite.cjs")}`,
  `--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.exts}`,
  "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
  `--remote-debugging-port=${port}`, "--new-window", work,
], { env, stdio: "ignore" });
const killMin = REAL ? 20 : 4; // real mode waits for the first scan of the real logs
const killer = setTimeout(() => { console.error(`timed out after ${killMin} min`); proc.kill("SIGKILL"); }, killMin * 60_000);

const page = await workbench(port);
const browser = await attach((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const s = await attach(page.webSocketDebuggerUrl);
const { result: { windowId } = {} } = await browser.call("Browser.getWindowForTarget", { targetId: page.id });
if (windowId) await browser.call("Browser.setWindowBounds", { windowId, bounds: { left: 40, top: 40, width: WIDTH, height: HEIGHT, windowState: "normal" } });

const out = REAL ? resolve(ARGS.out ?? join(pkg, "media")) : join(pkg, "media");
mkdirSync(out, { recursive: true });
const webText = `(() => { const d = document.querySelector("iframe#active-frame")?.contentDocument; const r = d?.getElementById("root"); return r ? r.innerText : null; })()`;
const scrollEnd = `(() => { const d = document.querySelector("iframe#active-frame")?.contentDocument; if (!d) return 0; let n = 0; for (const e of [d.scrollingElement, ...d.querySelectorAll("*")]) if (e && e.scrollHeight > e.clientHeight + 4) { e.scrollTop = e.scrollHeight; n++; } return n; })()`;
/** Evaluate in the extension's webview (the outer vscode-webview frame holds the page in #active-frame). */
async function inWebview(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  for (const t of targets.filter((x) => x.type === "iframe" && x.url.startsWith("vscode-webview://") && x.url.includes("/index.html") && x.webSocketDebuggerUrl)) {
    const w = await attach(t.webSocketDebuggerUrl);
    try {
      const v = (await w.call("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
      if (v != null && v !== "" && v !== 0) return v;
    } finally { w.close(); }
  }
  return null;
}
/** In the framed demo: start todo-garden's session the way a person does, then wait for its terminal. */
async function openDemoSession() {
  const end = Date.now() + 60_000;
  let started = false, openSince = null;
  while (Date.now() < end) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const t = targets.find((x) => x.url.startsWith(host.url) && x.webSocketDebuggerUrl);
    if (t) {
      const f = await attach(t.webSocketDebuggerUrl);
      await f.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
      const state = (await f.call("Runtime.evaluate", { returnByValue: true, expression: `(() => {
        if (document.querySelector(".xterm-screen")) return document.body.innerText.includes("New screenshot in") ? "toast" : "open";
        const b = document.querySelector('button.repo-start-btn[title^="new session in todo-garden "]');
        if (b && !${started}) { b.click(); return "clicked"; }
        return "waiting"; })()` })).result?.result?.value;
      if (state === "clicked") started = true;
      // Ten seconds lets the reply finish; a toast over the picture is waited out. `f` stays open
      // until the picture is taken: the dark emulation ends with it.
      if (state === "open") openSince ??= Date.now();
      if (state === "open" && Date.now() - openSince > 10_000) return f;
      f.close();
    }
    await sleep(500);
  }
  console.error("the demo session never opened in the app tab"); process.exit(1);
}
for (const view of VIEWS) {
  while (!existsSync(join(dirs.sig, `${view}.req`))) await sleep(200);
  await sleep(Number(process.env.WP_SHOT_SETTLE_MS ?? 6000)); // the scan, the charts' first draw
  // Below the title bar, which a development host labels "[Extension Development Host]".
  const box = (await s.call("Runtime.evaluate", { expression: `[document.querySelector(".part.titlebar")?.offsetHeight ?? 0, innerWidth, innerHeight]`, returnByValue: true })).result?.result?.value;
  const [top, w, h] = box ?? [0, WIDTH, HEIGHT];
  let seen = "";
  if (REAL) {
    // Over real logs the first scan takes minutes; the views say "reading" until it is done.
    // Wait for it (up to WP_SHOT_SCAN_MS) so a picture shows findings, not the reading state.
    const until = Date.now() + Number(process.env.WP_SHOT_SCAN_MS ?? 840000);
    const sidebar = async () => (await s.call("Runtime.evaluate", { expression: `document.querySelector(".part.sidebar")?.innerText ?? ""`, returnByValue: true })).result?.result?.value ?? "";
    while (Date.now() < until && /reading the logs|reading logs|reading…/i.test(view === "tree" ? await sidebar() : ((await inWebview(webText)) ?? ""))) await sleep(2000);
    if (view === "findings-end") { await inWebview(scrollEnd); await sleep(500); }
    seen = view === "tree"
      ? ((await s.call("Runtime.evaluate", { expression: `document.querySelector(".part.sidebar")?.innerText ?? ""`, returnByValue: true })).result?.result?.value ?? "")
      : (await inWebview(webText)) ?? "";
  }
  const demo = view === "app" ? await openDemoSession() : null;
  // The per-prompt list is what the listing promises first: bring it up, with the dearest one picked.
  if (view === "prompts") { await inWebview(`(() => { const d = document.querySelector("iframe#active-frame")?.contentDocument; const h = d?.querySelector(".turns"); if (!h) return null; const usd = (e) => Number(/\\$([\\d.]+)/.exec(e.textContent)?.[1] ?? 0); const rows = [...h.querySelectorAll(".turn-row")]; rows.sort((a, b) => usd(b) - usd(a))[0]?.click(); h.scrollIntoView({ block: "start" }); return h ? "ok" : null; })()`); await sleep(600); }
  const shot = await s.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: top, width: w, height: h - top, scale: 1 } });
  if (!shot.result?.data) { console.error(`no picture for ${view}: ${JSON.stringify(shot.error)}`); process.exit(1); }
  const file = join(out, REAL ? `vscode-setupcheck-${view}.png` : `listing2-${view}.png`);
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log(`wrote ${file} (${shot.result.data.length * 0.75 | 0} bytes)`);
  if (REAL) console.log(`  text[${view}]: ${JSON.stringify(seen.replace(/\s+/g, " ").trim().slice(0, 300))}`);
  demo?.close();
  writeFileSync(join(dirs.sig, `${view}.done`), "");
}
host?.close();
s.close(); browser.close();
await new Promise((res) => proc.on("close", res));
clearTimeout(killer);
if (process.env[E.SHOT_KEEP] !== "1") rmSync(root, { recursive: true, force: true });
else console.log(`kept: ${root}`);
