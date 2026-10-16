#!/usr/bin/env node
// Build and test the tree WITHOUT what stays private — proof that the public snapshot stands on its
// own. Copies the tracked files of this working tree (or, with --rev, of that commit: the snapshot
// `publish-public.mjs` would cut from it, `git archive`, the allow-list read from the same commit)
// into a temp dir, leaving out every path `deploy/public-allowlist.txt` keeps private (or, with
// --drop-only, only the private extension folders — the allow-list's `!packages/extensions/<id>/**`
// carve-outs), then runs, in the copy, the steps `verifySteps()` lists (public-lib.mjs):
//
//   npm ci && npm run build && npm run release:build -- --unsigned && (check the .tgz) && npm run lint && npm run test:unit && npm run test:host   [&& node scripts/run-e2e.mjs <filters>]
// (release:build is the step the public repo's npm-publish workflow runs on the tag: rehearsed here, before the undraft.)
//
// `npm ci` is a REAL install from the copy's own package.json + package-lock.json + .npmrc, never
// this checkout's node_modules: a lockfile that still names a private package, or a dependency
// only this checkout happens to have, fails here and not on a stranger's first `npm ci`.
//
//   node scripts/verify-public-tree.mjs                 # the allow-listed working tree
//   node scripts/verify-public-tree.mjs --rev HEAD      # the allow-listed snapshot of a commit (release:publish runs this)
//   node scripts/verify-public-tree.mjs --drop-only     # everything but the private extensions
//   node scripts/verify-public-tree.mjs --e2e git,plugin --keep
//   node scripts/verify-public-tree.mjs --rev HEAD --log out.log   # steps' output to the file; the screen gets
//                                                                   # one line per step + a heartbeat (the build sheet)
//
// Nothing here touches this checkout: the copy has its own node_modules and dist/ (the web bundle it
// builds is the copy's, never the live `packages/web/dist`). The copy is removed on success unless
// --keep; kept on failure, and its path printed. The cheap half of the same promise runs on every
// `npm run test:unit`: `tools/publictree.test.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, fstatSync, openSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, parseAllowlist, privateExtensions, verifySteps } from "./release/public-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const rev = opt("--rev");
// --log FILE: the steps' own output (thousands of lines of npm and test noise) goes to FILE, and the
// screen keeps a short running account — each step as it starts, its time and verdict as it ends,
// and every 20s the newest line of the log, so a phone watching the build sees it move.
const logPath = opt("--log");
if (args.includes("--log") && !logPath) { console.error("verify-public-tree: --log needs a file"); process.exit(2); }
const logFd = logPath ? openSync(logPath, "w") : null;
const say = (line, err = false) => {
  (err ? console.error : console.log)(line);
  if (logFd !== null) appendFileSync(logFd, line + "\n");
};
const secs = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
const logLines = (from = 0) => {
  try {
    return readFileSync(logPath).subarray(from).toString("utf8")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
};
const lastLogLine = () => (logLines(Math.max(0, fstatSync(logFd).size - 4096)).at(-1) ?? "").slice(0, 100);
// What a failed step said, for the screen: its ✖ / not-ok / error lines if it printed any, else its tail.
const failureExcerpt = (from) => {
  const lines = logLines(from);
  const marked = lines.filter((l) => !/^(✔|ok\b)/.test(l) && /^(✖|not ok\b)|\berror\b/i.test(l));
  return [...new Set(marked.length ? marked : lines)].slice(-15).map((l) => `      ${l.slice(0, 160)}`);
};
if (args.includes("--rev") && !rev) { console.error("verify-public-tree: --rev needs a commit"); process.exit(2); }

// The source: this working tree, or `git archive <rev>` unpacked (tracked files of that commit only).
let SRC = ROOT;
let stage = null;
if (rev) {
  const commit = execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: ROOT, encoding: "utf8" }).trim();
  stage = mkdtempSync(join(tmpdir(), "public-tree-src-"));
  const tarDir = mkdtempSync(join(tmpdir(), "public-tree-tar-"));
  const tar = join(tarDir, "src.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, commit], { cwd: ROOT });
  execFileSync("tar", ["-xf", tar, "-C", stage]);
  rmSync(tarDir, { recursive: true, force: true });
  SRC = stage;
  say(`verify-public-tree: source is ${rev} (${commit.slice(0, 10)}), not the working tree`);
}
const allowText = readFileSync(join(SRC, "deploy/public-allowlist.txt"), "utf8");
const rules = parseAllowlist(allowText);
const PRIVATE_EXTENSIONS = privateExtensions(allowText).map((id) => `packages/extensions/${id}/`);
const tracked = rev
  ? execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", rev], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean)
  : execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const keep = (p) => {
  if (PRIVATE_EXTENSIONS.some((d) => p.startsWith(d))) return false;
  return flag("--drop-only") ? true : classify(p, rules).included;
};

