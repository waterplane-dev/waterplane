/**
 * TLS for the LAN: the host's own encrypted port beside the plain one.
 *
 * Plain `http://<lan ip>:8770` can be read and rewritten by anything on the Wi-Fi; `lanid.ts`
 * proves a host, not a channel. This is a second listener with the SAME `http.handler` and the
 * SAME `attachWs`, so one socket per tab, one send path and the token gate are unchanged: a
 * caller on it is still peer kind `lan`.
 *
 * It listens only where `<PREFIX>_ALLOW_PUBLIC=1` already bound a LAN address, and only on those
 * addresses (`lanTlsPlan`): no new interface, nothing without the opt-in. Loopback and the
 * tailnet never get it — they have no use for it, and a new bind is a new way to be wrong.
 *
 * The key is P-256 in `<state dir>/lan-tls.json` (0600), minted once. A phone pins the leaf's SPKI,
 * so the key is the identity and the certificate is paperwork: when the addresses change the
 * certificate is re-issued on the SAME key and no phone is unpinned. Addresses are read at boot,
 * like every other bind, so a re-issue happens at boot. The certificate is built here (`der.ts`,
 * signed with `node:crypto`): no dependency, no `openssl` at run time.
 *
 * `<PREFIX>_TLS_CERT` + `<PREFIX>_TLS_KEY` use a person's own leaf (from a local CA) instead and
 * leave `lan-tls.json` alone. A broken one refuses the TLS listener and says why; the plain host
 * still runs, because a typo in an optional knob must not take the desktop off the network.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import type { EventEmitter } from "node:events";
import { chmodSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { RequestListener } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRAND, envName, logTag } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { bitString, boolTrue, integer, octetString, oid, seq, set, time, tlv, utf8String } from "./der.js";
import { env } from "./env.js";
import { isEncryptedSocket } from "./net.js";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";

export type LanTlsServer = Server;

/** What `welcome` and a pairing tell a phone. `spki`: lowercase hex SHA-256 of the leaf's SPKI DER. */
export interface LanTlsFacts { port: number; spki: string }

/** A key and certificate ready for `https.createServer`. */
export interface LanTlsMaterial {
  keyPem: string;
  /** The leaf, then any chain a person's own file carries. */
  certPem: string;
  spki: string;
  selfSigned: boolean;
}

export interface LanTlsRefusal { refused: string }

const isRefusal = (v: object): v is LanTlsRefusal => "refused" in v;

/** Where this host listens, or why it does not. `problem`: a knob is wrong, as against simply off. */
export type LanTlsPlan = { port: number; addrs: string[] } | { why: string; problem: boolean };

/**
 * The bind rule, the one place it is decided. `binds` is what the safe-address guard left, so an
 * explicit `<PREFIX>_HOST` narrows this and can never add to it: a host pinned to loopback under
 * the opt-in has `boundLan` filled and no LAN listener, and neither does this.
 */
export function lanTlsPlan(i: { allowPublic: boolean; plainPort: number; boundLan: string[]; binds: string[] }): LanTlsPlan {
  if (!i.allowPublic) return { why: `no LAN bind (${envName("ALLOW_PUBLIC")} is not 1)`, problem: false };
  if (env("TLS") === "0") return { why: `${envName("TLS")}=0`, problem: false };
  const addrs = i.boundLan.filter((a) => i.binds.includes(a));
  if (!addrs.length) return { why: i.boundLan.length ? `${envName("HOST")} binds no LAN address` : "no LAN address on this machine", problem: false };
  const raw = env("TLS_PORT");
  const port = raw ? Number(raw) : i.plainPort + 1;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === i.plainPort) {
    return { why: `${envName("TLS_PORT")} must be a port other than ${i.plainPort}, not ${raw || port}`, problem: true };
  }
  return { port, addrs };
}

/** This host's mDNS name, the one Bonjour answers to: `mac.fritz.box` is still `mac.local`. Exactly
 *  one name, never a wildcard, and nothing at all for a hostname a dNSName cannot spell. */
export function lanTlsNames(host: string = hostname()): string[] {
  const label = host.toLowerCase().replace(/\.local$/, "").split(".")[0];
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) ? [`${label}.local`] : [];
}

const spkiDer = (k: KeyObject): Buffer => k.export({ type: "spki", format: "der" });

