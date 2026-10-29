// The load flakes nobody has fixed yet — printed at the end of every pre-push, never blocking.
//
//   node scripts/flake-report.mjs [--all]   (npm run flakes = --all; the hook shows the newest five)
//
// run-e2e.mjs and run-node-tests.mjs stop refusing a push over a failure that passes alone, and
// log it instead (`~/.cache/<slug>/e2e-flakes.jsonl`, `host-flakes.jsonl`). A log nobody reads
// turns "not blocking" into "ignored": 23 e2e flakes had piled up there unread by 2026-10-27. So
// the gate says the count on every push, in the last lines the phone shows.
//
// OPEN = the test file has not been committed since its newest flake. A commit to the file is
// taken as an attempt at a fix and drops it from the count; it comes back if it flakes again.
// A file git cannot place (deleted, renamed) is not counted. Prints nothing when nothing is open.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SLUG } from "./lib-brand.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), SLUG);
const LOGS = ["e2e-flakes.jsonl", "host-flakes.jsonl"];
const SHOW = process.argv.includes("--all") ? Infinity : 5;

const git = (...args) => {
  try { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

const entries = [];
for (const log of LOGS) {
  let text = "";
  try { text = readFileSync(join(CACHE, log), "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.file && e.at) entries.push({ file: String(e.file), at: Date.parse(e.at), why: e.why?.[0] ?? e.tests?.[0] ?? "" });
    } catch { /* a torn line is skipped, not fatal */ }
  }
}
if (!entries.length) process.exit(0);

// run-e2e logs a script's basename; run-node-tests a repo-relative path. Place both in the tree.
const tracked = git("ls-files", "scripts", "packages/extensions", "packages/host/test").split("\n");
const place = (f) => (f.includes("/") ? (tracked.includes(f) ? f : null) : tracked.find((t) => basename(t) === f) ?? null);

const byFile = new Map();
for (const e of entries) {
  const path = place(e.file);
  if (!path) continue;
  const g = byFile.get(path) ?? { path, n: 0, newest: 0, why: "" };
  g.n++;
  if (e.at >= g.newest) { g.newest = e.at; g.why = e.why; }
  byFile.set(path, g);
}
const open = [...byFile.values()].filter((g) => {
  const touched = Date.parse(git("log", "-1", "--format=%cI", "--", g.path) || "0");
  return !(touched > g.newest);
}).sort((a, b) => b.newest - a.newest);
if (!open.length) process.exit(0);

const day = (t) => new Date(t).toISOString().slice(5, 10);
const total = open.reduce((s, g) => s + g.n, 0);
console.log(`\nflakes: ${open.length} test file(s) still flaky (${total} logged, newest ${day(open[0].newest)}) — not blocking; ${join(CACHE, "*-flakes.jsonl")}`);
for (const g of open.slice(0, SHOW)) {
  const why = g.why.length > 70 ? g.why.slice(0, 69) + "…" : g.why;
  console.log(`  ${String(g.n).padStart(2)}× ${basename(g.path)}  ${day(g.newest)}  ${why}`);
}
if (open.length > SHOW) console.log(`  … ${open.length - SHOW} more: npm run flakes`);
