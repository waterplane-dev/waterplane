// Where a client may make the daemon RUN something.
//
// `origin.ts` decides WHO may talk to this daemon; it says nothing about WHERE.
// Past that gate every directory a client names used to be an opaque string:
// `session.create` handed its `cwd` straight to `sessions.create()` (spawning
// `claude`), and `build.run` handed its `repoDir` to a shell command — while
// every other path a client names is contained (`files.ts`, `git.ts`,
// `scaffold.ts`, and `fanout.run`, which validates against `discoverTargets()`).
// A LAN peer holding a token, or a client bug carrying a stale path, could start
// an agent anywhere on the machine.
//
// Asserted end to end, over the real socket: a refused create must open NO
// session, and say so.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { inRoot } from "../packages/host/dist/scaffold.js";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8814;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-rootguard-`));
const OUTSIDE = mkdtempSync(join(tmpdir(), `${SLUG}-outside-`));
const REPO = join(ROOT, "repo");
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "README.md"), "# repo\n");
// A project command in a repo under the root and one in a directory OUTSIDE it:
// `/api/slash?cwd=` lists `<cwd>/.claude/commands`, so it is a directory listing
// under whatever the query names unless `cwd` is contained.
mkdirSync(join(REPO, ".claude", "commands"), { recursive: true });
writeFileSync(join(REPO, ".claude", "commands", "rg-inside.md"), "inside\n");
mkdirSync(join(OUTSIDE, ".claude", "commands"), { recursive: true });
writeFileSync(join(OUTSIDE, ".claude", "commands", "rg-outside.md"), "outside\n");

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

// ── The guard itself (pure, no host) ─────────────────────────────────
// Exported from scaffold.ts so there is ONE implementation rather than a fourth
// hand-rolled `startsWith` that forgets realpath on macOS (/var → /private/var).
check(inRoot(ROOT, REPO) !== null, "a directory inside the root passes");
check(inRoot(ROOT, ROOT) !== null, "the root itself passes");
check(inRoot(ROOT, OUTSIDE) === null, "a sibling temp dir is refused");
check(inRoot(ROOT, "/etc") === null, "an absolute path outside is refused");
check(inRoot(ROOT, join(ROOT, "..", "elsewhere")) === null, "a `..` climb out of the root is refused");
check(inRoot(ROOT, join(REPO, "..", "repo", "sub")) !== null, "a `..` that stays inside is allowed");
// The prefix trap: `<root>-evil` starts with `<root>` as a STRING but is not
// inside it. A separator-less startsWith would let this through.
check(inRoot(ROOT, ROOT + "-evil") === null, "a sibling whose name merely starts with the root is refused");

/** Wait for the daemon to be listening rather than guessing at a delay. */
async function waitForHost() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("host never came up");
}

await waitForHost();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const seen = { created: 0, acks: [], toasts: [] };
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "session.created") seen.created++;
  if (m.t === "op.ack") seen.acks.push(m);
  if (m.t === "toast") seen.toasts.push(m.text);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (id) => seen.acks.find((a) => a.ackId === id);

ws.on("open", async () => {
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(400);

  // ── A create outside the root is refused, and spawns nothing ────────
  ws.send(JSON.stringify({ t: "session.create", cwd: OUTSIDE, ackId: "out-1", cols: 80, rows: 30 }));
  await sleep(1200);
  check(ack("out-1")?.ok === false, `a create outside the root is acked ok:false (${JSON.stringify(ack("out-1")?.reason ?? null)})`);
  check(seen.created === 0, `…and no session was opened (saw ${seen.created})`);
  check(seen.toasts.some((t) => /outside the configured root/.test(t)), "…and the client is told why");

  // A refusal is REMEMBERED (durableOp: `ok:false` is a verdict), so the retry
  // that the offline queue will certainly make cannot spawn anything either.
  ws.send(JSON.stringify({ t: "session.create", cwd: OUTSIDE, ackId: "out-1", cols: 80, rows: 30 }));
  await sleep(800);
  check(seen.created === 0, "a re-sent refused create still opens nothing");

  // ── `..` escaping out of an in-root path is refused too ─────────────
  ws.send(JSON.stringify({ t: "session.create", cwd: join(REPO, "..", "..", "etc"), ackId: "out-2", cols: 80, rows: 30 }));
  await sleep(1000);
  check(ack("out-2")?.ok === false, "a `..` climb out of the root is refused");
  check(seen.created === 0, `…and still nothing opened (saw ${seen.created})`);

  // ── A legitimate create still works — the guard is not a wall ───────
  ws.send(JSON.stringify({ t: "session.create", cwd: REPO, ackId: "in-1", cols: 80, rows: 30 }));
  await sleep(1500);
  check(ack("in-1")?.ok === true, "a create inside the root is accepted");
  check(!!ack("in-1")?.sessionId, "…and names the session it opened");
  check(seen.created === 1, `…and exactly one session exists (saw ${seen.created})`);

  // ── A build outside the root does not execute ───────────────────────
  ws.send(JSON.stringify({ t: "build.run", repoDir: OUTSIDE, buildId: "whatever", ackId: "b-1" }));
  await sleep(800);
  check(ack("b-1")?.ok === false, "a build.run outside the root is refused before it can execute");

  // ── A backlog item is a deferred create, so it is contained on the way in ──
  ws.send(JSON.stringify({ t: "backlog.add", text: "do a thing", repoDir: OUTSIDE, ackId: "bl-1" }));
  await sleep(800);
  const blAck = seen.acks.find((a) => a.ackId === "bl-1");
  check(!blAck, "backlog.add answers on its own channel, not op.ack");

  // ── The slash list's `cwd` is contained too (a GET, so no ack to read) ──
  const slash = async (cwd) => {
    const q = cwd === undefined ? "" : `?cwd=${encodeURIComponent(cwd)}`;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/slash${q}`);
    return { status: r.status, commands: (await r.json()).commands ?? [] };
  };
  const projectNames = (r) => r.commands.filter((c) => c.source === "project").map((c) => c.name);
  const inside = await slash(REPO);
  check(inside.status === 200 && projectNames(inside).includes("/rg-inside"), "/api/slash for a cwd inside the root lists its .claude/commands");
  for (const [label, cwd] of [["a temp dir outside the root", OUTSIDE], ["/etc", "/etc"], ["a `..` climb out", join(REPO, "..", "..", "etc")]]) {
    const r = await slash(cwd);
    check(r.status === 200 && r.commands.some((c) => c.source === "builtin"), `/api/slash for ${label} still answers with the builtins (never a 4xx)`);
    check(!r.commands.some((c) => c.name === "/rg-outside" || c.name === "/rg-inside"), `…and lists no project command from ${label}`);
  }
  const none = await slash(undefined);
  check(none.status === 200 && none.commands.some((c) => c.source === "builtin"), "/api/slash with no cwd falls back to the root");
  done();
});

ws.on("error", (e) => { console.error("FAIL: socket error", e.message); process.exit(1); });
setTimeout(() => { console.error("FAIL: timed out"); done(); }, 60_000);
