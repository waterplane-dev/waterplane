// Peer desktops, end to end (docs/analysis/peer-hosts-plan.md, "Tests / e2e").
//
// Two REAL hosts, each on its own free port with its own ROOT, config dir, claude home and stub
// `claude` (`claude-stub-tui.mjs` in `STUB_MODE=answer`, which writes the conversation log a
// report is read from). One bare git remote, cloned under both roots; the clones key to the same
// repo through an `https://` URL that `insteadOf` rewrites to the local bare repo (`remoteKey`
// refuses a bare path, and the URL must be read AS WRITTEN on both ends).
//
// Pinned, in order:
//   1.  pairing over loopback with symmetric tokens and DIFFERENT names ("pc" lists B, "mac" lists
//       A); `GET /api/peers` carries no token and a `self.addr` of the right shape
//   2.  the peer routes refuse: no/unknown token 403, wrong or missing `x-…-peer-api` 409
//   3.  a job from A's agent route: B gets the row (`origin: peer:mac`), a DETACHED worktree at the
//       pushed sha carrying the marker and the pushed file, B's own clone untouched; the stub
//       answers naming `.claude/outbox/result.txt`; A's originating session gets exactly ONE prompt
//       starting `[report from peer pc]`, and the file lands in A's outbox as `peer-pc-*`
//   4.  the same key again ⇒ `existing`, one row, still one report
//   5.  B DOWN when the job is posted ⇒ A reports `unreachable`; B back on the same port ⇒ it
//       completes and reports (an unreachable peer is never a verdict)
//   6.  a repo B has no clone of ⇒ the refusal's sentence is the report, delivered as a prompt
//   7.  A's agent route refuses a browser (Origin) and a proxied request (403)
//   8.  self-maintenance: the delegated prompt runs `scripts/restart.sh` IN THE JOB WORKTREE ⇒
//       refused with the marker's sentence, and B's daemon is the same process, still serving
//
// Never port 8770, never the live daemon: both hosts are children of this script, tmux and
// preflight pinned off.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { freePort, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { PEER_API_HEADER } from "../packages/shared/dist/peer.js";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000, step = 150) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

const TMP = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-peer-`)));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "e2e";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "e2e@example.test";
process.env.GIT_CONFIG_GLOBAL = join(TMP, "gitconfig-empty");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");

// ── the shared remote(s), and a clone of each under each root ────────────────
const mkRemote = (name) => {
  const bare = join(TMP, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = join(TMP, `seed-${name}`);
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "ignore" });
  mkdirSync(join(seed, "scripts"), { recursive: true });
  copyFileSync(join(process.cwd(), "scripts/restart.sh"), join(seed, "scripts/restart.sh"));
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "seed"); git(seed, "push", "-q", "origin", "HEAD:main");
  return { bare, url: `https://example.test/acme/${name}.git` };
};
const projRemote = mkRemote("proj");
const otherRemote = mkRemote("other");
const clone = (root, name, remote) => {
  const dir = join(root, name);
  execFileSync("git", ["clone", "-q", remote.bare, dir], { stdio: "ignore" });
  git(dir, "config", "remote.origin.url", remote.url);
  git(dir, "config", `url.${remote.bare}.insteadOf`, remote.url);
  return dir;
};

// ── two hosts ────────────────────────────────────────────────────────────────
function mkNode(label) {
  const root = join(TMP, `root-${label}`);
  mkdirSync(root, { recursive: true });
  return {
    label, root, port: 0, host: null, exited: null,
    cfg: join(TMP, `cfg-${label}`), home: join(TMP, `home-${label}`), stubLog: join(TMP, `stub-${label}.log`),
  };
}
async function boot(n) {
  if (!n.port) n.port = await freePort();
  n.host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(n.port), [E.HOST]: "127.0.0.1", ...rootEnv(n.root),
      [E.CONFIG_DIR]: n.cfg, [E.CLAUDE_HOME]: n.home,
      XDG_DATA_HOME: join(TMP, `data-${n.label}`), XDG_CONFIG_HOME: join(TMP, `xdgcfg-${n.label}`),
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
      STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG: n.stubLog,
      [E.INTENT_TICK_MS]: "300", [E.PEER_POLL_MS]: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  n.host.stderr.on("data", (d) => process.stderr.write(`[${n.label}] ${d}`));
  n.exited = new Promise((r) => n.host.once("exit", r));
  await waitForHost(n.port);
}
const stop = async (n) => { if (n.host && n.host.exitCode === null && n.host.signalCode === null) { n.host.kill(); await n.exited; } };
const A = mkNode("a"), B = mkNode("b");
const cloneA = clone(A.root, "proj", projRemote);
const cloneB = clone(B.root, "proj", projRemote);
const otherA = clone(A.root, "other", otherRemote); // B has NO clone of this one

