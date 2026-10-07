/**
 * Peers, INBOUND: another paired desktop asks THIS one to run a job
 * (docs/analysis/peer-hosts-plan.md, WP3). Registered once from `main.ts` through
 * `setPeerServe`; `peers/routes.ts` has already checked the trusted path, the peer
 * token and the API version before anything here runs.
 *
 *   POST /api/peer/jobs                       PeerJobRequest  → PeerJobView
 *   GET  /api/peer/jobs/<id>                                  → PeerJobView
 *   GET  /api/peer/jobs/<id>/artifact?name=<outbox-relative>  → the file's bytes
 *
 * A job is NOT a new kind of thing: it is an ordinary intent row, posted through
 * `postClientDraft` (the one client path into the store) — so it is held by THIS
 * owner's auto-fire switch, budget and slot cap, shows in this phone's backlog,
 * is at-most-once by id (`peer-<from>-<key>`) and survives a usage limit like any
 * row. Nothing applies itself on a machine whose owner did not tap.
 *
 * Where it runs: the clone is found by REMOTE URL (`remoteKey`) over the discovered
 * repos — none or two is a sentence, never a clone, never a guess. The job gets a
 * DETACHED worktree at the asked commit under `<clone>/.claude/worktrees/` (inside
 * ROOT so `containRepoDir` accepts it; below discovery depth so it never lists as a
 * repo); the clone's own tree is never touched. The daemon's own checkout is refused
 * outright (a job must never be able to rebuild what runs it), and the worktree
 * carries `<state dir>/peer-job.json`, the marker `scripts/restart.sh` and the
 * installer refuse on.
 *
 * The report is read at GET time off the intent row and the session's transcript —
 * no listener, nothing to lose in a restart. Artifacts are only what the answer
 * names under `.claude/outbox/`, contained by `statInTree` AND a realpath check,
 * size-capped; the artifact route serves nothing else.
 */
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, join, sep } from "node:path";
import {
  BRAND,
  INTENT_MAX_STEPS,
  PEER_API_VERSION,
  PEER_ARTIFACTS_MAX,
  PEER_ARTIFACT_MAX_BYTES,
  PEER_KEY_RE,
  PEER_REPORT_MAX_CHARS,
  ORIGIN_PEER_PREFIX,
  peerJobId,
  remoteKey,
  type Intent,
  type PeerJobRequest,
  type PeerJobReport,
  type PeerJobState,
  type PeerJobView,
  type TranscriptDoc,
  type ContextSeriesDoc,
  type PeerJobCost,
  type PeerJobOrigin,
  type SessionBudgetCal,
  BUDGET_STALE_MS,
  cleanPeerJobCost,
  peerModelName,
} from "@waterplane/shared";
import { env } from "../env.js";
import { statInTree } from "../files.js";
import { gitFetchBranch, gitRemoteUrl, gitResolveCommit, gitWorktreeAddDetached, gitWorktreeRemove } from "../git.js";
import { realResolve } from "../paths.js";
import { discoverTargets } from "../repos.js";
import { lastBudgetCal } from "../sessionbudget.js";
type RepoTarget = Awaited<ReturnType<typeof discoverTargets>>[number];
import { postClientDraft, type ClientPostDeps } from "../agentintents.js";
import type { PeerPublic } from "./store.js";
import { hostVersion, type PeerServe } from "./routes.js";

export const PEER_JOB_MARKER = `${BRAND.stateDirName}/peer-job.json`;
/** Job worktrees older than this are removed: kept a week for inspection, then swept. */
export const PEER_WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const WORKTREES_SUBDIR = join(".claude", "worktrees");

export interface PeerServeDeps {
  ROOT: string;
  intents: Pick<import("../intents/manager.js").IntentManager, "post" | "get" | "list">;
  sessions: {
    getTranscript(id: string, since?: number, detail?: "lite" | "full"): TranscriptDoc | "unchanged" | null;
    diedAtLimit?(id: string): boolean;
    /** The job session's ledger (`ctxlog.ts` via `getContextSeries`) — what its cost is read off. */
    getContextSeries?(id: string, since?: number): ContextSeriesDoc | "unchanged" | null;
  };
  /** The weekly calibration in hand, for `weekPct`; default `sessionbudget.ts`'s `lastBudgetCal`. */
  budgetCal?: () => SessionBudgetCal | null;
  containRepoDir: ClientPostDeps["containRepoDir"];
  /** Overrides for tests. */
  discover?: () => Promise<RepoTarget[]>;
  /** The directory this daemon runs from; default `process.cwd()`. */
  selfDir?: string;
  now?: () => number;
  reportMax?: number;
}

