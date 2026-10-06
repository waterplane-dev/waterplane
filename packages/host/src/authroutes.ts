/**
 * The HTTP routes of the LAN identity and the paired-device ledger:
 *
 *   GET  /api/lan/identity        loopback/Tailscale ONLY (403 otherwise, even
 *                                 with a token), then the normal gate
 *   POST /api/lan/verify {nonce}  PRE-auth, rate-limited per remote IP
 *   GET  /api/devices             authed; `current` marks the caller's row
 *   POST /api/devices/revoke {id} authed; deletes the row, closes its sockets
 *
 * `server/http.ts` calls `handleLanPreAuth` ahead of the auth gate (the
 * identity scope check and verify) and `handleAuthedRoutes` behind it. Kept
 * flat and handed its deps, like `api.ts`, so it never reaches `server/ctx`.
 * Pairing routes (P2) hook in beside these in `server/http.ts`, and reuse
 * `ratelimit.ts` for their own pre-auth redeem.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isDeviceId, type DeviceListResponse, type DeviceRevokeResponse, type LanIdentityResponse, type LanVerifyResponse, type PeerKind,
} from "@waterplane/shared";
import type { AuthManager } from "./auth.js";
import { lanIdentity, lanMac, validNonce } from "./lanid.js";
import { hostName } from "./net.js";
import { RateLimiter, rateKey } from "./ratelimit.js";
import { corsHeaders } from "./origin.js";

// `LanIdentityResponse` / `LanVerifyResponse` live in `@waterplane/shared`
// (`lanroute.ts`): the phone checks the MAC this answers.

export interface AuthRouteDeps {
  root: string;
  auth: AuthManager;
  /** Close a revoked device's live sockets; how many. */
  closeDevice(id: string): number;
}

/** 10 verifies in a burst, then one every 2 s, per remote IP: a phone asks
 *  once per LAN connect, a scanner gets nowhere fast. */
const verifyLimit = new RateLimiter({ burst: 10, perSec: 0.5 });

/** Only these peers may learn the identity secret: it is what lets a phone
 *  trust a LAN address, so it must come over a path that is already trusted. */
export function mayReadLanIdentity(kind: PeerKind): boolean {
  return kind === "loopback" || kind === "tailscale";
}

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req.headers), ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) { req.destroy(); return {}; }
    chunks.push(c as Buffer);
  }
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

/**
 * Before the auth gate. Returns true when it answered. The identity route is
 * REFUSED here for every other peer kind — a LAN token does not unlock it — and
 * otherwise left for `handleAuthedRoutes`, so a gated Tailscale peer still
 * needs its token.
 */
export async function handleLanPreAuth(req: IncomingMessage, res: ServerResponse, kind: PeerKind, deps: AuthRouteDeps): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";
  if (path === "/api/lan/identity") {
    if (mayReadLanIdentity(kind)) return false;
    reply(req, res, 403, { error: "the LAN identity is served over loopback or Tailscale only" });
    return true;
  }
  if (path === "/api/lan/verify") {
    if (method !== "POST") { reply(req, res, 405, { error: "POST only" }); return true; }
    const key = rateKey(req);
    if (!verifyLimit.take(key)) {
      reply(req, res, 429, { error: "too many requests" }, { "retry-after": String(Math.ceil(verifyLimit.retryAfterMs(key) / 1000) || 1) });
      return true;
    }
    const body = await readJson(req);
    if (!validNonce(body.nonce)) { reply(req, res, 400, { error: "nonce must be 16–128 printable characters" }); return true; }
    const id = lanIdentity(deps.root);
    const out: LanVerifyResponse = { hostId: id.hostId, mac: lanMac(id.secret, id.hostId, body.nonce) };
    reply(req, res, 200, out);
    return true;
  }
  return false;
}

/** Behind the auth gate: the caller is trusted or holds a valid token. */
export async function handleAuthedRoutes(req: IncomingMessage, res: ServerResponse, kind: PeerKind, tok: string | null, deps: AuthRouteDeps): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";
  if (path === "/api/lan/identity" && method === "GET") {
    if (!mayReadLanIdentity(kind)) { reply(req, res, 403, { error: "not from this connection" }); return true; }
    const id = lanIdentity(deps.root);
    const out: LanIdentityResponse = { hostId: id.hostId, secret: id.secret, hostName: hostName() };
    reply(req, res, 200, out);
    return true;
  }
  if (path === "/api/devices" && method === "GET") {
    const me = deps.auth.deviceFor(tok);
    const out: DeviceListResponse = { devices: deps.auth.devices.list(me?.id) };
    reply(req, res, 200, out);
    return true;
  }
  if (path === "/api/devices/revoke" && method === "POST") {
    const body = await readJson(req);
    if (!isDeviceId(body.id)) { reply(req, res, 400, { ok: false, error: "bad device id" }); return true; }
    const revoked = deps.auth.devices.revoke(body.id);
    const closedSockets = revoked ? deps.closeDevice(body.id) : 0;
    const out: DeviceRevokeResponse = { ok: true, revoked, closedSockets };
    reply(req, res, 200, out);
    return true;
  }
  return false;
}
