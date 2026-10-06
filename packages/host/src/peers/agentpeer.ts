/**
 * The asking agent's way to a peer desktop (docs/analysis/peer-hosts-plan.md): the loopback twin of
 * `agentintents.ts` — `POST|GET|DELETE /api/agent/peer/<peer>/intents[/<id>]` — and the wiring that
 * builds the job machine (`jobs.ts`) from the host's own parts.
 *
 *  - **Same gate, same refusals.** `agentCallerRefusal` (loopback, no browser, not proxied) and
 *    `agentBasics` (key, prompt/steps, repo/dir/session) are reused, not copied: an agent that gets
 *    a sentence from `/api/agent/intents` gets the same sentence here.
 *  - **Nothing is forwarded that is not pushed.** `branch` must be on `origin` (`git ls-remote`) with
 *    `commit` reachable from its tip, else a 400 and nothing is sent or written. A retry under a key
 *    this host already holds answers that job (`existing`) before any git runs.
 *  - **The peer's clone is the peer's business**: `remote` is `remote.origin.url` AS WRITTEN (never `remote get-url`: it applies `insteadOf`, and the peer's `gitRemoteUrl` would key the repo differently) of the
 *    asking repo, matched there by `remoteKey`. A body's `peerDir` (a path on the PEER, picking one
 *    of two clones) is forwarded as the job's `dir`; the body's own `dir`/`repo` are THIS host's.
 *  - **The report comes back through the intent store** (`jobs.ts`): never a new send path.
 * Nothing here fires anything or applies a report.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ORIGIN_PEER_PREFIX,
  PEER_NAME_RE,
  PEER_REPORT_MAX_CHARS,
  makeEnvReader,
  peerJobId,
  remoteKey,
  sessionPickLabel,
  type PeerAgentAnswer,
  type PeerJobRequest,
} from "@waterplane/shared";
import { addClientBacklogItem, agentBasics, agentCallerRefusal, postClientDraft } from "../agentintents.js";
import { hostStateDir } from "../branddirs.js";
import { findTarget } from "../repos.js";
import { newOutboxPath } from "../files.js";
import type { ServerCtx } from "../server/ctx.js";
import { PeerClient } from "./client.js";
import { setPeerJobsLedger } from "./routes.js";
import { PeerJobs, type PeerJobRec } from "./jobs.js";

// ── git facts (injectable, so the refusals are pinned without a repo) ───────

export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

export const runGit: GitRun = (cwd, args) => new Promise((resolve) => {
  execFile("git", ["-C", cwd, ...args], { timeout: 20_000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim() }));
});

const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Is `commit` on `origin/<branch>`? The full sha, or why not. Asks the REMOTE (`ls-remote`), so a
 * branch that was only committed locally is refused: the peer fetches from the shared remote.
 */
export async function verifyPushed(cwd: string, branch: string, commit: string, git: GitRun = runGit):
  Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  if (!BRANCH_RE.test(branch)) return { ok: false, error: "`branch` is not a branch name" };
  if (!COMMIT_RE.test(commit)) return { ok: false, error: "`commit` is a git sha (7-40 hex)" };
  const local = await git(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (!local.ok || !/^[0-9a-f]{40}$/.test(local.out)) return { ok: false, error: `commit ${commit} is not in this repo` };
  const full = local.out;
  const remote = await git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (!remote.ok) return { ok: false, error: "could not ask origin about the branch (ls-remote failed) — nothing was sent" };
  const tip = /^([0-9a-f]{40})\s/.exec(remote.out)?.[1];
  if (!tip) return { ok: false, error: `branch ${branch} is not on origin; push first` };
  if (tip !== full) {
    const anc = await git(cwd, ["merge-base", "--is-ancestor", full, tip]);
    if (!anc.ok) return { ok: false, error: `commit ${full.slice(0, 10)} is not on origin/${branch}; push first` };
  }
  return { ok: true, commit: full };
}

// ── the route ───────────────────────────────────────────────────────────────

export interface PeerAgentDeps {
  jobs: Pick<PeerJobs, "get" | "list" | "submit" | "cancel">;
  containRepoDir(dir: unknown): Promise<string | null>;
  repoDir(id: string): Promise<string | null>;
  sessionCwd(id: string): string | null;
  /** The newest live session whose cwd is exactly `dir`. */
  runningSessionFor(dir: string): string | null;
  /** A session's label as a picker names it (`sessionPickLabel`); absent = unknown. */
  sessionLabel?(id: string): string | null | undefined;
  git?: GitRun;
  now?: () => number;
}
export interface PeerAgentIo {
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
}

const ROUTE = /^\/api\/agent\/peer\/([^/]+)\/intents(?:\/([^/]+))?$/;