const refusedView = (id: string, state: "refused" | "failed", detail: string): PeerJobView =>
  ({ id, state, peerApi: PEER_API_VERSION, version: hostVersion(), intentId: id, detail });

/** A path-safe directory name for a job id. */
export const jobDirName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;

/** What the body may say, or the sentence why not. */
export function parsePeerJob(body: unknown, peerName: string): { req: PeerJobRequest; steps: string[] } | { refused: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!PEER_KEY_RE.test(key)) return { refused: "`key` is required: 1-64 of A-Z a-z 0-9 . _ : -" };
  if (b.from !== peerName) return { refused: `\`from\` must be "${peerName}" — the name this host lists the caller by` };
  // A peer job runs an AGENT and reports its answer back as one prompt. A shell
  // session (`backends/shell.ts`) has no answer to report and is a desktop's own
  // terminal — never opened on another desktop's say-so (docs/analysis/shell-plan.md).
  const asked = (b.launch && typeof b.launch === "object" ? (b.launch as Record<string, unknown>).backend : undefined) ?? b.backend;
  if (asked === "shell") return { refused: "a peer job runs an agent; a shell session cannot be opened from another desktop" };
  if (typeof b.remote !== "string" || !remoteKey(b.remote)) return { refused: "`remote` is not a repository URL this host can match" };
  const branch = typeof b.branch === "string" ? b.branch.trim() : "";
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) return { refused: "`branch` is not a branch name" };
  const commit = typeof b.commit === "string" ? b.commit.trim() : "";
  if (!SHA_RE.test(commit)) return { refused: "`commit` must be a hex commit sha" };
  const steps = (Array.isArray(b.steps) ? b.steps : [b.prompt]).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (!steps.length) return { refused: "`prompt` (or `steps`) is required" };
  if (steps.length > INTENT_MAX_STEPS) return { refused: `at most ${INTENT_MAX_STEPS} steps` };
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 80) : undefined;
  return {
    steps,
    req: {
      key, from: peerName, remote: b.remote, branch, commit, steps, label,
      ...(typeof b.askerLabel === "string" && b.askerLabel.trim() ? { askerLabel: b.askerLabel.replace(/\s+/g, " ").trim().slice(0, 80) } : {}),
      ...(typeof b.closeWhenDone === "boolean" ? { closeWhenDone: b.closeWhenDone } : {}),
      ...(b.reportArtifacts === false ? { reportArtifacts: false } : {}),
      ...(typeof b.dir === "string" && b.dir.trim() ? { dir: b.dir.trim() } : {}),
    },
  };
}

