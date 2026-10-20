/**
 * Fork from a TURN — the wire + route half.
 *
 * `packages/host/test/convfork.test.mjs` pins the file operation; this pins what
 * a `session.create` carrying `forkAtTurn` actually does to the daemon: that the
 * fork is written and RESUMED (`--resume <newId>`, and not `--fork-session` on
 * top of it, which would open a third conversation), that the SOURCE log is
 * untouched, that a refusal is a refusal rather than a session opened on the
 * whole conversation, and that a replayed ackId spawns nothing — the same
 * at-most-once promise every other `session.create` makes, which matters more
 * here because the side effect is a file.
 *
 * `<ENV>_CLAUDE_HOME` points the host's `transcriptPath` at a temp tree, so the
 * fixture conversation is the only one in the world as far as this host knows.
 */
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8834;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-ff-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-ffhome-`));
const SRC = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

// Prints its args, then blocks — so the spawn flags are assertable and the
// session stays "running" for the session list.
const STUB = join(ROOT, "echoargs.sh");
writeFileSync(STUB, "#!/bin/bash\necho \"ARGS:$@\"\nread x\n");
chmodSync(STUB, 0o755);

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.CLAUDE_HOME]: HOME,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const finish = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 120); };

const projectDir = (cwd) => join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const logs = (cwd) => readdirSync(projectDir(cwd)).filter((n) => n.endsWith(".jsonl")).sort();
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Two turns; turn 1 also has a tool call and its result, so a cut that landed
 *  on the prompt record instead of the turn boundary is visible in the count. */
function writeFixture(cwd) {
  const rec = (o) => JSON.stringify({ sessionId: SRC, session_id: SRC, timestamp: "2026-09-05T10:00:00.000Z", ...o });
  const lines = [
    rec({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: [{ type: "text", text: "turn one" }] } }),
    rec({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] } }),
    rec({ type: "user", uuid: "r1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }),
    rec({ type: "assistant", uuid: "a1b", parentUuid: "r1", message: { role: "assistant", content: [{ type: "text", text: "done one" }] } }),
    rec({ type: "user", uuid: "u2", parentUuid: "a1b", message: { role: "user", content: [{ type: "text", text: "turn two" }] } }),
    rec({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "done two" }] } }),
  ];
  mkdirSync(projectDir(cwd), { recursive: true });
  writeFileSync(join(projectDir(cwd), SRC + ".jsonl"), lines.join("\n") + "\n");
}

bootWait(PORT, 1400, async () => {
  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ff" }),
  }).then((r) => r.json());
  writeFixture(repo.path);
  const srcPath = join(projectDir(repo.path), SRC + ".jsonl");
  const srcSha = sha(srcPath);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  const acks = new Map();
  const created = [];
  let args = "";
  let newId = null;

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") { step1(); return; }
    if (m.t === "op.ack") acks.set(m.ackId, m);
    if (m.t === "session.created") created.push(m.session);
    if (m.t === "pty") args += Buffer.from(m.dataB64, "base64").toString("utf8");
  });
  ws.on("open", () => send({ t: "hello", protocol: 1 }));

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // A positive is WAITED for, never slept for: a fixed 900 ms before reading the ack and the
  // stub's argv failed all three under the full parallel suite and passed alone. The fixed
  // naps left below sit before "nothing happened" checks, which load cannot make flake.
  const until = async (pred, ms = 20_000) => { for (let t = 0; t < ms && !pred(); t += 50) await wait(50); };

  async function step1() {
    // ── 1. A fork at turn 1 ─────────────────────────────────────────
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, title: "src (from #1)",
      resumeMode: "fork", resumeSessionId: SRC, forkAtTurn: "u1", ackId: "ff-1" });
    await until(() => acks.has("ff-1") && created.length >= 1 && args.includes("--resume "));
    const ack = acks.get("ff-1");
    check(ack?.ok === true, `fork op acked ok (${JSON.stringify(ack)})`);
    const after = logs(repo.path);
    check(after.length === 2, `a new conversation log was written (${after.length} logs)`);
    newId = after.map((n) => n.slice(0, -6)).find((id) => id !== SRC);
    check(!!newId && newId !== SRC, `the fork got its own id: ${newId}`);
    check(sha(srcPath) === srcSha, "the SOURCE log is byte-identical afterwards");

    // The fork holds turn 1 WHOLE — prompt, tool call, tool result, reply — and
    // stops before turn 2's prompt.
    const forked = readFileSync(join(projectDir(repo.path), newId + ".jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    check(forked.map((r) => r.uuid).join(",") === "u1,a1,r1,a1b", `cut on the turn boundary: ${forked.map((r) => r.uuid).join(",")}`);
    check(forked.every((r) => r.sessionId === newId), "every copied record names the new conversation");

    // ── 2. It is RESUMED, not re-forked ─────────────────────────────
    check(args.includes(`--resume ${newId}`), `spawned with --resume <newId> (args: ${args.split("\n")[0]})`);
    check(!args.includes("--fork-session"), "no --fork-session on top: the copy is already its own conversation");
    check(created.length === 1 && created[0].claudeSessionId === newId, "the session reports the forked conversation id");

    // ── 3. A replay of the same ackId spawns nothing ────────────────
    const before = logs(repo.path).length;
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, resumeMode: "fork", resumeSessionId: SRC, forkAtTurn: "u1", ackId: "ff-1" });
    await wait(700);
    check(created.length === 1, `replayed ackId spawned no second session (${created.length})`);
    check(logs(repo.path).length === before, "replayed ackId wrote no second log");

    // ── 4. A turn that is not in the log is refused, not guessed at ──
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, resumeMode: "fork", resumeSessionId: SRC, forkAtTurn: "nosuchturn", ackId: "ff-2" });
    await until(() => acks.has("ff-2"));
    const bad = acks.get("ff-2");
    check(bad?.ok === false, `an unknown turn is refused (${JSON.stringify(bad)})`);
    check(created.length === 1, "a refused fork opens no session on the whole conversation");
    check(logs(repo.path).length === before, "a refused fork writes no log");

    // ── 5. A traversal-shaped source id never reaches the filesystem ─
    send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, resumeMode: "fork", resumeSessionId: "../../etc/passwd", forkAtTurn: "u1", ackId: "ff-3" });
    await until(() => acks.has("ff-3"));
    check(acks.get("ff-3")?.ok === false, "a traversal-shaped conversation id is refused");
    check(created.length === 1, "…and opens nothing");
    finish();
  }
});
