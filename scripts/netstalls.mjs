#!/usr/bin/env node
// Per-phone HTTP stall summary out of the host's netstats.json
// (`clients[id].stalls`, written from `net.stalls` — see shared/netstall.ts).
//
//   node scripts/netstalls.mjs [path/to/netstats.json] [--events N]
//
// Default path: the daemon's state dir (shared `stateDirPick`), /netstats.json.
// Needs `npm run build:shared`. Reads only; prints nothing it was not told.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const ei = args.indexOf("--events");
const nEvents = ei >= 0 ? Math.max(0, Number(args[ei + 1]) || 0) : 5;
if (ei >= 0) args.splice(ei, 2);

let stallSummaryLines, stateDirPick;
try {
  ({ stallSummaryLines } = await import("../packages/shared/dist/netstall.js"));
  ({ stateDirPick } = await import("../packages/shared/dist/statedir.js"));
} catch {
  console.error("netstalls: run `npm run build:shared` first");
  process.exit(1);
}
const path = args[0] ?? `${stateDirPick(process.env, homedir()).dir}/netstats.json`;

let doc;
try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
  console.error(`netstalls: cannot read ${path}: ${e.message}`);
  process.exit(1);
}

const rows = Object.entries(doc.clients ?? {}).filter(([, c]) => c?.stalls);
if (!rows.length) { console.log(`${path}: no phone has reported stalls yet`); process.exit(0); }
const t = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
for (const [id, c] of rows) {
  const st = c.stalls;
  for (const line of stallSummaryLines(id, st)) console.log(line);
  console.log(`  updated ${t(st.updatedAt)}${c.ua ? ` · ${c.ua.slice(0, 60)}` : ""}`);
  const show = [...(st.open ?? []), ...(st.events ?? []).slice(-nEvents).reverse()];
  for (const e of show) {
    const ws = e.ws ? (e.ws.open ? `ws open${e.ws.pongAgeMs != null ? ` pong ${Math.round(e.ws.pongAgeMs / 1000)}s ago` : ""}` : "ws closed") : null;
    const bits = [
      `${e.outcome}`, `${e.method} ${e.label}${e.phase ? ` (${e.phase})` : ""}`, `${Math.round(e.ageMs / 1000)}s`,
      e.fuseMs != null && `fuse ${Math.round(e.fuseMs / 1000)}s`,
      e.inflight != null && `${e.inflight} in flight`,
      ws,
      e.visible != null && (e.visible ? "visible" : "hidden") + (e.visForMs != null ? ` ${Math.round(e.visForMs / 1000)}s` : ""),
      e.online === false && "navigator offline",
      e.sent != null && `sent ${e.sent}${e.total != null ? `/${e.total}` : ""} B`,
    ].filter(Boolean);
    console.log(`    ${t(e.at)} ${bits.join(" · ")}`);
    if (e.peers?.length) console.log(`      with: ${e.peers.map((p) => `${p.label} ${Math.round(p.ageMs / 1000)}s`).join(", ")}`);
  }
}
