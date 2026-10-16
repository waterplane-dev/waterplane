import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import "./lib-tmuxiso.mjs"; // every host booted here runs tmux in a socket dir of its own

// Shared helpers for the e2e scripts.
//
// Right now this owns exactly one thing, and it is the one every script got
// slightly differently: WAITING FOR THE HOST TO COME UP.

/** Poll until the host answers `/api/health`, or give up after `timeoutMs`. `E2E_BOOT_MS` raises
 *  the default where a boot is slow for a known reason — WSL loading a Windows checkout over /mnt. */
export async function waitForHost(port, timeoutMs = Number(process.env.E2E_BOOT_MS) || 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
      lastErr = new Error(`health answered ${r.status}`);
    } catch (e) {
      lastErr = e; // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`host on :${port} never came up within ${timeoutMs}ms — ${lastErr?.message ?? "no answer"}`);
}

/**
 * Wait for the host, AND for at least `settleMs` — then run the body.
 *
 * This replaces the `setTimeout(async () => { … }, 900)` that 47 of these
 * scripts opened with. That delay was doing two different jobs under one
 * number: waiting for the host to BIND, and giving whatever the script set up
 * a moment to SETTLE. Only the first is a race, and it is a race the script
 * always lost the same way — on a loaded machine the host has not bound at
 * 900ms, every request fails `ECONNREFUSED`, and the script reports the feature
 * broken. Measured on a busy laptop, a full suite run went 77/82 → 54/82 for no
 * reason but load, which is worse than a red suite: it is a suite nobody can
 * read.
 *
 * **Both waits are kept, and the longer one wins** (`Promise.all`). Replacing
 * the delay with a health poll ALONE would have been the obvious move and is
 * wrong: a script whose 900ms was really a settle window would start running
 * its assertions the instant the port answered, which is earlier than today —
 * so a mechanical migration across 47 files would have quietly changed the
 * timing of every one of them. This way the wait can only ever get LONGER than
 * it is now, so no script can newly fail because of it.
 */
export function bootWait(port, settleMs, body) {
  return Promise.all([
    waitForHost(port),
    new Promise((r) => setTimeout(r, settleMs)),
  ]).then(body);
}

/**
 * The intent store's rows, whichever shape the file is in.
 *
 * `<state>/intents.json` was a bare ARRAY (schema 1) and is now
 * `{ schema: 2, intents: [...] }` — the version that records "every work item
 * opens a session of its own". The host reads both (a v1 file is converted on
 * load, with a `.bak` beside it), so the scripts that read the file read both
 * too: one of them WRITES a v1 array on purpose to test exactly that path.
 */
export function readIntents(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.intents) ? parsed.intents : [];
  } catch {
    return [];
  }
}

/** A port nothing is listening on right now (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the real host the way every e2e script does by hand, and wait for it.
 *
 * Pinned, always: preflight off, a private tmux socket directory for the whole
 * process (`lib-tmuxiso.mjs` — sessions run inside tmux, never on the owner's
 * live server, every server killed on exit), loopback bind, a free port, a throwaway root, and the
 * stub `claude`. `env` overrides or adds knobs by their FULL name
 * (`{ [E.CLAUDE_BIN]: "bash" }`); `quiet` drops the `[host]` echo.
 *
 * Resolves to `{ port, base, root, host, stop }` once `/api/health` answers.
 * `stop()` kills the host and resolves when it has exited.
 *
 * `home: true` gives the host a scratch HOME of its own (realpath-resolved, so `/var` is
 * `/private/var` on both sides) with the root at `<home>/dev`: whatever the host says from `~` then
 * reads `~/dev/<repo>` instead of a machine's temp path — what a docs picture needs — and nothing
 * under the real home (config, keys, plugins, `~/.claude`) is read or written.
 */
export async function bootHost({ env = {}, quiet = false, tag = "e2e", home = false } = {}) {
  if (!existsSync("packages/host/dist/main.js")) {
    throw new Error("packages/host/dist/main.js is missing — build the host first (npm run build:shared && npm run build -w @waterplane/host)");
  }
  const port = await freePort();
  const scratch = mkdtempSync(join(tmpdir(), `${SLUG}-${tag}-`));
  const homeDir = home ? realpathSync(scratch) : null;
  const root = homeDir ? join(homeDir, "dev") : scratch;
  if (homeDir) mkdirSync(root);
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(port),
      [E.HOST]: "127.0.0.1",
      ...rootEnv(root),
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
      ...(homeDir ? { HOME: homeDir } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!quiet) {
    host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
    host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  }
  const exited = new Promise((r) => host.once("exit", r));
  const stop = () => {
    if (host.exitCode === null && host.signalCode === null) host.kill();
    return exited;
  };
  try {
    await waitForHost(port);
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, base: `http://127.0.0.1:${port}`, root, host, stop };
}
