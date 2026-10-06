/**
 * Calling a peer (docs/analysis/peer-hosts-plan.md): the asking side's HTTP to another waterplane
 * host — `hello`, post a job, read a job, fetch an artifact. Every call carries the bearer token
 * and `PEER_API_HEADER`, has a timeout, and answers a tagged result instead of throwing, so the
 * state machine in `jobs.ts` decides what each outcome means.
 *
 * Outcomes: `ok` (a body), `unreachable` (no answer, a timeout or a 5xx — never a verdict about
 * the job), `mismatch` (409: the sentence naming both versions), `denied` (403: not paired) and
 * `rejected` (any other 4xx, with the peer's own sentence). Nothing here retries or keeps state
 * except the 10-minute `hello` cache.
 */
import {
  PEER_API_HEADER,
  PEER_API_VERSION,
  peerVersionMismatchText,
  type PeerHello,
  type PeerJobRequest,
  type PeerJobView,
} from "@waterplane/shared";

export type PeerReply<T> =
  | { kind: "ok"; body: T }
  | { kind: "unreachable"; error: string }
  | { kind: "mismatch"; text: string }
  | { kind: "denied"; text: string }
  | { kind: "rejected"; status: number; text: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface PeerTarget { name: string; addr: string; token: string }

const JSON_TIMEOUT_MS = 10_000;
const ARTIFACT_TIMEOUT_MS = 60_000;
export const HELLO_TTL_MS = 10 * 60_000;

export class PeerClient {
  private hellos = new Map<string, { at: number; hello: PeerHello }>();
  constructor(
    private readonly f: FetchLike = (u, i) => fetch(u, i) as unknown as ReturnType<FetchLike>,
    private readonly now: () => number = Date.now,
  ) {}

  private async call<T>(t: PeerTarget, method: string, path: string, body: unknown, timeout: number, raw?: boolean): Promise<PeerReply<T>> {
    let r;
    try {
      r = await this.f(`http://${t.addr}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${t.token}`,
          [PEER_API_HEADER]: String(PEER_API_VERSION),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) { return { kind: "unreachable", error: String((e as Error)?.message || e) }; }
    if (r.status >= 500) return { kind: "unreachable", error: `${t.name} answered ${r.status}` };
    if (r.ok && raw) {
      try { return { kind: "ok", body: (await r.arrayBuffer()) as unknown as T }; }
      catch (e) { return { kind: "unreachable", error: String((e as Error)?.message || e) }; }
    }
    let j: any = null;
    try { j = await r.json(); } catch { /* a body that is not JSON says nothing */ }
    if (r.status === 409) {
      const theirs = Number(j?.peerApi);
      const text = Number.isInteger(theirs) && theirs !== PEER_API_VERSION
        ? peerVersionMismatchText(t.name, PEER_API_VERSION, theirs)
        : String(j?.error || `${t.name} refused the peer API version`);
      return { kind: "mismatch", text };
    }
    if (r.status === 403) return { kind: "denied", text: `${t.name} says this host is not paired` };
    if (!r.ok) return { kind: "rejected", status: r.status, text: typeof j?.error === "string" && j.error ? j.error : `${t.name} answered ${r.status}` };
    return { kind: "ok", body: j as T };
  }

  /** `hello`, cached 10 minutes per peer — only a good answer is cached. */
  async hello(t: PeerTarget): Promise<PeerReply<PeerHello>> {
    const c = this.hellos.get(t.name);
    if (c && this.now() - c.at < HELLO_TTL_MS) return { kind: "ok", body: c.hello };
    const r = await this.call<PeerHello>(t, "GET", "/api/peer/hello", undefined, JSON_TIMEOUT_MS);
    if (r.kind === "ok") this.hellos.set(t.name, { at: this.now(), hello: r.body });
    else this.hellos.delete(t.name);
    return r;
  }

  /** `hello` past the cache: what the peer says NOW (a sign-in shows up on the next look). */
  helloFresh(t: PeerTarget): Promise<PeerReply<PeerHello>> {
    this.hellos.delete(t.name);
    return this.hello(t);
  }

  postJob(t: PeerTarget, req: PeerJobRequest): Promise<PeerReply<PeerJobView>> {
    return this.call(t, "POST", "/api/peer/jobs", req, JSON_TIMEOUT_MS);
  }
  getJob(t: PeerTarget, id: string): Promise<PeerReply<PeerJobView>> {
    return this.call(t, "GET", `/api/peer/jobs/${encodeURIComponent(id)}`, undefined, JSON_TIMEOUT_MS);
  }
  getArtifact(t: PeerTarget, id: string, name: string): Promise<PeerReply<ArrayBuffer>> {
    return this.call(t, "GET", `/api/peer/jobs/${encodeURIComponent(id)}/artifact?name=${encodeURIComponent(name)}`, undefined, ARTIFACT_TIMEOUT_MS, true);
  }
}
