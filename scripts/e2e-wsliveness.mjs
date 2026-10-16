// The host lets go of a socket nobody is on the other end of (`server/liveness.ts`).
//
// A phone that sleeps, or a tailnet that flaps, leaves a half-open socket the
// host used to keep for ever: still in `clients`, still attached, every repaint
// queued for it in memory, and counted as a person watching its sessions. The
// host now pings each socket at the protocol level and terminates one that
// answers neither of two pings in a row.
//
// Booted with WATERPLANE_WS_PING_MS=300, so "two missed" is ~600-900 ms.
//
// Asserts:
//   1. a client that never answers pings (`autoPong: false` — the protocol-level
//      stand-in for a phone that went away without a FIN) is closed by the host
//      within ~2 s, as an abnormal 1006 close
//   2. a client that DOES answer (every browser and `ws` does, unasked) is still
//      open well past that, and its app-level `{t:"ping"}` heartbeat still works
//   3. netstats records the terminated socket's 1006 — it went through the
//      ordinary close path, not around it
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { E } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { port, base, stop } = await bootHost({ tag: "wsliveness", env: { [E.WS_PING_MS]: "300" } });
const url = `ws://127.0.0.1:${port}/ws`;
const open = (opts) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, opts);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
});

try {
  const before = (await fetch(`${base}/api/netstats`).then((r) => r.json())).sockets.closeCodes["1006"] ?? 0;

  const live = await open();
  const dead = await open({ autoPong: false });
  const t0 = Date.now();
  let liveClosed = false;
  live.on("close", () => { liveClosed = true; });
  const deadClosed = new Promise((r) => dead.once("close", (code) => r({ code, ms: Date.now() - t0 })));
  const outcome = await Promise.race([deadClosed, sleep(4000).then(() => null)]);

  // ── 1. the silent socket is let go ───────────────────────────────────────
  check(outcome !== null, `a socket that answers no ping is closed by the host (${outcome ? `${outcome.ms} ms` : "still open after 4 s"})`);
  check(!!outcome && outcome.ms <= 2000, `…within ~2 s at a 300 ms ping (${outcome?.ms} ms)`);
  check(outcome?.code === 1006, `…as a terminate (1006, no close handshake), not a polite close (${outcome?.code})`);

  // ── 2. the answering socket is not ────────────────────────────────────────
  await sleep(1500); // five more ping periods past the dead one's end
  check(!liveClosed && live.readyState === WebSocket.OPEN, "a socket that answers pings stays open");
  const pong = await new Promise((r) => {
    const timer = setTimeout(() => r(false), 3000);
    live.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "pong") { clearTimeout(timer); r(true); }
    });
    live.send(JSON.stringify({ t: "ping" }));
  });
  check(pong, "the app-level {t:\"ping\"} heartbeat is untouched");

  // ── 3. it went through the ordinary close path ───────────────────────────
  const after = (await fetch(`${base}/api/netstats`).then((r) => r.json())).sockets.closeCodes["1006"] ?? 0;
  check(after >= before + 1, `netstats counted the terminated socket's 1006 (${before} → ${after})`);

  live.close();
  dead.terminate();
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await stop();
}

console.log(failed ? "\nwsliveness: FAILED" : "\nwsliveness: all passed");
process.exit(failed ? 1 : 0);