/** The pin (8a): lowercase hex SHA-256 of the SPKI DER. */
export function spkiPin(publicKey: KeyObject): string {
  return createHash("sha256").update(spkiDer(publicKey)).digest("hex");
}

/** How a person reads a pin in a log line or the doctor. */
export const pinShort = (spki: string): string => spki.slice(0, 16);

const OID = {
  commonName: "2.5.4.3",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyId: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

/** Long enough that a re-issue is rare, and the 825 days a platform verifier still accepts. */
const VALID_DAYS = 825;
/** Re-issued at boot once this close to the end, so a phone that does check the date never meets an expired one. */
const RENEW_DAYS = 30;
const DAY_MS = 86_400_000;
/** The desktop's clock and the phone's are never equal. */
const BACKDATE_MS = 3_600_000;

const extension = (id: string, critical: boolean, value: Uint8Array): Buffer =>
  seq(oid(id), ...(critical ? [boolTrue()] : []), octetString(value));

function ipv4(ip: string): Buffer | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Buffer.from(p) : null;
}

/** A self-signed leaf for `ips` + `names` on `key`, as PEM. Signed, not trusted: its worth is the pin. */
export function issueLeaf(key: KeyObject, ips: string[], names: string[], now: Date = new Date()): string {
  const spki = spkiDer(createPublicKey(key));
  // RFC 7093 §2 method 1: the leftmost 160 bits of the SHA-256 of the subjectPublicKey bits,
  // which for P-256 are the 65-byte uncompressed point that ends the SPKI.
  const keyId = createHash("sha256").update(spki.subarray(spki.length - 65)).digest().subarray(0, 20);
  const signatureAlgorithm = seq(oid(OID.ecdsaSha256));
  const name = seq(set(seq(oid(OID.commonName), utf8String(`${BRAND.name} LAN`))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40; // positive, full length
  const sans = [
    ...names.map((n) => tlv(0x82, Buffer.from(n, "ascii"))),
    ...ips.flatMap((ip) => { const b = ipv4(ip); return b ? [tlv(0x87, b)] : []; }),
  ];
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    signatureAlgorithm,
    name,
    seq(time(new Date(now.getTime() - BACKDATE_MS)), time(new Date(now.getTime() + VALID_DAYS * DAY_MS))),
    name,
    spki,
    tlv(0xa3, seq(
      extension(OID.basicConstraints, true, seq()), // cA defaults to FALSE
      extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectKeyId, false, octetString(keyId)),
      extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId))),
      extension(OID.subjectAltName, false, seq(...sans)),
    )),
  );
  const der = seq(tbs, signatureAlgorithm, bitString(sign("sha256", tbs, key)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END CERTIFICATE-----\n`;
}

interface Stored { v: 1; key: string; cert: string; sans: string[] }

export function lanTlsFile(root: string): string {
  return join(hostStateDir(root), "lan-tls.json");
}

function p256(pem: unknown): KeyObject | null {
  if (typeof pem !== "string") return null;
  try {
    const k = createPrivateKey(pem);
    return k.asymmetricKeyDetails?.namedCurve === "prime256v1" ? k : null;
  } catch { return null; }
}

/** The stored leaf still serves: parses, on this key, for these names, not about to lapse. */
function leafHolds(s: Stored, key: KeyObject, sans: string[], now: Date): boolean {
  if (s.sans?.join() !== sans.join()) return false;
  try {
    const x = new X509Certificate(s.cert);
    return x.checkPrivateKey(key) && new Date(x.validTo).getTime() - now.getTime() > RENEW_DAYS * DAY_MS;
  } catch { return false; }
}

/**
 * The generated key and a leaf that names today's addresses. A key that cannot be READ refuses
 * rather than mints: writing a new one over it would move every phone's pin because of a
 * permissions slip. One that reads as garbage is kept aside by `readJsonGuarded`, and the new
 * pin is said out loud, because each phone will now refuse this host until it is paired again.
 */
export function ensureSelfSigned(root: string, ips: string[], names: string[] = lanTlsNames(), now: Date = new Date()): LanTlsMaterial | LanTlsRefusal {
  const file = lanTlsFile(root);
  const read = readJsonGuardedDetail<Stored | null>(file, null, (v) => p256((v as Stored | null)?.key) !== null);
  if (read.corrupt && !read.corrupt.movedTo) return { refused: `${file} could not be read (${read.corrupt.error})` };
  if (read.corrupt) console.warn(`${logTag} LAN TLS: the old key is unusable, minting a new one. Every phone's pin of this host is now wrong: pair them again.`);
  const sans = [...names.map((n) => `dns:${n}`), ...ips.map((ip) => `ip:${ip}`)].sort();
  const key = (read.value && p256(read.value.key)) || generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const held = read.value && leafHolds(read.value, key, sans, now) ? read.value : null;
  const out: Stored = held ?? {
    v: 1,
    key: key.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: issueLeaf(key, [...ips].sort(), [...names].sort(), now),
    sans,
  };
  if (!held) {
    try { writeJsonAtomic(file, out, { mode: 0o600 }); }
    catch (e) { return { refused: `${file} could not be written (${(e as Error).message})` }; }
  }
  try { chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
  return { keyPem: out.key, certPem: out.cert, spki: spkiPin(createPublicKey(key)), selfSigned: true };
}

/**
 * A person's own leaf, or null when neither knob is set. Both or neither; the leaf must parse and
 * the key must be its key. `selfSigned` is read off the certificate, never assumed from the knob:
 * a hand-made self-signed leaf is exactly as untrusted by a browser as the generated one.
 */
export function ownLeaf(certPath: string | undefined = env("TLS_CERT"), keyPath: string | undefined = env("TLS_KEY")): LanTlsMaterial | LanTlsRefusal | null {
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) return { refused: `${envName("TLS_CERT")} and ${envName("TLS_KEY")} go together; only ${envName(certPath ? "TLS_CERT" : "TLS_KEY")} is set` };
  const load = (path: string, what: string): string | LanTlsRefusal => {
    try { return readFileSync(path, "utf8"); }
    catch (e) { return { refused: `cannot read ${what} ${path} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` }; }
  };
  const certPem = load(certPath, "the certificate");
  if (typeof certPem !== "string") return certPem;
  const keyPem = load(keyPath, "the key");
  if (typeof keyPem !== "string") return keyPem;
  let x: X509Certificate;
  try { x = new X509Certificate(certPem); }
  catch { return { refused: `${certPath} is not a PEM certificate` }; }
  let key: KeyObject;
  try { key = createPrivateKey(keyPem); }
  catch { return { refused: `${keyPath} is not an unencrypted PEM private key` }; }
  if (!x.checkPrivateKey(key)) return { refused: `${keyPath} is not the key of ${certPath}` };
  return { keyPem, certPem, spki: spkiPin(x.publicKey), selfSigned: x.issuer === x.subject && x.verify(x.publicKey) };
}

export interface LanTlsReady { port: number; addrs: string[]; material: LanTlsMaterial }

/**
 * Everything short of listening, so the origin guard can be armed with the port first. Null when
 * there is to be no TLS listener; a refusal is said here, once. Never runs under the doctor: it
 * writes `lan-tls.json`.
 */
export function prepareLanTls(i: Parameters<typeof lanTlsPlan>[0] & { root: string }): LanTlsReady | null {
  const plan = lanTlsPlan(i);
  if ("why" in plan) {
    if (plan.problem) console.warn(`${logTag} LAN TLS off: ${plan.why}. The plain host still runs.`);
    return null;
  }
  const material = ownLeaf() ?? ensureSelfSigned(i.root, i.boundLan);
  if (isRefusal(material)) {
    console.warn(`${logTag} LAN TLS off: ${material.refused}. The plain host still runs.`);
    return null;
  }
  return { port: plan.port, addrs: plan.addrs, material };
}

let live: (LanTlsFacts & { selfSigned: boolean }) | null = null;

/** The live listener's port and pin, or null: nothing is advertised until a socket is really bound. */
export function lanTlsFacts(): LanTlsFacts | null {
  return live && { port: live.port, spki: live.spki };
}

/** Whether the live leaf is self-signed. False with no listener, so ask it about a TLS socket. */
export function lanTlsSelfSigned(): boolean {
  return live?.selfSigned ?? false;
}

/**
 * A self-signed port does not serve the web app: a browser click-through would read as protected and
 * is not (the phone pins the key instead). True for a request on a TLS socket while the live leaf is
 * self-signed; false on the plain port and with a person's own leaf. `server/http.ts` asks it for
 * every static path; `/api/*`, `/ws` and `/pair/*` never reach it.
 */
export function selfSignedNoticeFor(socket: object): boolean {
  return isEncryptedSocket(socket) && lanTlsSelfSigned();
}

/** The page that stands in for the app there. It names no desktop, user, path or version. */
export const SELF_SIGNED_NOTICE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Not a web page</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">This port is for the app</h1><p>This address is used by the phone app, which checks the desktop by its key. A browser cannot check it, so the web app is not served here.</p><p>To use the web app from a browser, open the desktop over Tailscale, or on its own screen.</p></body></html>`;

/** The same safe headers as the pair pages. */
export const SELF_SIGNED_NOTICE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** `welcome`'s two optional fields (8a), absent with no listener. */
export function lanTlsWelcome(): { tlsPort?: number; tlsSpki?: string } {
  return live ? { tlsPort: live.port, tlsSpki: live.spki } : {};
}

/**
 * `listenWithRetry`'s shape, except the ending: that one exits, because a host with no port is no
 * host. This port is the optional one, so busy to the end means log and carry on plain. It stays
 * armed after listening: an unhandled `error` on this server would take the daemon with it.
 */
export function listenOrCarryOn(
  server: Server, host: string, port: number, onUp: () => void,
  o: { attempts?: number; delayMs?: number } = {},
): void {
  const delayMs = o.delayMs ?? 500;
  const attempt = (left: number): void => {
    const failed = (e: NodeJS.ErrnoException): void => {
      if (e.code === "EADDRINUSE" && left > 0) {
        if (left % 5 === 0) console.warn(`${logTag} ${host}:${port} busy, retrying… (${left} left)`);
        setTimeout(() => attempt(left - 1), delayMs).unref();
        return;
      }
      console.error(`${logTag} LAN TLS: cannot bind ${host}:${port} (${e.code || e}); carrying on plain.`);
    };
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      server.on("error", (e) => console.error(`${logTag} LAN TLS listener ${host}:${port}: ${e.message}`));
      onUp();
    });
  };
  attempt(o.attempts ?? 20);
}

