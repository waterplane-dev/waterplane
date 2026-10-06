#!/usr/bin/env node
// Build and test the tree WITHOUT what stays private — proof that the public snapshot stands on its
// own. Copies the tracked files of this working tree (or, with --rev, of that commit: the snapshot
// `publish-public.mjs` would cut from it, `git archive`, the allow-list read from the same commit)
// into a temp dir, leaving out every path `deploy/public-allowlist.txt` keeps private (or, with
// --drop-only, only the private extension folders — the allow-list's `!packages/extensions/<id>/**`
// carve-outs), then runs, in the copy, the steps `verifySteps()` lists (public-lib.mjs):
//
//   npm ci && npm run build && npm run lint && npm run test:unit && npm run test:host   [&& node scripts/run-e2e.mjs <filters>]
//
// `npm ci` is a REAL install from the copy's own package.json + package-lock.json + .npmrc, never
// this checkout's node_modules: a lockfile that still names a private package, or a dependency
// only this checkout happens to have, fails here and not on a stranger's first `npm ci`.
//
//   node scripts/verify-public-tree.mjs                 # the allow-listed working tree
//   node scripts/verify-public-tree.mjs --rev HEAD      # the allow-listed snapshot of a commit (release:publish runs this)
//   node scripts/verify-public-tree.mjs --drop-only     # everything but the private extensions
//   node scripts/verify-public-tree.mjs --e2e git,plugin --keep
//
// Nothing here touches this checkout: the copy has its own node_modules and dist/ (the web bundle it
// builds is the copy's, never the live `packages/web/dist`). The copy is removed on success unless
// --keep; kept on failure, and its path printed. The cheap half of the same promise runs on every
// `npm run test:unit`: `tools/publictree.test.mjs`.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, parseAllowlist, privateExtensions, verifySteps } from "./release/public-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const rev = opt("--rev");
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
  console.log(`verify-public-tree: source is ${rev} (${commit.slice(0, 10)}), not the working tree`);
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
console.log(`verify-public-tree: ${copied} files into ${dest}${flag("--drop-only") ? " (private extensions dropped)" : " (allow-listed)"}${rev ? ` from ${rev}` : ""}`);
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
for (const { cmd, args: a, stop } of steps) {
  console.log(`\n──────── ${cmd} ${a.join(" ")} (in the copy) ────────`);
  const r = spawnSync(cmd, a, { cwd: dest, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed.push(`${cmd} ${a.join(" ")}`);
    if (stop) break;
  }
}
if (failed.length) {
  console.error(`\nverify-public-tree: FAILED: ${failed.map((f) => `\`${f}\``).join(", ")} — the copy is kept at ${dest}`);
  process.exit(1);
}
console.log(`\nverify-public-tree: the tree without the private extensions installs, builds, lints and passes${opt("--e2e") ? " (and its e2e)" : ""}.`);
if (flag("--keep")) console.log(`kept: ${dest}`);
else rmSync(dest, { recursive: true, force: true });
