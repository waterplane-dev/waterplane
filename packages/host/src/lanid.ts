/**
 * This desktop's LAN identity: a stable `hostId` and a secret that proves it.
 *
 * On plain-HTTP Wi-Fi the phone cannot tell `http://192.168.1.20:8770` from any
 * other box that happens to answer there (a different desktop after a DHCP
 * shuffle, a hostile device on a café network). So before it sends a token over
 * LAN it asks `POST /api/lan/verify {nonce}` and checks
 * `mac = HMAC-SHA256(secret, hostId + "\n" + nonce)` against the secret it
 * learned over the TRUSTED path (`GET /api/lan/identity`, loopback/Tailscale
 * only). A box without the secret cannot answer a fresh nonce.
 *
 * Stated residual (SECURITY.md): this defeats a wrong or impersonating host, not
 * an active relay that forwards the probe to the real desktop — plain HTTP on
 * the person's own Wi-Fi cannot resist that.
 *
 * `.waterplane/lan-identity.json`, mode 0600, created on first use.
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHostId, newHostId } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { writeJsonAtomic } from "./jsonstore.js";

export interface LanIdentity {
  hostId: string;
  /** base64url, 32 random bytes. Never leaves the trusted path. */
  secret: string;
}

/** Nonce bounds: long enough to be unguessable, short enough to be cheap. */
export const LAN_NONCE_MIN = 16;
export const LAN_NONCE_MAX = 128;

const cache = new Map<string, LanIdentity>();

export function lanIdentityFile(root: string): string {
  return join(hostStateDir(root), "lan-identity.json");
}

function readIdentity(file: string): LanIdentity | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (isHostId(j?.hostId) && typeof j?.secret === "string" && /^[A-Za-z0-9_-]{32,}$/.test(j.secret)) {
      return { hostId: j.hostId, secret: j.secret };
    }
  } catch { /* absent or unreadable ⇒ none */ }
  return null;
}

/** Whether the identity file exists and parses (doctor's question — never creates it). */
export function lanIdentityPresent(root: string): boolean {
  return cache.has(root) || readIdentity(lanIdentityFile(root)) !== null;
}

/** The identity, created (0600) the first time anything asks. A corrupt file is
 *  replaced: every phone then re-learns it over the trusted path, which is the
 *  same thing that happens the first time. */
export function lanIdentity(root: string): LanIdentity {
  const hit = cache.get(root);
  if (hit) return hit;
  const file = lanIdentityFile(root);
  let id = readIdentity(file);
  if (!id) {
    id = { hostId: newHostId(), secret: randomBytes(32).toString("base64url") };
    mkdirSync(dirname(file), { recursive: true });
    writeJsonAtomic(file, id, { mode: 0o600 });
  }
  try { chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
  cache.set(root, id);
  return id;
}

/** A nonce the verify endpoint will answer: a string within the bounds, printable. */
export function validNonce(n: unknown): n is string {
  return typeof n === "string" && n.length >= LAN_NONCE_MIN && n.length <= LAN_NONCE_MAX && /^[\x21-\x7e]+$/.test(n);
}

/** hex HMAC-SHA256(secret, hostId + "\n" + nonce). The phone computes the same. */
export function lanMac(secret: string, hostId: string, nonce: string): string {
  return createHmac("sha256", secret).update(`${hostId}\n${nonce}`).digest("hex");
}

/** For tests: forget the cached identity of `root`. */
export function forgetLanIdentity(root: string): void {
  cache.delete(root);
}