/**
 * One `https` server per planned address, on the handler and the socket wiring every bind shares.
 * `attachWs` hands back the `WebSocketServer`, because `ws` re-emits its server's `error` there:
 * unheard, that is an uncaught EADDRINUSE, which `shutdown.ts` rightly treats as fatal for the
 * plain port. Heard here, and answered by `listenOrCarryOn`.
 */
export function startLanTls(
  ready: LanTlsReady, handler: RequestListener, attachWs: (server: Server) => EventEmitter,
  o?: { attempts?: number; delayMs?: number },
): Server[] {
  const { keyPem: key, certPem: cert, spki, selfSigned } = ready.material;
  return ready.addrs.map((host) => {
    const server = createServer({ key, cert, minVersion: "TLSv1.2" }, handler);
    attachWs(server).on("error", () => { /* the server's own listener says it */ });
    listenOrCarryOn(server, host, ready.port, () => {
      live = { port: ready.port, spki, selfSigned };
      console.log(`${logTag} listening https://${host}:${ready.port}  (LAN TLS, pin ${pinShort(spki)})`);
    }, o);
    return server;
  });
}

/** The pin in `lan-tls.json` without touching it, for the doctor; null when there is none yet. */
function storedPin(root: string): string | null {
  try {
    const key = p256((JSON.parse(readFileSync(lanTlsFile(root), "utf8")) as Stored).key);
    return key && spkiPin(createPublicKey(key));
  } catch { return null; }
}

/** The doctor's row. It reads and never writes: no key minted, no port bound. */
export function lanTlsDoctor(i: Parameters<typeof lanTlsPlan>[0] & { root: string }): { status: "ok" | "warn"; detail: string; fix?: string } {
  const plan = lanTlsPlan(i);
  if ("why" in plan) {
    return plan.problem
      ? { status: "warn", detail: `LAN TLS off: ${plan.why}`, fix: `Fix ${envName("TLS_PORT")}. The plain host still runs.` }
      : { status: "ok", detail: `LAN TLS off: ${plan.why}` };
  }
  const own = ownLeaf();
  if (own && isRefusal(own)) {
    return { status: "warn", detail: `LAN TLS off: ${own.refused}`, fix: `Fix ${envName("TLS_CERT")} and ${envName("TLS_KEY")}, or unset both to use the generated key. The plain host still runs.` };
  }
  const pin = own ? own.spki : storedPin(i.root);
  return { status: "ok", detail: `LAN TLS on, port ${plan.port}, ${own ? "own leaf, " : ""}${pin ? `pin ${pinShort(pin)}` : "pin minted when the host starts"}` };
}
