/**
 * The asking side of a peer job (docs/analysis/peer-hosts-plan.md, "Lifecycle — Mac (outbound)"):
 * the ledger, the poll and the state machine, pure over injected deps (fetch via `PeerClient`,
 * clock, timers, the intent store) so it is testable without a daemon.
 *
 *   queued ──hello+POST──▶ <the peer's state: waiting | running | limit> ──▶ done | failed | refused
 *      └───────────── unreachable (an overlay, never a verdict) ◀───────────┘
 *
 *  - **The ledger** is `<state dir>/peer-jobs.json`, written BEFORE the first forward, so a crash
 *    between POST and write re-forwards under the same key and the peer answers `existing`. A
 *    restart re-reads it and resumes polling; `peerWait` is re-set on a surviving session.
 *  - **Poll only while a job is open** (`WATERPLANE_PEER_POLL_MS`): zero traffic with none. An
 *    unreachable peer backs off to 60 s and is NEVER failed by this module — only `cancel` (a
 *    person's DELETE) ends it without the peer's say.
 *  - **On a terminal state** the named artifacts are fetched into the asking repo's outbox
 *    (`.claude/outbox/peer-<peer>-…`, caps from `peer.ts`) and ONE report row is posted through the
 *    intent store — a `pinned` session-target row with `peerReportId`, fired by the ladder through
 *    `deliverInput`/`deliverChain`. This module never types into a session and never forks
 *    `deliver.ts`. At-most-once is the row id. A session that is gone ⇒ a manual backlog row plus a
 *    notification; nothing is guessed onto another session.
 *  - `peerWait` on the asking session is set on submit, kept in step with the state, and cleared
 *    when the report row settles.
 * Nothing here applies itself: the report is words for the asking session to act on.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  PEER_API_VERSION,
  PEER_ARTIFACT_MAX_BYTES,
  PEER_ARTIFACTS_MAX,
  cleanPeerJobCost,
  peerJobId,
  peerJobTerminal,
  peerReportId,
  peerReportPrompt,
  peerVersionMismatchText,
  type IntentDraft,
  type PeerJobLedgerRow,
  type PeerJobRecord,
  type PeerJobSummary,
  type PeerJobRequest,
  type PeerJobView,
  type SessionInfo,
} from "@waterplane/shared";
import type { PeerClient, PeerReply, PeerTarget } from "./client.js";
import type { PeerStore } from "./store.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import type { NotifyParams } from "../notifytypes.js";

/** What the ledger keeps beyond `PeerJobRecord` — additive, so a ledger from a build without it still reads. */
export interface PeerJobRec extends PeerJobRecord {
  /** The forward, minus `from` (the peer names us; filled from `hello` at send). */
  req: Omit<PeerJobRequest, "from">;
  /** The peer has the job (a POST was answered). */
  sent?: boolean;
  /** Artifacts landed in the asking repo. */
  fetched?: { name: string; relPath: string }[];
  notFetched?: { name: string; why: string }[];
  /** Index of the next artifact to fetch (so a restart resumes mid-list). */
  artIdx?: number;
  artTries?: number;
  /** The report row was posted (or the backlog fallback written). */
  reported?: boolean;
  fellBack?: boolean;
  /** Nothing more to do: the report settled, or the job was called off. */
  closed?: boolean;
}

export type PeerWait = NonNullable<SessionInfo["peerWait"]>;

