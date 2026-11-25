/**
 * The certificate a laptop's BROWSER trusts on the LAN: a CA for one name and one leaf under it.
 *
 * The leaf is on the key the phones pin (`lan-tls.json`, `lantls.ts`), so issuing, renewing or removing
 * it moves no pin: a phone pins the key and reads no certificate.
 *
 * The CA's private key lives in `issueBrowserCert` and nowhere else: made there, used for two
 * signatures and dropped, never exported, stored, logged or returned. So nothing can sign a second
 * leaf, not even this desktop, and a renewal is a new CA that each laptop trusts again. The
 * constraints in the CA (one name, no address, server certificates only, no CA below it) are the
 * second line behind that.
 *
 * `<state dir>/lan-browser.json` (0600, public bytes only) is written by `lan-cert` (`cli/lancert.ts`)
 * and only read here. What a reader gets is derived from the certificates in it: the other fields
 * are there for a person looking at the file.
 */
import { createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRAND, envName } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { env } from "./env.js";
import { BACKDATE_MS, certPem, DAY_MS, dnsName, ext, ipAddress, keyIdOf, randomSerial, signCertificate, spkiDer, spkiPin } from "./x509.js";

/** Under the 398 days a browser may hold a certificate to, and the 825 of an Apple user root. */
export const BROWSER_CERT_DAYS = 397;

/** Zones that are never public, so no public CA and no stranger owns a name in them. */
const PRIVATE_ZONES = [".home.arpa", ".local", ".lan", ".internal", ".fritz.box"];
/** The zone itself, or the router's own name: a certificate for it would cover every name below. */
const ZONE_ITSELF = new Set(["home.arpa", "fritz.box"]);
/** X.520 caps a common name at 64 characters, and the CA's is this name inside `caCommonName`. */
const MAX_NAME = 64 - `${BRAND.name}  12345678`.length;

const caCommonName = (name: string, keyId: Buffer): string => `${BRAND.name} ${name} ${keyId.toString("hex").slice(0, 8)}`;

