// UI feature-usage counters: POSTed deltas merge into <root>/<state>/ui-usage.json,
// GET returns the doc, DELETE resets it, and junk ids/counts are rejected.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8796;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
const post = (counts) => fetch(`${base}/api/ui-usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ counts }) }).then((r) => r.json());
const get = () => fetch(`${base}/api/ui-usage`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 800, async () => {
  try {
    // ── deltas accumulate ──
    await post({ "toolbar:diff": 2, "overlay:gallery": 1 });
    await post({ "toolbar:diff": 3, "action:compose.send": 1 });
    const doc = await get();
    check(doc.features["toolbar:diff"].count === 5, "same id across two flushes sums");
    check(doc.features["overlay:gallery"].count === 1, "second id kept");
    check(doc.features["action:compose.send"].count === 1, "third id kept");
    check(doc.features["toolbar:diff"].first <= doc.features["toolbar:diff"].last, "first/last timestamps recorded");
    check(doc.since > 0 && doc.updatedAt > 0, "doc carries since + updatedAt");

    // ── junk is dropped, not crashed on ──
    await post({ "bad id with spaces": 4, "toolbar:ok": "nope", "toolbar:neg": -5, "toolbar:huge": 1e9 });
    const d2 = await get();
    check(!("bad id with spaces" in d2.features), "id with illegal chars rejected");
    check(!("toolbar:ok" in d2.features), "non-numeric count rejected");
    check(!("toolbar:neg" in d2.features), "negative count rejected");
    check(d2.features["toolbar:huge"].count === 10000, "oversized count clamped");

    // ── persisted to disk where an agent can read it ──
    await sleep(3400); // debounced write
    const onDisk = JSON.parse(readFileSync(join(ROOT, STATE, "ui-usage.json"), "utf8"));
    check(onDisk.features["toolbar:diff"].count === 5, "counts land in <state>/ui-usage.json");

    // ── reset clears the window ──
    await fetch(`${base}/api/ui-usage`, { method: "DELETE" });
    const d3 = await get();
    check(Object.keys(d3.features).length === 0, "DELETE resets all counters");
    await post({ "toolbar:diff": 1 });
    const d4 = await get();
    check(d4.features["toolbar:diff"].count === 1, "counting resumes after a reset");
  } catch (e) {
    console.error(e);
    failed = true;
  }
  done();
});