export interface PeerJobsDeps {
  /** `<state dir>/peer-jobs.json`. */
  file: string;
  store: Pick<PeerStore, "outbound">;
  client: Pick<PeerClient, "hello" | "postJob" | "getJob" | "getArtifact">;
  now(): number;
  /** Poll period while running; 60 s is the unreachable ceiling. */
  pollMs: number;
  reportMax: number;
  /** Arm the next tick; the default is an unref'd `setTimeout`. */
  schedule(fn: () => void, ms: number): { cancel(): void };
  sessionAlive(id: string): boolean;
  setPeerWait(sessionId: string, w: PeerWait | null): void;
  /** Every job the session delegated, open or settled (`SessionInfo.peerJobs`); [] clears. Optional: absent = not published. */
  setPeerJobs?(sessionId: string, jobs: PeerJobSummary[]): void;
  /** The intent store's state for an id, or undefined when it holds none. */
  intentState(id: string): string | undefined;
  /** `postClientDraft` with `origin: "peer:<peer>"`. */
  postReport(draft: IntentDraft, peer: string): Promise<{ ok: true; existing: boolean } | { ok: false; reason: string }>;
  /** `addClientBacklogItem(…, {manual: true})`. */
  addBacklog(p: { cwd: string; text: string; label: string; id: string; peer: string }): Promise<boolean>;
  /** Write bytes into the repo's outbox as `peer-<peer>-<stem>`; the repo-relative path, or null. */
  saveArtifact(cwd: string, peer: string, name: string, bytes: Buffer): string | null;
  notify(n: Pick<NotifyParams, "title" | "body" | "backlog" | "outcome">): void;
  log?(msg: string): void;
}

export const UNREACHABLE_CEILING_MS = 60_000;
/** Newest jobs one session lists; older ones stay in the ledger and the Activity sheet. */
export const SESSION_JOBS_MAX = 12;
const LIMIT_POLL_MS = 30_000;
const ART_TRIES_MAX = 5;
const KEEP_CLOSED_MS = 30 * 24 * 3600_000;

const isTerminalIntent = (s: string | undefined): boolean => s === "done" || s === "failed" || s === "canceled";

export class PeerJobs {
  private recs = new Map<string, PeerJobRec>();
  private nextAt = new Map<string, number>();
  private fails = new Map<string, number>();
  private busy = new Set<string>();
  private timer: { cancel(): void } | null = null;
  private started = false;

  constructor(private readonly d: PeerJobsDeps) { this.load(); }