/** Why `name` cannot be the browser's name for this desktop, as a sentence with the way out, or null. */
export function browserNameRefusal(name: string, anyName = false): string | null {
  const way = "Choose a name like desk.home.arpa.";
  if (isIP(name.replace(/^\[|\]$/g, ""))) return `"${name}" is an address. The certificate is for a name, so that a passkey made there keeps working when the address changes. ${way}`;
  if (name.includes("*")) return `"${name}" is a wildcard. The certificate is for one name. ${way}`;
  if (name.endsWith(".")) return `"${name}" ends in a dot. Leave the dot off.`;
  const labels = name.split(".");
  if (name === "localhost" || labels.at(-1) === "localhost") return `"${name}" always means the machine the browser runs on, never this desktop. ${way}`;
  if (labels.length < 2) return `"${name}" is a single word. ${way}`;
  if (!labels.every((l) => l.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return `"${name}" is not a host name: lower-case letters, digits and hyphens between dots. ${way}`;
  if (/^\d+$/.test(labels.at(-1)!)) return `"${name}" reads as an address, because it ends in a number. ${way}`;
  if (name.length > MAX_NAME) return `"${name}" is ${name.length} characters, and a certificate's name field leaves room for ${MAX_NAME}. ${way}`;
  if (name === "ts.net" || name.endsWith(".ts.net")) return `"${name}" is a Tailscale name, which gets a real certificate from \`tailscale serve\`. ${way}`;
  if (ZONE_ITSELF.has(name)) return `"${name}" is a whole zone, not one machine. ${way}`;
  if (!anyName && !PRIVATE_ZONES.some((z) => name.endsWith(z))) {
    return `"${name}" is outside the private zones (${PRIVATE_ZONES.join(", ")}), so it may belong to somebody on the internet. ${way} If the name is yours, pass --any-name.`;
  }
  return null;
}

/**
 * The names a phone already dials this desktop by, as the origin guard trusts them: this machine's
 * own name with and without `.local`, and everything in ALLOWED_HOSTS. A browser certificate for one
 * of them would hand the app's WebView the browser rules on the TLS port (its `Origin` is
 * `http://localhost` or `capacitor://localhost`), so it is never issued or served.
 */
export function dialedNames(host: string = hostname()): Set<string> {
  const names = new Set<string>();
  const self = host.toLowerCase().replace(/\.local$/, "");
  for (const n of [self, self.split(".")[0]]) if (n) { names.add(n); names.add(`${n}.local`); }
  for (const h of (env("ALLOWED_HOSTS") ?? "").split(",")) { const t = h.trim().toLowerCase(); if (t) names.add(t); }
  return names;
}

/** Why `name` cannot be the browser's name because phones already open this desktop by it, or null. */
export function dialedNameRefusal(name: string): string | null {
  if (!dialedNames().has(name.toLowerCase())) return null;
  return `"${name}" is a name the phone app already opens this desktop by, and a certificate for it would lock the app out of the TLS port. Choose another name, like desk.home.arpa, and keep ${envName("ALLOWED_HOSTS")} for the app's names.`;
}

/**
 * What to do about a held certificate whose name phones now dial. Taking the name out of ALLOWED_HOSTS
 * serves the same certificate again, so it comes first; removing it loses the CA every laptop trusts.
 */
export function dialedFix(name: string, slug: string): string {
  const fromHosts = (env("ALLOWED_HOSTS") ?? "").split(",").some((h) => h.trim().toLowerCase() === name.toLowerCase());
  const keep = fromHosts
    ? `Take ${name} out of ${envName("ALLOWED_HOSTS")} and restart the host, and this certificate is served again unchanged. `
    : `${name} is this desktop's own name, so it cannot be served. `;
  return `${keep}To use another name instead, run \`${slug} lan-cert remove\`, then \`${slug} lan-cert issue --name <another name>\` (every laptop then trusts the new certificate again).`;
}

/** What `lan-browser.json` holds. No private key, ever. */
export interface BrowserCert {
  v: 1;
  name: string;
  /** The leaf, and the CA it chains to, as PEM. */
  cert: string;
  caCert: string;
  /** The CA's fingerprints, upper-case hex: how `Get-FileHash` and `certutil` print them. */
  caSha256: string;
  caSha1: string;
  /** ISO 8601, UTC. */
  notAfter: string;
  /** The leaf's pin, which is the phones' pin of this desktop. */
  spki: string;
}

const hex = (fingerprint: string): string => fingerprint.replaceAll(":", "");
/** The DER of a PEM certificate: what `ca.cer` is. */
export const certDer = (pem: string): Buffer => Buffer.from(new X509Certificate(pem).raw);

/**
 * A new CA for `name` and one leaf under it, on `leafKey`. The CA key is a local of this function;
 * nothing below exports it, and no error here carries more than its own sentence.
 */
export function issueBrowserCert(leafKey: KeyObject, name: string, now: Date = new Date()): BrowserCert {
  const bad = browserNameRefusal(name, true);
  if (bad) throw new Error(bad);
  if (leafKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the leaf key is not P-256");
  const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const caSpki = spkiDer(ca.publicKey);
  const caId = keyIdOf(caSpki);
  // Unique per issue, so an old root never stands in for this one when a chain is built by name.
  const issuer = caCommonName(name, caId);
  const notBefore = new Date(now.getTime() - BACKDATE_MS);
  const notAfter = new Date(now.getTime() + BROWSER_CERT_DAYS * DAY_MS);
  const caCert = certPem(signCertificate({
    serial: randomSerial(), issuer, subject: issuer, notBefore, notAfter, spki: caSpki,
    extensions: [
      ext.ca(),
      ext.keyCertSign(),
      ext.serverAuth(),
      // Permitting only a dNSName leaves addresses unconstrained, hence both address families excluded whole.
      ext.nameConstraints([dnsName(name)], [ipAddress(Buffer.alloc(8)), ipAddress(Buffer.alloc(32))]),
      ext.subjectKeyId(caId),
    ],
  }, ca.privateKey));
  const leafPublic = createPublicKey(leafKey);
  const leafSpki = spkiDer(leafPublic);
  const cert = certPem(signCertificate({
    serial: randomSerial(), issuer, subject: name, notBefore, notAfter, spki: leafSpki,
    extensions: [
      ext.notCa(),
      ext.digitalSignature(),
      ext.serverAuth(),
      ext.subjectKeyId(keyIdOf(leafSpki)),
      ext.authorityKeyId(caId),
      ext.subjectAltName([dnsName(name)]),
    ],
  }, ca.privateKey));
  const x = new X509Certificate(caCert);
  return { v: 1, name, cert, caCert, caSha256: hex(x.fingerprint256), caSha1: hex(x.fingerprint), notAfter: new X509Certificate(cert).validToDate.toISOString(), spki: spkiPin(leafPublic) };
}

export function browserCertFile(root: string): string {
  return join(hostStateDir(root), "lan-browser.json");
}

/** A certificate that can be served, every field read off the certificates themselves. */
export interface BrowserLeaf {
  name: string;
  /** The leaf alone: a browser that trusts the CA has it, and one that does not gains nothing from it. */
  certPem: string;
  caSha256: string;
  caSha1: string;
  notAfter: Date;
  /** Whole days left, rounded down; negative once expired. */
  daysLeft: number;
  spki: string;
}

/**
 * Why a stored certificate is not served. `expired` carries what it was, so that a renewal can be
 * named; `why` is the reason alone and `fix` the way out.
 */
export interface BrowserCertProblem { problem: "missing" | "unreadable" | "invalid" | "foreign-key" | "expired"; why: string; fix: string; was?: BrowserLeaf }

export const isBrowserCertProblem = (v: object): v is BrowserCertProblem => "problem" in v;

/** How a person gets a certificate, or a new one. */
export const issueLine = (name = "desk.home.arpa"): string => `Run \`${BRAND.slug} lan-cert issue --name ${name}\` on the desktop, then trust the new certificate on each laptop.`;

/** A parsed file against the desktop's key and the clock. Pure. `key` null: the key is not checked (`show`, `remove`). */
export function checkBrowserCert(raw: unknown, key: KeyObject | null, now: Date = new Date()): BrowserLeaf | BrowserCertProblem {
  const s = raw as Partial<BrowserCert> | null;
  const invalid = (why: string): BrowserCertProblem => ({ problem: "invalid", why, fix: issueLine() });
  if (!s || typeof s !== "object" || s.v !== 1 || typeof s.name !== "string" || typeof s.cert !== "string" || typeof s.caCert !== "string") return invalid("not a browser certificate file");
  if (browserNameRefusal(s.name, true)) return invalid("its name is not one that can be served");
  let leaf: X509Certificate;
  let ca: X509Certificate;
  try { leaf = new X509Certificate(s.cert); ca = new X509Certificate(s.caCert); } catch { return invalid("a certificate in it does not parse"); }
  if (leaf.ca || leaf.subjectAltName !== `DNS:${s.name}`) return invalid(`its certificate is not for ${s.name} alone`);
  if (!ca.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return invalid("its certificate was not signed by the CA beside it");
  const notAfter = leaf.validToDate;
  const out: BrowserLeaf = {
    name: s.name, certPem: certPem(Buffer.from(leaf.raw)), caSha256: hex(ca.fingerprint256), caSha1: hex(ca.fingerprint),
    notAfter, daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS), spki: spkiPin(leaf.publicKey),
  };
  if (key && !leaf.checkPrivateKey(key)) return { problem: "foreign-key", why: "it is on another key than this desktop's", fix: issueLine(s.name), was: out };
  if (notAfter.getTime() <= now.getTime()) return { problem: "expired", why: `it expired on ${notAfter.toISOString().slice(0, 10)}`, fix: issueLine(s.name), was: out };
  return out;
}

/** `lan-browser.json`, read and checked. It never writes, moves or repairs the file. */
export function readBrowserCert(root: string, key: KeyObject | null, now: Date = new Date()): BrowserLeaf | BrowserCertProblem {
  let text: string;
  try { text = readFileSync(browserCertFile(root), "utf8"); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { problem: "missing", why: "no browser certificate has been issued", fix: issueLine() }
      : { problem: "unreadable", why: `${browserCertFile(root)} could not be read (${code ?? "unknown error"})`, fix: "Make the file readable by the user the host runs as, or issue a new certificate." };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { problem: "invalid", why: "not JSON", fix: issueLine() }; }
  return checkBrowserCert(raw, key, now);
}
