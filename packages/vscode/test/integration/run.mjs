// Integration test: the packaged .vsix in a real, installed VS Code. Unpacks the .vsix, starts
// VS Code with a throwaway profile, extensions dir and claude config dir (holding one fixture
// conversation recorded for a throwaway git repo), and runs `suite.cjs` in its extension host.
// Your own VS Code profile, extensions and ~/.claude are never read or written.
//
//   node test/integration/run.mjs [file.vsix]      (default: the newest waterplane-*.vsix here)
//
// VS Code is found at WATERPLANE_VSCODE_BIN, else the standard macOS / Linux install paths. A
// window opens for the length of the run (~10-30 s) and closes itself. It is started with a
// loopback DevTools port so `webviews.mjs` can see whether the panel really rendered.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { probePanelText, probeWebviews } from "./webviews.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..", "..");
const CONV = "11111111-2222-4333-8444-555555555555";
const FIXTURE = join(pkg, "test", "fixtures", "projects", "-Users-x-repo", `${CONV}.jsonl`);
// A second conversation in the same folder, so the sessions list has two rows.
const CONV2 = "99999999-2222-4333-8444-555555555555";
const SECOND = "Summarise the release notes";

function vscodeBin() {
  const cands = [
    process.env.WATERPLANE_VSCODE_BIN,
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    join(process.env.HOME ?? "", "Applications/Visual Studio Code.app/Contents/MacOS/Code"),
    "/usr/share/code/code",
    "/usr/bin/code",
  ].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) { console.error(`No VS Code found. Set WATERPLANE_VSCODE_BIN. Looked at:\n  ${cands.join("\n  ")}`); process.exit(2); }
  return hit;
}

function vsixFile() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const all = readdirSync(pkg).filter((n) => /^waterplane-.*\.vsix$/.test(n))
    .map((n) => join(pkg, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!all.length) { console.error("No .vsix here. Run `npm run package` first."); process.exit(2); }
  return all[0];
}

