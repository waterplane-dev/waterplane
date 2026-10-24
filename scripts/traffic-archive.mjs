#!/usr/bin/env node
// Keeps the numbers GitHub, the VS Code Marketplace, npm and Google Play forget. Traffic (clones,
// views) is kept for 14 days only; release downloads, Marketplace installs and a Play listing's range
// are running totals with no history; npm serves daily downloads for a sliding window only. So this
// appends them to a JSONL OUTSIDE the repo, one row per repo, kind and day, never the same row twice:
//
//   node scripts/traffic-archive.mjs                    archive waterplane-dev/waterplane
//   node scripts/traffic-archive.mjs --repo o/r ...     other repos (repeatable)
//   node scripts/traffic-archive.mjs --ext pub.name     other Marketplace extensions (repeatable)
//   node scripts/traffic-archive.mjs --npm pkg          other npm packages (repeatable)
//   node scripts/traffic-archive.mjs --play pkg         other Play apps (repeatable): the public listing's
//                                                       download range ("10+"), no sign-in
//   node scripts/traffic-archive.mjs --play-bucket B    ONLY the exact daily installs of every --play app, from
//                                                       Play Console's report bucket (gs://B); needs a Google
//                                                       token in CLOUDSDK_AUTH_ACCESS_TOKEN (e.g. from
//                                                       `gcloud auth print-access-token`). The reports stay in the bucket, so
//                                                       one run fills every missing day: no daily sign-in.
//   node scripts/traffic-archive.mjs --out <file>       default <state dir>/traffic/github.jsonl
//   node scripts/traffic-archive.mjs --report [days]    print a Markdown summary of the file, no fetch
//   node scripts/traffic-archive.mjs --install-launchd  run it daily (macOS), then exit
//
// Rows:
//   {"repo","kind":"clones"|"views","day":"YYYY-MM-DD","count","uniques","at"}  one per UTC day
//   {"repo","kind":"downloads","day","tag","asset","count","at"}                the running total, as of `day`
//   {"repo":"<pub.name>","kind":"marketplace","day","installs","downloads","at"} the running totals, as of `day`
//   {"repo":"<pkg>","kind":"npm","day","count","at"}                          one per UTC day
//   {"repo":"<app>","kind":"playlisting","day","listed","range","min","name","at"} the public range, as of `day`
//   {"repo":"<app>","kind":"playinstalls","day","installs","uninstalls","active","total","at"}  one per day
// A traffic day is written only once it is over (UTC): today's bucket is still counting. A day
// already in the file is never rewritten, so the file only grows and a re-run adds nothing.
// Needs `gh` signed in with push access to the repo (GitHub's traffic API refuses anyone else).
// The Marketplace and npm queries are public, no sign-in. Never runs in GitHub Actions (off repo-wide): launchd,
// daily, so a running total gets one reading per day.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../packages/shared/dist/brand.js";

export const DEFAULT_REPO = `${BRAND.githubOrg}/${BRAND.slug}`;
/** packages/vscode's `publisher.name`. */
export const DEFAULT_EXT = `${BRAND.githubOrg}.${BRAND.slug}`;
/** The npm package the installer publishes (`<slug>@<version>`, check-npm-tarball.mjs). */
export const DEFAULT_NPM = BRAND.slug;
/** The Play flavor's applicationId (the store listing's `id=`). */
export const DEFAULT_PLAY = BRAND.appId;
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

/** The marketplace row from an extensionquery answer, or null when the extension is not in it. */
export function marketplaceRow(ext, answer, now) {
  const e = answer?.results?.[0]?.extensions?.[0];
  if (!e) return null;
  const stat = (n) => e.statistics?.find((s) => s.statisticName === n)?.value;
  const installs = stat("install"), downloads = stat("downloadCount");
  if (typeof installs !== "number" && typeof downloads !== "number") return null;
  return { repo: ext, kind: "marketplace", day: now.toISOString().slice(0, 10), installs: installs ?? null, downloads: downloads ?? null, at: now.toISOString() };
}

