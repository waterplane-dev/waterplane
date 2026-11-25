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
 * like every other bind, so a re-issue happens at boot. The certificate is built here (`x509.ts`,
 * signed with `node:crypto`): no dependency, no `openssl` at run time.
 *
 * `<PREFIX>_TLS_CERT` + `<PREFIX>_TLS_KEY` use a person's own leaf (from a local CA) instead and
 * leave `lan-tls.json` alone. A broken one refuses the TLS listener and says why; the plain host
 * still runs, because a typo in an optional knob must not take the desktop off the network.
 *
 * A browser certificate (`lanca.ts`) is a second leaf on the generated key, presented to a handshake
 * that asks for its one name and to no other. Read once, at boot: a renewal or a removal counts from
 * the next start, and a request never opens the file. One that cannot be served is one log line.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import type { EventEmitter } from "node:events";
import { chmodSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createSecureContext, type SecureContext, type TLSSocket } from "node:tls";
import type { RequestListener } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRAND, envName, logTag } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { env } from "./env.js";
import { browserCertFile, dialedFix, dialedNameRefusal, isBrowserCertProblem, issueLine, readBrowserCert, type BrowserLeaf } from "./lanca.js";
import { isEncryptedSocket, noteTlsServerName, tlsServerName } from "./net.js";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import { BACKDATE_MS, certPem, DAY_MS, dnsName, ext, ipAddress, ipv4, keyIdOf, randomSerial, signCertificate, spkiDer, spkiPin } from "./x509.js";

export { spkiPin };

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

/** How a person reads a pin in a log line or the doctor. */
export const pinShort = (spki: string): string => spki.slice(0, 16);

/** Long enough that a re-issue is rare, and the 825 days a platform verifier still accepts. */
const VALID_DAYS = 825;
/** Re-issued at boot once this close to the end, so a phone that does check the date never meets an expired one. */
const RENEW_DAYS = 30;

/** A self-signed leaf for `ips` + `names` on `key`, as PEM. Signed, not trusted: its worth is the pin. */
export function issueLeaf(key: KeyObject, ips: string[], names: string[], now: Date = new Date()): string {
  const spki = spkiDer(createPublicKey(key));
  const keyId = keyIdOf(spki);
  return certPem(signCertificate({
    serial: randomSerial(),
    issuer: `${BRAND.name} LAN`,
    subject: `${BRAND.name} LAN`,
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + VALID_DAYS * DAY_MS),
    spki,
    extensions: [
      ext.notCa(),
      ext.digitalSignature(),
      ext.serverAuth(),
      ext.subjectKeyId(keyId),
      ext.authorityKeyId(keyId),
      ext.subjectAltName([...names.map(dnsName), ...ips.flatMap((ip) => { const b = ipv4(ip); return b ? [ipAddress(b)] : []; })]),
    ],
  }, key));
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
  const read = readJsonGuardedDetail<Stored | null>(file, null, (v) => p256((v as Stored | null)?.key) !== null, { keepUnreadable: true });
  if (read.corrupt?.unreadable) return { refused: `${file} could not be read (${read.corrupt.error})` };
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

/** `browser`: the certificate for the one name a browser may open this port by, when there is one to serve. */
export interface LanTlsReady { port: number; addrs: string[]; material: LanTlsMaterial; browser?: BrowserLeaf | null }

/** The two knobs that put a person's own leaf on the port. Either one set is enough to shadow the browser certificate. */
const ownLeafKnobs = (): boolean => Boolean(env("TLS_CERT") || env("TLS_KEY"));

/**
 * The browser certificate this boot serves beside the generated leaf, or null with one line saying
 * why (silent when none was ever issued). It only reads, and nothing about it can throw past here:
 * the app's listener does not depend on it.
 */
export function browserLeafFor(root: string, material: LanTlsMaterial, now: Date = new Date()): BrowserLeaf | null {
  const off = (why: string): null => { console.warn(`${logTag} LAN TLS: the browser certificate is not served: ${why}`); return null; };
  try {
    const c = readBrowserCert(root, createPrivateKey(material.keyPem), now);
    if (isBrowserCertProblem(c) && c.problem === "missing") return null;
    if (ownLeafKnobs()) return off(`${envName("TLS_CERT")} and ${envName("TLS_KEY")} take the port.`);
    if (isBrowserCertProblem(c)) return off(`${c.why}. ${c.fix}`);
    const dialed = dialedNameRefusal(c.name);
    if (dialed) return off(`${dialed} Remove it with \`lan-cert remove\` or issue one for another name.`);
    createSecureContext({ key: material.keyPem, cert: c.certPem }); // the TLS library has the last word
    return c;
  } catch (e) {
    return off(`${browserCertFile(root)} cannot be used (${(e as NodeJS.ErrnoException).code ?? "unknown error"}).`);
  }
}

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
  return { port: plan.port, addrs: plan.addrs, material, browser: browserLeafFor(i.root, material) };
}

let live: (LanTlsFacts & { selfSigned: boolean; browserName: string | null; browserUntil: number | null }) | null = null;

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
 * self-signed; false on the plain port, with a person's own leaf, and where the handshake asked for the
 * browser certificate's name, the one name a browser can check. `server/http.ts` asks it for
 * every static path; `/api/*`, `/ws` and `/pair/*` never reach it.
 */