const http = (n, path, { method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : Buffer.from(JSON.stringify(body));
  const req = request({
    host: "127.0.0.1", port: n.port, path, method,
    headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers },
  }, (res) => {
    let t = "";
    res.on("data", (d) => (t += d));
    res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});

/** A phone socket on a node: sessions it has seen, and its intent list on demand. */
async function phone(n) {
  const ws = new WebSocket(`ws://127.0.0.1:${n.port}/ws`);
  const sessions = new Map();
  let intents = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if ((msg.t === "session.created" || msg.t === "session.updated") && msg.session) sessions.set(msg.session.id, msg.session);
    if (msg.t === "intent.list") intents = msg.intents;
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(300);
  return {
    async create(cwd) {
      const before = new Set(sessions.keys());
      ws.send(JSON.stringify({ t: "session.create", cwd, cols: 100, rows: 40 }));
      const sid = await until(() => [...sessions.keys()].find((k) => !before.has(k) && sessions.get(k).cwd === cwd), 8000);
      if (sid) ws.send(JSON.stringify({ t: "session.attach", id: sid }));
      await until(() => sessions.get(sid)?.hooked === true, 6000);
      return sid;
    },
    /** The owner's global auto-fire switch: a delegated job (and a report row) waits at the gate without it. */
    setAuto(enabled) { ws.send(JSON.stringify({ t: "backlog.setAuto", enabled })); return sleep(300); },
    async intents() { ws.send(JSON.stringify({ t: "intent.list" })); await sleep(250); return intents; },
    /** The last SessionInfo this phone was sent for `id`, or every one whose cwd is `cwd`. */
    session: (id) => sessions.get(id),
    sessionsIn: (cwd) => [...sessions.values()].filter((s) => s.cwd === cwd),
    close: () => ws.close(),
  };
}

const T_A_TO_B = "tok-mac-to-pc-0123456789abcdef"; // what A presents to B (B keeps its hash as the inbound for "mac")
const T_B_TO_A = "tok-pc-to-mac-0123456789abcdef";
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const markCount = (log, mark) => read(log).split(mark).length - 1;
const outboxPeerFiles = (dir) => { try { return readdirSync(join(dir, ".claude", "outbox")).filter((f) => f.startsWith("peer-pc-")); } catch { return []; } };
// The head carries the job's measured cost parts after the mark (`· <1 min]`), so count the open mark.
const MARK = "[report from peer pc";
const jobState = async (id) => (await http(A, `/api/agent/peer/pc/intents/${id}`)).json?.state;

async function main() {
  await boot(A); await boot(B);
  const pa = await phone(A), pb = await phone(B);
  await pa.setAuto(true); await pb.setAuto(true); // each owner's own tap; nothing applies itself without it

  // ── 1. pairing ─────────────────────────────────────────────────────────────
  const pairA = await http(A, "/api/peers", { method: "POST", body: { name: "pc", addr: `127.0.0.1:${B.port}`, outboundToken: T_A_TO_B, inboundToken: T_B_TO_A } });
  const pairB = await http(B, "/api/peers", { method: "POST", body: { name: "mac", addr: `127.0.0.1:${A.port}`, outboundToken: T_B_TO_A, inboundToken: T_A_TO_B } });
  check(pairA.json?.ok === true && pairB.json?.ok === true, `paired over loopback, symmetric tokens, names pc / mac (${pairA.status} ${pairB.status})`);
  const listA = await http(A, "/api/peers");
  check(listA.json?.peers?.length === 1 && listA.json.peers[0].name === "pc", "GET /api/peers lists the peer by A's own name for it");
  check(!listA.text.includes(T_A_TO_B) && !listA.text.includes(T_B_TO_A), "…and never echoes a token");
  const addr = listA.json?.self?.addr;
  check(listA.json?.self && "addr" in listA.json.self && (addr === null || /^[^:\s]+:\d{1,5}$/.test(addr)), `self.addr is null or host:port (${JSON.stringify(addr)})`);

  // ── 2. what the peer routes refuse ─────────────────────────────────────────
  const goodH = { authorization: `Bearer ${T_A_TO_B}`, [PEER_API_HEADER]: "1" };
  const hello = await http(B, "/api/peer/hello", { headers: goodH });
  check(hello.status === 200 && hello.json?.you === "mac", `hello with the right token and version names the caller (${hello.status} ${hello.text.slice(0, 80)})`);
  const wrongVer = await http(B, "/api/peer/hello", { headers: { ...goodH, [PEER_API_HEADER]: "99" } });
  check(wrongVer.status === 409 && /99/.test(wrongVer.json?.error ?? "") && /1/.test(wrongVer.json?.error ?? ""), `wrong version header ⇒ 409 naming both numbers (${wrongVer.json?.error})`);
  const noVer = await http(B, "/api/peer/hello", { headers: { authorization: goodH.authorization } });
  check(noVer.status === 409, "a missing version header ⇒ 409");
  const badTok = await http(B, "/api/peer/hello", { headers: { authorization: "Bearer nope", [PEER_API_HEADER]: "1" } });
  check(badTok.status === 403, "an unknown token ⇒ 403");
  const noTok = await http(B, "/api/peer/jobs/x", { headers: { [PEER_API_HEADER]: "1" } });
  check(noTok.status === 403, "no token ⇒ 403 on the jobs routes too");

  // ── 3. a job, end to end ───────────────────────────────────────────────────
  const sidA = await pa.create(cloneA);
  check(!!sidA, "A has a live, hooked session in its clone (the one the report must come back to)");
  git(cloneA, "checkout", "-q", "-b", "feat-x");
  writeFileSync(join(cloneA, "peer-marker.txt"), "pushed from A\n");
  git(cloneA, "add", "-A"); git(cloneA, "commit", "-qm", "feat-x"); git(cloneA, "push", "-q", "origin", "feat-x");
  const sha = git(cloneA, "rev-parse", "HEAD");
  const bHeadBefore = git(cloneB, "rev-parse", "HEAD");
  const bBranchBefore = git(cloneB, "rev-parse", "--abbrev-ref", "HEAD");

  const post = (key, prompt) => http(A, "/api/agent/peer/pc/intents", { method: "POST", body: { key, dir: cloneA, branch: "feat-x", commit: sha, prompt } });
  const first = await post("k1", "STUB_WRITE .claude/outbox/result.txt\nSTUB_SAY Done: the report is in .claude/outbox/result.txt");
  check(first.status === 200 && first.json?.ok === true && first.json.id === "peer-pc-k1" && first.json.existing === false, `POST /api/agent/peer/pc/intents → 200 id peer-pc-k1 (${first.status} ${first.text.slice(0, 160)})`);
  check(/pc/.test(first.json?.fires ?? ""), `…and says where it went (${first.json?.fires})`);

  const row = await until(async () => (await pb.intents()).find((i) => i.id === "peer-mac-k1"), 15_000);
  check(!!row && row.origin === "peer:mac", `B's intent list holds the row, origin peer:mac (${row?.origin})`);
  const wt = join(cloneB, ".claude", "worktrees", "peer-mac-k1");
  check(existsSync(wt) && git(wt, "rev-parse", "HEAD") === sha, "B made a worktree at the pushed sha");
  let detached = false;
  try { git(wt, "symbolic-ref", "-q", "HEAD"); } catch { detached = true; }
  check(detached, "…detached (no branch checked out under it)");
  check(existsSync(join(wt, STATE, "peer-job.json")), "…carrying the peer-job marker");
  check(existsSync(join(wt, "peer-marker.txt")), "…and the pushed file");

  const k1done = await until(async () => (await jobState("peer-pc-k1")) === "done", 40_000);
  if (!k1done) {
    console.log("  A's view:", JSON.stringify((await http(A, "/api/agent/peer/pc/intents/peer-pc-k1")).json));
    console.log("  B's view:", JSON.stringify((await http(B, "/api/peer/jobs/peer-mac-k1", { headers: goodH })).json));
    console.log("  B's row:", JSON.stringify((await pb.intents()).find((i) => i.id === "peer-mac-k1")));
  }
  check(!!k1done, "A sees the job done");
  check(existsSync(join(wt, ".claude", "outbox", "result.txt")), "the stub's answer file is in the job worktree's outbox");
  check(!!(await until(() => outboxPeerFiles(cloneA).length > 0, 15_000)), `the artifact landed in A's .claude/outbox/ as peer-pc-* (${outboxPeerFiles(cloneA).join(",")})`);
  check(!!(await until(() => markCount(A.stubLog, MARK) >= 1, 15_000)), "A's session received the report as a prompt");
  await sleep(2500); // a duplicate would have fired by now
  check(markCount(A.stubLog, MARK) === 1, `…exactly ONE prompt starting ${MARK} (${markCount(A.stubLog, MARK)})`);
  check(/peer-pc-result/.test(read(A.stubLog)), "…and it names the fetched file");
  // WP8 — transparency and cost. The stub writes no conversation log, so money and model are ABSENT
  // (never $0) and the duration, which the row itself measured, is the one part the head carries.
  check(/\[report from peer pc · [^\]$]*min\]/.test(read(A.stubLog)) && !/\[report from peer pc[^\]]*\$0/.test(read(A.stubLog)), "…its head carries the job's duration and no $0");
  const ledger = await http(A, "/api/peerjobs");
  const lrow = ledger.json?.jobs?.find((j) => j.jobId === "peer-pc-k1");
  check(ledger.status === 200 && lrow?.sessionId === sidA && lrow.cost?.durationMs > 0 && lrow.cost.usd === undefined && !ledger.text.includes(T_A_TO_B),
    `GET /api/peerjobs lists the job for the phone: asking session, duration, no money it did not measure, no token (${ledger.status} ${JSON.stringify(lrow?.cost)})`);
  check(!!(await until(() => pa.session(sidA)?.peerJobs?.some((j) => j.jobId === "peer-pc-k1" && j.state === "done"), 10_000)), "A's asking session lists the job it sent (SessionInfo.peerJobs), settled, after the tag cleared");
  const jobSess = pb.sessionsIn(wt)[0];
  check(jobSess?.peerJob?.from === "mac" && jobSess.peerJob.jobId === "peer-mac-k1", `B's job session says why it exists (peerJob ${JSON.stringify(jobSess?.peerJob)})`);
  check(git(cloneB, "status", "--porcelain") === "" && git(cloneB, "rev-parse", "HEAD") === bHeadBefore && git(cloneB, "rev-parse", "--abbrev-ref", "HEAD") === bBranchBefore, "B's own clone: `git status` clean, HEAD and branch unchanged");

  // ── 4. same key ⇒ existing ─────────────────────────────────────────────────
  const again = await post("k1", "STUB_SAY should never run");
  check(again.json?.existing === true && again.json.id === "peer-pc-k1", "the same key again ⇒ existing, same id");
  await sleep(1500);
  check((await pb.intents()).filter((i) => i.id === "peer-mac-k1").length === 1, "…one row on B");
  check(markCount(A.stubLog, MARK) === 1, "…and still one report");

  // ── 5. B down, then back on the same port ─────────────────────────────────
  await stop(B);
  const down = await post("k2", "STUB_SAY back from the dead");
  check(down.json?.ok === true && down.json.id === "peer-pc-k2", "a job posts while B is down");
  check(!!(await until(async () => (await jobState("peer-pc-k2")) === "unreachable", 15_000)), "A shows it unreachable (never failed)");
  await boot(B);
  const pb2 = await phone(B);
  check(!!(await until(async () => (await jobState("peer-pc-k2")) === "done", 60_000, 500)), "B back on the same port: the job completes");
  check(!!(await until(() => markCount(A.stubLog, MARK) >= 2, 15_000)), "…and its report arrives");

  // ── 6. a repo B has no clone of ────────────────────────────────────────────
  const sidOther = await pa.create(otherA);
  check(!!sidOther, "A has a live session in the other repo");
  git(otherA, "checkout", "-q", "-b", "feat-o");
  writeFileSync(join(otherA, "o.txt"), "o\n"); git(otherA, "add", "-A"); git(otherA, "commit", "-qm", "o"); git(otherA, "push", "-q", "origin", "feat-o");
  const shaO = git(otherA, "rev-parse", "HEAD");
  const noClone = await http(A, "/api/agent/peer/pc/intents", { method: "POST", body: { key: "k3", dir: otherA, branch: "feat-o", commit: shaO, prompt: "STUB_SAY never" } });
  check(noClone.json?.ok === true, "a job for a repo B has no clone of is accepted by A");
  check(!!(await until(async () => (await jobState("peer-pc-k3")) === "refused", 25_000)), "…B refuses it");
  check(!!(await until(() => /no clone of/.test(read(A.stubLog)), 20_000)), "…and the sentence (no clone of … clone it here first) arrives as the report prompt");

  // ── 7. who may call A's agent route ────────────────────────────────────────
  const body7 = (key) => ({ key, dir: cloneA, branch: "feat-x", commit: sha, prompt: "x" });
  const withOrigin = await http(A, "/api/agent/peer/pc/intents", { method: "POST", body: body7("k4"), headers: { origin: `http://127.0.0.1:${A.port}` } });
  check(withOrigin.status === 403, "an Origin header (a browser) ⇒ 403");
  const proxied = await http(A, "/api/agent/peer/pc/intents", { method: "POST", body: body7("k5"), headers: { "x-forwarded-for": "100.64.0.9" } });
  check(proxied.status === 403, "a proxied request (x-forwarded-for) ⇒ 403 — the non-loopback case a loopback-bound host can reach");
  check((await http(A, "/api/agent/peer/pc/intents/peer-pc-k4")).status === 404 && (await http(A, "/api/agent/peer/pc/intents/peer-pc-k5")).status === 404, "…and neither left a job behind");

  // ── 8. self-maintenance ────────────────────────────────────────────────────
  const bPid = B.host.pid;
  const maint = await post("k6", "STUB_RUN bash scripts/restart.sh\nSTUB_SAY ran the restart");
  check(maint.json?.ok === true, "a delegated prompt that runs scripts/restart.sh posts");
  check(!!(await until(async () => (await jobState("peer-pc-k6")) === "done", 60_000, 500)), "the job ends");
  const wt6 = join(cloneB, ".claude", "worktrees", "peer-mac-k6");
  const jr = await http(B, "/api/peer/jobs/peer-mac-k6", { headers: goodH });
  const text = jr.json?.report?.text ?? "";
  check(/exited 1/.test(text) && /refused: this is a delegated job's worktree/.test(text), `restart.sh was refused with the marker's sentence (${text.replace(/\s+/g, " ").slice(-170)})`);
  check(existsSync(join(wt6, "scripts", "restart.sh")), "(it ran in the job worktree, which carries its own copy)");
  const health = await http(B, "/api/health");
  check(health.json?.ok === true && B.host.pid === bPid && B.host.exitCode === null, "B's daemon is the same process and still answers /api/health");

  pa.close(); pb.close(); pb2.close();
}

main()
  .catch((e) => { console.error(e); failed = true; })
  .finally(async () => {
    await Promise.all([stop(A), stop(B)]);
    process.exit(failed ? 1 : 0);
  });