/** Rows from an npm downloads/range answer, as of `now`: one per finished UTC day, like traffic. */
export function npmRows(pkg, answer, now) {
  const today = now.toISOString().slice(0, 10);
  const at = now.toISOString();
  return (answer?.downloads ?? [])
    .filter((d) => typeof d.day === "string" && d.day < today && typeof d.downloads === "number")
    .map((d) => ({ repo: pkg, kind: "npm", day: d.day, count: d.downloads, at }));
}

/** The public listing's download range ("10+", "1K+") as a row. `html` null means no public page (an
 *  app in review, or unpublished): a row saying so, `listed: false`, so the dashboard can say it too.
 *  A page without the figure (Play hides it below its first range) is null: nothing to record. */
export function playListingRow(app, html, now) {
  if (html == null) return { repo: app, kind: "playlisting", day: now.toISOString().slice(0, 10), listed: false, range: null, min: null, at: now.toISOString() };
  const m = /<div[^>]*>([0-9][0-9.,]*[KMB]?)\+<\/div><div[^>]*>Downloads</.exec(html);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[1].slice(-1)] ?? 1;
  const min = Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
  const title = /<title[^>]*>([^<]+?) - Apps on Google Play<\/title>/.exec(html)?.[1];
  const name = title?.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"') ?? null;
  return { repo: app, kind: "playlisting", day: now.toISOString().slice(0, 10), listed: true, range: `${m[1]}+`, min, name, at: now.toISOString() };
}

/** One Play Console installs report (`stats/installs/installs_<app>_<YYYYMM>_overview.csv`, UTF-16
 *  with a BOM, or UTF-8) as rows, one per day. Columns are read by header name, since Play has
 *  renamed them over the years; a column it no longer sends is null, never 0. The last two days are
 *  left out: Play fills them in late, and a day in the file is never rewritten. */
