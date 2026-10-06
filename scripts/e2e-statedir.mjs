// The daemon's global state moves OUT of the code root at boot, over a real
// daemon — the wiring the unit tests (`host/test/statedir.test.mjs`) cannot
// reach: `env.ts` runs the move before ANY store opens, binds the new dir, and
// every store then reads and writes there.
//
//   1. a root holding the old layout (`<root>/<state>/acks.json`, a settings
//      file) boots, and the files are in `<PREFIX>STATE_DIR` afterwards, byte
//      for byte, with a symlink at the old place
//   2. the stores really OPENED the moved files: the settings the old file
//      held are what `/api/storage/host` reports from the new dir, which names
//      the new dir as where it is
//   3. a second boot moves nothing and loses nothing (idempotent)
//   4. a second root with its OWN old state, booted against the now-full state
//      dir, is MERGED: what the state dir lacked moves in, a file both hold
//      stays in the old dir untouched (the new copy wins), said loudly
//   5. while another host for the same root still answers on the port, the
//      move is refused and the old dir stays a real dir — a write from that
//      host between rename and pointer would split the state in two
//
// This is the one script that deliberately does NOT use `rootEnv()`'s
// state-dir-under-the-root pin: the move between the two IS the subject.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG, STATE } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8925;
const WORK = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-statedir-`)));
const ROOT = join(WORK, "dev");
const STATE_DIR = join(WORK, "state", "wp");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

async function boot(root) {
  let out = "";
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1",
      [E.ROOT]: root, [E.STATE_DIR]: STATE_DIR,
      [E.CONFIG_DIR]: join(WORK, "config"),
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (d) => { out += d; });
  host.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((r) => host.once("exit", r));
  await waitForHost(PORT);
  return { log: () => out, stop: async () => { host.kill(); await exited; } };
}

const ACKS = JSON.stringify({ acks: { "e2e-ack-1": { ts: Date.now(), ok: true, sessionId: "s-e2e" } } });
mkdirSync(join(ROOT, STATE), { recursive: true });
writeFileSync(join(ROOT, STATE, "acks.json"), ACKS);
// Valid JSON on purpose (321 bytes): the daemon reads it at boot, and an unparseable file is moved aside as corrupt.
writeFileSync(join(ROOT, STATE, "sent.json"), `[${" ".repeat(319)}]`);

try {
  // 1 + 2
  let h = await boot(ROOT);
  try {
    check(lstatSync(join(ROOT, STATE)).isSymbolicLink(), "the old place is a symlink after boot");
    check(readlinkSync(join(ROOT, STATE)) === STATE_DIR, "pointing at the state dir");
    const sent = existsSync(join(STATE_DIR, "sent.json")) ? readFileSync(join(STATE_DIR, "sent.json"), "utf8") : "";
    check(sent.length === 321, "a ledger arrived byte for byte");
    check(existsSync(join(STATE_DIR, "acks.json")), "the ack ledger arrived");
    check(/moved .* to .*state\/wp/.test(h.log()), "the move is one line in the boot log");
    const rep = await (await fetch(`http://127.0.0.1:${PORT}/api/storage/host`)).json();
    check(realpathSync(rep.dir) === STATE_DIR, `the host-store report reads the new dir (${rep.dir})`);
    check(typeof rep.total === "number" && rep.total >= 321, `and counts the moved files there (${rep.total} bytes)`);
  } finally { await h.stop(); }
  const acksAfter = readFileSync(join(STATE_DIR, "acks.json"), "utf8");
  check(acksAfter.includes("e2e-ack-1"), "the remembered ack survived the move and the daemon's own flush");

  // 3
  h = await boot(ROOT);
  try {
    check(!/moved /.test(h.log()), "a second boot moves nothing");
    check(readFileSync(join(STATE_DIR, "acks.json"), "utf8").includes("e2e-ack-1"), "and loses nothing");
  } finally { await h.stop(); }

  // 4
  const ROOT2 = join(WORK, "dev2");
  mkdirSync(join(ROOT2, STATE), { recursive: true });
  writeFileSync(join(ROOT2, STATE, "acks.json"), "{}");
  writeFileSync(join(ROOT2, STATE, "decision-log.json"), "[]");
  h = await boot(ROOT2);
  try {
    check(/BOTH .* held state — merged 1 entry .*in BOTH and stayed in .*: acks\.json/.test(h.log()), "both holding state: merged, and the collision named loudly");
    check(lstatSync(join(ROOT2, STATE)).isDirectory() && !lstatSync(join(ROOT2, STATE)).isSymbolicLink(), "the old dir is left a real dir");
    check(readFileSync(join(ROOT2, STATE, "acks.json"), "utf8") === "{}", "its copy of the collision untouched");
    check(existsSync(join(ROOT2, STATE, "MOVED.txt")), "with a note saying why it is there");
    check(existsSync(join(STATE_DIR, "decision-log.json")), "what the state dir lacked moved in");
    check(readFileSync(join(STATE_DIR, "acks.json"), "utf8").includes("e2e-ack-1"), "the state dir's ack ledger was not overwritten");
  } finally { await h.stop(); }

  // 5
  const ROOT3 = join(WORK, "dev3");
  const STATE3 = join(WORK, "state3");
  mkdirSync(join(ROOT3, STATE), { recursive: true });
  writeFileSync(join(ROOT3, STATE, "acks.json"), "{}");
  const fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, protocol: 2, root: ROOT3 }));
  });
  await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
  try {
    let out = "";
    const host = spawn("node", ["packages/host/dist/main.js"], {
      env: { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1",
        [E.ROOT]: ROOT3, [E.STATE_DIR]: STATE3, [E.CONFIG_DIR]: join(WORK, "config"), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host.stdout.on("data", (d) => { out += d; });
    host.stderr.on("data", (d) => { out += d; });
    const exited = new Promise((r) => host.once("exit", r));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (host.exitCode === null) { host.kill(); await exited; }
    check(/not moving .* another host for this root answers/.test(out), "a live host for the same root blocks the move, in words");
    check(lstatSync(join(ROOT3, STATE)).isDirectory() && !lstatSync(join(ROOT3, STATE)).isSymbolicLink(), "the old dir is still a real dir");
    check(!existsSync(join(STATE3, "acks.json")), "and nothing reached the new dir");
  } finally { await new Promise((r) => fake.close(r)); }
} catch (e) {
  console.log("FAIL:", e?.message ?? e);
  failed = true;
}

console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
