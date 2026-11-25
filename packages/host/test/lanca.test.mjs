/**
 * The browser's certificate (`lanca.ts`, `x509.ts`): what is in it, what it can and cannot sign for,
 * and what a reader of `lan-browser.json` accepts. `openssl verify` is asked where there is one,
 * because a constraint that only our own writer understands constrains nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND, envName } from "@waterplane/shared";
import { ensureSelfSigned, issueLeaf, lanTlsFile, readLanTlsKey, spkiPin } from "../dist/lantls.js";
import { BROWSER_CERT_DAYS, browserCertFile, browserNameRefusal, certDer, checkBrowserCert, dialedNameRefusal, isBrowserCertProblem, issueBrowserCert, readBrowserCert } from "../dist/lanca.js";
import { certPem, dnsName, ext, ipAddress, keyIdOf, randomSerial, signCertificate, spkiDer } from "../dist/x509.js";

const scratch = mkdtempSync(join(tmpdir(), "lanca-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const r = join(scratch, `d${n++}`); mkdirSync(r); return r; };
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const NAME = "desk.home.arpa";
const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = 86_400_000;

/** One DER value: its tag, its content, and where the next one starts. */
function der(b, at = 0) {
  let i = at + 1;
  let len = b[i++];
  if (len & 0x80) { let k = len & 0x7f; len = 0; while (k--) len = len * 256 + b[i++]; }
  return { tag: b[at], body: b.subarray(i, i + len), end: i + len };
}
function children(b) {
  const out = [];
  for (let at = 0; at < b.length;) { const d = der(b, at); out.push(d); at = d.end; }
  return out;
}
/** The raw extension list of a certificate, and each as { oid hex, critical, value }. */
function extensionsOf(raw) {
  const tbs = children(children(der(raw).body)[0].body);
  const block = children(tbs.find((c) => c.tag === 0xa3).body)[0].body;
  const list = children(block).map((e) => {
    const p = children(e.body);
    return { oid: p[0].body.toString("hex"), critical: p.length === 3 && p[1].body[0] === 0xff, value: p.at(-1).body };
  });
  return { block, list, get: (hex) => list.find((e) => e.oid === hex) };
}
const SKI = "551d0e", KU = "551d0f", SAN = "551d11", BC = "551d13", NC = "551d1e", AKI = "551d23", EKU = "551d25";

test("issueLeaf is byte-identical to what the phones' certificate always was, up to serial and signature", () => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.alloc(32, 7));
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: Buffer.alloc(32, 7).toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
  const raw = new X509Certificate(issueLeaf(key, ["10.0.0.7", "192.168.1.20"], ["mac.local"], NOW)).raw;
  const tbs = Buffer.from(raw.subarray(4, 8 + raw.readUInt16BE(6)));
  assert.equal(tbs.subarray(0, 11).toString("hex"), "3082016fa003020102" + "0210");
  tbs.fill(0, 11, 27); // the serial
  // Recorded from the writer before it moved into x509.ts.
  assert.equal(createHash("sha256").update(tbs).digest("hex"), "ee628d63932a58c6d510f33122dcbf6777802d2412c9495202229f889af68348");
});

test("the CA: one name, no address, server certificates only, no CA below it, and every limit critical", () => {
  const c = issueBrowserCert(p256(), NAME, NOW);
  const x = new X509Certificate(c.caCert);
  assert.equal(x.ca, true);
  assert.equal(x.verify(x.publicKey), true, "self-signed");
  assert.equal(x.subject, `CN=${BRAND.name} ${NAME} ${keyIdOf(spkiDer(x.publicKey)).toString("hex").slice(0, 8)}`);
  const e = extensionsOf(x.raw);
  assert.deepEqual(e.list.map((i) => [i.oid, i.critical]), [[BC, true], [KU, true], [EKU, false], [NC, true], [SKI, false]]);
  assert.equal(e.get(BC).value.toString("hex"), "30060101ff020100", "CA:TRUE, pathlen:0");
  assert.equal(e.get(KU).value.toString("hex"), "03020204", "keyCertSign alone");
  assert.deepEqual(x.keyUsage, ["1.3.6.1.5.5.7.3.1"], "serverAuth alone");
  const permitted = Buffer.concat([Buffer.from([0x30, 16, 0x82, 14]), Buffer.from(NAME)]);
  const excluded = Buffer.concat([Buffer.from([0x30, 10, 0x87, 8]), Buffer.alloc(8), Buffer.from([0x30, 34, 0x87, 32]), Buffer.alloc(32)]);
  const body = Buffer.concat([Buffer.from([0xa0, permitted.length]), permitted, Buffer.from([0xa1, excluded.length]), excluded]);
  assert.deepEqual(e.get(NC).value, Buffer.concat([Buffer.from([0x30, body.length]), body]));
});

