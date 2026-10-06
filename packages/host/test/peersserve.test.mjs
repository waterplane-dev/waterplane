/**
 * Peers, inbound (peers/serve.ts): a paired desktop's job becomes ONE ordinary
 * intent row in a detached worktree of the right clone — real git over temp repos,
 * a real http server around the handler, a fake intent store and transcript. No daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_API_VERSION } from "@waterplane/shared";
import { createPeerServe, outboxNamesIn, parsePeerJob, lastAnswerText, jobDirName, PEER_JOB_MARKER } from "../dist/peers/serve.js";
import { inRoot } from "../dist/scaffold.js";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const REMOTE_URL = "https://github.com/acme/widget.git";

/** A bare "origin" with one commit on main, and a clone of it under root/<name> whose origin URL is spelled as GitHub's. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-peer-")));
  const root = join(base, "root");
  mkdirSync(root);
  const bare = join(base, "origin.git");
  git(base, "init", "--bare", "-b", "main", bare);
  const seed = join(base, "seed");
  git(base, "clone", bare, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "one");
  git(seed, "push", "origin", "HEAD:main");
  const sha = git(seed, "rev-parse", "HEAD");
  const clone = (name) => {
    const dir = join(root, name);
    git(base, "clone", bare, dir);
    // The URL as the asker spells it; fetches still go to the bare repo.
    git(dir, "remote", "set-url", "origin", REMOTE_URL);
    git(dir, "config", `url.${bare}.insteadOf`, REMOTE_URL);
    return dir;
  };
  return { base, root, bare, seed, sha, clone };
}

function fakeIntents() {
  const rows = new Map();
  return {
    rows,
    post(draft) {
      if (rows.has(draft.id)) return { ok: true, intent: rows.get(draft.id), existing: true };
      const intent = { ...draft, state: "queued", createdAt: 1 };
      rows.set(draft.id, intent);
      return { ok: true, intent, existing: false };
    },
    get: (id) => rows.get(id),
    list: () => [...rows.values()],
  };
}

const PEER = { name: "mac", addr: "127.0.0.1:8770", outbound: true, inbound: true, addedAt: 1 };

function boot(w, extra = {}) {
  const intents = fakeIntents();
  const transcripts = new Map();
  const deps = {
    ROOT: w.root,
    intents,
    sessions: { getTranscript: (id) => transcripts.get(id) ?? null, diedAtLimit: () => false },
    containRepoDir: async (d) => { const x = typeof d === "string" ? inRoot(w.root, d) : null; return x && existsSync(x) ? x : null; },
    selfDir: join(w.base, "elsewhere"),
    ...extra,
  };
  mkdirSync(deps.selfDir, { recursive: true });
  const serve = createPeerServe(deps);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const peer = req.headers["x-peer"] === "other" ? { ...PEER, name: "other" } : PEER;
    if (!(await serve(req, res, url.pathname, url, peer))) res.writeHead(404).end("nf");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    server.unref();
    const port = server.address().port;
    const call = async (method, path, body, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const buf = Buffer.from(await r.arrayBuffer());
      let json; try { json = JSON.parse(buf.toString()); } catch { /* bytes */ }
      return { status: r.status, json, buf };
    };
    ok({ intents, transcripts, serve, call, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

const jobBody = (w, over = {}) => ({ key: "k1", from: "mac", remote: "git@github.com:Acme/Widget", branch: "main", commit: w.sha, prompt: "run the tests", ...over });

test("a job: right clone by remote, detached worktree at the sha, marker, one serial repo-target row, clone untouched", async () => {
  const w = world();
  const clone = w.clone("widget");
  const before = git(clone, "status", "--porcelain");
  const h = await boot(w);
  const r = await h.call("POST", "/api/peer/jobs", jobBody(w, { label: "unit tests" }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, "queued");
  assert.equal(r.json.id, "peer-mac-k1");
  const wt = join(clone, ".claude", "worktrees", "peer-mac-k1");
  assert.equal(r.json.worktree, wt);
  assert.equal(git(wt, "rev-parse", "HEAD"), w.sha);
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
  // The job's label rides in the marker so a session opened there can say why it exists (WP8).
  assert.deepEqual(JSON.parse(readFileSync(join(wt, PEER_JOB_MARKER), "utf8")), { id: "peer-mac-k1", from: "mac", key: "k1", label: "unit tests" });
  const row = h.intents.rows.get("peer-mac-k1");
  assert.equal(row.origin, "peer:mac");
  assert.equal(row.cwd, wt);
  assert.deepEqual(row.target, { kind: "repo" });
  assert.equal(row.serial, true);
  assert.equal(row.auto, true);
  assert.deepEqual(row.payload, { kind: "prompt", steps: ["run the tests"] });
  assert.equal(row.label, "unit tests");
  assert.equal(git(clone, "status", "--porcelain"), before, "the clone's tree is untouched (worktrees dir excluded)");
  h.close();
});

test("at-most-once by id: a repeat (and a concurrent twin) is the same row, existing:true, nothing new", async () => {
  const w = world();
  w.clone("widget");
  const h = await boot(w);
  const [a, b] = await Promise.all([h.call("POST", "/api/peer/jobs", jobBody(w)), h.call("POST", "/api/peer/jobs", jobBody(w))]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(h.intents.rows.size, 1);
  assert.ok(a.json.existing || b.json.existing);
  const c = await h.call("POST", "/api/peer/jobs", jobBody(w));
  assert.equal(c.json.existing, true);
  assert.equal(h.intents.rows.size, 1);
  h.close();
});

test("clone match: none, two (dir picks), and a body that is not the caller's", async () => {
  const w = world();
  const h = await boot(w);
  const none = await h.call("POST", "/api/peer/jobs", jobBody(w));
  assert.equal(none.json.state, "refused");
  assert.match(none.json.detail, /no clone of github\.com\/acme\/widget/);
  assert.equal(h.intents.rows.size, 0);

  const c1 = w.clone("widget"), c2 = w.clone("widget2");
  const two = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k2" }));
  assert.equal(two.json.state, "refused");
  assert.match(two.json.detail, /ambiguous/);
  assert.ok(two.json.detail.includes(c1) && two.json.detail.includes(c2));
  const pick = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k2", dir: c2 }));
  assert.equal(pick.json.state, "queued");
  assert.ok(h.intents.rows.get("peer-mac-k2").cwd.startsWith(c2));

  const liar = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k3", from: "pc" }));
  assert.equal(liar.status, 400);
  h.close();
});

test("the daemon's own checkout is refused before any git runs", async () => {
  const w = world();
  const clone = w.clone("widget");
  const h = await boot(w, { selfDir: clone });
  const r = await h.call("POST", "/api/peer/jobs", jobBody(w));
  assert.equal(r.json.state, "refused");
  assert.match(r.json.detail, /live waterplane checkout/);
  assert.ok(!existsSync(join(clone, ".claude", "worktrees")), "no worktree was made");
  assert.equal(h.intents.rows.size, 0);
  h.close();
});

test("fetch failures and unknown commits are `failed` with a sentence, never a row", async () => {
  const w = world();
  w.clone("widget");
  const h = await boot(w);
  const nob = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k4", branch: "nope" }));
  assert.equal(nob.json.state, "failed");
  assert.match(nob.json.detail, /could not fetch nope/);
  const nocommit = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k5", commit: "deadbeefdeadbeef" }));
  assert.equal(nocommit.json.state, "failed");
  assert.equal(h.intents.rows.size, 0);
  h.close();
});

test("a stale worktree of ours is reused at the same commit, replaced at another, never a stranger's", async () => {
  const w = world();
  const clone = w.clone("widget");
  const h = await boot(w);
  await h.call("POST", "/api/peer/jobs", jobBody(w));
  const wt = join(clone, ".claude", "worktrees", "peer-mac-k1");
  writeFileSync(join(wt, "scratch"), "x");
  h.intents.rows.clear(); // as if the row had been evicted: only the worktree remains
  await h.call("POST", "/api/peer/jobs", jobBody(w));
  assert.ok(existsSync(join(wt, "scratch")), "same commit: reused as it was");

  writeFileSync(join(w.seed, "a.txt"), "two\n");
  git(w.seed, "commit", "-am", "two");
  git(w.seed, "push", "origin", "HEAD:main");
  const sha2 = git(w.seed, "rev-parse", "HEAD");
  h.intents.rows.clear();
  const r = await h.call("POST", "/api/peer/jobs", jobBody(w, { commit: sha2 }));
  assert.equal(r.json.state, "queued");
  assert.equal(git(wt, "rev-parse", "HEAD"), sha2);
  assert.ok(!existsSync(join(wt, "scratch")), "another commit: removed and recreated");

  // a directory with that name that is NOT ours is left alone
  const stranger = join(clone, ".claude", "worktrees", "peer-mac-k9");
  mkdirSync(stranger, { recursive: true });
  const s = await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "k9" }));
  assert.equal(s.json.state, "failed");
  assert.match(s.json.detail, /not a delegated job's worktree/);
  h.close();
});

test("GET job: states off the row, the answer as the report, outbox artifacts contained and capped", async () => {
  const w = world();
  w.clone("widget");
  const h = await boot(w);
  const posted = await h.call("POST", "/api/peer/jobs", jobBody(w));
  const wt = posted.json.worktree;
  const row = h.intents.rows.get("peer-mac-k1");

  let g = await h.call("GET", "/api/peer/jobs/peer-mac-k1");
  assert.equal(g.json.state, "queued");
  assert.equal(g.json.report, undefined);
  row.state = "blocked"; row.blockDetail = "auto-fire is off";
  g = await h.call("GET", "/api/peer/jobs/peer-mac-k1");
  assert.deepEqual([g.json.state, g.json.waiting], ["waiting", "auto-fire is off"]);
  row.state = "running"; row.sessionId = "s1";
  assert.equal((await h.call("GET", "/api/peer/jobs/peer-mac-k1")).json.state, "running");

  mkdirSync(join(wt, ".claude", "outbox"), { recursive: true });
  writeFileSync(join(wt, ".claude", "outbox", "result.txt"), "hello");
  writeFileSync(join(wt, ".claude", "outbox", "big.bin"), Buffer.alloc((8 << 20) + 1));
  writeFileSync(join(w.base, "secret.txt"), "nope");
  symlinkSync(join(w.base, "secret.txt"), join(wt, ".claude", "outbox", "link.txt"));
  h.transcripts.set("s1", { turns: [
    { blocks: [{ kind: "text", text: "first" }] },
    { blocks: [{ kind: "text", text: "All green. See .claude/outbox/result.txt, .claude/outbox/big.bin, .claude/outbox/link.txt, .claude/outbox/../../a.txt and .claude/outbox/missing.png." }] },
  ] });
  row.state = "done";
  g = await h.call("GET", "/api/peer/jobs/peer-mac-k1");
  assert.equal(g.json.state, "done");
  assert.equal(g.json.sessionId, "s1");
  assert.equal(g.json.peerApi, PEER_API_VERSION);
  assert.equal(g.json.report.ok, true);
  assert.match(g.json.report.text, /^All green\./);
  assert.deepEqual(g.json.report.artifacts, [{ name: "result.txt", size: 5 }]);

  const dl = await h.call("GET", "/api/peer/jobs/peer-mac-k1/artifact?name=result.txt");
  assert.equal(dl.status, 200);
  assert.equal(dl.buf.toString(), "hello");
  for (const bad of ["../../a.txt", "link.txt", "big.bin", "missing.png", "", "..%2F..%2Fa.txt"]) {
    const r = await h.call("GET", `/api/peer/jobs/peer-mac-k1/artifact?name=${bad}`);
    assert.ok(r.status === 404 || r.status === 413, `${bad} -> ${r.status}`);
  }
  h.close();
});

test("a failed row reports ok:false with the row's sentence; the report is capped and says so", async () => {
  const w = world();
  w.clone("widget");
  const h = await boot(w, { reportMax: 10 });
  await h.call("POST", "/api/peer/jobs", jobBody(w));
  const row = h.intents.rows.get("peer-mac-k1");
  row.state = "failed"; row.sessionId = "s1"; row.result = { ok: false, detail: "the session was lost" };
  h.transcripts.set("s1", { turns: [{ blocks: [{ kind: "text", text: "0123456789ABCDEF" }] }] });
  const g = await h.call("GET", "/api/peer/jobs/peer-mac-k1");
  assert.equal(g.json.state, "failed");
  assert.equal(g.json.detail, "the session was lost");
  assert.deepEqual([g.json.report.ok, g.json.report.text, g.json.report.truncated], [false, "0123456789", true]);
  h.close();
});

test("a job is the posting peer's alone", async () => {
  const w = world();
  w.clone("widget");
  const h = await boot(w);
  await h.call("POST", "/api/peer/jobs", jobBody(w));
  assert.equal((await h.call("GET", "/api/peer/jobs/peer-mac-k1", undefined, { "x-peer": "other" })).status, 404);
  assert.equal((await h.call("GET", "/api/peer/jobs/peer-mac-nope")).status, 404);
  assert.equal((await h.call("GET", "/api/peer/jobs/peer-mac-k1/artifact?name=x", undefined, { "x-peer": "other" })).status, 404);
  h.close();
});

test("sweep removes job worktrees older than 7 days, keeps young ones and ones with work still to do", async () => {
  const w = world();
  const clone = w.clone("widget");
  const h = await boot(w);
  await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "old" }));
  await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "busy" }));
  await h.call("POST", "/api/peer/jobs", jobBody(w, { key: "young" }));
  const wtOf = (k) => join(clone, ".claude", "worktrees", `peer-mac-${k}`);
  const old = new Date(Date.now() - 8 * 86400_000);
  for (const k of ["old", "busy"]) utimesSync(join(wtOf(k), PEER_JOB_MARKER), old, old);
  h.intents.rows.get("peer-mac-old").state = "done";
  const removed = await h.serve.sweep();
  assert.deepEqual(removed, [wtOf("old")]);
  assert.ok(!existsSync(wtOf("old")) && existsSync(wtOf("busy")) && existsSync(wtOf("young")));
  h.close();
});

