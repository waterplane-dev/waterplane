/**
 * Peer desktops — one waterplane host delegating a job to another and getting
 * the answer back (plan: docs/analysis/peer-hosts-plan.md).
 *
 * Everything both ends must word and judge the same way lives here, pure: the
 * wire DTOs of `/api/peer/*` and the loopback `/api/agent/peer/<peer>/intents`
 * twin, the `peers.json` row, the repo-identity key two clones are matched by,
 * the address rule, the report prompt, the tag's words and the version-mismatch
 * sentence. Nothing here opens a socket or reads a file.
 *
 * Every reader degrades to null / "" — a remote URL that cannot be read is no
 * key, an address that cannot be vouched for is refused with a reason, a wait
 * we cannot describe says nothing. Never a wrong value.
 *
 * `PEER_API_VERSION` follows `PROTOCOL_VERSION`'s rule: an additive field never
 * bumps it, a changed meaning does.
 */
import { BRAND } from "./brand.js";
import { fmtUsd, normalizeModel } from "./pricing.js";
import type { SessionInfo } from "./wire/session.js";

export const PEER_API_VERSION = 1;
/** The header every peer call carries its API version in. */
/** Lower-case: Node hands header names over lower-cased, and HTTP compares them case-blind. */
export const PEER_API_HEADER = `x-${BRAND.slug}-peer-api`;

/** Report text cap (the host reads `WATERPLANE_PEER_REPORT_MAX_CHARS` over it). */
export const PEER_REPORT_MAX_CHARS = 16_000;
export const PEER_ARTIFACT_MAX_BYTES = 8 << 20;
export const PEER_ARTIFACTS_MAX = 8;

/** The caller's at-most-once key — the same shape `agentintents.ts` accepts. */
export const PEER_KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** A peer's name as `peers.json` lists it: also a URL path segment and an id part. */
export const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export type PeerJobState = "queued" | "waiting" | "running" | "limit" | "done" | "failed" | "refused";
/** The asker adds one state of its own: the peer could not be reached. */
export type PeerJobLocalState = PeerJobState | "unreachable";
const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "refused"]);
/** Settled for good: nothing more will happen to this job on the peer. */
export const peerJobTerminal = (s: string | undefined): boolean => !!s && TERMINAL.has(s);

/** Body of `POST /api/peer/jobs` (peer-facing, token-gated). */
export interface PeerJobRequest {
  /** Caller's at-most-once key, `PEER_KEY_RE`. */
  key: string;
  /** Asking host's peer name as the PEER lists it. */
  from: string;
  /** The repo's remote URL as the asker sees it (matched by `remoteKey`). */
  remote: string;
  /** What was pushed; the peer checks out `commit` detached. */
  branch: string;
  commit: string;
  prompt?: string;
  /** At most `INTENT_MAX_STEPS`. */
  steps?: string[];
  label?: string;
  closeWhenDone?: boolean;
  /** Default true: bring back `.claude/outbox` files the answer names. */
  reportArtifacts?: boolean;
  /** Picks one clone when the peer has two of the remote. */
  dir?: string;
  /**
   * The ASKING session's label, so the job session on the peer can say why it exists
   * ("job from mac · <this> · <label>"). Additive: an older peer ignores it.
   */
  askerLabel?: string;
}

export interface PeerReportArtifact { name: string; size: number }

export interface PeerJobReport {
  ok: boolean;
  text: string;
  truncated: boolean;
  artifacts: PeerReportArtifact[];
  pushedBranch?: string;
}

/** `GET /api/peer/jobs/<id>`. */
export interface PeerJobView {
  id: string;
  state: PeerJobState;
  peerApi: number;
  /** The peer's waterplane version. */
  version: string;
  intentId: string;
  sessionId?: string;
  worktree?: string;
  /** The row's blockDetail, or the limit's reset words. */
  waiting?: string;
  report?: PeerJobReport;
  /** The sentence, when refused or failed. */
  detail?: string;
  /**
   * What the job's session has spent, read off the PEER's own ledger (`ctxlog.ts`, the same pass
   * the session's cost chip there is drawn from). Additive; every field ABSENT when nothing
   * measured it — never 0, never a guess. While the job runs it is "so far".
   */
  cost?: PeerJobCost;
}