export function playCsvRows(app, buf, now) {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le")
    : buf.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const cells = (l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iDay = col("date"), iIn = col("daily user installs", "daily device installs", "install events"),
    iOut = col("daily user uninstalls", "daily device uninstalls", "uninstall events"),
    iAct = col("active device installs"), iTot = col("total user installs");
  if (iDay < 0 || iIn < 0) return [];
  const cutoff = new Date(now.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const num = (c, i) => (i < 0 || c[i] === "" || c[i] == null || !Number.isFinite(Number(c[i])) ? null : Number(c[i]));
  const at = now.toISOString();
  const rows = [];
  for (const l of lines.slice(1)) {
    const c = cells(l);
    const day = c[iDay];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
    rows.push({ repo: app, kind: "playinstalls", day, installs: num(c, iIn), uninstalls: num(c, iOut), active: num(c, iAct), total: num(c, iTot), at });
  }
  return rows;
}

/** A release download a person installs: the signatures, checksums and release.json are fetched by
 *  the installer and the updater alongside it, so counting them repeats the same people. */
export const isInstall = (r) => r.kind === "downloads" && /\.(tar\.gz|apk)$/.test(r.asset);

/** A Markdown summary of the archive: the last `days` UTC days of traffic, and each running total
 *  now against `days` ago. Reads only the file; a total with no older reading says so. */
export function report(text, now, days = 14) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  const since = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);
  const out = [`# Reach, last ${days} days`, "", `From ${rows.length} archived rows, as of ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`];
  for (const repo of [...new Set(rows.filter((r) => r.kind === "clones" || r.kind === "views").map((r) => r.repo))]) {
    const sum = (kind, f) => rows.filter((r) => r.repo === repo && r.kind === kind && r.day >= since).reduce((a, r) => a + r[f], 0);
    out.push("", `## ${repo}`, "", `- Views: ${sum("views", "count")} (daily uniques summed: ${sum("views", "uniques")})`,
      `- Clones: ${sum("clones", "count")} (daily uniques summed: ${sum("clones", "uniques")})`);
    const active = rows.filter((r) => r.repo === repo && r.kind === "views" && r.day >= since && r.count > 0);
    if (active.length) out.push(`- Days with views: ${active.map((r) => `${r.day} (${r.count})`).join(", ")}`);
  }
  for (const pkg of [...new Set(rows.filter((r) => r.kind === "npm").map((r) => r.repo))]) {
    const rs = rows.filter((r) => r.repo === pkg && r.kind === "npm" && r.day >= since);
    const active = rs.filter((r) => r.count > 0);
    out.push("", `## npm ${pkg}`, "", `- Downloads: ${rs.reduce((a, r) => a + r.count, 0)}`);
    if (active.length) out.push(`- Days with downloads: ${active.map((r) => `${r.day} (${r.count})`).join(", ")}`);
  }
  const totals = (r) => r.kind === "marketplace" ? r.installs : r.count;
  const series = new Map();
  const installable = (r) => r.kind === "marketplace" || isInstall(r);
  for (const r of [...rows.filter((r) => r.kind === "marketplace"), ...rows.filter((r) => r.kind === "downloads")]) {
    if (!installable(r)) continue;
    const k = r.kind === "marketplace" ? `${r.repo} (Marketplace installs)` : `${r.repo} ${r.tag}/${r.asset} (downloads)`;
    series.set(k, [...(series.get(k) ?? []), r]);
  }
  if (series.size) out.push("", "## Running totals", "", "Release downloads count the .tar.gz and .apk only.", "");
  for (const [k, rs] of series) {
    rs.sort((a, b) => a.day.localeCompare(b.day));
    const last = rs.at(-1), base = rs.filter((r) => r.day <= since).at(-1);
    const extra = last.kind === "marketplace" && last.downloads != null ? `, ${last.downloads} downloads incl. updates` : "";
    out.push(`- ${k}: ${totals(last)} on ${last.day}${extra}` + (base ? `, +${totals(last) - totals(base)} since ${base.day}` : `, first reading ${rs[0].day}`));
  }
  return out.join("\n") + "\n";
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

export function launchdPlist({ node, script, out, repos, exts = [], npms = [], plays = [], pathEnv, logDir }) {
  const args = [node, script, "--out", out, ...repos.flatMap((r) => ["--repo", r]), ...exts.flatMap((e) => ["--ext", e]),
    ...npms.flatMap((n) => ["--npm", n]), ...plays.flatMap((p) => ["--play", p])];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <!-- Daily 10:00. StartCalendarInterval runs once after wake when the Mac slept through it. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
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
  const o = { repos: [], exts: [], npms: [], plays: [], bucket: null, out: null, install: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repos.push(argv[++i]);
    else if (a === "--ext") o.exts.push(argv[++i]);
    else if (a === "--npm") o.npms.push(argv[++i]);
    else if (a === "--play") o.plays.push(argv[++i]);
    else if (a === "--play-bucket") o.bucket = argv[++i].replace(/^gs:\/\//, "").replace(/\/.*$/, "");
    else if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--report") o.report = /^\d+$/.test(argv[i + 1] ?? "") ? Number(argv[++i]) : 14;
    else if (a === "--install-launchd") o.install = true;
    else { console.error(`traffic-archive: unknown argument ${a}`); process.exit(2); }
  }
  if (!o.repos.length) o.repos.push(DEFAULT_REPO);
  if (!o.exts.length) o.exts.push(DEFAULT_EXT);
  if (!o.npms.length) o.npms.push(DEFAULT_NPM);
  if (!o.plays.length) o.plays.push(DEFAULT_PLAY);
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
    node: process.execPath, script: fileURLToPath(import.meta.url), out: o.out, repos: o.repos, exts: o.exts, npms: o.npms, plays: o.plays, logDir,
    pathEnv: [...new Set([path.dirname(ghPath), path.dirname(process.execPath), "/usr/bin", "/bin"])].join(":"),
  }));
  const domain = `gui/${process.getuid()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  console.log(`installed ${plist} (daily, 10:00) — logs in ${logDir}`);
  console.log(`remove: launchctl bootout ${domain}/${LAUNCHD_LABEL} && rm ${plist}`);
}

async function marketplace(ext) {
  const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json;api-version=7.1-preview.1" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: ext }] }], flags: 0x100 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`marketplace ${ext}: HTTP ${res.status}`);
  return res.json();
}

async function npm(pkg) {
  const res = await fetch(`https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(pkg)}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`npm ${pkg}: HTTP ${res.status}`);
  return res.json();
}

