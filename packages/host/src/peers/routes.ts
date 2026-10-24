/**
 * The HTTP surface of peer pairing (docs/analysis/peer-hosts-plan.md):
 *
 *  - `GET|POST|DELETE /api/peers[/<name>]` — the PHONE manages the ledger.
 *    Ordinary token gate (already applied by `server/http.ts`) AND
 *    `canManage(kind)`: the trusted path only (loopback + Tailscale), never LAN
 *    — the same rule that guards the password.
 *  - `GET /api/peer/hello` and everything else under `/api/peer/` — the OTHER
 *    DAEMON calls these. A peer token unlocks ONLY this prefix; a device token
 *    never does (it is simply not in this ledger ⇒ 403 "not paired"), and the
 *    device-token gate in `http.ts` stands aside for this prefix because the
 *    check here is the stricter one.
 *
 * Order of refusals on `/api/peer/*`: not the trusted path (LAN/public) ⇒ 403;
 * no/unknown token ⇒ 403 "not paired" and nothing else (the refusal is logged
 * with the remote address); wrong or missing `PEER_API_HEADER` ⇒ 409 in
 * `peerVersionRefusalText`'s words. Routes other than `hello` are WP3's
 * (`setPeerServe`), reached only after all three checks passed.
 *
 * Nothing here binds anything, sets a CORS header or touches `origin.ts`.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PEER_API_HEADER,
  PEER_API_VERSION,
  parsePeerApiHeader,
  peerVersionRefusalText,
  type PeerHello,
  type PeerJobLedgerRow,
  type PeerStatusResponse,
} from "@waterplane/shared";
import type { PeerKind } from "@waterplane/shared";
import { requestPeerKind } from "../net.js";
import type { PeerPublic, PeerStore } from "./store.js";
import type { PeerReply, PeerTarget } from "./client.js";

/** Reached only for an authenticated, version-matched peer. Return false for "not mine" (⇒ 404). */
export type PeerServe = (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  peer: PeerPublic,
) => Promise<boolean>;

let registeredServe: PeerServe | undefined;
/**
 * WP3 (inbound) registers its `/api/peer/jobs…` handler here at boot — a
 * late-bound seam, so `routes.ts` and `api.ts` need no edit when it lands.
 * Called from `main.ts`, never at import.
 */
export function setPeerServe(fn: PeerServe | undefined): void { registeredServe = fn; }

let jobsLedger: (() => PeerJobLedgerRow[]) | undefined;
/**
 * The asking side's job ledger, for the phone's `GET /api/peerjobs` (`peers/agentpeer.ts`
 * registers it at boot). Unset ⇒ an empty list: no ledger is no jobs, never an error.
 */
export function setPeerJobsLedger(fn: (() => PeerJobLedgerRow[]) | undefined): void { jobsLedger = fn; }

let selfAddr: string | null = null;
/**
 * This daemon's own tailnet `ip:port`, from `main.ts` once the binds are known; null when it is not
 * bound on a tailnet IP. Never a LAN address, never a guess: the phone pairs with it.
 */
export function setPeerSelfAddr(addr: string | null): void { selfAddr = addr; }

export interface PeerRouteDeps {
  store: PeerStore;
  /** Overrides the registered `setPeerServe` handler (tests); neither ⇒ those routes are 404. */
  serve?: PeerServe;
  /** Overrides the ledger registered with `setPeerJobsLedger` (tests). */
  jobs?: () => PeerJobLedgerRow[];
  /** Overrides the address registered with `setPeerSelfAddr` (tests). */
  selfAddr?: string | null;
  /** `AuthManager.canManage`. */
  canManage(kind: PeerKind): boolean;
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
  /** This host's waterplane version, for `hello`; defaults to the host package's. */
  version?: string;
  /** Where a refusal is logged (the peer's remote address); defaults to console.warn. */
  warn?: (msg: string) => void;
  /** Is claude signed in on THIS desktop, for `hello` (cached; null unreadable). Absent ⇒ not said. */
  signedIn?: () => Promise<"in" | "out" | null>;
  /** Ask a paired peer's `hello` now, for the phone's row. Absent ⇒ that route answers 404. */
  askPeer?: (t: PeerTarget) => Promise<PeerReply<PeerHello>>;
}

let cachedVersion: string | null = null;
/** The host package's version, or "unknown" — a value nobody can mistake for a real one. */
export function hostVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const p = new URL("../../package.json", import.meta.url);
    const v = JSON.parse(readFileSync(p, "utf8"))?.version;
    cachedVersion = typeof v === "string" && v ? v : "unknown";
  } catch { cachedVersion = "unknown"; }
  return cachedVersion;
}

/** `Authorization: Bearer <tok>` only — a peer never rides a cookie or a ws subprotocol. */
export function peerBearer(h: IncomingMessage["headers"]): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,256})\s*$/i.exec(typeof h.authorization === "string" ? h.authorization : "");
  return m ? m[1] : null;
}

