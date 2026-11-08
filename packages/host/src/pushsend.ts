/**
 * One Web Push delivery, on `node:crypto` alone: a VAPID key pair (RFC 8292), the payload encrypted
 * to the subscription (RFC 8291, `aes128gcm` from RFC 8188), and the POST to the push service.
 * What to do with a refusal is `push.ts`'s; this file only reports one.
 */
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Base64url: the 65-byte uncompressed P-256 point, and the 32-byte private scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface Vapid {
  subject: string;
  publicKey: string;
  signingKey: KeyObject;
}

/** Thrown for any answer outside 2xx. Header names are lower case, as node gives them. */
export class PushRefused extends Error {
  constructor(readonly statusCode: number, readonly headers: Record<string, unknown>) {
    super(`push service answered ${statusCode}`);
  }
}

/** One record of RFC 8188; 4096 is what RFC 8291 §4 lets a push service insist on for the whole body. */
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const P256_POINT_BYTES = 65;
const GCM_TAG_BYTES = 16;
const HEADER_BYTES = SALT_BYTES + 4 + 1 + P256_POINT_BYTES;
/** The largest payload that still leaves the body at 4096 bytes: header, tag and the delimiter out. */
export const PUSH_MAX_PLAINTEXT = RECORD_SIZE - HEADER_BYTES - GCM_TAG_BYTES - 1;

/** Payloads are padded up to a multiple of this, so the push service sees a size class, not a length.
 *  `PUSH_FLOOR` in `push.ts` is a multiple of it, so a payload cut to the floor is not padded past it. */
const PAD_STEP = 256;

/** RFC 8292 §2 allows up to 24 h; `PUSH_CLOCK_SKEW_MS` in `push.ts` is reasoned from this 12 h. */
const VAPID_LIFETIME_S = 12 * 3600;
/** How long a push service may hold a message for a phone that is off: four weeks. */
const TTL_S = 2_419_200;
/** The whole send, from opening the socket to the end of the answer. */
const SEND_DEADLINE_MS = 30_000;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

export function generateVapidKeys(): VapidKeys {
  const { x, y, d } = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(x!), unb64u(y!)])), privateKey: d! };
}

/** Throws on a contact or key no push service could accept, so a bad one is said once, at boot. */
export function vapidFrom(subject: string, keys: VapidKeys): Vapid {
  const protocol = new URL(subject).protocol;
  if (protocol !== "https:" && protocol !== "mailto:") throw new Error(`VAPID contact must be an https: or mailto: URL, not ${protocol}`);
  const point = unb64u(keys.publicKey);
  if (point.length !== P256_POINT_BYTES || point[0] !== 4) throw new Error("VAPID public key is not an uncompressed P-256 point");
  if (unb64u(keys.privateKey).length !== 32) throw new Error("VAPID private key is not 32 bytes");
  const signingKey = createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
  });
  return { subject, publicKey: keys.publicKey, signingKey };
}

/** A bad endpoint's own `TypeError` carries the whole URL in `.input`, and its path is a secret. */
function endpointUrl(endpoint: string): URL {
  try { return new URL(endpoint); } catch { throw Object.assign(new Error("subscription endpoint is not a URL"), { code: "ERR_INVALID_URL" }); }
}

/** The `Authorization` value for one push service. `nowMs` is this host's clock. */
export function vapidAuthorization(endpoint: string, vapid: Vapid, nowMs: number = Date.now()): string {
  const claims = { aud: endpointUrl(endpoint).origin, exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_S, sub: vapid.subject };
  const unsigned = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapid.signingKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * RFC 8291 §3.4 into RFC 8188 §2: one record, so the delimiter is 0x02 and any padding is zeros after it.
 * `fixed` exists for the RFC's own test vector, which has no padding; a real send always takes a
 * fresh key and salt, and is padded.
 */
export function encryptPayload(text: string, keys: PushSubscription["keys"], fixed?: { privateKey: Buffer; salt: Buffer }): Buffer {
  const plain = Buffer.from(text, "utf8");
  if (plain.length > PUSH_MAX_PLAINTEXT) throw new Error(`push payload of ${plain.length} bytes is over ${PUSH_MAX_PLAINTEXT}`);
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== P256_POINT_BYTES) throw new Error("subscription p256dh is not a P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret is not 16 bytes");

  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(SALT_BYTES);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(uaPublic), authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const padded = fixed ? plain.length : Math.min(PUSH_MAX_PLAINTEXT, Math.ceil(Math.max(plain.length, 1) / PAD_STEP) * PAD_STEP);
  const tail = Buffer.alloc(1 + padded - plain.length);
  tail[0] = 2;
  const sealed = Buffer.concat([cipher.update(plain), cipher.update(tail), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header[SALT_BYTES + 4] = P256_POINT_BYTES;
  asPublic.copy(header, SALT_BYTES + 5);
  return Buffer.concat([header, sealed]);
}

type Post = (url: URL, options: RequestOptions, answer: (res: IncomingMessage) => void) => ClientRequest;

/** POST `body`; resolves on 2xx, rejects with `PushRefused` otherwise. Settles within `deadlineMs`
 *  however slowly the service answers. `post` is `https.request` outside a test. */
export function postPush(url: URL, headers: Record<string, string | number>, body: Buffer, deadlineMs: number, post: Post = request): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = post(url, { method: "POST", headers: { ...headers, "Content-Length": body.length } }, (res) => {
      res.resume();
      res.on("error", reject);
      res.on("end", () => {
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) resolve(); else reject(new PushRefused(code, res.headers));
      });
    });
    const deadline = setTimeout(() => {
      reject(Object.assign(new Error("push service did not answer in time"), { code: "ETIMEDOUT" }));
      req.destroy();
    }, deadlineMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(body);
  });
}

function sendNotification(sub: PushSubscription, text: string, vapid: Vapid): Promise<void> {
  return postPush(endpointUrl(sub.endpoint), {
    Authorization: vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: TTL_S,
    Urgency: "normal",
  }, encryptPayload(text, sub.keys), SEND_DEADLINE_MS);
}

/** The one send, held in an object so a test can stand in for the network. */
export const pushTransport = { sendNotification };
