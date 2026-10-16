// Usage readings per source end to end (R-usage-026): a real host with a plugin that contributes
// two probes (scripts/fixtures/usage-probe-stub), the built-in Copilot extension reading a STUB gh
// (the GH_BIN knob) behind a `copilot` shim on PATH, and claude's own /usage screen from STUB_USAGE.
//   - usage.status carries `readings`: claude first, then the stub and copilot;
//   - a probe answering null draws NOTHING (its source is absent, never `pct: null`);
//   - usage.refresh re-probes (USAGE_TTL_MS=0);
//   - GET /api/usagelog/stub answers samples; /api/usagelog keeps its own shape; claude/unknown 404;
//   - switching the contributing plugin off removes its source on the next usage.status;
//   - a throwing probe keeps its last reading until the window's resetAt, then the source is gone.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8946;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-usagesrc-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-usagesrccfg-`));
const BIN = mkdtempSync(join(tmpdir(), `${SLUG}-usagesrcbin-`));
const MODE = join(BIN, "probe-mode.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (m) => writeFileSync(MODE, JSON.stringify(m));
const asks = () => (existsSync(MODE + ".asks") ? readFileSync(MODE + ".asks", "utf8").split("\n").filter(Boolean).length : 0);

// A `copilot` on PATH (only its presence is checked) and a gh that answers the quota body.
writeFileSync(join(BIN, "copilot"), "#!/bin/sh\nexit 0\n");
const copilotReset = new Date(Date.now() + 10 * 86_400_000).toISOString();
writeFileSync(join(BIN, "gh"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
  copilot_plan: "individual",
  quota_reset_date_utc: copilotReset,
  quota_snapshots: {
    chat: { has_quota: true, unlimited: false, entitlement: 200, remaining: 191, credits_used: 9, percent_remaining: 95.5, overage_count: 0, token_based_billing: true },
    completions: { has_quota: false, unlimited: true },
    premium_interactions: { has_quota: false, unlimited: false, entitlement: 0, remaining: 0, credits_used: 0, percent_remaining: 100 },
  },
})}\nJSON\n`);
chmodSync(join(BIN, "copilot"), 0o755);
chmodSync(join(BIN, "gh"), 0o755);

const resetAt = Date.now() + 25_000; // the stub window's reset; the throw phase waits it out
setMode({ mode: "ok", pct: 37, resetAt });
writeFileSync(join(CONFIG, "plugin-paths.json"), JSON.stringify({ paths: [resolve("scripts/fixtures/usage-probe-stub")] }));

const env = {
  ...process.env,
  PATH: `${BIN}:${process.env.PATH}`,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
  [E.GH_BIN]: join(BIN, "gh"),
  [E.USAGE_TTL_MS]: "0", // every usage.refresh re-probes
  [E.E2E_PROBE_MODE]: MODE,
  STUB_USAGE: "42,61",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

try {
  await waitForHost(PORT);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let status = null, plugins = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "usage.status") status = m;
    if (m.t === "plugin.list") plugins = m.plugins;
  });
  await new Promise((r) => ws.on("open", r));
  const send = (m) => ws.send(JSON.stringify(m));
  const until = async (cond, ms = 12_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
    return false;
  };
  const src = (id) => status?.readings?.find((r) => r.source === id);
  send({ t: "hello", protocol: 1 });
  check(await until(() => status && Array.isArray(status.readings)), "usage.status on hello carries a readings list");

  // Registration is async after boot; asking refreshes every source (and claude's own scrape).
  let lastAsk = 0;
  const ready = await until(() => {
    if (Date.now() - lastAsk > 1500) { lastAsk = Date.now(); send({ t: "usage.refresh" }); }
    return src("claude") && src("stub") && src("copilot");
  }, 25_000);
  const ids = (status?.readings ?? []).map((r) => r.source);
  check(ready, `claude, the stub plugin's source and copilot all have a reading (got ${ids.join(",")})`);
  check(ids[0] === "claude", `claude is first (got ${ids[0]})`);
  check(src("claude")?.windows?.some((w) => w.id === "session" && w.pct === 42), "claude's windows come from the /usage screen (session 42)");
  const chat = src("copilot")?.windows?.find((w) => w.id === "chat");
  check(chat?.pct === 5 && chat?.used === 9 && chat?.limit === 200 && chat?.unit === "mo" && chat?.unitName === "credits", `copilot's chat window is 9 / 200 credits, 5% (got ${JSON.stringify(chat)})`);
  check(Math.abs((chat?.resetAt ?? 0) - Date.parse(copilotReset)) < 1000, "copilot's reset is quota_reset_date_utc");
  check(!src("copilot")?.windows?.some((w) => w.id === "premium"), "copilot: no premium window without a real quota");
  check(src("stub")?.windows?.[0]?.pct === 37, "the plugin's stub source reads 37%");
  check(!src("quiet"), "a probe answering null is ABSENT from readings");
  check(!(status.readings ?? []).some((r) => r.windows.some((w) => w.pct == null && w.used == null)), "no reading carries an empty window (pct null with no count)");

  // usage.refresh re-probes.
  const before = asks();
  send({ t: "usage.refresh" });
  check(await until(() => asks() > before), `usage.refresh re-asks the probe (${before} -> ${asks()})`);

  // History.
  const hist = await fetch(`${base}/api/usagelog/stub`).then(async (r) => ({ s: r.status, j: await r.json() }));
  check(hist.s === 200 && hist.j.samples?.length >= 1 && hist.j.samples[0].w?.[0]?.id === "day", `GET /api/usagelog/stub answers samples (${hist.s}, ${hist.j.samples?.length})`);
  const cl = await fetch(`${base}/api/usagelog`).then((r) => r.json());
  check(Array.isArray(cl.samples) && "keptFrom" in cl && "cap" in cl && "retainMs" in cl && !("source" in cl), "GET /api/usagelog keeps claude's own shape");
  const r404 = await fetch(`${base}/api/usagelog/claude`);
  const r404b = await fetch(`${base}/api/usagelog/nosuch`);
  check(r404.status === 404 && r404b.status === 404, "claude and an unknown source answer 404 in words");

  // The contributing plugin switched off => its sources are gone on the next usage.status
  // (the built-in Copilot extension is never switched off, so the fixture stands for "a plugin").
  check(plugins?.some((p) => p.manifest.id === "usage-probe-stub" && p.state === "active"), "the stub plugin is listed active");
  status = null;
  send({ t: "plugin.enable", id: "usage-probe-stub", enabled: false });
  check(await until(() => status && !src("stub")), "switching the plugin off drops its source");
  check(!!src("claude") && !!src("copilot"), "claude's and copilot's readings stay");
  send({ t: "plugin.enable", id: "usage-probe-stub", enabled: true });
  const back = await until(() => { send({ t: "usage.refresh" }); return src("stub") && !src("stub").remembered; }, 15_000);
  check(back, "switched back on, the source returns with a fresh reading");

  // A throwing probe keeps the last reading until the window resets.
  setMode({ mode: "throw", pct: 37, resetAt });
  send({ t: "usage.refresh" });
  await sleep(1500);
  send({ t: "usage.get" });
  await sleep(500);
  check(!!src("stub") && src("stub").windows[0].pct === 37, "a throwing probe keeps its last reading before the reset");
  const wait = resetAt - Date.now() + 1200;
  if (wait > 0) await sleep(wait);
  status = null;
  send({ t: "usage.get" });
  check(await until(() => status && !src("stub"), 5000), "after the window's reset the kept reading is gone");
  ws.close();
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  host.kill();
}
process.exit(failed ? 1 : 0);