test("pure: the body, the outbox names an answer carries, the last answer", () => {
  assert.ok("refused" in parsePeerJob({ key: "a b", from: "mac" }, "mac"));
  assert.ok("refused" in parsePeerJob({ key: "a", from: "mac", remote: "nonsense", branch: "m", commit: "abcdef1", prompt: "x" }, "mac"));
  assert.ok("refused" in parsePeerJob({ key: "a", from: "mac", remote: "git@h.io:o/r", branch: "--upload-pack=x", commit: "abcdef1", prompt: "x" }, "mac"));
  assert.ok("refused" in parsePeerJob({ key: "a", from: "mac", remote: "git@h.io:o/r", branch: "m", commit: "not-hex", prompt: "x" }, "mac"));
  assert.ok("refused" in parsePeerJob({ key: "a", from: "mac", remote: "git@h.io:o/r", branch: "m", commit: "abcdef1" }, "mac"));
  assert.ok(!("refused" in parsePeerJob({ key: "a", from: "mac", remote: "git@h.io:o/r", branch: "feat/x", commit: "abcdef1", steps: ["x"] }, "mac")));
  // A shell is never opened from another desktop, however it is spelled.
  const shellJob = { key: "a", from: "mac", remote: "git@h.io:o/r", branch: "m", commit: "abcdef1", prompt: "x" };
  assert.match(parsePeerJob({ ...shellJob, launch: { backend: "shell" } }, "mac").refused ?? "", /shell session cannot be opened/);
  assert.match(parsePeerJob({ ...shellJob, backend: "shell" }, "mac").refused ?? "", /shell session cannot be opened/);
  assert.deepEqual(outboxNamesIn("see .claude/outbox/a.png, `.claude/outbox/b c.txt` and (.claude/outbox/a.png). x.claude/outbox/no"), ["a.png", "b"]);
  assert.equal(lastAnswerText(null), null);
  assert.equal(lastAnswerText({ turns: [{ blocks: [{ kind: "text", text: "a" }] }, { blocks: [{ kind: "thinking", text: "z" }] }] }), "a");
  assert.equal(jobDirName("peer-mac-a:b/c"), "peer-mac-a_b_c");
});

test("restart.sh refuses inside a job worktree with a sentence and does not build", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-restart-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, ".waterplane"));
  writeFileSync(join(dir, PEER_JOB_MARKER), "{}");
  const src = new URL("../../../scripts/restart.sh", import.meta.url).pathname;
  copyFileSync(src, join(dir, "scripts", "restart.sh"));
  const r = spawnSync("bash", [join(dir, "scripts", "restart.sh")], { cwd: dir, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /delegated job's worktree/);
  assert.ok(!/building/.test(r.stdout));
});