const dest = mkdtempSync(join(tmpdir(), "public-tree-"));
let copied = 0;
for (const p of tracked) {
  if (!keep(p)) continue;
  const src = join(SRC, p);
  if (!lstatSync(src, { throwIfNoEntry: false })) continue; // deleted in the working tree, not yet committed
  mkdirSync(dirname(join(dest, p)), { recursive: true });
  const st = lstatSync(src);
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), join(dest, p));
  else copyFileSync(src, join(dest, p));
  copied++;
}
say(`verify-public-tree: ${copied} files into ${dest}${flag("--drop-only") ? " (private extensions dropped)" : " (allow-listed)"}${rev ? ` from ${rev}` : ""}`);
// A repository of its own: several checks read `git ls-files` (the brand ratchet, the
// repo-health engine, `tools/publictree.test.mjs`), and the public snapshot is a repository too.
const g = (...a) => execFileSync("git", ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: dest, stdio: "ignore" });
// Two commits, not one: the repo-health tests assert that a scoped history (`tools/`) is SMALLER
// than the whole one, which a single commit touching everything can never be.
g("init", "-q");
g("add", "-A", "--", ".", ":(exclude)tools");
g("commit", "-q", "--no-verify", "--allow-empty", "-m", "public tree snapshot");
g("add", "-A");
g("commit", "-q", "--no-verify", "--allow-empty", "-m", "public tree snapshot: tools/");

if (stage) rmSync(stage, { recursive: true, force: true });

const steps = verifySteps({ e2e: opt("--e2e") });
// Every step runs (an install or build failure stops the rest — nothing after it means anything),
// so one report says everything the copy got wrong.
const failed = [];
const t0 = Date.now();
for (const [i, { cmd, args: a, stop }] of steps.entries()) {
  const name = `${cmd} ${a.join(" ")}`;
  const started = Date.now();
  const logFrom = logFd !== null ? fstatSync(logFd).size : 0;
  if (logFd !== null) say(`[${i + 1}/${steps.length}] ${name} …`);
  else console.log(`\n──────── ${name} (in the copy) ────────`);
  const beat = logFd !== null
    ? setInterval(() => { const l = lastLogLine(); console.log(`    … ${secs(Date.now() - started)}${l ? ` · ${l}` : ""}`); }, 20_000)
    : null;
  const status = await new Promise((done) => {
    const child = spawn(cmd, a, { cwd: dest, stdio: logFd !== null ? ["ignore", logFd, logFd] : "inherit", env: process.env });
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });
  if (beat) clearInterval(beat);
  if (logFd !== null) {
    say(`    ${status === 0 ? "ok" : `FAILED (exit ${status})`} · ${secs(Date.now() - started)}`);
    if (status !== 0) for (const l of failureExcerpt(logFrom)) console.log(l);
  }
  if (status !== 0) {
    failed.push(name);
    if (stop) break;
  }
}
if (failed.length) {
  say(`\nverify-public-tree: FAILED: ${failed.map((f) => `\`${f}\``).join(", ")} — the copy is kept at ${dest} (${secs(Date.now() - t0)})`, true);
  if (logFd !== null) closeSync(logFd);
  process.exit(1);
}
say(`\nverify-public-tree: the tree without the private extensions installs, builds, lints and passes${opt("--e2e") ? " (and its e2e)" : ""} (${secs(Date.now() - t0)}).`);
if (flag("--keep")) say(`kept: ${dest}`);
else rmSync(dest, { recursive: true, force: true });
if (logFd !== null) closeSync(logFd);