  // ── ledger ────────────────────────────────────────────────────────────
  private load(): void {
    try {
      const j = readJsonGuarded<any>(this.d.file, null);
      const now = this.d.now();
      for (const r of Array.isArray(j?.jobs) ? j.jobs : []) {
        if (!r || typeof r.id !== "string" || typeof r.peer !== "string" || typeof r.cwd !== "string" || !r.req) continue;
        if (r.closed && now - (r.updatedAt || 0) > KEEP_CLOSED_MS) continue;
        this.recs.set(r.id, r as PeerJobRec);
      }
    } catch { /* no ledger yet, or one we cannot read: start empty, never invent a job */ }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.d.file), { recursive: true });
      writeJsonAtomic(this.d.file, { jobs: [...this.recs.values()] });
    } catch (e) { this.d.log?.(`[peer] could not write the job ledger: ${(e as Error).message}`); }
  }

  // ── public ────────────────────────────────────────────────────────────
  get(id: string): PeerJobRec | undefined { return this.recs.get(id); }
  list(): PeerJobRec[] { return [...this.recs.values()]; }
  isOpen(r: PeerJobRec): boolean { return !r.closed; }

  /** One job as a session lists it. */
  summary(r: PeerJobRec): PeerJobSummary {
    const t = this.d.store.outbound(r.peer);
    return {
      peer: r.peer, jobId: r.id, state: r.state, since: r.createdAt,
      ...(r.label ? { label: r.label } : {}),
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.view?.sessionId ? { peerSessionId: r.view.sessionId } : {}),
      ...(t ? { peerBase: `http://${t.addr}` } : {}),
      ...(r.cost ? { cost: r.cost } : {}),
    };
  }

  /** The ledger as the phone reads it (`GET /api/peerjobs`), newest first. No token, no report text. */
  ledger(): PeerJobLedgerRow[] {
    return this.list().sort((a, b) => b.createdAt - a.createdAt).map((r) => ({
      ...this.summary(r), cwd: r.cwd,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.askerLabel ? { askerLabel: r.askerLabel } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.closed ? { closed: true } : {}),
      ...(r.reported ? { reported: true } : {}),
    }));
  }

  /** Resume after a restart: re-set `peerWait` on surviving sessions, poll again. Zero traffic with no open job. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const r of this.recs.values()) {
      if (r.closed) continue;
      this.nextAt.set(r.id, 0);
      this.syncWait(r);
    }
    // A surviving session (tmux) lists its settled jobs too, not only the open one.
    for (const sid of new Set([...this.recs.values()].filter((r) => r.closed).map((r) => r.sessionId))) this.syncJobs(sid);
    this.arm();
  }

  stop(): void { this.timer?.cancel(); this.timer = null; this.started = false; }

  /**
   * Take a job. An id this ledger already holds answers THAT record (`existing`) and forwards
   * nothing; the ledger is written before the first forward.
   */
  submit(p: { peer: string; req: Omit<PeerJobRequest, "from">; cwd: string; sessionId?: string }):
    { ok: true; rec: PeerJobRec; existing: boolean } | { ok: false; error: string; status: number } {
    const id = peerJobId(p.peer, p.req.key);
    const prior = this.recs.get(id);
    if (prior) return { ok: true, rec: prior, existing: true };
    if (!this.d.store.outbound(p.peer)) return { ok: false, status: 404, error: `no outbound pairing with "${p.peer}" — pair it from the phone first` };
    const now = this.d.now();
    const rec: PeerJobRec = {
      id, peer: p.peer, key: p.req.key, state: "queued", cwd: p.cwd, sessionId: p.sessionId,
      branch: p.req.branch, commit: p.req.commit, createdAt: now, updatedAt: now, req: p.req,
      ...(p.req.label ? { label: p.req.label } : {}), ...(p.req.askerLabel ? { askerLabel: p.req.askerLabel } : {}),
    };
    this.recs.set(id, rec);
    this.persist();
    this.syncWait(rec);
    this.nextAt.set(id, 0);
    if (this.started) setImmediate(() => { void this.tick(); });
    return { ok: true, rec, existing: false };
  }

  /** A person's DELETE: ends the job on this side without a report. The peer's own row is left to run. */
  cancel(id: string): PeerJobRec | undefined {
    const r = this.recs.get(id);
    if (!r) return undefined;
    if (r.closed) return r;
    if (!peerJobTerminal(r.state)) {
      r.state = "failed";
      r.detail = `called off by the asking agent — ${r.peer} may still run the job; its session is there to stop`;
      if (!r.endedAt) r.endedAt = this.d.now();
    }
    this.close(r);
    return r;
  }

  /** Advance every due job once. Public so tests (and the timer) drive it. */
  async tick(): Promise<void> {
    const now = this.d.now();
    const due = [...this.recs.values()].filter((r) => !r.closed && !this.busy.has(r.id) && (this.nextAt.get(r.id) ?? 0) <= now);
    await Promise.all(due.map(async (r) => {
      this.busy.add(r.id);
      try { await this.advance(r); } catch (e) { this.d.log?.(`[peer] ${r.id}: ${(e as Error).message}`); this.later(r, this.d.pollMs); }
      finally { this.busy.delete(r.id); }
    }));
    this.arm();
  }

  // ── timing ────────────────────────────────────────────────────────────
  private later(r: PeerJobRec, ms: number): void { this.nextAt.set(r.id, this.d.now() + ms); }

  private arm(): void {
    this.timer?.cancel();
    this.timer = null;
    if (!this.started) return;
    let soon = Infinity;
    for (const r of this.recs.values()) if (!r.closed) soon = Math.min(soon, this.nextAt.get(r.id) ?? 0);
    if (soon === Infinity) return; // no open job, no traffic
    this.timer = this.d.schedule(() => { void this.tick(); }, Math.max(0, soon - this.d.now()));
  }

  private pollEvery(r: PeerJobRec): number { return r.state === "limit" ? Math.max(this.d.pollMs, LIMIT_POLL_MS) : this.d.pollMs; }

  // ── peerWait on the asking session ────────────────────────────────────
  /** `SessionInfo.peerJobs` for the asking session: every job it sent, open or closed, oldest first. */
  private syncJobs(sessionId: string | undefined): void {
    if (!sessionId || !this.d.setPeerJobs || !this.d.sessionAlive(sessionId)) return;
    const mine = this.list().filter((x) => x.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt).slice(-SESSION_JOBS_MAX);
    this.d.setPeerJobs(sessionId, mine.map((x) => this.summary(x)));
  }

  private syncWait(r: PeerJobRec): void {
    this.syncJobs(r.sessionId);
    if (!r.sessionId || r.closed) return;
    if (!this.d.sessionAlive(r.sessionId)) return;
    const t = this.d.store.outbound(r.peer);
    this.d.setPeerWait(r.sessionId, {
      peer: r.peer, jobId: r.id, state: r.state,
      since: r.state === "unreachable" && r.unreachableSince ? r.unreachableSince : r.createdAt,
      ...(r.view?.sessionId ? { peerSessionId: r.view.sessionId } : {}),
      ...(t ? { peerBase: `http://${t.addr}` } : {}),
    });
  }

  private close(r: PeerJobRec): void {
    r.closed = true;
    r.updatedAt = this.d.now();
    this.nextAt.delete(r.id);
    if (r.sessionId) this.d.setPeerWait(r.sessionId, null);
    this.syncJobs(r.sessionId);
    this.persist();
    this.arm();
  }

  // ── one step of one job ───────────────────────────────────────────────
  private async advance(r: PeerJobRec): Promise<void> {
    if (peerJobTerminal(r.state)) return this.finish(r);
    const t = this.d.store.outbound(r.peer);
    if (!t) return this.settleLocally(r, "refused", `${r.peer} is no longer paired for outbound calls — the job was not sent or its answer cannot be read`);
    if (!r.sent) return this.send(r, t);
    return this.poll(r, t);
  }

  private async send(r: PeerJobRec, t: PeerTarget): Promise<void> {
    const hello = await this.d.client.hello(t);
    if (hello.kind !== "ok") return this.onBad(r, hello, true);
    if (hello.body.peerApi !== PEER_API_VERSION) {
      return this.settleLocally(r, "refused", peerVersionMismatchText(t.name, PEER_API_VERSION, hello.body.peerApi) || `${t.name} runs another peer API`);
    }
    // The peer lists this host under a name of its own; `hello.you` is that name.
    const from = hello.body.you || t.name;
    const posted = await this.d.client.postJob(t, { ...r.req, from });
    if (posted.kind !== "ok") return this.onBad(r, posted, true);
    r.sent = true;
    r.remoteId = posted.body.id || undefined;
    this.applyView(r, posted.body);
    if (peerJobTerminal(r.state)) return this.finish(r);
    this.later(r, this.pollEvery(r));
  }

  private async poll(r: PeerJobRec, t: PeerTarget): Promise<void> {
    const got = await this.d.client.getJob(t, r.remoteId ?? r.id);
    if (got.kind !== "ok") return this.onBad(r, got, false);
    this.applyView(r, got.body);
    if (peerJobTerminal(r.state)) return this.finish(r);
    this.later(r, this.pollEvery(r));
  }

  /** What a non-ok reply means. Unreachable is never a verdict; a refusal is. */
  private onBad(r: PeerJobRec, reply: Exclude<PeerReply<unknown>, { kind: "ok" }>, preSend: boolean): void {
    if (reply.kind === "mismatch" || reply.kind === "denied") return this.settleLocally(r, "refused", reply.text);
    if (reply.kind === "rejected" && (preSend || reply.status === 404)) {
      return this.settleLocally(r, preSend ? "refused" : "failed", preSend ? reply.text : `${r.peer} no longer knows this job (${reply.text})`);
    }
    const why = reply.kind === "unreachable" ? reply.error : reply.kind === "rejected" ? reply.text : "";
    if (r.state !== "unreachable") {
      r.state = "unreachable";
      r.unreachableSince = this.d.now();
    }
    r.detail = why;
    r.updatedAt = this.d.now();
    const n = (this.fails.get(r.id) ?? 0) + 1;
    this.fails.set(r.id, n);
    this.later(r, Math.min(UNREACHABLE_CEILING_MS, this.d.pollMs * 2 ** Math.min(n, 10)));
    this.persist();
    this.syncWait(r);
  }

  private applyView(r: PeerJobRec, v: PeerJobView): void {
    r.view = v;
    r.state = v.state;
    // The peer's cost reading, cleaned field by field; a later view without one keeps the last
    // (a floor that was true), never a zero.
    const cost = cleanPeerJobCost(v.cost);
    if (cost) r.cost = cost;
    if (peerJobTerminal(v.state) && !r.endedAt) r.endedAt = this.d.now();
    r.unreachableSince = undefined;
    r.detail = v.detail;
    r.updatedAt = this.d.now();
    this.fails.delete(r.id);
    this.persist();
    this.syncWait(r);
  }

  /** A verdict reached without the peer's say (or with a sentence of ours): terminal, reported like any other. */
  private settleLocally(r: PeerJobRec, state: "refused" | "failed", detail: string): void {
    r.state = state;
    r.detail = detail;
    r.unreachableSince = undefined;
    if (!r.endedAt) r.endedAt = this.d.now();
    r.view = { id: r.id, state, peerApi: PEER_API_VERSION, version: "", intentId: "", detail, ...(r.view?.sessionId ? { sessionId: r.view.sessionId } : {}) };
    r.updatedAt = this.d.now();
    this.persist();
    this.syncWait(r);
    this.nextAt.set(r.id, 0);
    void this.finish(r).then(() => this.arm());
  }

  // ── terminal: artifacts, then ONE report ──────────────────────────────
  private async finish(r: PeerJobRec): Promise<void> {
    if (r.closed) return;
    if (!r.reported) {
      if (!(await this.fetchArtifacts(r))) return;
      await this.report(r);
      if (!r.reported) return;
    }
    // The report row settles through the ladder; until then the session keeps its tag.
    const s = r.fellBack ? "done" : this.d.intentState(peerReportId(r.peer, r.key));
    if (s === undefined || isTerminalIntent(s)) {
      if (s === "failed" || s === "canceled") await this.fallBack(r, "the report could not be delivered");
      return this.close(r);
    }
    this.later(r, this.d.pollMs);
  }

  /** false = try again later (an unreachable peer mid-list). */
  private async fetchArtifacts(r: PeerJobRec): Promise<boolean> {
    const list = r.req.reportArtifacts === false ? [] : (r.view?.report?.artifacts ?? []).slice(0, PEER_ARTIFACTS_MAX);
    const over = (r.view?.report?.artifacts.length ?? 0) - list.length;
    r.fetched ??= [];
    r.notFetched ??= [];
    const t = this.d.store.outbound(r.peer);
    for (let i = r.artIdx ?? 0; i < list.length; i++) {
      const a = list[i]!;
      if (!Number.isFinite(a.size) || a.size > PEER_ARTIFACT_MAX_BYTES) {
        r.notFetched.push({ name: a.name, why: `over the ${PEER_ARTIFACT_MAX_BYTES >> 20} MB cap` });
      } else if (!t) {
        r.notFetched.push({ name: a.name, why: "peer no longer paired" });
      } else {
        const got = await this.d.client.getArtifact(t, r.remoteId ?? r.id, a.name);
        if (got.kind === "unreachable" || (got.kind === "rejected" && got.status !== 404 && (r.artTries ?? 0) < ART_TRIES_MAX)) {
          r.artTries = (r.artTries ?? 0) + 1;
          if (r.artTries < ART_TRIES_MAX) {
            r.artIdx = i;
            this.persist();
            this.later(r, Math.min(UNREACHABLE_CEILING_MS, this.d.pollMs * 2 ** r.artTries));
            return false;
          }
          r.notFetched.push({ name: a.name, why: "the peer could not be reached" });
        } else if (got.kind !== "ok") {
          r.notFetched.push({ name: a.name, why: got.kind === "rejected" ? got.text : got.kind === "mismatch" || got.kind === "denied" ? got.text : "refused" });
        } else if (got.body.byteLength > PEER_ARTIFACT_MAX_BYTES) {
          r.notFetched.push({ name: a.name, why: `over the ${PEER_ARTIFACT_MAX_BYTES >> 20} MB cap` });
        } else {
          const rel = this.d.saveArtifact(r.cwd, r.peer, a.name, Buffer.from(got.body));
          if (rel) r.fetched.push({ name: a.name, relPath: rel }); else r.notFetched.push({ name: a.name, why: "could not be written into this repo's outbox" });
        }
        r.artTries = 0;
      }
      r.artIdx = i + 1;
    }
    if (over > 0) r.notFetched.push({ name: `${over} more`, why: `only the first ${PEER_ARTIFACTS_MAX} are fetched` });
    r.artIdx = list.length;
    this.persist();
    return true;
  }

  private promptOf(r: PeerJobRec): string {
    const view = r.view ?? { id: r.id, state: r.state as PeerJobView["state"], peerApi: PEER_API_VERSION, version: "", intentId: "", detail: r.detail };
    // The cost the head carries is the CLEANED one (`r.cost`), never the peer's raw field.
    const { cost: _raw, ...bare } = view;
    const lines = [peerReportPrompt(r.peer, r.cost ? { ...bare, cost: r.cost } : bare, this.d.reportMax)];
    // The full transport path, every time: that is what the reader turns into the file itself.
    if (r.fetched?.length) lines.push("", "Fetched into this repo:", ...r.fetched.map((f) => `- ${f.relPath}`));
    if (r.notFetched?.length) lines.push("", ...r.notFetched.map((f) => `not fetched: ${f.name}: ${f.why}`));
    return lines.join("\n");
  }

  private async report(r: PeerJobRec): Promise<void> {
    if (!r.sessionId || !this.d.sessionAlive(r.sessionId)) return this.fallBack(r, "the asking session has closed");
    const id = peerReportId(r.peer, r.key);
    const posted = await this.d.postReport({
      id, cwd: r.cwd, target: { kind: "session", sessionId: r.sessionId }, pinned: true, trigger: { kind: "now" }, auto: true,
      payload: { kind: "prompt", steps: [this.promptOf(r)] }, label: `report from ${r.peer}`,
    }, r.peer);
    if (!posted.ok) return this.fallBack(r, `the report row was refused: ${posted.reason}`);
    r.reported = true;
    r.updatedAt = this.d.now();
    this.persist();
  }

  /** A manual backlog row and a notification: a sentence and a row, never a guess at another session. */
  private async fallBack(r: PeerJobRec, why: string): Promise<void> {
    if (r.fellBack) { r.reported = true; return; }
    const ok = await this.d.addBacklog({ cwd: r.cwd, text: this.promptOf(r), label: `report from ${r.peer} (${why})`, id: `${peerReportId(r.peer, r.key)}-backlog`, peer: r.peer });
    r.fellBack = ok;
    r.reported = true;
    r.updatedAt = this.d.now();
    this.persist();
    this.d.notify({
      title: `Report from ${r.peer}`,
      body: `${r.peer}'s job ${r.state === "done" ? "finished" : r.state}; ${why} — the report is in this repo's backlog.`,
      ...(ok ? { backlog: { cwd: r.cwd, ids: [`${peerReportId(r.peer, r.key)}-backlog`] } } : {}),
      outcome: r.state === "done" ? "ok" : "failed",
    });
  }
}