/** Every `.claude/outbox/<file>` path an answer names, in order, de-duplicated; outbox-relative names. */
export function outboxNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_.-])\.claude\/outbox\/([^\s`'"()<>\[\]{},;|*]+)/g)) {
    const name = m[1].replace(/[.:!?]+$/, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The text blocks of the transcript's last turn that said anything. */
export function lastAnswerText(doc: TranscriptDoc | "unchanged" | null): string | null {
  if (!doc || doc === "unchanged") return null;
  for (let i = doc.turns.length - 1; i >= 0; i--) {
    const t = doc.turns[i].blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("\n\n").trim();
    if (t) return t;
  }
  return null;
}

/**
 * What a job's session spent, as the asker is told it — read off THIS host's ledger, the
 * `ContextSeriesDoc` `ctxlog.ts` builds for the session's own cost chip, so the two can never
 * disagree. Every field degrades to ABSENT on its own (`host-ledgers`' rule), never 0:
 *  - `usd` / `tokens` only where the subagent directory was READ (`usageTok` present) — a bill
 *    missing its agents is worse than none — and `usd` only where something was priced;
 *  - `model` is the log's own newest model, as an alias;
 *  - `durationMs` from the row starting to it settling (to `now` while it runs); absent before it starts;
 *  - `weekPct` only off a weekly calibration taken within `BUDGET_STALE_MS` (stale is unknown).
 */
export function peerJobCostOf(
  doc: ContextSeriesDoc | null | undefined,
  row: Pick<Intent, "state" | "startedAt" | "settledAt">,
  at: number,
  cal: SessionBudgetCal | null | undefined,
): PeerJobCost | undefined {
  const raw: Record<string, unknown> = {};
  if (doc && doc.usageTok != null && Number.isFinite(doc.usageTok)) {
    const usd = (doc.cost?.total ?? 0) + (doc.agentCost?.total ?? 0);
    if (usd > 0) raw.usd = usd;
    const s = doc.split, a = doc.agentSplit;
    if (s) {
      raw.tokens = {
        in: s.input + (a?.input ?? 0), out: s.output + (a?.output ?? 0),
        cacheRead: s.cacheRead + (a?.cacheRead ?? 0), cacheWrite: s.cacheWrite + (a?.cacheWrite ?? 0),
      };
    }
    if (doc.unpricedTok) raw.unpricedTok = doc.unpricedTok;
  }
  if (doc?.model) raw.model = peerModelName(doc.model) ?? undefined;
  if (row.startedAt && row.startedAt > 0) {
    const live = row.state === "starting" || row.state === "running";
    const end = row.settledAt && row.settledAt >= row.startedAt ? row.settledAt : live ? at : null;
    if (end != null) raw.durationMs = end - row.startedAt;
  }
  const per = cal && Number.isFinite(cal.checkedAt) && at - cal.checkedAt <= BUDGET_STALE_MS ? cal.weeklyUsdPerPct : null;
  if (typeof raw.usd === "number" && per && per > 0) raw.weekPct = raw.usd / per;
  return cleanPeerJobCost(raw);
}

/**
 * Why a session in `cwd` exists, when `cwd` is a delegated job's worktree: its marker names the
 * asking desktop, the job and both labels. Null for any other directory, or a marker we cannot read.
 */
export function peerJobOriginAt(cwd: string): PeerJobOrigin | null {
  try {
    const m = JSON.parse(readFileSync(join(cwd, PEER_JOB_MARKER), "utf8"));
    if (!m || typeof m.from !== "string" || !m.from || typeof m.id !== "string") return null;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
    const askerLabel = str(m.askerLabel), label = str(m.label);
    return { from: m.from, jobId: m.id, ...(askerLabel ? { askerLabel } : {}), ...(label ? { label } : {}) };
  } catch { return null; }
}

export function createPeerServe(d: PeerServeDeps): PeerServe & {
  /** Remove job worktrees older than `PEER_WORKTREE_MAX_AGE_MS`; returns what it removed. */
  sweep(now?: number): Promise<string[]>;
} {
  const now = (): number => (d.now ?? Date.now)();
  const reportMax = (): number => {
    if (d.reportMax) return d.reportMax;
    const n = Number(env("PEER_REPORT_MAX_CHARS"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : PEER_REPORT_MAX_CHARS;
  };
  const discover = d.discover ?? (() => discoverTargets(d.ROOT));
  const selfDir = (): string => realResolve(d.selfDir ?? process.cwd());
  const inflight = new Map<string, Promise<PeerJobView>>();
  const doneViews = new Map<string, PeerJobView>();
  let lastSweep = 0;

  const ownedBy = (i: Intent | undefined, peer: PeerPublic): i is Intent => !!i && i.origin === `${ORIGIN_PEER_PREFIX}${peer.name}`;

  /** The job's clone: exactly one primary checkout whose origin is the same repo, or why not. */
  async function findClone(remote: string, dir?: string): Promise<{ clone: string } | { refused: string }> {
    const want = remoteKey(remote);
    let targets: RepoTarget[] = [];
    try { targets = (await discover()).filter((t) => t.isPrimary); } catch { /* none */ }
    const hits: string[] = [];
    for (const t of targets) {
      const url = await gitRemoteUrl(t.worktreePath);
      if (url && remoteKey(url) === want) hits.push(t.worktreePath);
    }
    const shown = want ?? remote;
    if (dir) {
      const r = realResolve(dir);
      const pick = hits.find((h) => realResolve(h) === r);
      return pick ? { clone: pick } : { refused: `\`dir\` is not one of this host's clones of ${shown}${hits.length ? ` (${hits.join(", ")})` : ""}` };
    }
    if (!hits.length) return { refused: `no clone of ${shown} under this host's root — clone it here first` };
    if (hits.length > 1) return { refused: `ambiguous: ${hits.join(", ")} are all clones of ${shown} — name one with \`dir\`` };
    return { clone: hits[0] };
  }

  /** Keep `<clone>/.claude/worktrees/` out of the clone's `git status` without touching its tree. */
  function excludeWorktrees(clone: string): void {
    try {
      const gitDir = join(clone, ".git");
      if (!statSync(gitDir).isDirectory()) return;
      const f = join(gitDir, "info", "exclude");
      const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
      if (cur.split("\n").some((l) => l.trim() === "/.claude/worktrees/" || l.trim() === ".claude/worktrees/")) return;
      mkdirSync(join(gitDir, "info"), { recursive: true });
      appendFileSync(f, `${cur && !cur.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`);
    } catch { /* best effort — a noisier status is not a failed job */ }
  }

  const isOurs = (wt: string): boolean => existsSync(join(wt, PEER_JOB_MARKER));

  async function headOf(wt: string): Promise<string | null> {
    return gitResolveCommit(wt, "HEAD");
  }

  async function start(peer: PeerPublic, req: PeerJobRequest, steps: string[], id: string): Promise<PeerJobView> {
    const found = await findClone(req.remote, req.dir);
    if ("refused" in found) return refusedView(id, "refused", found.refused);
    const clone = found.clone;
    const cloneReal = realResolve(clone);
    const me = selfDir();
    if (me === cloneReal || me.startsWith(cloneReal + sep)) {
      return refusedView(id, "refused", `that is the live ${BRAND.name} checkout on this peer; the job must run in another clone`);
    }

    const fetched = await gitFetchBranch(clone, req.branch);
    if (!fetched.ok) return refusedView(id, "failed", `could not fetch ${req.branch}: ${fetched.error}`);
    const sha = await gitResolveCommit(clone, req.commit);
    if (!sha) return refusedView(id, "failed", `commit ${req.commit} is not in ${req.branch} on origin — push it first`);

    const wt = join(clone, WORKTREES_SUBDIR, jobDirName(id));
    if (existsSync(wt)) {
      if (isOurs(wt) && (await headOf(wt)) === sha) {
        /* a stale worktree of ours at the same commit: reused as it is */
      } else if (isOurs(wt)) {
        const gone = await gitWorktreeRemove(clone, wt);
        if (!gone.ok || existsSync(wt)) return refusedView(id, "failed", `could not replace the old job worktree: ${gone.ok ? "still there" : gone.error}`);
      } else {
        return refusedView(id, "failed", `${wt} exists and is not a delegated job's worktree — left alone`);
      }
    }
    if (!existsSync(wt)) {
      mkdirSync(join(clone, WORKTREES_SUBDIR), { recursive: true });
      excludeWorktrees(clone);
      const added = await gitWorktreeAddDetached(clone, wt, sha);
      if (!added.ok) return refusedView(id, "failed", `could not make the job worktree: ${added.error}`);
    }
    try {
      mkdirSync(join(wt, BRAND.stateDirName), { recursive: true });
      writeFileSync(join(wt, PEER_JOB_MARKER), JSON.stringify({
        id, from: peer.name, key: req.key, ...(req.reportArtifacts === false ? { reportArtifacts: false } : {}),
        // Why the session here exists, for its row (`peerJobOriginAt`).
        ...(req.askerLabel ? { askerLabel: req.askerLabel } : {}), ...(req.label ? { label: req.label } : {}),
      }));
    } catch (e: any) {
      return refusedView(id, "failed", `could not mark the job worktree: ${e?.message ?? e}`);
    }

    const posted = await postClientDraft(
      { intents: d.intents, containRepoDir: d.containRepoDir },
      {
        id,
        cwd: wt,
        payload: { kind: "prompt", steps },
        target: { kind: "repo" },
        trigger: { kind: "now" },
        auto: true,
        serial: true,
        ...(req.closeWhenDone !== undefined ? { closeWhenDone: req.closeWhenDone } : {}),
        label: req.label ?? `job from ${peer.name}`,
      },
      { origin: `${ORIGIN_PEER_PREFIX}${peer.name}` },
    );
    if (!posted.ok) return refusedView(id, "refused", posted.refusedCwd ? "the job worktree is outside this host's root" : posted.reason);
    return viewOf(posted.intent);
  }

  function costOfRow(i: Intent): PeerJobCost | undefined {
    let doc: ContextSeriesDoc | "unchanged" | null = null;
    try { doc = i.sessionId && d.sessions.getContextSeries ? d.sessions.getContextSeries(i.sessionId, 0) : null; } catch { doc = null; }
    let cal: SessionBudgetCal | null = null;
    try { cal = (d.budgetCal ?? lastBudgetCal)(); } catch { cal = null; }
    return peerJobCostOf(doc === "unchanged" ? null : doc, i, now(), cal);
  }

  /** The row (and, once it ended, the session's answer) as the asker sees it. */
  function viewOf(i: Intent): PeerJobView {
    const cached = doneViews.get(i.id);
    if (cached) return cached;
    const sid = i.sessionId;
    let state: PeerJobState;
    let waiting: string | undefined;
    switch (i.state) {
      case "queued": state = "queued"; waiting = i.blockDetail; break;
      case "blocked": state = "waiting"; waiting = i.blockDetail; break;
      case "starting": state = "running"; break;
      case "running":
        if (i.followed && sid && d.sessions.diedAtLimit?.(sid)) { state = "limit"; waiting = i.blockDetail ?? "the session hit the usage limit; it resumes at the reset"; }
        else state = "running";
        break;
      case "done": state = "done"; break;
      default: state = "failed";
    }
    const view: PeerJobView = {
      id: i.id, state, peerApi: PEER_API_VERSION, version: hostVersion(), intentId: i.id,
      ...(sid ? { sessionId: sid } : {}),
      worktree: i.cwd,
      ...(waiting ? { waiting } : {}),
    };
    // What the job's session has spent, off this host's own ledger — absent field by field.
    const cost = costOfRow(i);
    if (cost) view.cost = cost;
    if (state === "failed") view.detail = i.state === "canceled" ? "the job was canceled on this peer" : i.result?.detail || "the job failed";
    if (state === "done" || state === "failed") {
      view.report = reportOf(i, state === "done");
      if (state === "done" || i.state === "canceled" || i.result) {
        doneViews.set(i.id, view);
        if (doneViews.size > 64) doneViews.delete(doneViews.keys().next().value as string);
      }
    }
    return view;
  }

  function reportOf(i: Intent, ok: boolean): PeerJobReport {
    const full = (i.sessionId ? lastAnswerText(d.sessions.getTranscript(i.sessionId, 0, "full")) : null) ?? "";
    const max = reportMax();
    const truncated = full.length > max;
    let wantArtifacts = true;
    try { wantArtifacts = JSON.parse(readFileSync(join(i.cwd, PEER_JOB_MARKER), "utf8"))?.reportArtifacts !== false; } catch { /* no marker: default */ }
    const artifacts: PeerJobReport["artifacts"] = [];
    if (wantArtifacts) {
      for (const name of outboxNamesIn(full)) {
        if (artifacts.length >= PEER_ARTIFACTS_MAX) break;
        const a = artifactFile(i.cwd, name);
        if (a && a.size <= PEER_ARTIFACT_MAX_BYTES) artifacts.push({ name, size: a.size });
      }
    }
    return { ok, text: truncated ? full.slice(0, max) : full, truncated, artifacts };
  }

  /** One outbox file of a job worktree, contained lexically (`statInTree`) AND by realpath; else null. */
  function artifactFile(wt: string, name: string): { full: string; size: number } | null {
    if (!name || name.includes("\0")) return null;
    const rel = `.claude/outbox/${name}`;
    const st = statInTree(wt, rel, { anyType: true });
    if (!st) return null;
    try {
      const outbox = realpathSync(join(wt, ".claude", "outbox"));
      if (lstatSync(st.full).isSymbolicLink() && !realpathSync(st.full).startsWith(outbox + sep)) return null;
      if (!realpathSync(st.full).startsWith(outbox + sep)) return null;
    } catch { return null; }
    return { full: st.full, size: st.size };
  }

  async function sweep(at: number = now()): Promise<string[]> {
    lastSweep = at;
    const removed: string[] = [];
    let targets: RepoTarget[] = [];
    try { targets = (await discover()).filter((t) => t.isPrimary); } catch { return removed; }
    for (const t of targets) {
      const base = join(t.worktreePath, WORKTREES_SUBDIR);
      let names: string[] = [];
      try { names = readdirSync(base); } catch { continue; }
      for (const n of names) {
        const wt = join(base, n);
        const marker = join(wt, PEER_JOB_MARKER);
        try {
          const age = at - statSync(marker).mtimeMs;
          if (age < PEER_WORKTREE_MAX_AGE_MS) continue;
          const job = JSON.parse(readFileSync(marker, "utf8"));
          const row = typeof job?.id === "string" ? d.intents.get(job.id) : undefined;
          if (row && row.state !== "done" && row.state !== "failed" && row.state !== "canceled") continue; // still has work
          if ((await gitWorktreeRemove(t.worktreePath, wt)).ok) removed.push(wt);
        } catch { /* not a job worktree, or unreadable: leave it */ }
      }
    }
    return removed;
  }

  const handler: PeerServe = async (req, res, path, url, peer) => {
    if (path !== "/api/peer/jobs" && !path.startsWith("/api/peer/jobs/")) return false;
    const method = req.method ?? "GET";
    const send = (data: unknown, status = 200): true => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
      return true;
    };
    if (now() - lastSweep > SWEEP_EVERY_MS) void sweep().catch(() => undefined);

    if (path === "/api/peer/jobs") {
      if (method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return true; }
      const body = await readBody(req);
      if (body === undefined) return send({ ok: false, error: "the body must be JSON (max 256 KB)" }, 400);
      const parsed = parsePeerJob(body, peer.name);
      if ("refused" in parsed) return send({ ok: false, error: parsed.refused }, 400);
      const id = peerJobId(peer.name, parsed.req.key);
      // At-most-once by id, forever: the store's own row answers a repeat, before any git runs.
      const prior = d.intents.get(id);
      if (prior) return ownedBy(prior, peer) ? send({ ...viewOf(prior), existing: true }) : send({ ok: false, error: "that id belongs to something else on this host" }, 409);
      let run = inflight.get(id);
      const joined = !!run;
      if (!run) {
        run = start(peer, parsed.req, parsed.steps, id).finally(() => inflight.delete(id));
        inflight.set(id, run);
      }
      const view = await run;
      return send(joined ? { ...view, existing: true } : view);
    }

    const rest = path.slice("/api/peer/jobs/".length);
    const [rawId, ...tail] = rest.split("/");
    let id: string;
    try { id = decodeURIComponent(rawId); } catch { id = ""; }
    const row = d.intents.get(id);
    if (!ownedBy(row, peer)) return send({ ok: false, error: "no such job" }, 404);
    if (method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return true; }

    if (tail.length === 0) return send(viewOf(row));

    if (tail.length === 1 && tail[0] === "artifact") {
      const name = url.searchParams.get("name") ?? "";
      const a = artifactFile(row.cwd, name);
      if (!a) return send({ ok: false, error: "no such file in the job's outbox" }, 404);
      if (a.size > PEER_ARTIFACT_MAX_BYTES) return send({ ok: false, error: `larger than ${PEER_ARTIFACT_MAX_BYTES} bytes` }, 413);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(a.size),
        "content-disposition": `attachment; filename="${basename(a.full).replace(/[^\w.-]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      createReadStream(a.full).on("error", () => res.destroy()).pipe(res);
      return true;
    }
    return false;
  };
  return Object.assign(handler, { sweep });
}

/** The request's JSON body, or undefined when it is not JSON or is past 256 KB. */
async function readBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 256 * 1024) return undefined;
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return undefined; }
}