export function selfSignedNoticeFor(socket: object): boolean {
  if (!isEncryptedSocket(socket) || !lanTlsSelfSigned()) return false;
  return !live?.browserName || tlsServerName(socket) !== live.browserName;
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
 * `welcome`'s `tlsName` + `tlsNameUntil` (ms epoch of the certificate's end): only for a socket whose own
 * handshake asked for the browser certificate's name, so a phone, a tailnet browser or a plain socket is
 * told nothing. Absent with no listener or no browser certificate.
 */
export function lanTlsExpiry(socket: object | undefined): { tlsName?: string; tlsNameUntil?: number } {
  if (!socket || !live?.browserName || live.browserUntil === null || !isEncryptedSocket(socket)) return {};
  return tlsServerName(socket) === live.browserName ? { tlsName: live.browserName, tlsNameUntil: live.browserUntil } : {};
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
  const browser = ready.browser ?? null;
  const named = browser && createSecureContext({ key, cert: browser.certPem, minVersion: "TLSv1.2" });
  // Exactly the name, spelled as a browser spells it. Anything else (an address, another name, no
  // SNI) is left on the default context: the leaf the phones pin, as with no browser certificate.
  const SNICallback = (asked: string, cb: (err: Error | null, ctx?: SecureContext) => void): void =>
    cb(null, named && asked === browser!.name ? named : undefined);
  return ready.addrs.map((host) => {
    const server = createServer({ key, cert, minVersion: "TLSv1.2", ...(named ? { SNICallback } : {}) }, handler);
    // Before `https`'s own listener hands the socket to the parser: no request is read unnamed.
    if (named) server.prependListener("secureConnection", (s: TLSSocket) => noteTlsServerName(s));
    attachWs(server).on("error", () => { /* the server's own listener says it */ });
    listenOrCarryOn(server, host, ready.port, () => {
      live = { port: ready.port, spki, selfSigned, browserName: browser?.name ?? null, browserUntil: browser?.notAfter.getTime() ?? null };
      console.log(`${logTag} listening https://${host}:${ready.port}  (LAN TLS, pin ${pinShort(spki)})${browser ? `, for browsers https://${browser.name}:${ready.port} until ${browser.notAfter.toISOString().slice(0, 10)}` : ""}`);
    }, o);
    return server;
  });
}

/**
 * The key in `lan-tls.json`, read and never minted, moved aside or rewritten: for the doctor and for
 * `lan-cert`, which puts a second certificate on it (`lanca.ts`). `missing` is a host that has not
 * served TLS yet, as against a file that is there and does not read.
 */
export function readLanTlsKey(root: string): KeyObject | (LanTlsRefusal & { missing: boolean }) {
  const file = lanTlsFile(root);
  try {
    const key = p256((JSON.parse(readFileSync(lanTlsFile(root), "utf8")) as Stored).key);
    return key ?? { refused: `${file} holds no usable key`, missing: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A parse error's message quotes the file, which holds a private key: only a file-system code is said.
    return { refused: code === "ENOENT" ? `${file} does not exist` : `${file} could not be read (${code ?? "not JSON"})`, missing: code === "ENOENT" };
  }
}

/** The pin in `lan-tls.json` without touching it; null when there is none yet. */
function storedPin(root: string): string | null {
  const key = readLanTlsKey(root);
  return isRefusal(key) ? null : spkiPin(createPublicKey(key));
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

/** A browser certificate this close to its end is worth a line: each renewal is a visit to every laptop. */
const BROWSER_WARN_DAYS = 30;

/** The doctor's row for the browser certificate, or null when none was issued. It only reads. */
export function lanBrowserDoctor(i: Parameters<typeof lanTlsPlan>[0] & { root: string }, now: Date = new Date()): { status: "ok" | "warn"; detail: string; fix?: string } | null {
  const key = readLanTlsKey(i.root);
  const c = readBrowserCert(i.root, isRefusal(key) ? null : key, now);
  if (isBrowserCertProblem(c) && c.problem === "missing") return null;
  const name = (isBrowserCertProblem(c) ? c.was : c)?.name;
  const what = `browser certificate${name ? ` for ${name}` : ""}`;
  if (ownLeafKnobs()) {
    return { status: "warn", detail: `${what} is not served: ${envName("TLS_CERT")} and ${envName("TLS_KEY")} take the port`, fix: `Unset both and restart the host to serve it, or delete it with \`${BRAND.slug} lan-cert remove\`.` };
  }
  // The dialed-name check comes first: for such a name `issue --name <it>` is refused, so a problem's own fix would send a person in a circle.
  const dialed = name ? dialedNameRefusal(name) : null;
  if (dialed && name) return { status: "warn", detail: `${what} is not served: ${dialed}`, fix: dialedFix(name, BRAND.slug) };
  if (isBrowserCertProblem(c)) return { status: "warn", detail: `${what} is not served: ${c.why}`, fix: c.fix };
  if (isRefusal(key)) return { status: "warn", detail: `${what} cannot be checked: ${key.refused}`, fix: "Restore that file. A new key needs a new browser certificate, and every phone paired again." };
  const left = `${c.daysLeft} ${c.daysLeft === 1 ? "day" : "days"} left`;
  if (c.daysLeft <= BROWSER_WARN_DAYS) return { status: "warn", detail: `${what}, ${left}`, fix: `${issueLine(c.name)} Restart the host in between.` };
  const plan = lanTlsPlan(i);
  if ("why" in plan) return { status: plan.problem ? "warn" : "ok", detail: `${what}, ${left}, not served: LAN TLS off: ${plan.why}` };
  return { status: "ok", detail: `${what}, ${left}, https://${c.name}:${plan.port}` };
}