async function playListing(app) {
  const res = await fetch(`https://play.google.com/store/apps/details?id=${encodeURIComponent(app)}&hl=en&gl=US`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null; // not public yet (in review), or unpublished
  if (!res.ok) throw new Error(`play ${app}: HTTP ${res.status}`);
  return res.text();
}

/** Every installs report for `app` in the bucket, as rows. */
async function playReports(bucket, app, token) {
  const auth = { authorization: `Bearer ${token}` };
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  const rows = [];
  let page = "";
  do {
    const q = new URLSearchParams({ prefix: `stats/installs/installs_${app}_`, ...(page ? { pageToken: page } : {}) });
    const res = await fetch(`${base}?${q}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`play bucket ${bucket}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const list = await res.json();
    for (const item of list.items ?? []) {
      if (!/_overview\.csv$/.test(item.name)) continue;
      const f = await fetch(`${base}/${encodeURIComponent(item.name)}?alt=media`, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!f.ok) throw new Error(`play report ${item.name}: HTTP ${f.status}`);
      rows.push(...playCsvRows(app, Buffer.from(await f.arrayBuffer()), new Date()));
    }
    page = list.nextPageToken ?? "";
  } while (page);
  return rows;
}

function append(out, rows, now) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const add = newRows(existing, rows);
  if (add.length) fs.appendFileSync(out, add.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${now.toISOString()} traffic-archive: ${add.length} new of ${rows.length} rows → ${out}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.install) return install(o);
  if (o.report != null) {
    process.stdout.write(report(fs.existsSync(o.out) ? fs.readFileSync(o.out, "utf8") : "", new Date(), o.report));
    return;
  }
  const now = new Date();
  const rows = [];
  if (o.bucket) {
    const token = process.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
    if (!token) throw new Error("--play-bucket needs a Google token in CLOUDSDK_AUTH_ACCESS_TOKEN (e.g. from `gcloud auth print-access-token`)");
    for (const app of o.plays) {
      const got = await playReports(o.bucket, app, token);
      console.log(`traffic-archive: ${app}: ${got.length} report day${got.length === 1 ? "" : "s"}${got.length ? "" : " (Play writes a report once the app has installs)"}`);
      rows.push(...got);
    }
    return append(o.out, rows, now);
  }
  for (const repo of o.repos) {
    const traffic = {
      clones: gh([`repos/${repo}/traffic/clones`]),
      views: gh([`repos/${repo}/traffic/views`]),
    };
    const releases = gh(["--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]).flat();
    rows.push(...rowsFrom(repo, { traffic, releases }, now));
  }
  for (const ext of o.exts) {
    // A Marketplace outage must not cost the GitHub rows, which expire; say it and carry on.
    try {
      const row = marketplaceRow(ext, await marketplace(ext), now);
      if (row) rows.push(row);
      else console.error(`traffic-archive: ${ext} not found on the Marketplace`);
    } catch (e) { console.error(`traffic-archive: ${e.message}`); }
  }
  for (const pkg of o.npms) {
    try { rows.push(...npmRows(pkg, await npm(pkg), now)); } catch (e) { console.error(`traffic-archive: ${e.message}`); }
  }
  for (const app of o.plays) {
    try {
      const row = playListingRow(app, await playListing(app), now);
      if (row) rows.push(row);
      else console.error(`traffic-archive: ${app}'s Play listing shows no download range`);
    } catch (e) { console.error(`traffic-archive: ${e.message}`); }
  }
  append(o.out, rows, now);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`traffic-archive: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  });
}
