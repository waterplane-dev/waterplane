// Exercises the speed-test endpoints: download stream (size + cache headers),
// upload drain (byte count + server timing), and the connection debug probe.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8795;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 800, async () => {
  try {
    // ── download: exact byte count + no-store, from a preallocated random block ──
    const N = 1_000_000;
    const r = await fetch(`${base}/api/speedtest/download?bytes=${N}`);
    check(r.status === 200, "download 200");
    check(r.headers.get("content-length") === String(N), "download content-length matches requested bytes");
    check((r.headers.get("cache-control") || "").includes("no-store"), "download is no-store");
    const buf = Buffer.from(await r.arrayBuffer());
    check(buf.length === N, "download body is exactly N bytes");

    // default size when none requested (8 MB)
    const rd = await fetch(`${base}/api/speedtest/download`);
    check(rd.headers.get("content-length") === String(8 * 1024 * 1024), "download defaults to 8 MB");
    await rd.arrayBuffer();

    // ceiling: a huge ask is clamped to 256 MB (don't actually pull it — just check the header)
    const rc = await fetch(`${base}/api/speedtest/download?bytes=999999999999`);
    check(rc.headers.get("content-length") === String(256 * 1024 * 1024), "download clamps to 256 MB ceiling");
    rc.body?.cancel();

    // ── upload: server counts bytes and reports a timing ──
    const payload = Buffer.alloc(500_000, 7);
    const up = await fetch(`${base}/api/speedtest/upload`, { method: "POST", body: payload }).then((x) => x.json());
    check(up.ok === true && up.bytes === payload.length, "upload counts received bytes");
    check(typeof up.ms === "number", "upload reports a server-side ms");

    // ── debug: loopback client classification + shape ──
    const dbg = await fetch(`${base}/api/speedtest/debug`).then((x) => x.json());
    check(dbg.clientKind === "loopback", "debug classifies 127.0.0.1 as loopback");
    check(Array.isArray(dbg.lanIps), "debug returns lanIps array");
    check(typeof dbg.verdict === "string" && dbg.verdict.length > 0, "debug has a verdict line");
    check("route" in dbg && "tailscaleCli" in dbg, "debug has route + tailscaleCli fields");
  } catch (e) {
    console.error(e);
    failed = true;
  }
  done();
});
