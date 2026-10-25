#!/usr/bin/env node
// A dashboard over the numbers scripts/traffic-archive.mjs keeps: GitHub views and clones, release
// downloads, VS Code Marketplace installs, npm downloads and Google Play installs, drawn from the archive file alone (it
// never calls GitHub, the Marketplace, npm or Play itself — the daily archive job does that).
//
//   node scripts/reach-dashboard.mjs                    serve on 127.0.0.1:8790
//   node scripts/reach-dashboard.mjs --port N --in <file>
//   node scripts/reach-dashboard.mjs --install-launchd  keep it running (macOS) and print the
//                                                       `tailscale serve` line that publishes it
//
// LOOPBACK ONLY, by design: the tailnet reaches it through `tailscale serve --https=<port>`, the
// same front door the host uses, so nothing here ever listens on a Tailscale or LAN address.
// Read-only: GET / and GET /data.json, nothing else. The Host check stops a web page in a browser
// on this machine from reading it through DNS rebinding.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BRAND } from "../packages/shared/dist/brand.js";
import { isInstall, stateDir } from "./traffic-archive.mjs";

export const DEFAULT_PORT = 8790;
export const BIND = "127.0.0.1";
export const LAUNCHD_LABEL = `${BRAND.launchdLabel.replace(/\.host$/, "")}.reach-dashboard`;
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "reach-dashboard.html");

/** Loopback names, or this machine's MagicDNS name as `tailscale serve` forwards it. */
export function hostAllowed(host) {
  const name = String(host ?? "").replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name);
}

/** The archive's rows shaped for the page: one series per source, sorted by day. A running total
 *  (release installs) is carried forward per asset, so a day sums every asset's latest reading. */
export function shape(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  const byDay = (a, b) => a.day.localeCompare(b.day);
  const group = (kind, pick) => {
    const out = {};
    for (const r of rows.filter((r) => r.kind === kind)) (out[r.repo] ??= []).push({ day: r.day, ...pick(r) });
    for (const k in out) out[k].sort(byDay);
    return out;
  };
  const releases = {};
  const perRepo = {};
  for (const r of rows.filter(isInstall).sort(byDay)) (perRepo[r.repo] ??= []).push(r);
  for (const [repo, rs] of Object.entries(perRepo)) {
    const latest = new Map();
    const days = [];
    for (const r of rs) {
      latest.set(`${r.tag}/${r.asset}`, r.count);
      const total = [...latest.values()].reduce((a, n) => a + n, 0);
      if (days.at(-1)?.day === r.day) days.at(-1).total = total;
      else days.push({ day: r.day, total });
    }
    releases[repo] = days;
  }
  return {
    views: group("views", (r) => ({ count: r.count, uniques: r.uniques })),
    clones: group("clones", (r) => ({ count: r.count, uniques: r.uniques })),
    npm: group("npm", (r) => ({ count: r.count })),
    npmPublish: group("npmpublish", (r) => ({ version: r.version })),
    releaseDays: group("release", (r) => ({ tag: r.tag })),
    stars: group("stars", (r) => ({ stars: r.stars, forks: r.forks, watchers: r.watchers })),
    marketplace: group("marketplace", (r) => ({ installs: r.installs, downloads: r.downloads })),
    playListing: group("playlisting", (r) => ({ listed: r.listed !== false, range: r.range, min: r.min, name: r.name ?? null })),
    playInstalls: group("playinstalls", (r) => ({ installs: r.installs, uninstalls: r.uninstalls, active: r.active, total: r.total })),
    releases,
    rows: rows.length,
  };
}

export function handler(file) {
  return (req, res) => {
    const send = (code, type, body) => {
      // One line per request: the only way to see what a phone that "does not load" actually sent.
      console.log(`${new Date().toISOString()} ${code} ${req.method} ${req.url} host=${req.headers.host ?? "-"} dest=${req.headers["sec-fetch-dest"] ?? "-"} ua=${String(req.headers["user-agent"] ?? "-").slice(0, 160)}`);
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    if (!hostAllowed(req.headers.host)) return send(403, "text/plain", "host not allowed\n");
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only\n");
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", fs.readFileSync(PAGE));
    // The page reports what it got to (and any script error) here, so a phone that shows a blank
    // page says why in this log. Read-only in effect: it only writes a log line, truncated.
    if (url.pathname === "/beacon") {
      console.log(`${new Date().toISOString()} beacon ${String(url.searchParams.get("m") ?? "").slice(0, 300)}`);
      return send(204, "text/plain", "");
    }
    if (url.pathname === "/data.json") {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return send(200, "application/json", JSON.stringify({ ...shape(text), file, at: new Date().toISOString() }));
    }
    send(404, "text/plain", "not found\n");
  };
}

function parseArgs(argv) {
  const o = { port: DEFAULT_PORT, file: path.join(stateDir(), "traffic", "github.jsonl"), install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--in") o.file = path.resolve(argv[++i]);
    else if (a === "--install-launchd") o.install = true;
    else { console.error(`reach-dashboard: unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

export function launchdPlist({ node, script, port, file, logDir }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = [node, script, "--port", String(port), "--in", file];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, "reach-dashboard.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, "reach-dashboard.err.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function install(o) {
  if (process.platform !== "darwin") { console.error("reach-dashboard: --install-launchd is macOS only"); process.exit(2); }
  const logDir = path.join(os.homedir(), "Library/Logs", BRAND.slug);
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plist, launchdPlist({ node: process.execPath, script: fileURLToPath(import.meta.url), port: o.port, file: o.file, logDir }));
  const domain = `gui/${process.getuid()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  console.log(`installed ${plist} (always on, ${BIND}:${o.port}) — logs in ${logDir}`);
  console.log(`publish on the tailnet: tailscale serve --bg --https=${o.port} http://${BIND}:${o.port}`);
  console.log(`remove: launchctl bootout ${domain}/${LAUNCHD_LABEL} && rm ${plist} && tailscale serve --https=${o.port} off`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const o = parseArgs(process.argv.slice(2));
  if (o.install) install(o);
  else http.createServer(handler(o.file)).listen(o.port, BIND, () => console.log(`reach-dashboard on http://${BIND}:${o.port} reading ${o.file}`));
}