/** Tokens by kind — the four are never merged (`tokens.ts`). */
export interface PeerTokenSplit { in: number; out: number; cacheRead: number; cacheWrite: number }

/**
 * One job's spend as the peer measured it. Each field stands alone and is absent when its own
 * reading is: a job whose model has no published rate still carries its tokens and duration.
 * `usd` is a LIST-PRICE counterfactual (`costText`'s framing), subagents included.
 */
export interface PeerJobCost {
  usd?: number;
  tokens?: PeerTokenSplit;
  /** The model alias (`opus-5-5`), never a raw dated id. */
  model?: string;
  /** From the row starting to it settling — or to the reading, while it runs. */
  durationMs?: number;
  /** `usd` as a share of the account's WEEKLY limit, by the peer's own calibration; absent when it has none fresh. */
  weekPct?: number;
  /** Tokens on a model with no published rate — in no `usd`. */
  unpricedTok?: number;
}

/** `GET /api/peer/hello`. */
export interface PeerHello {
  peerApi: number;
  version: string;
  /** The name this host knows the CALLER by, when the token matched one. */
  you?: string;
  /** Is claude signed in on this desktop: a job sent while it is not stops at the sign-in
   *  screen. Absent from an older peer and when its `claude auth status` could not be read. */
  claudeSignedIn?: boolean;
}

/** `GET /api/peers/<name>/status` — the phone asks its own host to ask that peer, now. */
export interface PeerStatusResponse {
  ok: boolean;
  /** Why the peer could not be asked (offline, not paired that way, refused), in words. */
  error?: string;
  version?: string;
  claudeSignedIn?: boolean;
}

/** The loopback route's answer. */
export interface PeerAgentAnswer {
  ok: true;
  /** `peerJobId(peer, key)`. */
  id: string;
  state: PeerJobLocalState;
  peer: string;
  fires: string;
  existing?: boolean;
}

/** The asker's ledger row for one job (`.waterplane/peer-jobs.json`). */
export interface PeerJobRecord {
  id: string;
  peer: string;
  key: string;
  state: PeerJobLocalState;
  cwd: string;
  /** The asking session; absent once it is gone (the report falls to the backlog). */
  sessionId?: string;
  branch: string;
  commit: string;
  createdAt: number;
  updatedAt: number;
  /** Since when the peer has been unreachable, when it is. */
  unreachableSince?: number;
  view?: PeerJobView;
  detail?: string;
  /** The job's own label, as the asking agent gave it. */
  label?: string;
  /** The asking session's label when the job was sent. */
  askerLabel?: string;
  /** The peer's last cost reading for the job (`cleanPeerJobCost`'d); absent = none yet. */
  cost?: PeerJobCost;
  /** When this side first saw the job settle (terminal), epoch ms. */
  endedAt?: number;
  /**
   * The peer's own id for the job (`PeerJobView.id` from the POST answer). The peer names a job
   * after what IT calls us, which need not be what we call it, so every later read goes by this.
   */
  remoteId?: string;
}

/**
 * One row of `peers.json`. Outbound rows (we call them) keep the clear
 * `token`; inbound rows (they call us) keep `tokenSha256` only.
 */
export interface PeerRow {
  name: string;
  /** `host:port` — what `peerAddressOk` vouched for. */
  addr: string;
  token?: string;
  tokenSha256?: string;
  addedAt: number;
}

/** The id of a job on both hosts: `peer-<name>-<key>`. */
export const peerJobId = (peer: string, key: string): string => `peer-${peer}-${key}`;
/** The report row's id. */
export const peerReportId = (peer: string, key: string): string => `${peerJobId(peer, key)}-report`;

