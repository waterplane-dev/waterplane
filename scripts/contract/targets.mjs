// The two desktops the contract suite runs against (demo-mode plan §6):
//
//   realHost() — the daemon itself (`packages/host/dist`) over a real socket,
//                with the stub TUI as `claude` (`bootHost()` in lib-e2e.mjs);
//   fakeHost() — `createDemoHost` in this process, the TypeScript imported
//                as-is (node strips the types), wired the way the demo
//                transport (`packages/web/src/demo/transport.ts`) wires it.
//
// Both expose the SAME `Target`, so a check is written once and cannot tell
// which one it is talking to except through `target.kind` — which a check reads
// only to state a difference the plan names, never to loosen an assertion.
//
//   interface Target {
//     kind: "real" | "fake";
//     repoDir: string;                       // a repo the target accepts work in
//     connect(): Promise<Conn>;              // a socket that has said hello
//     http(method, path, body?): Promise<{ status, text, json }>;
//     stop(): Promise<void>;
//   }
//   interface Conn {
//     welcome: HostMessage;                  // what hello was answered with
//     send(msg: ClientMessage): void;
//     mark(): number;                        // a cursor into what arrived
//     waitFor(pred, { since?, ms?, what? }): Promise<HostMessage>;
//     all(pred, since?): HostMessage[];
//     closed: boolean;
//     close(): Promise<void>;
//   }
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "../lib-e2e.mjs";
import { E, SLUG } from "../lib-brand.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The frame log + waiter both connection kinds share. */
function frameLog() {
  const frames = [];
  let waiters = [];
  const log = {
    frames,
    closed: false,
    push(msg) {
      frames.push(msg);
      const still = [];
      for (const w of waiters) {
        const hit = w.scan();
        if (hit) w.resolve(hit); else still.push(w);
      }
      waiters = still;
    },
    mark: () => frames.length,
    all: (pred, since = 0) => frames.slice(since).filter(pred),
    waitFor(pred, { since = 0, ms = 15_000, what = "a frame" } = {}) {
      return new Promise((resolve, reject) => {
        let i = since;
        const scan = () => {
          for (; i < frames.length; i++) if (pred(frames[i])) return frames[i++];
          return null;
        };
        const hit = scan();
        if (hit) { resolve(hit); return; }
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== entry);
          reject(new Error(`no ${what} within ${ms} ms (saw ${frames.length - since}: ${[...new Set(frames.slice(since).map((f) => f.t))].join(", ") || "nothing"})`));
        }, ms);
        const entry = { scan, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        waiters.push(entry);
      });
    },
  };
  return log;
}

async function helloOn(conn, protocol) {
  conn.send({ t: "hello", protocol });
  conn.welcome = await conn.waitFor((m) => m.t === "welcome", { what: "welcome" });
  return conn;
}

/**
 * The real daemon. `STUB_MODE=repaint` is the stub TUI with a `❯` composer that
 * echoes and runs a turn on Return, so `submit` delivery is verified for real.
 */
export async function realHost() {
  const { PROTOCOL_VERSION } = await import("@waterplane/shared");
  const scratch = mkdtempSync(join(tmpdir(), `${SLUG}-contract-stub-`));
  const h = await bootHost({
    tag: "contract",
    quiet: !process.env.CONTRACT_VERBOSE,
    env: {
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
      [E.IDLE_MS]: "1500",
      STUB_MODE: "repaint",
      STUB_LOG: join(scratch, "stub-input.log"),
    },
  });
  const http = async (method, path, body) => {
    const r = await fetch(h.base + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  };
  // Setup, not contract: the fake ships its repos in the scenario, the real
  // host makes one on disk. Every check finds it the same way, via /api/repos.
  const made = await http("POST", "/api/repo", { name: "contract" });
  if (!made.json?.path) { await h.stop(); throw new Error(`could not create a repo: ${made.text}`); }
  const repos = await http("GET", "/api/repos");
  const repoDir = repos.json?.targets?.[0]?.worktreePath;
  const conns = new Set();
  return {
    kind: "real",
    repoDir,
    protocol: PROTOCOL_VERSION,
    http,
    async connect({ protocol = PROTOCOL_VERSION } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
      const log = frameLog();
      ws.on("message", (raw) => log.push(JSON.parse(raw.toString())));
      const closedP = new Promise((r) => ws.once("close", () => { log.closed = true; r(); }));
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      const conn = {
        ...log,
        get closed() { return log.closed; },
        send: (m) => ws.send(JSON.stringify(m)),
        async close() { ws.close(); await Promise.race([closedP, sleep(2000)]); conns.delete(conn); },
      };
      conns.add(conn);
      return helloOn(conn, protocol);
    },
    async stop() {
      for (const c of [...conns]) await c.close();
      await h.stop();
    },
  };
}

/** The scenario the fake boots from: one repo, nothing else. The checks make
 *  their own sessions, exactly as they do on the real host. */
export function seedScenario(PROTOCOL_VERSION, repoDir) {
  return {
    meta: { id: "contract", protocol: PROTOCOL_VERSION, stamp: "contract-1" },
    clock: { start: 0 },
    state: {
      bootId: "contract-boot",
      model: {
        repos: [{ id: "contract", repoName: "contract", branch: "main", isPrimary: true, worktreePath: repoDir, outboxCount: 0 }],
      },
    },
    script: [],
  };
}

/**
 * DemoHost in process. Time is wall time (the transport's choice too), and
 * `advance()` runs off a short interval; `afterMs` is honoured with a timer,
 * a core `close` ends the connection — the same three duties the browser
 * transport has, so what the checks see is what the phone would.
 */
export async function fakeHost() {
  const { PROTOCOL_VERSION } = await import("@waterplane/shared");
  const { createDemoHost } = await import("../../packages/web/src/demo/host/index.ts");
  const repoDir = "/demo/contract";
  const host = createDemoHost(seedScenario(PROTOCOL_VERSION, repoDir), { now: () => Date.now() });
  const tick = setInterval(() => host.advance(), 20);
  const conns = new Set();
  return {
    kind: "fake",
    repoDir,
    protocol: PROTOCOL_VERSION,
    host,
    async http(method, path, body) {
      const [p, qs] = path.split("?");
      const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined;
      const res = host.request({ method, path: p, query, body });
      if (res.afterMs) await sleep(res.afterMs);
      let json = null;
      try { json = JSON.parse(res.body); } catch { /* not JSON */ }
      return { status: res.status, text: res.body, json };
    },
    async connect({ protocol = PROTOCOL_VERSION } = {}) {
      const log = frameLog();
      let core;
      const sink = (out) => {
        const deliver = () => {
          if (log.closed) return;
          if (out.kind === "close") { log.closed = true; core?.close(); return; }
          // Through JSON, as a socket would: nothing shared by reference.
          log.push(JSON.parse(JSON.stringify(out.msg)));
        };
        if (out.afterMs) setTimeout(deliver, out.afterMs); else queueMicrotask(deliver);
      };
      core = host.connect(sink);
      const conn = {
        ...log,
        get closed() { return log.closed; },
        send: (m) => { if (!log.closed) queueMicrotask(() => core.receive(JSON.parse(JSON.stringify(m)))); },
        async close() { log.closed = true; core.close(); conns.delete(conn); },
      };
      conns.add(conn);
      return helloOn(conn, protocol);
    },
    async stop() {
      clearInterval(tick);
      for (const c of [...conns]) await c.close();
    },
  };
}

export const TARGETS = { fake: fakeHost, real: realHost };