const vsix = vsixFile();
const bin = vscodeBin();
const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-vscode-it-")));
const keep = process.env.WATERPLANE_IT_KEEP === "1";
const dirs = Object.fromEntries(["unpacked", "user", "exts", "claude", "work"].map((d) => [d, join(root, d)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// The extension exactly as it ships.
execFileSync("unzip", ["-q", vsix, "-d", dirs.unpacked]);
const manifest = JSON.parse(readFileSync(join(dirs.unpacked, "extension", "package.json"), "utf8"));

// A workspace with a git history for the health measure.
const gitEnv = { ...process.env };
delete gitEnv.GIT_DIR; delete gitEnv.GIT_WORK_TREE; delete gitEnv.GIT_INDEX_FILE;
const git = (...a) => execFileSync("git", ["-C", dirs.work, ...a], { stdio: "ignore", env: gitEnv });
git("init", "-q", "-b", "main");
writeFileSync(join(dirs.work, "index.ts"), "export const a = 1;\nexport function f(x: number) { return x + a; }\n");
writeFileSync(join(dirs.work, "CLAUDE.md"), "# test repo\n\nOne rule.\n");
git("add", "-A");
git("-c", "user.name=it", "-c", "user.email=it@example.invalid", "commit", "-q", "-m", "one");

// A repo-health series the waterplane desktop app "already measured" in the folder: the packaged engine run
// into a scratch dir, then filed as `.waterplane/repohealth.jsonl`. The Health tab must show it unmeasured.
{
  const made = join(root, "made");
  mkdirSync(made);
  await new Promise((res, rej) => {
    const w = new Worker(join(dirs.unpacked, "extension", "dist", "healthworker.mjs"), {
      argv: ["update", "--root=" + dirs.work], env: { ...gitEnv, WATERPLANE_VSCODE_HEALTH_DIR: made }, stdout: true, stderr: true,
    });
    w.on("error", rej);
    w.on("exit", () => res());
  });
  mkdirSync(join(dirs.work, ".waterplane"));
  copyFileSync(join(made, "repohealth.jsonl"), join(dirs.work, ".waterplane", "repohealth.jsonl"));
}

// The fixture conversation, filed under the slug the CLI gives this workspace's cwd.
const slug = dirs.work.replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(dirs.claude, "projects", slug), { recursive: true });
copyFileSync(FIXTURE, join(dirs.claude, "projects", slug, `${CONV}.jsonl`));
{
  // The fixture is the older one by a few minutes; the second is written just now, so it is the newest.
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(dirs.claude, "projects", slug, `${CONV}.jsonl`), old, old);
  const at = (s) => new Date(Date.now() - 20_000 + s * 1000).toISOString();
  writeFileSync(join(dirs.claude, "projects", slug, `${CONV2}.jsonl`), [
    { type: "user", timestamp: at(0), cwd: dirs.work, message: { role: "user", content: SECOND } },
    { type: "assistant", timestamp: at(1), cwd: dirs.work, message: { id: "it-1", model: "claude-sonnet-4-5", role: "assistant", stop_reason: "end_turn",
      usage: { input_tokens: 40, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 30 } } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const out = join(root, "result.json");
const sig = join(root, "sig");
mkdirSync(sig);
const port = await new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env, CLAUDE_CONFIG_DIR: dirs.claude, WP_IT_OUT: out, WP_IT_CONV: CONV, WP_IT_CONV2: CONV2, WP_IT_SECOND: SECOND, WP_IT_SIG: sig,
  WP_IT_STORAGE: join(dirs.user, "User", "globalStorage", `${manifest.publisher}.${manifest.name}`.toLowerCase()) };
// A launch from inside a VS Code terminal or an Electron tool would otherwise attach to that one.
for (const k of Object.keys(env)) if (k.startsWith("VSCODE_") || k === "ELECTRON_RUN_AS_NODE") delete env[k];

console.log(`vsix:   ${vsix} (${manifest.version})\nvscode: ${bin}\nscratch: ${root}`);
const args = [
  `--extensionDevelopmentPath=${join(dirs.unpacked, "extension")}`,
  `--extensionTestsPath=${join(here, "suite.cjs")}`,
  `--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.exts}`,
  "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
  "--disable-gpu", `--remote-debugging-port=${port}`, "--new-window", dirs.work,
];
const t0 = Date.now();
const code = await new Promise((res) => {
  const p = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  p.stdout.on("data", (b) => log.push(b));
  p.stderr.on("data", (b) => log.push(b));
  const timer = setTimeout(() => { console.error("timed out after 5 min"); p.kill("SIGKILL"); }, 5 * 60_000);
  // The suite asks for a webview probe by writing sig/<name>.req with the modes it expects open;
  // the verdict goes back as sig/<name>.json.
  const poll = setInterval(async () => {
    for (const f of readdirSync(sig).filter((n) => n.endsWith(".req"))) {
      const name = f.slice(0, -4);
      const body = readFileSync(join(sig, f), "utf8");
      rmSync(join(sig, f));
      // `{tab, needles}`: wait for the panel's text (the suite shows the view first); otherwise a comma list of modes to see rendered.
      const ask = body.startsWith("{") ? JSON.parse(body) : null;
      const verdict = ask ? await probePanelText(port, ask.tab, ask.needles, ask.click ?? null) : await probeWebviews(port, body.split(",").filter(Boolean));
      writeFileSync(join(sig, `${name}.json`), JSON.stringify(verdict));
    }
  }, 300);
  p.on("close", (c) => {
    clearTimeout(timer);
    clearInterval(poll);
    if (c !== 0) writeFileSync(join(root, "vscode.log"), Buffer.concat(log));
    res(c ?? 1);
  });
});

let checks = [];
try { checks = JSON.parse(readFileSync(out, "utf8")).checks; } catch { /* the suite never got to write */ }
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name} (${c.ms} ms)${c.ok ? "" : `\n     ${c.why}`}`);
const passed = code === 0 && checks.length > 0 && checks.every((c) => c.ok);
console.log(`\n${passed ? "PASS" : "FAIL"}: ${checks.filter((c) => c.ok).length}/${checks.length} checks, VS Code exit ${code}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!passed) console.log(`kept for a look: ${root}${existsSync(join(root, "vscode.log")) ? ` (VS Code output in ${join(root, "vscode.log")})` : ""}`);
else if (!keep) rmSync(root, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