/** Read one `peers.json` row; anything unreadable is dropped, never defaulted. */
export function cleanPeerRow(raw: unknown): PeerRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !PEER_NAME_RE.test(r.name)) return null;
  if (typeof r.addr !== "string" || peerAddressOk(r.addr) !== null) return null;
  const token = typeof r.token === "string" && r.token ? r.token : undefined;
  const sha = typeof r.tokenSha256 === "string" && /^[0-9a-f]{64}$/.test(r.tokenSha256) ? r.tokenSha256 : undefined;
  if (!token && !sha) return null; // a row that can authenticate nobody is no row
  if (typeof r.addedAt !== "number" || !Number.isFinite(r.addedAt) || r.addedAt <= 0) return null;
  return { name: r.name, addr: r.addr, ...(token ? { token } : {}), ...(sha ? { tokenSha256: sha } : {}), addedAt: r.addedAt };
}

/**
 * One key for "the same remote", whatever its spelling: ssh://, scp-style
 * `git@host:o/r`, https://, with or without `.git`, a trailing slash, userinfo,
 * a port, or capitals. `host/path` lower-cased; null when there is no host or
 * no path (a local path or `file://` identifies nothing another machine shares).
 */
export function remoteKey(url: string): string | null {
  if (typeof url !== "string") return null;
  const s = url.trim();
  if (!s || /\s/.test(s) || /^file:/i.test(s)) return null;
  let host: string;
  let path: string;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:@]+)(?::\d*)?\/(.+)$/i.exec(s);
  if (m) {
    host = m[1];
    path = m[2];
  } else {
    // scp-style `user@host:path`; a bare `host:path` too, but never a URL
    const sc = /^(?:[^/@:]+@)?([^/:@]+):(?!\/\/)\/?(.+)$/.exec(s);
    if (!sc || sc[1].length === 1) return null; // a drive letter is no host
    host = sc[1];
    path = sc[2];
  }
  path = path.split(/[?#]/)[0].replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "").replace(/^\/+/, "");
  host = host.toLowerCase();
  if (!host || !path || path.split("/").some((p) => !p || p === "." || p === "..")) return null;
  return `${host}/${path.toLowerCase()}`;
}

/**
 * Is `addr` an address a peer may be reached on? null = fine, else why not.
 * Accepts `100.64/10:port`, `<name>.<tailnet>.ts.net:port` and
 * `127.0.0.1:port`. Nothing else — no `*.local`, no LAN, no public, no bare name.
 */
export function peerAddressOk(addr: string): string | null {
  if (typeof addr !== "string" || !addr.trim()) return "no address given";
  const m = /^([^:/\s]+):(\d{1,5})$/.exec(addr.trim());
  if (!m) return "write the address as host:port";
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return "the port must be 1-65535";
  const host = m[1].toLowerCase();
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const o = ip.slice(1).map(Number);
    if (o.some((n) => n > 255) || ip.slice(1).some((p) => p.length > 1 && p.startsWith("0"))) return "not a valid IPv4 address";
    if (o[0] === 127 && o[1] === 0 && o[2] === 0 && o[3] === 1) return null;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return null;
    return "only a Tailscale address (100.64.0.0/10) or 127.0.0.1 may be a peer";
  }
  if (host.endsWith(".ts.net")) {
    const labels = host.split(".");
    if (labels.length >= 4 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null;
    return "a MagicDNS name looks like <machine>.<tailnet>.ts.net";
  }
  return "only a Tailscale address (100.x or <machine>.<tailnet>.ts.net) or 127.0.0.1 may be a peer";
}

/** The asker's sentence for a peer-API version mismatch; says which side is older. */
export function peerVersionMismatchText(peer: string, ours: number, theirs: number): string {
  if (!Number.isInteger(ours) || !Number.isInteger(theirs) || ours === theirs) return "";
  return theirs > ours
    ? `${peer} runs peer API ${theirs}, this host ${ours} — upgrade this host`
    : `${peer} runs peer API ${theirs}, this host ${ours} — upgrade ${peer}`;
}

/** The peer's own side of the same sentence, when it refuses a caller (409 body). */
export function peerVersionRefusalText(ours: number, theirs: number | null): string {
  if (theirs === null) return `this host speaks peer API ${ours}; the request named no version`;
  if (!Number.isInteger(ours) || !Number.isInteger(theirs) || ours === theirs) return "";
  return theirs > ours
    ? `this host runs peer API ${ours}, the caller ${theirs} — upgrade this host`
    : `this host runs peer API ${ours}, the caller ${theirs} — upgrade the caller`;
}

/** Parse the header value; null when absent or not a whole non-negative number. */
export function parsePeerApiHeader(v: string | undefined | null): number | null {
  if (typeof v !== "string" || !/^\d{1,6}$/.test(v.trim())) return null;
  return Number(v.trim());
}

/**
 * The ONE wording of a peer's report, as the asking session receives it.
 * `max` caps the report text; a cut says how much, and names the peer session
 * to open for the rest. Starts with the peer mark.
 */
export function peerReportPrompt(peer: string, job: PeerJobView, max: number = PEER_REPORT_MAX_CHARS): string {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : PEER_REPORT_MAX_CHARS;
  // The mark, then what the job cost on the peer — each part only where it was measured.
  const head = `[${["report from peer " + peer, ...peerCostParts(job.cost)].join(" · ")}]`;
  const r = job.report;
  if (!r) {
    const lines = [`${head} The job ${job.state === "refused" ? "was refused" : "ended"} on ${peer} with no report.`];
    if (job.detail) lines.push(job.detail);
    return lines.join("\n");
  }
  const verdict = job.state === "refused" ? "was refused" : r.ok ? "finished" : "failed";
  const lines = [`${head} The job ${verdict} on ${peer}.`];
  if (job.detail && !r.ok) lines.push(job.detail);
  let text = r.text ?? "";
  let cutChars = 0;
  if (text.length > cap) {
    cutChars = text.length - cap;
    text = text.slice(0, cap);
  }
  lines.push("", text.trim() ? text : "(the peer's answer was empty)");
  if (cutChars || r.truncated) {
    const open = job.sessionId ? ` — open session ${job.sessionId} on ${peer} for the rest` : "";
    const what = cutChars ? `${cutChars} more characters not shown` : "the peer cut its answer";
    lines.push("", `[cut: ${what}${open}]`);
  }
  if (r.artifacts.length) {
    lines.push("", `Files the peer produced (${r.artifacts.length}):`, ...r.artifacts.map((a) => `- ${a.name} (${a.size} bytes)`));
  }
  if (r.pushedBranch) lines.push("", `The peer pushed branch ${r.pushedBranch}.`);
  return lines.join("\n");
}

/**
 * The tag's words — "waiting on pc · 4 min". The age is the PHONE's clock at
 * render (`now`), so a host-computed string is never stale on arrival; without
 * `now`, or with a `since` that cannot be believed, the age is left off.
 * Empty when there is nothing true to say.
 */
export function peerWaitWords(w: SessionInfo["peerWait"], now?: number): string {
  if (!w || typeof w.peer !== "string" || !w.peer) return "";
  const what: Record<string, string> = {
    queued: `waiting on ${w.peer}`,
    waiting: `waiting on ${w.peer}`,
    running: `waiting on ${w.peer}`,
    limit: `${w.peer} is at its usage limit`,
    unreachable: `${w.peer} unreachable`,
    done: `${w.peer} has answered`,
    failed: `${w.peer}'s job failed`,
    refused: `${w.peer} refused the job`,
  };
  const base = what[w.state];
  if (!base) return "";
  if (typeof now !== "number" || !Number.isFinite(now) || !Number.isFinite(w.since) || w.since <= 0 || now < w.since) return base;
  const min = Math.floor((now - w.since) / 60_000);
  const age = min < 1 ? "just now" : min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`;
  return `${base} · ${age}`;
}

// ── what a job cost, and why a session exists ───────────────────────────────

const posNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const wholeNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * A model id as a job's cost names it: the ALIAS without the `claude-` prefix
 * (`claude-opus-5-5-20260901` → `opus-5-5`), or another backend's own short id
 * as written. Null for anything that is not a plausible id.
 */
export function peerModelName(m: unknown): string | null {
  if (typeof m !== "string") return null;
  const n = normalizeModel(m);
  const id = n ? n.replace(/^claude-/, "") : m.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._/-]{0,47}$/.test(id) ? id : null;
}

/**
 * Read a `PeerJobCost` off the wire FIELD BY FIELD: each one that is not a
 * believable reading is dropped on its own, never zeroed, never defaulted.
 * `tokens` is all four kinds or none (a split missing a kind is not a split),
 * and all-zero is no reading. Undefined when nothing survives.
 */
export function cleanPeerJobCost(raw: unknown): PeerJobCost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: PeerJobCost = {};
  if (posNum(r.usd)) out.usd = r.usd;
  const t = r.tokens && typeof r.tokens === "object" ? (r.tokens as Record<string, unknown>) : null;
  if (t && wholeNum(t.in) && wholeNum(t.out) && wholeNum(t.cacheRead) && wholeNum(t.cacheWrite)
    && t.in + t.out + t.cacheRead + t.cacheWrite > 0) {
    out.tokens = { in: t.in, out: t.out, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite };
  }
  const model = peerModelName(r.model);
  if (model) out.model = model;
  if (posNum(r.durationMs)) out.durationMs = r.durationMs;
  if (posNum(r.weekPct) && r.weekPct <= 100) out.weekPct = r.weekPct;
  if (posNum(r.unpricedTok)) out.unpricedTok = r.unpricedTok;
  return Object.keys(out).length ? out : undefined;
}

/** A job's length in words: `<1 min`, `6 min`, `1 h 20 min`, `2 d 3 h`. Empty when it cannot be believed. */
export function peerDurationText(ms: number | undefined): string {
  if (!posNum(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** `≈0.05% of week` — the peer's own estimate; empty without one. */
export function peerWeekText(weekPct: number | undefined): string {
  if (!posNum(weekPct)) return "";
  if (weekPct < 0.001) return "<0.001% of week";
  const s = weekPct < 1 ? String(Number(weekPct.toPrecision(1))) : weekPct < 10 ? weekPct.toFixed(1) : String(Math.round(weekPct));
  return `≈${s}% of week`;
}

/** `["$0.84", "opus-5-5", "6 min"]` — the parts that were measured, in that order; [] for none. */
export function peerCostParts(c: PeerJobCost | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (posNum(c.usd)) out.push(fmtUsd(c.usd));
  if (c.model) out.push(c.model);
  const d = peerDurationText(c.durationMs);
  if (d) out.push(d);
  return out;
}

/** The state as a line says it after "sent to pc: <label> · ". */
const JOB_STATE_WORDS: Record<PeerJobLocalState, string> = {
  queued: "queued there",
  waiting: "waiting there",
  running: "running",
  limit: "at its usage limit",
  unreachable: "unreachable",
  done: "done",
  failed: "failed",
  refused: "refused",
};
/** A job state in the words a line uses ("running", "queued there", …); "" for an unknown one. */
export const peerJobStateWords = (s: string): string => (JOB_STATE_WORDS as Record<string, string>)[s] ?? "";

/** One delegated job as the asking session lists it (`SessionInfo.peerJobs`). */
export interface PeerJobSummary {
  peer: string;
  jobId: string;
  state: PeerJobLocalState;
  label?: string;
  /** When the job was sent. */
  since: number;
  /** When this side saw it settle. */
  endedAt?: number;
  peerSessionId?: string;
  peerBase?: string;
  cost?: PeerJobCost;
}

/**
 * One row of the asker's ledger as the PHONE reads it (`GET /api/peerjobs`, trusted path):
 * a summary plus where it came from. Never a token, never the peer's report text.
 */
export interface PeerJobLedgerRow extends PeerJobSummary {
  /** The asking repo (worktree path on this desktop). */
  cwd: string;
  /** The asking session; absent once it is gone. */
  sessionId?: string;
  askerLabel?: string;
  /** The sentence, when refused/failed/unreachable. */
  detail?: string;
  /** Nothing more will happen: the report settled or the job was called off. */
  closed?: boolean;
  /** The report reached the asking session (or its backlog). */
  reported?: boolean;
}

/**
 * "sent to pc: run the e2e suite · done · $0.84 · opus-5-5 · 6 min" — one line
 * per job in the asking session's facts. The cost parts only where measured;
 * a job with no label is "a job". Empty when there is nothing true to say.
 */
export function peerJobLine(j: Pick<PeerJobSummary, "peer" | "state" | "label" | "cost"> | null | undefined): string {
  if (!j || typeof j.peer !== "string" || !j.peer) return "";
  const st = peerJobStateWords(j.state);
  if (!st) return "";
  const label = typeof j.label === "string" && j.label.trim() ? j.label.trim() : "a job";
  return [`sent to ${j.peer}: ${label}`, st, ...peerCostParts(j.cost)].join(" · ");
}

/**
 * What a session cost, SPLIT by desktop: "$22.28 here + $0.84 on pc".
 * Never a single summed figure — the two were measured on two machines, and a
 * total without its split hides which one spent it. `hereUsd` absent (nothing
 * priced here) says so instead of dropping the half. Jobs with no `usd` are
 * counted, not charged zero. Null when no job carries a cost at all.
 */
export function peerSpendSplit(hereUsd: number | null | undefined, jobs: readonly Pick<PeerJobSummary, "peer" | "cost">[] | null | undefined):
  { text: string; peerUsd: number; byPeer: { peer: string; usd: number }[]; unpriced: number } | null {
  if (!jobs?.length) return null;
  const by = new Map<string, number>();
  let unpriced = 0;
  for (const j of jobs) {
    const usd = j.cost?.usd;
    if (posNum(usd)) by.set(j.peer, (by.get(j.peer) ?? 0) + usd);
    else unpriced++;
  }
  if (!by.size) return null;
  const byPeer = [...by].map(([peer, usd]) => ({ peer, usd }));
  const peers = byPeer.map((p) => `${fmtUsd(p.usd)} on ${p.peer}`).join(" + ");
  const here = posNum(hereUsd) ? `${fmtUsd(hereUsd)} here + ` : "";
  const missing = posNum(hereUsd) ? "" : " (this desktop's share is not priced)";
  const un = unpriced ? ` · ${unpriced} peer job${unpriced === 1 ? "" : "s"} not priced` : "";
  return { text: `${here}${peers}${missing}${un}`, peerUsd: byPeer.reduce((a, p) => a + p.usd, 0), byPeer, unpriced };
}

/**
 * The peer-job spend that belongs in a weekly-limit calibration over
 * `[from, to]` (both desktops on ONE account: the peer's spend is in the
 * percentage the account reports, and this desktop's ledger never saw it).
 * Only jobs that started AND ended inside the window, with a measured `usd` —
 * a job straddling either edge cannot be cut to the window, so it is left out
 * and COUNTED (`straddling`), never prorated. Null when nothing qualifies.
 */
export function peerWeekSpend(jobs: readonly Pick<PeerJobSummary, "peer" | "cost" | "since" | "endedAt">[] | null | undefined, from: number, to: number):
  { usd: number; byPeer: { peer: string; usd: number }[]; text: string; straddling: number } | null {
  if (!jobs?.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const by = new Map<string, number>();
  let straddling = 0;
  for (const j of jobs) {
    const usd = j.cost?.usd;
    if (!posNum(usd)) continue;
    const end = posNum(j.endedAt) ? j.endedAt : null;
    if (end != null && j.since >= from && end <= to) { by.set(j.peer, (by.get(j.peer) ?? 0) + usd); continue; }
    // Overlaps the window without fitting in it: left out, and counted.
    if (j.since < to && (end == null || end > from)) straddling++;
  }
  if (!by.size) return null;
  const byPeer = [...by].map(([peer, usd]) => ({ peer, usd }));
  return { usd: byPeer.reduce((a, p) => a + p.usd, 0), byPeer, straddling, text: `incl. ${byPeer.map((p) => `${fmtUsd(p.usd)} on ${p.peer}`).join(" + ")}` };
}

/** Why a session on the PEER exists (`SessionInfo.peerJob`). */
export interface PeerJobOrigin {
  /** The asking desktop, as this host lists it. */
  from: string;
  jobId: string;
  askerLabel?: string;
  label?: string;
}

/** "job from mac · <asking session label> · <job label>" — absent parts omitted; empty with no `from`. */
export function peerJobOriginText(o: PeerJobOrigin | null | undefined): string {
  if (!o || typeof o.from !== "string" || !o.from) return "";
  const clean = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 80) : "");
  return [`job from ${o.from}`, clean(o.askerLabel), clean(o.label)].filter(Boolean).join(" · ");
}