test("the leaf: on the desktop's key, for the one name, tied to its CA by key id", () => {
  const key = p256();
  const c = issueBrowserCert(key, NAME, NOW);
  const leaf = new X509Certificate(c.cert);
  const ca = new X509Certificate(c.caCert);
  assert.equal(leaf.checkPrivateKey(key), true);
  assert.equal(c.spki, spkiPin(createPublicKey(key)), "the phones' pin");
  assert.equal(leaf.ca, false);
  assert.equal(leaf.subject, `CN=${NAME}`);
  assert.equal(leaf.issuer, ca.subject);
  assert.equal(leaf.subjectAltName, `DNS:${NAME}`);
  assert.equal(leaf.verify(ca.publicKey), true);
  const e = extensionsOf(leaf.raw);
  assert.deepEqual(e.list.map((i) => [i.oid, i.critical]), [[BC, true], [KU, true], [EKU, false], [SKI, false], [AKI, false], [SAN, false]]);
  assert.equal(e.get(BC).value.toString("hex"), "3000");
  assert.equal(e.get(KU).value.toString("hex"), "03020780", "digitalSignature alone");
  const caId = extensionsOf(ca.raw).get(SKI).value.subarray(2);
  assert.deepEqual(caId, keyIdOf(spkiDer(ca.publicKey)));
  assert.deepEqual(e.get(AKI).value, Buffer.concat([Buffer.from([0x30, 22, 0x80, 20]), caId]), "keyid only, the CA's own");
  assert.deepEqual(e.get(SKI).value.subarray(2), keyIdOf(spkiDer(leaf.publicKey)));
});

test("dates, fingerprints and serials: 397 days, an hour back, and nothing repeats between two issues", () => {
  const key = p256();
  const [a, b] = [issueBrowserCert(key, NAME, NOW), issueBrowserCert(key, NAME, NOW)];
  for (const c of [a, b]) {
    for (const pem of [c.cert, c.caCert]) {
      const x = new X509Certificate(pem);
      assert.equal(x.validFromDate.getTime(), NOW.getTime() - 3_600_000);
      assert.equal(x.validToDate.getTime(), NOW.getTime() + BROWSER_CERT_DAYS * DAY);
      assert.equal(x.serialNumber.length, 32);
    }
    assert.equal(c.notAfter, "2027-12-26T12:00:00.000Z");
    assert.equal(c.caSha256, createHash("sha256").update(certDer(c.caCert)).digest("hex").toUpperCase(), "what Get-FileHash prints for ca.cer");
    assert.equal(c.caSha1, createHash("sha1").update(certDer(c.caCert)).digest("hex").toUpperCase());
  }
  const [xa, xb] = [new X509Certificate(a.caCert), new X509Certificate(b.caCert)];
  assert.notEqual(xa.subject, xb.subject, "an old root never stands in for a new one by name");
  assert.notEqual(xa.serialNumber, xb.serialNumber);
  assert.notEqual(spkiPin(xa.publicKey), spkiPin(xb.publicKey), "a new CA key every time");
  assert.equal(a.spki, b.spki, "the leaf key is not");
});

test("no private key is in what is issued, and neither certificate is on the other's key", () => {
  const key = p256();
  const c = issueBrowserCert(key, NAME, NOW);
  assert.doesNotMatch(JSON.stringify(c), /PRIVATE/);
  assert.deepEqual(Object.keys(c).sort(), ["caCert", "caSha1", "caSha256", "cert", "name", "notAfter", "spki", "v"]);
  assert.equal(new X509Certificate(c.caCert).checkPrivateKey(key), false, "the desktop's key signs nothing under the CA");
});

test("a key that is not P-256 and a name that cannot be served are refused before anything is made", () => {
  assert.throws(() => issueBrowserCert(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey, NAME), /not P-256/);
  assert.throws(() => issueBrowserCert(p256(), "192.168.1.20"), /is an address/);
});