/** A job as the agent reads it: the state, the peer's words, and — once it is in — the report. */
export function peerJobView(r: PeerJobRec) {
  return {
    id: r.id, peer: r.peer, state: r.state, branch: r.branch, commit: r.commit,
    ...(r.closed ? { closed: true } : {}),
    ...(r.view?.waiting ? { waiting: r.view.waiting } : {}),
    ...(r.unreachableSince ? { unreachableSince: r.unreachableSince } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.view?.sessionId ? { peerSession: r.view.sessionId } : {}),
    ...(r.reported ? { reported: true } : {}),
    ...(r.cost ? { cost: r.cost } : {}),
  };
}

/** `true` when the request was this route's (answered, or refused). */
export function makePeerAgentHandler(d: PeerAgentDeps) {
  return async (req: IncomingMessage, res: ServerResponse, path: string, _url: URL, io: PeerAgentIo): Promise<boolean> => {
    const m = ROUTE.exec(path);
    if (!m) return false;
    const { json } = io;
    const refusal = agentCallerRefusal(req.socket.remoteAddress, req.headers);
    if (refusal) { json(res, { ok: false, error: refusal }, 403); return true; }
    const method = req.method ?? "GET";
    let peer: string, id: string;
    try { peer = decodeURIComponent(m[1]!); id = m[2] ? decodeURIComponent(m[2]) : ""; } catch { json(res, { ok: false, error: "bad path" }, 400); return true; }
    if (!PEER_NAME_RE.test(peer)) { json(res, { ok: false, error: "no such peer" }, 404); return true; }
    const git = d.git ?? runGit;

    if (method === "POST" && !id) {
      const body = await io.readJson(req);
      let cwd: string | null = null;
      if (typeof body?.repo === "string" && body.repo.trim()) {
        const wt = await d.repoDir(body.repo.trim());
        if (!wt) { json(res, { ok: false, error: "unknown repo — ids come from GET /api/repos" }, 404); return true; }
        cwd = await d.containRepoDir(wt);
      } else if (typeof body?.dir === "string" && body.dir.trim()) cwd = await d.containRepoDir(body.dir);
      if ((body?.repo || body?.dir) && !cwd) { json(res, { ok: false, error: "that folder is outside the configured root — nothing was sent" }, 400); return true; }
      const basics = agentBasics(body, { now: (d.now ?? Date.now)(), cwd, sessionCwd: d.sessionCwd, intent: () => undefined });
      if ("refused" in basics) { json(res, { ok: false, error: basics.refused }, 400); return true; }
      const key = basics.key;
      const prior = d.jobs.get(peerJobId(peer, key));
      const answer = (r: PeerJobRec, existing: boolean): PeerAgentAnswer & { note: string } => ({
        ok: true, id: r.id, state: r.state, peer, existing, fires: `sent to ${peer} — waiting`,
        note: existing ? "already sent under this key — nothing new was forwarded" : `the report comes back as a prompt in this session; DELETE /api/agent/peer/${peer}/intents/${r.id} calls it off here`,
      });
      if (prior) { json(res, answer(prior, true)); return true; }

      const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
      const commit = typeof body?.commit === "string" ? body.commit.trim() : "";
      const pushed = await verifyPushed(basics.cwd, branch, commit, git);
      if (!pushed.ok) { json(res, { ok: false, error: pushed.error }, 400); return true; }
      const url0 = await git(basics.cwd, ["config", "--get", "remote.origin.url"]);
      if (!url0.ok || !remoteKey(url0.out)) { json(res, { ok: false, error: "this repo's origin remote cannot be read as a shared remote — the peer could not find the repo" }, 400); return true; }
      const req2: Omit<PeerJobRequest, "from"> = {
        key, remote: url0.out, branch, commit: pushed.commit, steps: basics.steps,
        ...(basics.label ? { label: basics.label } : {}),
        ...(typeof body.closeWhenDone === "boolean" ? { closeWhenDone: body.closeWhenDone } : {}),
        ...(typeof body.reportArtifacts === "boolean" ? { reportArtifacts: body.reportArtifacts } : {}),
        ...(typeof body.peerDir === "string" && body.peerDir.trim() ? { dir: body.peerDir.trim() } : {}),
      };
      // The asking session: the one named, else the newest live one in this cwd; none ⇒ the backlog gets the report.
      const sessionId = basics.sessionId ?? d.runningSessionFor(basics.cwd) ?? undefined;
      // Its label rides to the peer, so the job's session there can say whose work it is.
      const askerLabel = sessionId ? d.sessionLabel?.(sessionId)?.replace(/\s+/g, " ").trim().slice(0, 80) : undefined;
      if (askerLabel) req2.askerLabel = askerLabel;
      // Re-read after every await: submit is synchronous, and answers the same record to a racing twin.
      const r = d.jobs.submit({ peer, req: req2, cwd: basics.cwd, sessionId });
      if (!r.ok) { json(res, { ok: false, error: r.error }, r.status); return true; }
      json(res, answer(r.rec, r.existing));
      return true;
    }

    if (method === "GET" && !id) { json(res, { ok: true, jobs: d.jobs.list().filter((r) => r.peer === peer).map(peerJobView) }); return true; }

    if (id && (method === "GET" || method === "DELETE")) {
      const r = d.jobs.get(id);
      if (!r || r.peer !== peer) { json(res, { ok: false, error: "no such job" }, 404); return true; }
      if (method === "DELETE") d.jobs.cancel(id);
      json(res, { ok: true, ...peerJobView(d.jobs.get(id)!), ...(method === "DELETE" ? { calledOff: true } : {}) });
      return true;
    }
    json(res, { ok: false, error: `${method} is not a verb here — POST /api/agent/peer/${peer}/intents, GET …/intents[/<id>], DELETE …/intents/<id>` }, 405);
    return true;
  };
}

