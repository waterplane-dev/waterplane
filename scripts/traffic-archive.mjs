#!/usr/bin/env node
// Keeps the GitHub numbers GitHub forgets. Traffic (clones, views) is kept for 14 days only, and
// release download counts are a running total with no history, so this appends both to a JSONL
// OUTSIDE the repo, one row per repo, kind and day, never the same row twice:
//
//   node scripts/traffic-archive.mjs                    archive waterplane-dev/waterplane
//   node scripts/traffic-archive.mjs --repo o/r ...     other repos (repeatable)
//   node scripts/traffic-archive.mjs --out <file>       default <state dir>/traffic/github.jsonl
//   node scripts/traffic-archive.mjs --install-launchd  run it weekly (macOS), then exit
//
// Rows:
//   {"repo","kind":"clones"|"views","day":"YYYY-MM-DD","count","uniques","at"}  one per UTC day
//   {"repo","kind":"downloads","day","tag","asset","count","at"}                the running total, as of `day`
// A traffic day is written only once it is over (UTC): today's bucket is still counting. A day
// already in the file is never rewritten, so the file only grows and a re-run adds nothing.
// Needs `gh` signed in with push access to the repo (GitHub's traffic API refuses anyone else).
// Never runs in GitHub Actions (off repo-wide): launchd, weekly, well inside the 14 days.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../packages/shared/dist/brand.js";

export const DEFAULT_REPO = `${BRAND.githubOrg}/${BRAND.slug}`;
/** Beside the host's own launchd job: `<host label minus .host>.traffic-archive`. */
export const LAUNCHD_LABEL = `${BRAND.launchdLabel.replace(/\.host$/, "")}.traffic-archive`;

/** The daemon's state dir, by the rule in shared/src/statedir.ts (env → XDG → ~/.local/state). */
export function stateDir(env = process.env, home = os.homedir()) {
  if (env[`${BRAND.envPrefix}STATE_DIR`]) return env[`${BRAND.envPrefix}STATE_DIR`];
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, BRAND.configDirName);
  return path.join(home, ".local/state", BRAND.configDirName);
}

/** The dedup key: one row per repo, kind, day (and asset, for downloads). */
export const rowKey = (r) => [r.repo, r.kind, r.day, r.kind === "downloads" ? `${r.tag}/${r.asset}` : ""].join("|");

/** Rows from GitHub's answers, as of `now`. `traffic` is { clones, views } (the API bodies), `releases` the releases list. */
export function rowsFrom(repo, { traffic, releases }, now) {
  const today = now.toISOString().slice(0, 10);
  const at = now.toISOString();
  const rows = [];
  for (const kind of ["clones", "views"]) {
    for (const d of traffic[kind]?.[kind] ?? []) {
      const day = String(d.timestamp).slice(0, 10);
      if (day >= today) continue; // still counting
      rows.push({ repo, kind, day, count: d.count, uniques: d.uniques, at });
    }
  }
  for (const rel of releases ?? []) {
    for (const a of rel.assets ?? []) {
      rows.push({ repo, kind: "downloads", day: today, tag: rel.tag_name, asset: a.name, count: a.download_count, at });
    }
  }
  return rows;
}

/** The rows not already in `existingText` (JSONL), in order. Unreadable lines are skipped, never fatal. */
export function newRows(existingText, rows) {
  const seen = new Set();
  for (const line of existingText.split("\n")) {
    if (!line.trim()) continue;
    try { seen.add(rowKey(JSON.parse(line))); } catch { /* a torn line: keep going */ }
  }
  const out = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function launchdPlist({ node, script, out, repos, pathEnv, logDir }) {
  const args = [node, script, "--out", out, ...repos.flatMap((r) => ["--repo", r])];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <!-- Mondays 10:00. StartCalendarInterval runs once after wake when the Mac slept through it. -->
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(pathEnv)}</string></dict>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, "traffic-archive.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, "traffic-archive.err.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function gh(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function parseArgs(argv) {
  const o = { repos: [], out: null, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repos.push(argv[++i]);
    else if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--install-launchd") o.install = true;
    else { console.error(`traffic-archive: unknown argument ${a}`); process.exit(2); }
  }
  if (!o.repos.length) o.repos.push(DEFAULT_REPO);
  o.out ??= path.join(stateDir(), "traffic", "github.jsonl");
  return o;
}

function install(o) {
  if (process.platform !== "darwin") { console.error("traffic-archive: --install-launchd is macOS only"); process.exit(2); }
  const ghPath = execFileSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).trim();
  const logDir = path.join(os.homedir(), "Library/Logs", BRAND.slug);
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plist, launchdPlist({
    node: process.execPath, script: fileURLToPath(import.meta.url), out: o.out, repos: o.repos, logDir,
    pathEnv: [...new Set([path.dirname(ghPath), path.dirname(process.execPath), "/usr/bin", "/bin"])].join(":"),
  }));
  const domain = `gui/${process.getuid()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  console.log(`installed ${plist} (weekly, Mondays 10:00) — logs in ${logDir}`);
  console.log(`remove: launchctl bootout ${domain}/${LAUNCHD_LABEL} && rm ${plist}`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.install) return install(o);
  const now = new Date();
  const rows = [];
  for (const repo of o.repos) {
    const traffic = {
      clones: gh([`repos/${repo}/traffic/clones`]),
      views: gh([`repos/${repo}/traffic/views`]),
    };
    const releases = gh(["--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]).flat();
    rows.push(...rowsFrom(repo, { traffic, releases }, now));
  }
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const existing = fs.existsSync(o.out) ? fs.readFileSync(o.out, "utf8") : "";
  const add = newRows(existing, rows);
  if (add.length) fs.appendFileSync(o.out, add.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${now.toISOString()} traffic-archive: ${add.length} new of ${rows.length} rows → ${o.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) {
    console.error(`traffic-archive: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
}