test("openssl -x509_strict accepts the leaf for its name, and refuses what a stolen CA key would sign", { skip: !hasOpenssl && "no openssl" }, () => {
  const dir = fresh();
  const key = p256();
  const c = issueBrowserCert(key, NAME);
  const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const verify = (ca, leaf, ...more) => spawnSync("openssl", ["verify", "-x509_strict", "-purpose", "sslserver", ...more, "-CAfile", ca, leaf], { encoding: "utf8" });
  const ca = f("ca.pem", c.caCert);
  const ok = verify(ca, f("leaf.pem", c.cert), "-verify_hostname", NAME);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.notEqual(verify(ca, join(dir, "leaf.pem"), "-verify_hostname", "other.home.arpa").status, 0);

  // The same CA extensions, byte for byte, on a key this test holds.
  const caX = new X509Certificate(c.caCert);
  const own = p256();
  const ownSpki = spkiDer(createPublicKey(own));
  const dates = { notBefore: new Date(Date.now() - 3_600_000), notAfter: new Date(Date.now() + 30 * DAY) };
  const e = extensionsOf(caX.raw);
  const ownCa = f("own.pem", certPem(signCertificate({ serial: randomSerial(), issuer: "own", subject: "own", ...dates, spki: ownSpki, extensions: [e.block] }, own)));
  const under = (sans, extra = [ext.notCa(), ext.digitalSignature()], subject = "leaf") => certPem(signCertificate({
    serial: randomSerial(), issuer: "own", subject, ...dates, spki: ownSpki,
    extensions: [...extra, ext.serverAuth(), ext.subjectKeyId(keyIdOf(ownSpki)), ext.authorityKeyId(e.get(SKI).value.subarray(2)), ext.subjectAltName(sans)],
  }, own));
  const good = verify(ownCa, f("good.pem", under([dnsName(NAME)])));
  assert.equal(good.status, 0, `the harness itself verifies: ${good.stdout}${good.stderr}`);
  const refused = (what, sans, why) => {
    const r = verify(ownCa, f("bad.pem", under(sans)));
    assert.notEqual(r.status, 0, what);
    assert.match(r.stdout + r.stderr, why, what);
  };
  refused("another name", [dnsName("google.com")], /permitted subtree violation/);
  refused("a name that only ends alike", [dnsName("evil-desk.home.arpa")], /permitted subtree violation/);
  refused("an IPv4 address", [ipAddress(Buffer.from([192, 168, 1, 20]))], /excluded subtree violation/);
  refused("an IPv6 address", [ipAddress(Buffer.alloc(16, 1))], /excluded subtree violation/);
  // pathlen:0: a CA below it signs nothing.
  const mid = f("mid.pem", under([dnsName(NAME)], [ext.ca(), ext.keyCertSign()], "mid"));
  const end = f("end.pem", certPem(signCertificate({ serial: randomSerial(), issuer: "mid", subject: "end", ...dates, spki: ownSpki,
    extensions: [ext.notCa(), ext.digitalSignature(), ext.serverAuth(), ext.subjectKeyId(keyIdOf(ownSpki)), ext.authorityKeyId(keyIdOf(ownSpki)), ext.subjectAltName([dnsName(NAME)])] }, own)));
  const chain = verify(ownCa, end, "-untrusted", mid);
  assert.notEqual(chain.status, 0);
  assert.match(chain.stdout + chain.stderr, /path length constraint exceeded/);
});

test("names: private zones pass, everything that could be somebody else's is refused in a sentence", () => {
  for (const ok of ["desk.home.arpa", "desk.local", "my-mac.lan", "a.b.internal", "desk.fritz.box"]) assert.equal(browserNameRefusal(ok), null, ok);
  const no = {
    "192.168.1.20": /is an address/, "fe80::1": /is an address/, "[fe80::1]": /is an address/, "*.home.arpa": /wildcard/, "desk.home.arpa.": /dot off/,
    "localhost": /this desktop/, "app.localhost": /this desktop/, "desk": /single word/, "": /single word/, "desk_1.lan": /not a host name/, "-desk.lan": /not a host name/,
    "desk-.lan": /not a host name/, "desk..lan": /not a host name/, "Desk.lan": /not a host name/, "désk.lan": /not a host name/, "desk.lan:8771": /not a host name/,
    "desk.lan/x": /not a host name/, "1.2.3.400": /ends in a number/, [`${"a".repeat(64)}.lan`]: /not a host name/, [`${"a".repeat(41)}.lan`]: /leaves room for 44/,
    "desk.tail1234.ts.net": /tailscale serve/, "home.arpa": /whole zone/, "fritz.box": /whole zone/,
  };
  for (const [name, why] of Object.entries(no)) {
    assert.match(browserNameRefusal(name) ?? "accepted", why, name);
    assert.match(browserNameRefusal(name, true) ?? "accepted", why, `${name} with --any-name`);
  }
  assert.match(browserNameRefusal("desk.example.com"), /--any-name/);
  assert.equal(browserNameRefusal("desk.example.com", true), null);
  assert.equal(browserNameRefusal("evilhome.arpa", true), null, "a zone is matched at a dot, so this one needs --any-name");
  assert.match(browserNameRefusal("evilhome.arpa"), /--any-name/);
  assert.equal(browserNameRefusal(`${"a".repeat(40)}.lan`), null, "44 characters fit");
});