// ── the seam api.ts mounts, and the boot wiring main.ts calls ────────────────

let registered: ReturnType<typeof makePeerAgentHandler> | undefined;

/** Mounted in `api.ts`; a no-op until `startPeerJobs` has run (and under `--doctor`, forever). */
export async function handlePeerAgent(req: IncomingMessage, res: ServerResponse, path: string, url: URL, io: PeerAgentIo): Promise<boolean> {
  return registered ? registered(req, res, path, url, io) : false;
}

/** The bytes of a peer's artifact into the repo's outbox as `peer-<peer>-<stem>`; the repo-relative path. */
export function saveOutboxArtifact(cwd: string, peer: string, name: string, bytes: Buffer): string | null {
  const base = basename(String(name).replace(/\\/g, "/"));
  const ext0 = extname(base);
  const ext = /^\.[A-Za-z0-9]{1,8}$/.test(ext0) ? ext0.toLowerCase() : ".bin";
  const stem = (ext0 ? base.slice(0, -ext0.length) : base).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "file";
  try {
    const p = newOutboxPath(cwd, `peer-${peer}-${stem}`, ext);
    writeFileSync(p.full, bytes);
    return p.relPath;
  } catch { return null; }
}

/** Build the job machine from the host's parts, mount the route, resume open jobs. Called from `main.ts` after `intents.start()`. */
export function startPeerJobs(ctx: ServerCtx): PeerJobs | null {
  if (ctx.DOCTOR) return null; // a doctor run never polls a peer or posts a row
  const { envInt } = makeEnvReader(process.env, () => undefined);
  const jobs = new PeerJobs({
    file: join(hostStateDir(ctx.ROOT), "peer-jobs.json"),
    store: ctx.peers,
    client: new PeerClient(),
    now: Date.now,
    pollMs: Math.max(500, envInt("PEER_POLL_MS", 5000)),
    reportMax: Math.max(500, envInt("PEER_REPORT_MAX_CHARS", PEER_REPORT_MAX_CHARS)),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return { cancel: () => clearTimeout(t) }; },
    sessionAlive: (id) => !!ctx.sessions.get(id)?.running,
    setPeerWait: (id, w) => ctx.sessions.setPeerFacts(id, { peerWait: w }),
    setPeerJobs: (id, list) => ctx.sessions.setPeerFacts(id, { peerJobs: list }),
    intentState: (id) => ctx.intents.get(id)?.state,
    postReport: async (draft, peer) => {
      const r = await postClientDraft({ intents: ctx.intents, containRepoDir: (x) => ctx.containRepoDir(x) }, draft, { origin: ORIGIN_PEER_PREFIX + peer });
      return r.ok ? { ok: true, existing: r.existing } : { ok: false, reason: r.reason };
    },
    addBacklog: async (p) => {
      const r = await addClientBacklogItem({ containRepoDir: (x) => ctx.containRepoDir(x), backlog: ctx.backlog },
        { repoDir: p.cwd, text: p.text, label: p.label, id: p.id, origin: ORIGIN_PEER_PREFIX + p.peer, manual: true });
      return r.ok;
    },
    saveArtifact: saveOutboxArtifact,
    notify: (title, body, backlog) => ctx.notify("backlog", { title, body, ...(backlog ? { backlog } : {}) }),
    log: (m) => console.warn(m),
  });
  registered = makePeerAgentHandler({
    jobs,
    containRepoDir: (x) => ctx.containRepoDir(x),
    repoDir: async (id) => (await findTarget(ctx.ROOT, id))?.worktreePath ?? null,
    sessionCwd: (id) => { const s = ctx.sessions.get(id); return s && s.running ? s.cwd : null; },
    runningSessionFor: (dir) => ctx.sessions.runningSessionFor(dir),
    sessionLabel: (id) => { const s = ctx.sessions.get(id); return s ? sessionPickLabel(s) : null; },
  });
  // The phone's read of this ledger (`GET /api/peerjobs`, trusted path — `routes.ts`).
  setPeerJobsLedger(() => jobs.ledger());
  jobs.start();
  return jobs;
}
