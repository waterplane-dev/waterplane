// The web bundle the Android shell updates itself from: the manifest describes
// exactly the tree the daemon serves, every file comes back byte-identical to
// its advertised sha256, and a path from the phone cannot climb out of it.
//
// Why this matters more than a normal read endpoint: what these two routes hand
// over becomes the app the phone RUNS. A manifest that disagrees with the files,
// or a hash nobody checks, is a half-written bundle replacing a working UI on a
// device that is nowhere near you.
//
// The hashes catch a bad transfer only, so this also pins the signature the
// phone checks: `sig` verifies over the decoded `signed` bytes with the key
// `welcome` hands out, and `signed` describes the same bundle as the manifest.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8807;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const DIST = resolve(process.cwd(), "packages/web/dist");

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

if (!existsSync(join(DIST, "index.html"))) {
  console.log("SKIP: no packages/web/dist — run `npm run build` first");
  process.exit(0);
}

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  [E.HOST]: "127.0.0.1",
  ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** The `welcome` frame a fresh socket gets. */
function welcome() {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("error", fail);
    setTimeout(() => fail(new Error("no welcome within 10 s")), 10_000).unref();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") { ws.close(); done(m); }
    });
  });
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

try {
  check(await waitUp(), "host is up");

  // ── manifest ────────────────────────────────────────────────────────────
  const m = await (await fetch(`${base}/api/webbundle`)).json();
  check(m.ok === true, `manifest ok${m.ok ? "" : ` — ${m.reason}`}`);

  // The id is the bundle's OWN, shipped inside it: that is what lets a running
  // app say which build it is without bookkeeping that can drift.
  const onDisk = readFileSync(join(DIST, "build-id.txt"), "utf8").trim();
  check(m.buildId === onDisk, `buildId is dist/build-id.txt (${m.buildId})`);
  check(/^[a-f0-9]{8,64}$/.test(m.buildId || ""), "buildId is a plain hex id (usable as a directory name)");

  const local = walk(DIST).sort();
  check(m.files.length === local.length, `manifest lists every file in dist (${m.files.length})`);
  const paths = new Set(m.files.map((f) => f.path));
  for (const need of ["index.html", "build-id.txt"]) {
    check(paths.has(need), `manifest includes ${need}`);
  }
  // Without build-id.txt in the bundle, a downloaded build could not identify
  // itself after it took over, and every launch would look like an update.
  check(m.total === m.files.reduce((n, f) => n + f.size, 0), "total is the sum of the file sizes");
  check(m.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)), "every file carries a sha256");
  check(!m.files.some((f) => f.path.startsWith("/") || f.path.includes("..")), "no absolute or climbing paths in the manifest");

  // ── files come back exactly as advertised ───────────────────────────────
  // Cover the shapes that matter: the entry point, the big hashed asset (the one
  // that actually changes), and a binary.
  const sample = [
    m.files.find((f) => f.path === "index.html"),
    m.files.find((f) => f.path.endsWith(".js")),
    m.files.find((f) => f.path.endsWith(".png")),
  ].filter(Boolean);
  check(sample.length >= 2, "found sample files to verify");
  for (const f of sample) {
    const r = await fetch(`${base}/api/webbundle/file?path=${encodeURIComponent(f.path)}`);
    const buf = Buffer.from(await r.arrayBuffer());
    check(r.status === 200, `GET ${f.path} → 200`);
    check(buf.length === f.size, `${f.path} is ${f.size} bytes as advertised`);
    check(sha(buf) === f.sha256, `${f.path} matches its manifest sha256`);
    check(buf.equals(readFileSync(join(DIST, f.path))), `${f.path} is byte-identical to the file on disk`);
  }

  // ── containment ─────────────────────────────────────────────────────────
  // The path comes off the network. `..` resolves to a real file, so it has to
  // be refused AFTER resolution, not by pattern-matching the string.
  for (const bad of [
    "../package.json",
    "../../package.json",
    "assets/../../../package.json",
    "/etc/passwd",
    "",
    "does-not-exist.js",
  ]) {
    const r = await fetch(`${base}/api/webbundle/file?path=${encodeURIComponent(bad)}`);
    check(r.status === 404, `refuses ${JSON.stringify(bad)} (${r.status})`);
  }
  // A directory is not a file, even though it is inside the bundle.
  const dirTry = await fetch(`${base}/api/webbundle/file?path=assets`);
  check(dirTry.status === 404, "refuses a directory");

  // ── the manifest tracks the tree ────────────────────────────────────────
  // Second call must agree with the first (the host caches hashes against
  // mtimes; a cache that answered differently would be worse than none).
  const m2 = await (await fetch(`${base}/api/webbundle`)).json();
  check(m2.buildId === m.buildId && m2.files.length === m.files.length, "repeat manifest is stable");
  const idx = m.files.find((f) => f.path === "index.html");
  check(idx && idx.size === statSync(join(DIST, "index.html")).size, "sizes come from the real files");

  // ── the signature ───────────────────────────────────────────────────────
  const w = await welcome();
  check(typeof w.updateKey === "string" && w.updateKey.length > 0, "welcome hands out the update key");
  check(w.tlsPort === undefined && w.tlsSpki === undefined, "welcome says nothing about a TLS listener it does not know of");
  const pub = createPublicKey({ key: Buffer.from(w.updateKey, "base64"), format: "der", type: "spki" });
  const signedBytes = Buffer.from(m.signed, "base64");
  const sigBytes = Buffer.from(m.sig, "base64");
  check(sigBytes.length === 64, "sig is 64-byte P1363");
  check(verify("sha256", signedBytes, { key: pub, dsaEncoding: "ieee-p1363" }, sigBytes), "sig verifies with the key welcome gave");
  const body = JSON.parse(signedBytes.toString("utf8"));
  check(body.v === 1 && body.hostId === w.hostId, "signed names this desktop");
  check(body.buildId === m.buildId && body.total === m.total, "signed names the build the manifest describes");
  check(JSON.stringify(body.files) === JSON.stringify(m.files), "signed lists the same files and hashes");
  check(Number.isInteger(body.gen) && body.gen >= 1, "signed carries a gen");
  check(m2.sig === m.sig, "a repeat poll is not signed again");
} catch (e) {
  console.log("FAIL: threw —", e?.message || e);
  failed = true;
}

host.kill();
console.log(failed ? "\nFAILURES" : "\nALL PASS");
setTimeout(() => process.exit(failed ? 1 : 0), 150);
