/**
 * The X.509 writer behind `lantls.ts` (the self-signed leaf a phone pins) and `lanca.ts` (the CA and
 * the leaf a browser trusts): names, extensions and the signed certificate, over `der.ts`. P-256 and
 * ecdsa-with-SHA256 only. Like `der.ts` it writes and never parses.
 */
import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { bitString, boolTrue, integer, octetString, oid, seq, set, time, tlv, utf8String } from "./der.js";

const OID = {
  commonName: "2.5.4.3",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyId: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

export const DAY_MS = 86_400_000;
/** The desktop's clock and the reader's are never equal. */
export const BACKDATE_MS = 3_600_000;

export const spkiDer = (publicKey: KeyObject): Buffer => publicKey.export({ type: "spki", format: "der" });

/** The pin (8a): lowercase hex SHA-256 of the SPKI DER. */
export function spkiPin(publicKey: KeyObject): string {
  return createHash("sha256").update(spkiDer(publicKey)).digest("hex");
}

/** RFC 7093 §2 method 1: the leftmost 160 bits of the SHA-256 of the subjectPublicKey bits,
 *  which for P-256 are the 65-byte uncompressed point that ends the SPKI. */
export function keyIdOf(spki: Buffer): Buffer {
  return createHash("sha256").update(spki.subarray(spki.length - 65)).digest().subarray(0, 20);
}

/** Positive, and full length. */
export function randomSerial(): Buffer {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  return serial;
}

const extension = (id: string, critical: boolean, value: Uint8Array): Buffer =>
  seq(oid(id), ...(critical ? [boolTrue()] : []), octetString(value));

/** An IPv4 address as its four bytes, or null. */
export function ipv4(ip: string): Buffer | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Buffer.from(p) : null;
}

/** A name in a SAN or a constraint: `[2]` dNSName and `[7]` iPAddress, both primitive. */
export const dnsName = (n: string): Buffer => tlv(0x82, Buffer.from(n, "ascii"));
export const ipAddress = (bytes: Uint8Array): Buffer => tlv(0x87, bytes);

export const ext = {
  /** Critical. cA defaults to FALSE, so an end entity's is an empty sequence. */
  notCa: (): Buffer => extension(OID.basicConstraints, true, seq()),
  /** Critical, CA:TRUE, pathlen:0: it signs leaves and no other CA. */
  ca: (): Buffer => extension(OID.basicConstraints, true, seq(boolTrue(), integer(Buffer.from([0])))),
  /** Critical. Bit 0 and bit 5 of the named-bit list. */
  digitalSignature: (): Buffer => extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
  keyCertSign: (): Buffer => extension(OID.keyUsage, true, bitString(Buffer.from([0x04]), 2)),
  serverAuth: (): Buffer => extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
  subjectKeyId: (id: Uint8Array): Buffer => extension(OID.subjectKeyId, false, octetString(id)),
  authorityKeyId: (id: Uint8Array): Buffer => extension(OID.authorityKeyId, false, seq(tlv(0x80, id))),
  subjectAltName: (names: Uint8Array[]): Buffer => extension(OID.subjectAltName, false, seq(...names)),
  /** Critical. Each subtree is a GeneralSubtree whose minimum defaults to 0; `[0]` permitted, `[1]` excluded. */
  nameConstraints: (permitted: Uint8Array[], excluded: Uint8Array[]): Buffer =>
    extension(OID.nameConstraints, true, seq(tlv(0xa0, ...permitted.map((n) => seq(n))), tlv(0xa1, ...excluded.map((n) => seq(n))))),
};

export interface CertSpec {
  serial: Buffer;
  /** Common names; each is the whole distinguished name. */
  issuer: string;
  subject: string;
  notBefore: Date;
  notAfter: Date;
  /** The subject's SPKI DER. */
  spki: Buffer;
  extensions: Buffer[];
}

const distinguishedName = (cn: string): Buffer => seq(set(seq(oid(OID.commonName), utf8String(cn))));

/** `spec` signed by `signer`, as DER. */
export function signCertificate(spec: CertSpec, signer: KeyObject): Buffer {
  const signatureAlgorithm = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(spec.serial),
    signatureAlgorithm,
    distinguishedName(spec.issuer),
    seq(time(spec.notBefore), time(spec.notAfter)),
    distinguishedName(spec.subject),
    spec.spki,
    tlv(0xa3, seq(...spec.extensions)),
  );
  return seq(tbs, signatureAlgorithm, bitString(sign("sha256", tbs, signer)));
}

export function certPem(der: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END CERTIFICATE-----\n`;
}