test("checkBrowserCert: what serves, and each thing that does not", () => {
  const key = p256();
  const c = issueBrowserCert(key, NAME, NOW);
  const good = checkBrowserCert(c, key, NOW);
  assert.equal(isBrowserCertProblem(good), false);
  assert.deepEqual({ ...good, notAfter: good.notAfter.toISOString() }, { name: NAME, certPem: c.cert, caSha256: c.caSha256, caSha1: c.caSha1, notAfter: c.notAfter, daysLeft: 397, spki: c.spki });
  const problem = (raw, k = key, now = NOW) => checkBrowserCert(raw, k, now).problem;
  for (const bad of [null, undefined, 1, "x", [], {}, { ...c, v: 2 }, { ...c, cert: 1 }, { ...c, caCert: "x" }, { ...c, cert: "" }]) assert.equal(problem(bad), "invalid", JSON.stringify(bad)?.slice(0, 40));
  assert.equal(problem({ ...c, name: "other.home.arpa" }), "invalid", "the name must be the certificate's");
  assert.equal(problem({ ...c, name: "*.home.arpa" }), "invalid");
  assert.equal(problem({ ...c, caCert: issueBrowserCert(key, NAME, NOW).caCert }), "invalid", "the CA beside it must have signed it");
  assert.equal(problem({ ...c, cert: c.caCert }), "invalid", "a CA is not a leaf");
  assert.equal(problem({ ...c, cert: issueLeaf(key, ["192.168.1.20"], [NAME], NOW) }), "invalid", "the phones' certificate is not a browser's");
  assert.equal(problem(c, p256()), "foreign-key");
  const at = (days) => new Date(NOW.getTime() + days * DAY);
  assert.equal(checkBrowserCert(c, key, at(396.5)).daysLeft, 0);
  assert.equal(problem(c, key, at(397)), "expired");
  assert.equal(checkBrowserCert(c, key, at(398)).was.daysLeft, -1);
  assert.match(checkBrowserCert(c, key, at(398)).fix, /lan-cert issue --name desk\.home\.arpa/);
  // Only the certificates are believed: the plain fields beside them are for a person.
  const lied = checkBrowserCert({ ...c, notAfter: "2999-01-01T00:00:00Z", caSha256: "0", spki: "0" }, key, at(397));
  assert.equal(lied.problem, "expired");
  assert.equal(lied.was.caSha256, c.caSha256);
});

test("reading the file never writes, moves or repairs it", () => {
  const root = fresh();
  assert.equal(readBrowserCert(root, null).problem, "missing");
  const file = browserCertFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{not json");
  assert.equal(readBrowserCert(root, null).problem, "invalid");
  assert.equal(readFileSync(file, "utf8"), "{not json");
  rmSync(file);
  mkdirSync(file);
  assert.equal(readBrowserCert(root, null).problem, "unreadable");
  assert.deepEqual(readdirSync(dirname(file)), ["lan-browser.json"]);
});

test("readLanTlsKey reads and never mints, and its refusal quotes nothing of the file", () => {
  const root = fresh();
  assert.equal(readLanTlsKey(root).missing, true);
  assert.equal(existsSync(lanTlsFile(root)), false);
  const m = ensureSelfSigned(root, ["192.168.1.20"], ["mac.local"]);
  assert.equal(spkiPin(createPublicKey(readLanTlsKey(root))), m.spki);
  for (const bad of ["-----BEGIN SECRET", "null", JSON.stringify({ key: "BEGIN SECRET" })]) {
    writeFileSync(lanTlsFile(root), bad);
    const r = readLanTlsKey(root);
    assert.equal(r.missing, false);
    assert.doesNotMatch(r.refused, /SECRET|BEGIN/);
    assert.equal(readFileSync(lanTlsFile(root), "utf8"), bad);
  }
});

test("names a phone already dials are refused: the own .local and fritz.box names, ALLOWED_HOSTS", () => {
  const k = envName("ALLOWED_HOSTS");
  const old = process.env[k];
  try {
    const hostname = osHostname;
    const own = hostname().toLowerCase().replace(/\.local$/, "");
    assert.match(dialedNameRefusal(`${own.split(".")[0]}.local`) ?? "accepted", /already opens this desktop/);
    assert.match(dialedNameRefusal(own.toUpperCase()) ?? "accepted", /already opens/);
    assert.equal(dialedNameRefusal("desk.home.arpa"), null);
    process.env[k] = "nas.fritz.box, Other.Lan";
    assert.match(dialedNameRefusal("nas.fritz.box") ?? "accepted", /already opens/);
    assert.match(dialedNameRefusal("other.lan") ?? "accepted", /already opens/);
    assert.equal(dialedNameRefusal("desk.home.arpa"), null);
  } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; }
});
