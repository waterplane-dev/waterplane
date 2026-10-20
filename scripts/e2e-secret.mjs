// Write-only secret setter: host scope (<state>/.env), repo scope (.env), the
// gitignore gate (auto-add + refuse-on-tracked), masking, and that NO read path
// leaks the value.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8798;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-secret-`));
// Isolate host-scope secrets to a tmp config dir so the test never touches the
// real ~/.config/<app>/.env.
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-cfg-`));
// A write-only JSON target (whole-file raw JSON, no key) declared host-side.
const JSON_TARGET = join(CONFIG, "cookies.json");
writeFileSync(join(CONFIG, "write-targets.json"), JSON.stringify([
  { id: "cookies", label: "Cookies", mode: "json", path: JSON_TARGET },
]));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

const SECRET = "AIzaSyTESTKEY_0123456789abcdef";

bootWait(PORT, 900, async () => {
  try {
    // ── Host scope → <root>/<state>/.env ──────────────────────────────────
    const h = await post("/api/secret", { scope: "host", key: "GEMINI_API_KEY", value: SECRET });
    const envPath = join(CONFIG, ".env");
    check(h.ok && h.action === "created" && h.file === envPath, "host secret created in fixed config dir");
    check(h.masked === "••••cdef", "response is masked (last 4)");
    check(!JSON.stringify(h).includes(SECRET), "full value never returned in host response");
    check(readFileSync(envPath, "utf8").includes(`GEMINI_API_KEY=${SECRET}`), "value written to file");
    check((statSync(envPath).mode & 0o777) === 0o600, "file is chmod 600");

    // replace keeps it a single line
    const h2 = await post("/api/secret", { scope: "host", key: "GEMINI_API_KEY", value: SECRET + "2" });
    check(h2.action === "replaced", "second set reports replaced");
    const lines = readFileSync(envPath, "utf8").split("\n").filter((l) => l.startsWith("GEMINI_API_KEY="));
    check(lines.length === 1, "only one GEMINI_API_KEY line after replace");

    // no value GET counterpart exists
    const getMiss = await fetch(`${base}/api/secret`);
    check(getMiss.status === 404, "GET /api/secret has no read path");

    // ── Write-only targets: list + JSON (whole-file) target ─────────────
    const tl = await j("/api/secret/targets");
    check(Array.isArray(tl.targets) && tl.targets[0]?.id === "env", "targets list: built-in env first");
    const ct = tl.targets.find((t) => t.id === "cookies");
    check(ct && ct.mode === "json" && ct.path === JSON_TARGET, "targets list includes configured json target");

    const blob = JSON.stringify({ sid: SECRET, n: 1 });
    const jw = await post("/api/secret", { scope: "host", targetId: "cookies", value: blob });
    check(jw.ok && jw.action === "created" && jw.file === JSON_TARGET, "json target written (no key needed)");
    check(readFileSync(JSON_TARGET, "utf8") === blob, "json target file IS the raw JSON blob");
    check((statSync(JSON_TARGET).mode & 0o777) === 0o600, "json target is chmod 600");
    check(!JSON.stringify(jw).includes(SECRET), "json write response never returns the value");
    // invalid JSON rejected
    const badJson = await post("/api/secret", { scope: "host", targetId: "cookies", value: "{not json" });
    check(badJson.ok === false && /json/i.test(badJson.error || ""), "invalid JSON rejected");
    // unknown target rejected
    const badTarget = await post("/api/secret", { scope: "host", targetId: "nope", value: "{}" });
    check(badTarget.ok === false, "unknown target rejected");

    // bad key rejected
    const badKey = await post("/api/secret", { scope: "host", key: "no spaces!", value: "x" });
    check(badKey.ok === false, "invalid key rejected");
    // newline injection rejected
    const inj = await post("/api/secret", { scope: "host", key: "K", value: "a\nB=evil" });
    check(inj.ok === false, "newline in value rejected");

    // ── Repo scope: gitignore gate ──────────────────────────────────────
    // setup:false → no scaffolded .gitignore, so this exercises the "nothing
    // ignores .env yet" path the gate is actually for.
    const repo = await post("/api/repo", { name: "secretdemo", setup: false });
    const id = (await j("/api/repos")).targets.find((t) => t.repoName === "secretdemo").id;

    // .env is neither tracked nor ignored → host auto-adds it to .gitignore, then writes
    const r1 = await post("/api/secret", { scope: "repo", repoId: id, file: ".env", key: "API_TOKEN", value: SECRET });
    check(r1.ok && r1.addedToGitignore, "repo: .env auto-added to .gitignore");
    check(readFileSync(join(repo.path, ".gitignore"), "utf8").split("\n").some((l) => l.trim() === ".env"), ".gitignore now lists .env");
    check(readFileSync(join(repo.path, ".env"), "utf8").includes(`API_TOKEN=${SECRET}`), "repo .env got the value");

    // a tracked, non-ignored env file → REFUSE (would commit the secret)
    writeFileSync(join(repo.path, ".env.tracked"), "PLACEHOLDER=1\n");
    execFileSync("git", ["add", ".env.tracked"], { cwd: repo.path });
    execFileSync("git", ["commit", "-m", "track env", "--no-gpg-sign"], { cwd: repo.path });
    const r2 = await post("/api/secret", { scope: "repo", repoId: id, file: ".env.tracked", key: "X", value: SECRET });
    check(r2.ok === false && /tracked/.test(r2.error || ""), "refuses to write into a git-tracked env file");
    check(!readFileSync(join(repo.path, ".env.tracked"), "utf8").includes(SECRET), "tracked file left untouched");

    // a tracked template (.env.example) is committed by design — flagged template, not a leak
    writeFileSync(join(repo.path, ".env.example"), "API_TOKEN=changeme\n");
    execFileSync("git", ["add", ".env.example"], { cwd: repo.path });
    execFileSync("git", ["commit", "-m", "add example", "--no-gpg-sign"], { cwd: repo.path });

    // path traversal rejected
    const trav = await post("/api/secret", { scope: "repo", repoId: id, file: "../escape.env", key: "X", value: "y" });
    check(trav.ok === false, "traversal / non-root file rejected");

    // envfiles listing returns names + flags, never contents
    const ef = await j(`/api/repos/${id}/envfiles`);
    check(Array.isArray(ef.files) && ef.files.some((f) => f.name === ".env" && f.gitignored), "envfiles lists .env as gitignored");
    check(ef.files.some((f) => f.name === ".env.tracked" && f.tracked && !f.template), "envfiles flags tracked file");
    check(ef.files.some((f) => f.name === ".env.example" && f.template), "envfiles marks .env.example as template");
    check(!JSON.stringify(ef).includes(SECRET), "envfiles listing never exposes a value");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