/** Answers `/api/peers*` and `/api/peer/*`; true when it did, false for any other path. */
export async function handlePeerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: PeerRouteDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  // The REQUEST's tier, not the socket's: behind `tailscale serve`/funnel the socket is loopback.
  const kind = requestPeerKind(req.socket.remoteAddress, req.headers);

  // ── the phone reads what this desktop has delegated (read-only, trusted path) ──
  if (path === "/api/peerjobs") {
    if (!deps.canManage(kind)) { deps.json(res, { ok: false, error: "not allowed from this connection" }, 403); return true; }
    if (method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return true; }
    const jobs = deps.jobs ?? jobsLedger;
    deps.json(res, { ok: true, jobs: jobs ? jobs() : [] });
    return true;
  }

  // ── the phone manages the ledger ──────────────────────────────────────
  if (path === "/api/peers" || path.startsWith("/api/peers/")) {
    if (!deps.canManage(kind)) { deps.json(res, { ok: false, error: "not allowed from this connection" }, 403); return true; }
    if (path === "/api/peers") {
      if (method === "GET") { deps.json(res, { ok: true, peers: deps.store.list(), self: { addr: deps.selfAddr !== undefined ? deps.selfAddr : selfAddr } }); return true; }
      if (method === "POST") {
        const b = await deps.readJson(req);
        const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
        const r = deps.store.upsert({
          name: str(b?.name) ?? "",
          addr: str(b?.addr) ?? "",
          outboundToken: str(b?.outboundToken),
          inboundToken: str(b?.inboundToken),
        });
        if (!r.ok) { deps.json(res, { ok: false, error: r.error }, 400); return true; }
        deps.json(res, { ok: true, peer: r.row, replaced: r.replaced });
        return true;
      }
      res.writeHead(405, { allow: "GET, POST" }).end();
      return true;
    }
    if (path.endsWith("/status") && method === "GET" && deps.askPeer) {
      let pname: string;
      try { pname = decodeURIComponent(path.slice("/api/peers/".length, -"/status".length)); } catch { pname = ""; }
      const t = deps.store.outbound(pname);
      if (!t) { deps.json(res, { ok: false, error: deps.store.get(pname) ? `this desktop cannot call ${pname} (no outbound token)` : "no such peer" } satisfies PeerStatusResponse); return true; }
      const r = await deps.askPeer(t);
      const out: PeerStatusResponse = r.kind === "ok"
        ? { ok: true, version: r.body.version, ...(typeof r.body.claudeSignedIn === "boolean" ? { claudeSignedIn: r.body.claudeSignedIn } : {}) }
        : { ok: false, error: r.kind === "unreachable" ? `${t.name} did not answer: ${r.error}` : r.text };
      deps.json(res, out);
      return true;
    }
    let name: string;
    try { name = decodeURIComponent(path.slice("/api/peers/".length)); } catch { name = ""; }
    if (method === "GET") {
      const row = deps.store.get(name);
      if (!row) deps.json(res, { ok: false, error: "no such peer" }, 404); else deps.json(res, { ok: true, peer: row });
      return true;
    }
    if (method === "DELETE") {
      if (!deps.store.remove(name)) deps.json(res, { ok: false, error: "no such peer" }, 404); else deps.json(res, { ok: true });
      return true;
    }
    res.writeHead(405, { allow: "GET, DELETE" }).end();
    return true;
  }

  // ── the other daemon calls these ──────────────────────────────────────
  if (path === "/api/peer" || path.startsWith("/api/peer/")) {
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    // Peers live on the tailnet or loopback (`peerAddressOk`); LAN/public never get to try a token.
    if (!deps.canManage(kind)) { deps.json(res, { ok: false, error: "not paired" }, 403); return true; }
    const peer = deps.store.authenticate(peerBearer(req.headers));
    if (!peer) {
      warn(`[peer] refused ${method} ${path} from ${req.socket.remoteAddress ?? "?"}: not paired`);
      deps.json(res, { ok: false, error: "not paired" }, 403);
      return true;
    }
    const theirs = parsePeerApiHeader(req.headers[PEER_API_HEADER] as string | undefined);
    if (theirs !== PEER_API_VERSION) {
      deps.json(res, { ok: false, error: peerVersionRefusalText(PEER_API_VERSION, theirs), peerApi: PEER_API_VERSION }, 409);
      return true;
    }
    if (path === "/api/peer/hello" && method === "GET") {
      const signed = deps.signedIn ? await deps.signedIn() : null;
      const hello: PeerHello = { peerApi: PEER_API_VERSION, version: deps.version ?? hostVersion(), you: peer.name, ...(signed ? { claudeSignedIn: signed === "in" } : {}) };
      deps.json(res, hello);
      return true;
    }
    const serve = deps.serve ?? registeredServe;
    if (serve && await serve(req, res, path, url, peer)) return true;
    deps.json(res, { ok: false, error: "not found" }, 404);
    return true;
  }

  return false;
}
