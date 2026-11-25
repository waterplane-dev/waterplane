/**
 * TLS on the LAN (`lantls.ts`, `der.ts`). The certificate is written by hand, so every reader
 * that matters reads it here: `node:crypto`'s `X509Certificate`, a real TLS handshake, and
 * `openssl verify` where there is one. The pin is the contract with the phone, so what moves it and
 * what must not is pinned one case at a time. A live host is `e2e-lantls.mjs`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect, createServer as netServer } from "node:net";
import { connect } from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envName } from "@waterplane/shared";
import { WebSocketServer } from "ws";
import { bitString, integer, oid, seq, time } from "../dist/der.js";
import { authCookie } from "../dist/auth.js";
import { browserOriginRefusal } from "../dist/confirmgate.js";
import { checkLanBrowser, checkLanTls } from "../dist/doctor.js";
import { browserCertFile, issueBrowserCert } from "../dist/lanca.js";
import { browserLeafFor, ensureSelfSigned, issueLeaf, lanTlsFacts, lanTlsFile, lanTlsNames, lanTlsPlan, lanTlsExpiry, lanTlsSelfSigned, lanTlsWelcome, listenOrCarryOn, ownLeaf, pinShort, prepareLanTls, selfSignedNoticeFor, spkiPin, startLanTls } from "../dist/lantls.js";
import { isEncryptedSocket, isProxied, noteTlsServerName, requestPeerKind, tlsServerName } from "../dist/net.js";
import { checkRequestOrigin, configureOrigins, corsHeaders, isBrowserName, originHint } from "../dist/origin.js";

const scratch = mkdtempSync(join(tmpdir(), "lantls-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshRoot = () => { const r = join(scratch, `root${n++}`); mkdirSync(r); return r; };
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const IPS = ["192.168.1.20", "10.0.0.7"];
const PLAN = { allowPublic: true, plainPort: 8770, boundLan: IPS, binds: ["100.64.0.1", "127.0.0.1", ...IPS] };

/** Run `fn` with knobs set, and put them back whatever happens. */
function withEnv(knobs, fn) {
  const names = Object.keys(knobs).map(envName);
  const old = names.map((k) => process.env[k]);
  Object.entries(knobs).forEach(([k, v]) => { process.env[envName(k)] = v; });
  try { return fn(); } finally {
    names.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; });
  }
}

/** The value of extension `oidBytes` in a certificate's DER: what its OCTET STRING wraps. */
function extensionValue(raw, oidBytes) {
  const at = raw.indexOf(Buffer.from(oidBytes));
  assert.notEqual(at, -1, `extension ${Buffer.from(oidBytes).toString("hex")} is in the certificate`);
  let i = at + oidBytes.length;
  if (raw[i] === 0x01) i += 3; // critical
  assert.equal(raw[i], 0x04, "the value is an OCTET STRING");
  return raw.subarray(i + 2, i + 2 + raw[i + 1]);
}

test("der: lengths, integers, oids and both time forms are the canonical encodings", () => {
  assert.equal(seq(Buffer.alloc(127)).subarray(0, 2).toString("hex"), "307f");
  assert.equal(seq(Buffer.alloc(128)).subarray(0, 3).toString("hex"), "308180");
  assert.equal(seq(Buffer.alloc(300)).subarray(0, 4).toString("hex"), "3082012c");
  assert.equal(integer(Buffer.from([0, 0, 5])).toString("hex"), "020105", "leading zeros go");
  assert.equal(integer(Buffer.from([0x80])).toString("hex"), "02020080", "the high bit never reads negative");
  assert.equal(oid("1.2.840.10045.4.3.2").toString("hex"), "06082a8648ce3d040302");
  assert.equal(bitString(Buffer.from([0x80]), 7).toString("hex"), "03020780");
  assert.equal(time(new Date("2049-12-31T23:59:59Z")).toString("latin1").slice(2), "491231235959Z");
  assert.equal(time(new Date("2050-01-01T00:00:00Z")).toString("latin1").slice(2), "20500101000000Z");
  assert.equal(time(new Date("2050-01-01T00:00:00Z"))[0], 0x18, "GeneralizedTime from 2050");
});

test("the certificate parses, is self-signed, and names exactly its SANs", () => {
  const key = p256();
  const x = new X509Certificate(issueLeaf(key, IPS, ["mac.local"]));
  assert.equal(x.ca, false);
  assert.equal(x.subject, x.issuer);
  assert.equal(x.verify(x.publicKey), true, "the signature verifies against its own key");
  assert.equal(x.checkPrivateKey(key), true);
  assert.equal(x.subjectAltName, "DNS:mac.local, IP Address:192.168.1.20, IP Address:10.0.0.7");
  assert.equal(x.checkIP("192.168.1.20"), "192.168.1.20");
  assert.equal(x.checkIP("192.168.1.21"), undefined);
  assert.equal(x.checkHost("mac.local"), "mac.local");
  assert.equal(x.checkHost("other.local"), undefined, "no wildcard: exactly this host's name");
  assert.deepEqual(x.keyUsage, ["1.3.6.1.5.5.7.3.1"], "serverAuth, and nothing else");
  const days = (new Date(x.validTo) - new Date(x.validFrom)) / 86_400_000;
  assert.ok(days > 824 && days < 827, `valid for about 825 days, not ${days}`);
  assert.ok(new Date(x.validFrom) < new Date(), "already valid on a phone whose clock is a little behind");
});

test("Subject and Authority Key Identifiers are the same id, off the public key", () => {
  const key = p256();
  const raw = new X509Certificate(issueLeaf(key, IPS, ["mac.local"])).raw;
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const want = createHash("sha256").update(spki.subarray(spki.length - 65)).digest().subarray(0, 20);
  assert.deepEqual(extensionValue(raw, [0x55, 0x1d, 0x0e]), Buffer.concat([Buffer.from([0x04, 20]), want]));
  assert.deepEqual(extensionValue(raw, [0x55, 0x1d, 0x23]), Buffer.concat([Buffer.from([0x30, 22, 0x80, 20]), want]));
});

test("openssl verify accepts it, for a TLS server", { skip: hasOpenssl ? false : "openssl is not on this machine" }, () => {
  const f = join(scratch, "verify.pem");
  writeFileSync(f, issueLeaf(p256(), IPS, ["mac.local"]));
  assert.match(execFileSync("openssl", ["verify", "-CAfile", f, f], { encoding: "utf8" }), /: OK/);
  assert.match(execFileSync("openssl", ["verify", "-purpose", "sslserver", "-verify_ip", "192.168.1.20", "-CAfile", f, f], { encoding: "utf8" }), /: OK/);
  const shown = execFileSync("openssl", ["x509", "-in", f, "-noout", "-text"], { encoding: "utf8" });
  assert.match(shown, /Subject Key Identifier/);
  assert.match(shown, /Authority Key Identifier/);
  assert.match(shown, /ecdsa-with-SHA256/);
});

test("the mDNS name is one exact label, or nothing", () => {
  assert.deepEqual(lanTlsNames("Mac.local"), ["mac.local"]);
  assert.deepEqual(lanTlsNames("mac.fritz.box"), ["mac.local"]);
  assert.deepEqual(lanTlsNames("johannes-mbp"), ["johannes-mbp.local"]);
  assert.deepEqual(lanTlsNames("käse"), [], "a dNSName is ASCII");
  assert.deepEqual(lanTlsNames(""), []);
});

test("the key is 0600, kept across restarts, and the pin is 8a's hash", () => {
  const root = freshRoot();
  const a = ensureSelfSigned(root, IPS, ["mac.local"]);
  assert.equal(statSync(lanTlsFile(root)).mode & 0o777, 0o600);
  assert.equal(lanTlsFile(root).endsWith("lan-tls.json"), true);
  assert.equal(a.selfSigned, true);
  const x = new X509Certificate(a.certPem);
  assert.equal(a.spki, createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("hex"));
  assert.match(a.spki, /^[0-9a-f]{64}$/);
  const before = readFileSync(lanTlsFile(root), "utf8");
  const b = ensureSelfSigned(root, [...IPS].reverse(), ["mac.local"]);
  assert.equal(b.certPem, a.certPem, "same addresses in another order: the leaf is not re-issued");
  assert.equal(readFileSync(lanTlsFile(root), "utf8"), before, "and the file is not rewritten");
});

test("a loosened file goes back to 0600", () => {
  const root = freshRoot();
  ensureSelfSigned(root, IPS, ["mac.local"]);
  chmodSync(lanTlsFile(root), 0o644);
  ensureSelfSigned(root, IPS, ["mac.local"]);
  assert.equal(statSync(lanTlsFile(root)).mode & 0o777, 0o600);
});

test("new addresses re-issue on the SAME key: the SPKI never moves", () => {
  const root = freshRoot();
  const a = ensureSelfSigned(root, IPS, ["mac.local"]);
  const b = ensureSelfSigned(root, ["192.168.7.7"], ["mac.local"]);
  assert.notEqual(b.certPem, a.certPem);
  assert.equal(b.spki, a.spki);
  assert.equal(b.keyPem, a.keyPem);
  assert.equal(new X509Certificate(b.certPem).subjectAltName, "DNS:mac.local, IP Address:192.168.7.7");
  const c = ensureSelfSigned(root, ["192.168.7.7"], ["renamed.local"]);
  assert.equal(c.spki, a.spki, "a renamed machine keeps its pin too");
  assert.match(new X509Certificate(c.certPem).subjectAltName, /renamed\.local/);
});

test("a leaf near its end, or not on this key, is re-issued on the same key", () => {
  const root = freshRoot();
  const a = ensureSelfSigned(root, IPS, ["mac.local"]);
  const late = new Date(Date.now() + 800 * 86_400_000);
  const b = ensureSelfSigned(root, IPS, ["mac.local"], late);
  assert.notEqual(b.certPem, a.certPem);
  assert.equal(b.spki, a.spki);
  assert.ok(new Date(new X509Certificate(b.certPem).validTo) > new Date(late.getTime() + 800 * 86_400_000));

  const stored = JSON.parse(readFileSync(lanTlsFile(root), "utf8"));
  writeFileSync(lanTlsFile(root), JSON.stringify({ ...stored, cert: issueLeaf(p256(), IPS, ["mac.local"]) }));
  const c = ensureSelfSigned(root, IPS, ["mac.local"]);
  assert.equal(c.spki, a.spki, "a stray leaf never moves the pin: the key is the identity");
  assert.equal(new X509Certificate(c.certPem).checkPrivateKey(createPrivateKey(c.keyPem)), true, "and the leaf is back on it");
});

test("a garbage store is kept aside and a new key says so", () => {
  const root = freshRoot();
  const a = ensureSelfSigned(root, IPS, ["mac.local"]);
  writeFileSync(lanTlsFile(root), JSON.stringify({ v: 1, key: "not a key", cert: "x", sans: [] }));
  const b = ensureSelfSigned(root, IPS, ["mac.local"]);
  assert.notEqual(b.spki, a.spki);
  assert.ok(readdirSync(dirname(lanTlsFile(root))).some((f) => f.startsWith("lan-tls.json.corrupt-")), "the old file is kept, never overwritten");
});

test("a store that cannot be READ refuses: a permissions slip never moves every phone's pin", { skip: process.getuid?.() === 0 ? "root reads everything" : false }, () => {
  const root = freshRoot();
  ensureSelfSigned(root, IPS, ["mac.local"]);
  const before = (chmodSync(lanTlsFile(root), 0o600), readFileSync(lanTlsFile(root), "utf8"));
  chmodSync(lanTlsFile(root), 0o000);
  const r = ensureSelfSigned(root, IPS, ["mac.local"]);
  chmodSync(lanTlsFile(root), 0o600);
  assert.match(r.refused, /could not be read/);
  assert.equal(readFileSync(lanTlsFile(root), "utf8"), before);
});

test("nothing listens without the opt-in, and never off the LAN addresses", () => {
  assert.deepEqual(lanTlsPlan(PLAN), { port: 8771, addrs: IPS }, "default PORT+1, LAN addresses only: not loopback, not the tailnet");
  assert.equal(lanTlsPlan({ ...PLAN, allowPublic: false }).problem, false);
  assert.equal("port" in lanTlsPlan({ ...PLAN, allowPublic: false }), false, "no opt-in, no listener");
  assert.equal("port" in lanTlsPlan({ ...PLAN, boundLan: [] }), false, "no LAN address, no listener");
  // `boundLan` is filled under the opt-in even when <PREFIX>_HOST pins the bind elsewhere.
  for (const binds of [["127.0.0.1"], ["100.64.0.1"], ["0.0.0.0"]]) {
    assert.equal("port" in lanTlsPlan({ ...PLAN, binds }), false, `an explicit host of ${binds} adds nothing`);
  }
  assert.deepEqual(lanTlsPlan({ ...PLAN, binds: ["10.0.0.7"] }), { port: 8771, addrs: ["10.0.0.7"] }, "an explicit LAN host narrows it to that one");
  withEnv({ TLS: "0" }, () => assert.equal("port" in lanTlsPlan(PLAN), false, "the off switch"));
  withEnv({ TLS_PORT: "9443" }, () => assert.equal(lanTlsPlan(PLAN).port, 9443));
  for (const bad of ["8770", "0", "65536", "abc", "84.5"]) {
    withEnv({ TLS_PORT: bad }, () => assert.equal(lanTlsPlan(PLAN).problem, true, `a port of ${bad} is said, not bound`));
  }
  assert.equal(lanTlsPlan({ ...PLAN, plainPort: 65535 }).problem, true, "PORT+1 past the range");
});

test("prepare writes nothing without the opt-in", () => {
  const root = freshRoot();
  assert.equal(prepareLanTls({ ...PLAN, allowPublic: false, root }), null);
  assert.equal(existsSync(lanTlsFile(root)), false);
  withEnv({ TLS: "0" }, () => assert.equal(prepareLanTls({ ...PLAN, root }), null));
  assert.equal(existsSync(lanTlsFile(root)), false);
  const ready = prepareLanTls({ ...PLAN, root });
  assert.equal(ready.port, 8771);
  assert.deepEqual(ready.addrs, IPS);
  assert.equal(existsSync(lanTlsFile(root)), true);
});

test("own leaf: the pin follows it, lan-tls.json is left alone", () => {
  const key = p256();
  const certPath = join(scratch, "own.pem");
  const keyPath = join(scratch, "own.key");
  writeFileSync(certPath, issueLeaf(key, IPS, ["mac.local"]));
  writeFileSync(keyPath, key.export({ type: "pkcs8", format: "pem" }));
  const own = ownLeaf(certPath, keyPath);
  assert.equal(own.spki, spkiPin(createPublicKey(key)));
  assert.equal(own.selfSigned, true, "read off the certificate: a self-signed own leaf is still self-signed");
  const root = freshRoot();
  const ready = withEnv({ TLS_CERT: certPath, TLS_KEY: keyPath }, () => prepareLanTls({ ...PLAN, root }));
  assert.equal(ready.material.spki, own.spki);
  assert.equal(existsSync(lanTlsFile(root)), false);
});

test("own leaf from a CA is not self-signed, and a chain file still pins the leaf", { skip: hasOpenssl ? false : "openssl is not on this machine" }, () => {
  const d = join(scratch, "ca");
  mkdirSync(d);
  const f = (name) => join(d, name);
  const run = (...a) => execFileSync("openssl", a, { stdio: "pipe" });
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("ca.key"));
  run("req", "-x509", "-new", "-key", f("ca.key"), "-subj", "/CN=home ca", "-days", "30", "-out", f("ca.pem"));
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("leaf.key"));
  run("req", "-new", "-key", f("leaf.key"), "-subj", "/CN=mac.local", "-out", f("leaf.csr"));
  run("x509", "-req", "-in", f("leaf.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "30", "-out", f("leaf.pem"));
  writeFileSync(f("chain.pem"), readFileSync(f("leaf.pem"), "utf8") + readFileSync(f("ca.pem"), "utf8"));
  const own = ownLeaf(f("chain.pem"), f("leaf.key"));
  assert.equal(own.selfSigned, false);
  assert.equal(own.spki, spkiPin(new X509Certificate(readFileSync(f("leaf.pem"))).publicKey));
});

test("a bad own leaf refuses the listener and says why, and never falls back to the generated key", () => {
  const key = p256();
  const certPath = join(scratch, "bad.pem");
  const keyPath = join(scratch, "bad.key");
  const otherKeyPath = join(scratch, "other.key");
  const junkPath = join(scratch, "junk.pem");
  writeFileSync(certPath, issueLeaf(key, IPS, ["mac.local"]));
  writeFileSync(keyPath, key.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(otherKeyPath, p256().export({ type: "pkcs8", format: "pem" }));
  writeFileSync(junkPath, "not pem at all");
  assert.equal(ownLeaf(undefined, undefined), null);
  assert.match(ownLeaf(certPath, undefined).refused, /go together.*TLS_CERT/);
  assert.match(ownLeaf(undefined, keyPath).refused, /go together.*TLS_KEY/);
  assert.match(ownLeaf(join(scratch, "absent.pem"), keyPath).refused, /cannot read the certificate .*ENOENT/);
  assert.match(ownLeaf(certPath, join(scratch, "absent.key")).refused, /cannot read the key .*ENOENT/);
  assert.match(ownLeaf(junkPath, keyPath).refused, /not a PEM certificate/);
  assert.match(ownLeaf(certPath, junkPath).refused, /not an unencrypted PEM private key/);
  assert.match(ownLeaf(certPath, otherKeyPath).refused, /is not the key of/);
  const root = freshRoot();
  for (const knobs of [{ TLS_CERT: certPath }, { TLS_CERT: certPath, TLS_KEY: otherKeyPath }]) {
    assert.equal(withEnv(knobs, () => prepareLanTls({ ...PLAN, root })), null);
  }
  assert.equal(existsSync(lanTlsFile(root)), false, "a typo in the knob does not quietly switch to another identity");
});

test("doctor: on with port and short pin, off with why, and it never mints a key", () => {
  const root = freshRoot();
  const row = (allowPublic = true) => checkLanTls({ root, port: 8770, allowPublic }, IPS);
  const off = row(false);
  assert.equal(off.id, "lan-tls");
  assert.equal(off.status, "ok");
  assert.match(off.detail, /off.*ALLOW_PUBLIC/);
  withEnv({ TLS: "0" }, () => assert.match(row().detail, /off.*TLS=0/));
  withEnv({ HOST: "127.0.0.1" }, () => assert.match(row().detail, /off.*HOST binds no LAN address/));
  assert.match(row().detail, /on, port 8771, pin minted when the host starts/);
  assert.equal(existsSync(lanTlsFile(root)), false);
  const m = ensureSelfSigned(root, IPS, ["mac.local"]);
  assert.equal(row().detail, `LAN TLS on, port 8771, pin ${pinShort(m.spki)}`);
  withEnv({ TLS_PORT: "8770" }, () => assert.equal(row().status, "warn"));
  withEnv({ TLS_CERT: "/nonexistent.pem" }, () => {
    const bad = row();
    assert.equal(bad.status, "warn");
    assert.match(bad.detail, /off:.*go together/);
    assert.match(bad.fix, /TLS_CERT/);
  });
});

const wsOn = (server) => new WebSocketServer({ server, path: "/ws" });
const busyPort = () => new Promise((resolve) => {
  const s = netServer();
  s.listen(0, "127.0.0.1", () => resolve(s));
});

test("a busy port retries, gives up without taking the process down, and advertises nothing", async (t) => {
  const busy = await busyPort();
  t.after(() => busy.close());
  const port = busy.address().port;
  const material = ensureSelfSigned(freshRoot(), ["127.0.0.1"], []);
  const lines = [];
  t.mock.method(console, "error", (l) => lines.push(l));
  // A real `ws` server, wired as `main.ts` does: it re-emits the bind error, and an unheard one is
  // an uncaught EADDRINUSE, which `shutdown.ts` turns into `process.exit(1)`.
  const uncaught = [];
  const heard = (e) => uncaught.push(e);
  process.on("uncaughtException", heard);
  t.after(() => process.off("uncaughtException", heard));
  const servers = startLanTls({ port, addrs: ["127.0.0.1"], material }, () => {}, wsOn, { attempts: 2, delayMs: 5 });
  t.after(() => servers.forEach((s) => s.close()));
  while (!lines.length) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(uncaught, [], "the bind error never reaches the process");
  assert.match(lines[0], /cannot bind .*EADDRINUSE.*carrying on plain/);
  assert.equal(lanTlsFacts(), null, "nothing is advertised for a port nobody is on");
  assert.deepEqual(lanTlsWelcome(), {});
  assert.equal(lanTlsSelfSigned(), false);
  assert.equal(servers[0].listening, false);
});

test("a port freed during the retries is taken", async (t) => {
  const busy = await busyPort();
  const port = busy.address().port;
  const material = ensureSelfSigned(freshRoot(), ["127.0.0.1"], []);
  const [server] = startLanTls({ port, addrs: ["127.0.0.1"], material }, () => {}, wsOn, { attempts: 50, delayMs: 10 });
  t.after(() => server.close());
  await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => busy.close(r));
  while (!server.listening) await new Promise((r) => setTimeout(r, 5));
  assert.equal(server.listening, true);
});

test("listenOrCarryOn does not throw on any other bind failure either", async (t) => {
  const lines = [];
  t.mock.method(console, "error", (l) => lines.push(l));
  const { createServer } = await import("node:https");
  const s = createServer({});
  listenOrCarryOn(s, "203.0.113.1", 0, () => assert.fail("that address is not ours"));
  while (!lines.length) await new Promise((r) => setTimeout(r, 5));
  assert.match(lines[0], /carrying on plain/);
});

test("the live listener: TLS 1.2 floor, facts after the bind, the encrypted helper, peer kind untouched", async (t) => {
  const material = ensureSelfSigned(freshRoot(), ["127.0.0.1"], []);
  const free = await busyPort();
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  const seen = [];
  const attached = [];
  const [server] = startLanTls({ port, addrs: ["127.0.0.1"], material }, (req, res) => {
    seen.push({ encrypted: isEncryptedSocket(req.socket), kind: requestPeerKind("192.168.1.50", req.headers) });
    res.end("ok");
  }, (s) => { attached.push(s); return wsOn(s); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  while (!server.listening) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(attached, [server], "the socket wiring is attached to this server too");
  assert.deepEqual(lanTlsFacts(), { port, spki: material.spki });
  assert.deepEqual(lanTlsWelcome(), { tlsPort: port, tlsSpki: material.spki });
  assert.equal(lanTlsSelfSigned(), true);

  const hello = (opts) => new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...opts }, () => { const v = s.getProtocol(); const c = s.getPeerX509Certificate(); s.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); s.once("end", () => resolve({ v, c })); s.resume(); });
    s.once("error", (e) => resolve({ error: e }));
  });
  const ok = await hello({ minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  assert.equal(ok.v, "TLSv1.2");
  assert.equal(spkiPin(ok.c.publicKey), material.spki, "the pin is what the handshake presents");
  assert.equal((await hello({})).v, "TLSv1.3");
  assert.deepEqual(seen[0], { encrypted: true, kind: "lan" }, "encrypted, and still `lan`");
  // Below the floor: this node refuses to offer 1.1 by default, so ask for it by cipher level.
  const old = await hello({ minVersion: "TLSv1.1", maxVersion: "TLSv1.1", ciphers: "DEFAULT:@SECLEVEL=0" });
  assert.ok(old.error, "TLS 1.1 is refused");
  assert.equal(isEncryptedSocket({}), false);
  assert.equal(isEncryptedSocket({ encrypted: false }), false);
});

// ---- the browser certificate: one name on the TLS port, and only there (R-security-023's port) ----

const NAME = "desk.home.arpa";
const freePort = async () => { const s = await busyPort(); const { port } = s.address(); await new Promise((r) => s.close(r)); return port; };

/** A key, a browser certificate on it, and the file the host reads. `over` replaces the file's text. */
function issued(root, { now, key, over } = {}) {
  const m = ensureSelfSigned(root, ["127.0.0.1"], ["mac.local"]);
  const cert = issueBrowserCert(key ?? createPrivateKey(m.keyPem), NAME, now);
  writeFileSync(browserCertFile(root), over ?? JSON.stringify(cert));
  return { m, cert };
}

/** What a boot does, on loopback: prepare, arm the guard, listen. The handler makes the calls `server/http.ts` makes. */
async function serveNamed(t, root, knobs = {}) {
  const port = await freePort();
  const warned = [];
  t.mock.method(console, "warn", (l) => warned.push(l));
  const ready = withEnv({ TLS_PORT: String(port), ...knobs }, () => prepareLanTls({ root, allowPublic: true, plainPort: 1, boundLan: ["127.0.0.1"], binds: ["127.0.0.1"] }));
  t.mock.restoreAll();
  configureOrigins({ port: 8770, tlsPort: port, tlsName: ready.browser?.name, lanIps: ["192.168.1.20"], tailscaleIp: "100.64.0.1" });
  t.after(() => configureOrigins({ port: 8770 }));
  const handler = (req, res) => {
    if (req.url.startsWith("/api/")) {
      const v = checkRequestOrigin(req.headers, { path: req.url, method: req.method, proxied: isProxied(req.headers), tlsName: tlsServerName(req.socket) });
      res.writeHead(v.ok ? 200 : 403, corsHeaders(req.headers));
      res.end(v.ok ? "API" : `${v.reason} ${originHint(v)}`);
    } else if (req.url === "/expiry") res.end(JSON.stringify(lanTlsExpiry(req.socket)));
    else if (req.url === "/gate") res.end(browserOriginRefusal(req) ?? "CONSENT");
    else res.end(selfSignedNoticeFor(req.socket) ? "NOTICE" : "APP");
  };
  const [server] = startLanTls({ ...ready, addrs: ["127.0.0.1"] }, handler, wsOn);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const plain = createHttpServer(handler);
  await new Promise((r) => plain.listen(0, "127.0.0.1", r));
  t.after(() => { plain.closeAllConnections(); plain.close(); });
  while (!server.listening) await new Promise((r) => setTimeout(r, 5));
  return { port, plainPort: plain.address().port, ready, warned, server };
}

/** Requests down ONE connection, each `[path, headers, method]`; TLS when `tls` holds its options. The leaf shown comes back too. */
function talk(port, tls, ...reqs) {
  return new Promise((resolve, reject) => {
    const answers = [];
    let buf = "";
    let leaf = null;
    const next = () => {
      const r = reqs[answers.length];
      if (!r) { s.destroy(); resolve({ answers, leaf, session }); return; }
      s.write(`${r[2] ?? "GET"} ${r[0]} HTTP/1.1\r\n${Object.entries(r[1]).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    };
    let session = null;
    const s = tls ? connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...tls }, () => { leaf = s.getPeerX509Certificate(); next(); }) : netConnect({ host: "127.0.0.1", port }, next);
    s.on("session", (x) => { session = x; });
    s.setEncoding("utf8");
    s.once("error", reject);
    s.on("data", (d) => {
      buf += d;
      const m = /^HTTP\/1\.1 (\d+)[^]*?\r\n\r\n/.exec(buf);
      if (!m) return;
      const head = m[0];
      const body = buf.slice(head.length);
      const len = /content-length: (\d+)/i.exec(head);
      const done = len ? body.length >= Number(len[1]) : body.endsWith("0\r\n\r\n");
      if (!done) return;
      buf = "";
      answers.push({ status: Number(m[1]), head, body: len ? body : body.split("\r\n")[1] ?? "" });
      next();
    });
  });
}

test("welcome expiry fields ride only a socket that arrived by the certificate's name", async (t) => {
  const root = freshRoot();
  const { cert } = issued(root);
  const { port, plainPort } = await serveNamed(t, root);
  const get = async (tls, p, headers = { host: `127.0.0.1:${p}` }) => JSON.parse((await talk(p, tls, ["/expiry", headers])).answers[0].body);
  const named = await get({ servername: NAME }, port, { host: `${NAME}:${port}` });
  assert.equal(named.tlsName, NAME);
  assert.equal(named.tlsNameUntil, new Date(cert.notAfter).getTime());
  assert.deepEqual(await get({}, port), {}, "TLS without the name");
  assert.deepEqual(await get({ servername: "mac.local" }, port), {}, "another name");
  assert.deepEqual(await get(null, plainPort, { host: `${NAME}:${plainPort}` }), {}, "the plain socket, even with the name in Host");
  assert.deepEqual(lanTlsExpiry(undefined), {});
});

test("browser certificate: its name counts on its own TLS handshake, under exactly its Host and Origin, and nowhere else", async (t) => {
  const root = freshRoot();
  const { cert } = issued(root);
  const { port, plainPort, ready } = await serveNamed(t, root);
  const host = `${NAME}:${port}`;
  const origin = `https://${host}`;
  const api = async (tls, headers, path = "/api/x") => (await talk(port, tls, [path, headers])).answers[0];
  const sni = { servername: NAME };

  const good = await talk(port, sni, ["/api/x", { host }], ["/api/x", { host, origin }], ["/", { host }]);
  assert.deepEqual(good.answers.map((a) => a.body), ["API", "API", "APP"]);
  assert.equal(new X509Certificate(cert.cert).fingerprint256, good.leaf.fingerprint256, "the CA's leaf");
  assert.doesNotMatch(good.answers[1].head, /access-control/i, "same-origin: nothing to reflect");
  const verified = await new Promise((resolve) => { const s = connect({ host: "127.0.0.1", port, servername: NAME, ca: cert.caCert }, () => { resolve(s.authorized); s.destroy(); }); s.once("error", resolve); });
  assert.equal(verified, true, "a verifier that trusts the CA accepts it under the name");

  // The name in the headers without the handshake: no SNI, another SNI, another spelling, and the plain port.
  for (const other of [{}, { servername: "mac.local" }, { servername: "x.desk.home.arpa" }, { servername: "DESK.home.arpa" }, { servername: `${NAME}.` }]) {
    for (const h of [{ host }, { host, origin }]) assert.equal((await api(other, h)).status, 403, `SNI ${other.servername} ${h.origin ?? "no origin"}`);
    assert.equal((await api(other, { host }, "/api/repos/a/artifact")).status, 403, "nor on an opaque read route");
    const page = await talk(port, other, ["/", { host }]);
    assert.equal(page.answers[0].body, "NOTICE");
    assert.equal(page.leaf.fingerprint256, new X509Certificate(ready.material.certPem).fingerprint256, "and the leaf it always was");
  }
  for (const h of [{ host }, { host, origin }, { host: `${NAME}:${plainPort}` }, { host: `${NAME}:${plainPort}`, origin: `http://${NAME}:${plainPort}` }, { host: "localhost", origin }]) {
    for (const path of ["/api/x", "/api/repos/a/artifact"]) assert.equal((await talk(plainPort, null, [path, h])).answers[0].status, 403, `plain ${JSON.stringify(h)} ${path}`);
  }
  const advice = (await talk(plainPort, null, ["/api/x", { host: NAME }])).answers[0].body;
  assert.match(advice, new RegExp(`Open it as ${origin}`));
  assert.doesNotMatch(advice, /set \S*ALLOWED_HOSTS/, "never told to trust the name on the plain port");

  // The right handshake, a Host that is not exactly it.
  for (const h of [NAME, `${NAME}:${port + 1}`, `${NAME}.:${port}`, `DESK.home.arpa:${port}`, `${NAME}:0${port}`, `x.${host}`, "evil.example.com"]) {
    assert.equal((await api(sni, { host: h })).status, 403, `Host ${h}`);
    assert.equal((await api(sni, { host: h, origin })).status, 403, `Host ${h} with the origin`);
  }
  // The right handshake and Host, an Origin that is not exactly it. One that passes elsewhere is refused here too.
  for (const o of [`http://${host}`, `https://${NAME}`, `https://${NAME}:${port + 1}`, `https://${NAME}.:${port}`, `https://x.${host}`, "null", "http://localhost", "capacitor://localhost", `https://192.168.1.20:${port}`]) {
    assert.equal((await api(sni, { host, origin: o })).status, 403, `Origin ${o}`);
  }
  assert.equal((await api(sni, { host: `192.168.1.20:${port}`, origin })).status, 403, "its origin, at another of our hosts");
  // Through a proxy, and cross-site without an Origin: refused, the opaque read routes included.
  for (const h of ["x-forwarded-for", "tailscale-user-login", "via"]) assert.equal((await api(sni, { host, origin, [h]: "1" })).status, 403, h);
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await api(sni, { host, "sec-fetch-site": site })).status, 403, site);
    assert.equal((await api(sni, { host, "sec-fetch-site": site }, "/api/repos/a/artifact")).status, 403, `${site}, opaque read`);
  }
  assert.equal((await api(sni, { host, "sec-fetch-site": "same-origin" })).status, 200);
  // One connection, another Host on the next request.
  const turn = await talk(port, sni, ["/api/x", { host, origin }], ["/api/x", { host: `evil.example.com:${port}`, origin }], ["/api/x", { host, origin: "https://evil.example.com" }], ["/api/x", { host, origin }]);
  assert.deepEqual(turn.answers.map((a) => a.status), [200, 403, 403, 200]);

  // Every other socket as before: an address is an address, with or without the app's origin.
  assert.equal((await api({}, { host: `192.168.1.20:${port}` })).status, 200);
  const app = await api({}, { host: `192.168.1.20:${port}`, origin: "http://localhost" });
  assert.equal(app.status, 200);
  assert.match(app.head, /access-control-allow-origin: http:\/\/localhost/i);
});

test("browser certificate: a resumed session carries no name into another handshake", async (t) => {
  const root = freshRoot();
  issued(root);
  const { port } = await serveNamed(t, root);
  const h = { host: `${NAME}:${port}` };
  for (const v of ["TLSv1.2", "TLSv1.3"]) {
    const o = { minVersion: v, maxVersion: v };
    const ask = async (servername, session) => {
      const r = await talk(port, { ...o, servername, session }, ["/api/x", h], ["/api/x", h]);
      return { status: r.answers[1].status, session: r.session };
    };
    const named = await ask(NAME);
    const bare = await ask(undefined);
    assert.equal(named.status, 200, v);
    assert.equal(bare.status, 403, v);
    assert.ok(named.session && bare.session, `${v}: both gave a session to resume`);
    assert.equal((await ask(undefined, named.session)).status, 403, `${v}: the name's session, no SNI`);
    assert.equal((await ask("mac.local", named.session)).status, 403, `${v}: the name's session, another SNI`);
    // The name resumed as itself: TLS 1.3, which every browser speaks, says so again; 1.2 does not and is nameless.
    assert.equal((await ask(NAME, named.session)).status, v === "TLSv1.3" ? 200 : 403, `${v}: the name's own session`);
  }
});

test("browser certificate: a TLS 1.2 resumption is nameless whatever the library reports, and a plain socket always is", () => {
  const sock = (o) => ({ encrypted: true, servername: NAME, getProtocol: () => "TLSv1.3", isSessionReused: () => false, ...o });
  const named = (s) => { noteTlsServerName(s); return tlsServerName(s); };
  assert.equal(named(sock({})), NAME);
  assert.equal(named(sock({ isSessionReused: () => true })), NAME);
  assert.equal(named(sock({ getProtocol: () => "TLSv1.2" })), NAME);
  assert.equal(named(sock({ getProtocol: () => "TLSv1.2", isSessionReused: () => true })), null);
  assert.equal(named(sock({ servername: false })), null);
  assert.equal(named(sock({ encrypted: false })), null);
  assert.equal(tlsServerName(sock({})), null, "a socket no listener of ours noted");
  assert.equal(tlsServerName(undefined), null);
  const s = sock({});
  assert.equal(named(s), NAME);
  s.servername = "other.lan";
  assert.equal(named(s), NAME, "a renegotiation does not rename it");
});

test("browser certificate: the confirm gate takes its page's POST, and the name from anywhere else is no consent", async (t) => {
  const root = freshRoot();
  issued(root);
  const { port, plainPort } = await serveNamed(t, root);
  const host = `${NAME}:${port}`;
  const origin = `https://${host}`;
  const gate = async (tls, headers) => (await talk(tls ? port : plainPort, tls, ["/gate", { ...headers, "content-length": "0" }, "POST"])).answers[0].body;
  const sni = { servername: NAME };
  assert.equal(await gate(sni, { host, origin }), "CONSENT");
  assert.match(await gate(sni, { host }), /no Origin cannot give consent/);
  for (const o of [`http://${host}`, `https://${NAME}`, "http://localhost", "null"]) assert.equal(await gate(sni, { host, origin: o }), "origin not allowed", o);
  assert.equal(await gate(sni, { host, origin, "x-forwarded-for": "1.2.3.4" }), "origin not allowed", "proxied");
  assert.equal(await gate(sni, { host: `192.168.1.20:${port}`, origin }), "origin not allowed");
  assert.equal(await gate({}, { host, origin }), "origin not allowed", "no SNI");
  assert.equal(await gate(null, { host, origin }), "origin not allowed", "the plain port");
  assert.equal(await gate(null, { host: "localhost", origin: "http://localhost" }), "CONSENT", "the app, as before");
  assert.equal(browserOriginRefusal({ headers: { host, origin } }), "origin not allowed", "no socket, no name");
});

test("browser certificate: the pin, the notice and lan-tls.json are what they were, and a request opens no file", async (t) => {
  const root = freshRoot();
  const before = ensureSelfSigned(root, ["127.0.0.1"], ["mac.local"]);
  issued(root);
  const { port, ready } = await serveNamed(t, root);
  const stored = readFileSync(lanTlsFile(root), "utf8");
  assert.deepEqual(lanTlsFacts(), { port, spki: before.spki });
  assert.deepEqual(lanTlsWelcome(), { tlsPort: port, tlsSpki: before.spki });
  const byIp = await talk(port, {}, ["/", { host: "127.0.0.1" }]);
  const byName = await talk(port, { servername: NAME }, ["/", { host: `${NAME}:${port}` }]);
  assert.equal(byIp.answers[0].body, "NOTICE");
  assert.equal(byIp.leaf.fingerprint256, new X509Certificate(ready.material.certPem).fingerprint256, "by address: the self-signed leaf");
  assert.equal(spkiPin(byIp.leaf.publicKey), before.spki);
  assert.equal(spkiPin(byName.leaf.publicKey), before.spki, "one key on both leaves");
  rmSync(browserCertFile(root));
  assert.equal((await talk(port, { servername: NAME }, ["/", { host: `${NAME}:${port}` }])).answers[0].body, "APP", "read at boot: a removal counts from the next start");
  assert.equal(readFileSync(lanTlsFile(root), "utf8"), stored);
});

test("browser certificate: a bad file, or a person's own leaf, is one line and never the listener", async (t) => {
  const year = 400 * 86_400_000;
  const cases = [
    ["expired", (root) => issued(root, { now: new Date(Date.now() - year) }), /expired on .*lan-cert issue --name desk\.home\.arpa/],
    ["foreign key", (root) => issued(root, { key: p256() }), /another key/],
    ["corrupt", (root) => issued(root, { over: "{" }), /not JSON/],
    ["not certificates", (root) => issued(root, { over: JSON.stringify({ v: 1, name: NAME, cert: "x", caCert: "y" }) }), /does not parse/],
    ["a folder", (root) => { ensureSelfSigned(root, ["127.0.0.1"], []); mkdirSync(browserCertFile(root)); }, /could not be read \(EISDIR\)/],
    ["none issued", (root) => ensureSelfSigned(root, ["127.0.0.1"], []), null],
  ];
  for (const [label, make, line] of cases) {
    await t.test(label, async (tt) => {
      const root = freshRoot();
      make(root);
      const key = JSON.parse(readFileSync(lanTlsFile(root), "utf8")).key;
      const files = readdirSync(dirname(lanTlsFile(root)));
      const { port, ready, warned } = await serveNamed(tt, root);
      assert.equal(ready.browser, null);
      assert.equal(warned.length, line ? 1 : 0, warned.join("\n"));
      if (line) assert.match(warned[0], line);
      const r = await talk(port, { servername: NAME }, ["/", { host: `${NAME}:${port}` }], ["/api/x", { host: `${NAME}:${port}` }], ["/api/x", { host: `192.168.1.20:${port}` }]);
      assert.deepEqual(r.answers.map((a) => a.body === "API" || a.body === "NOTICE" ? a.body : a.status), ["NOTICE", 403, "API"]);
      assert.equal(spkiPin(r.leaf.publicKey), ready.material.spki);
      assert.equal(JSON.parse(readFileSync(lanTlsFile(root), "utf8")).key, key, "the key is the phones' key");
      assert.deepEqual(readdirSync(dirname(lanTlsFile(root))), files, "nothing moved aside, nothing made");
    });
  }
  await t.test("a person's own leaf", async (tt) => {
    const root = freshRoot();
    issued(root);
    const own = ensureSelfSigned(freshRoot(), ["127.0.0.1"], ["own.lan"]);
    const [c, k] = ["own.pem", "own.key"].map((f) => join(root, f));
    writeFileSync(c, own.certPem);
    writeFileSync(k, own.keyPem);
    const { port, ready, warned } = await serveNamed(tt, root, { TLS_CERT: c, TLS_KEY: k });
    assert.equal(ready.browser, null);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /not served: \S*TLS_CERT and \S*TLS_KEY take the port/);
    const r = await talk(port, { servername: NAME }, ["/api/x", { host: `${NAME}:${port}` }]);
    assert.equal(r.answers[0].status, 403);
    assert.equal(spkiPin(r.leaf.publicKey), own.spki);
  });
});

test("doctor: the browser certificate's row, when there is one to speak of", () => {
  const root = freshRoot();
  const row = (now, allowPublic = true) => checkLanBrowser({ root, port: 8770, allowPublic }, IPS, now);
  const DAY = 86_400_000;
  assert.equal(row(), null, "none issued: no row");
  const { m, cert } = issued(root);
  const end = new Date(cert.notAfter).getTime();
  assert.deepEqual(row(), { id: "lan-browser", status: "ok", detail: `browser certificate for ${NAME}, 396 days left, https://${NAME}:8771` });
  assert.equal(row(new Date(end - 31 * DAY)).status, "ok");
  const soon = row(new Date(end - 30 * DAY));
  assert.equal(soon.status, "warn");
  assert.match(soon.detail, /30 days left/);
  assert.match(soon.fix, /lan-cert issue --name desk\.home\.arpa/);
  const over = row(new Date(end + DAY));
  assert.equal(over.status, "warn");
  assert.match(over.detail, /not served: it expired on/);
  assert.match(over.fix, /lan-cert issue --name desk\.home\.arpa/);
  withEnv({ TLS_CERT: "/x.pem", TLS_KEY: "/x.key" }, () => {
    assert.equal(row().status, "warn");
    assert.match(row().detail, /desk\.home\.arpa is not served: \S*TLS_CERT and \S*TLS_KEY take the port/);
  });
  withEnv({ ALLOWED_HOSTS: NAME }, () => {
    const dialed = row();
    assert.equal(dialed.status, "warn");
    assert.match(dialed.detail, /is not served: .*already opens this desktop/);
    assert.match(dialed.fix, /^Take desk\.home\.arpa out of \S*ALLOWED_HOSTS and restart the host/);
    assert.match(dialed.fix, /lan-cert remove`, then `\S+ lan-cert issue --name <another name>`/);
    assert.doesNotMatch(dialed.fix, /issue --name desk\.home\.arpa/);
    // an expired certificate for a dialed name gets the dialed fix too, never the refused "issue --name"
    const gone = row(new Date(end + DAY));
    assert.match(gone.detail, /already opens this desktop/);
    assert.match(gone.fix, /^Take desk\.home\.arpa out of/);
    assert.doesNotMatch(gone.fix, /issue --name desk\.home\.arpa/);
  });
  assert.match(row(undefined, false).detail, /not served: LAN TLS off/);
  assert.equal(row(undefined, false).status, "ok", "switched off is not a problem");
  writeFileSync(browserCertFile(root), "{");
  assert.match(row().detail, /^browser certificate is not served: not JSON$/);
  assert.equal(row().status, "warn");
  writeFileSync(browserCertFile(root), JSON.stringify(issueBrowserCert(p256(), NAME)));
  assert.match(row().detail, /another key/);
  issued(root);
  rmSync(lanTlsFile(root));
  assert.match(row().detail, /cannot be checked: .*does not exist/);
  assert.equal(existsSync(lanTlsFile(root)), false, "and no key is minted to find out");
  assert.ok(m);
});

test("a browser certificate for a name the phones already dial is not served, and the app's leaf still is", () => {
  const root = freshRoot();
  const { m } = issued(root);
  const warned = [];
  const warn = console.warn;
  console.warn = (s) => { warned.push(String(s)); };
  try {
    withEnv({ ALLOWED_HOSTS: "desk.fritz.box" }, () => {
      writeFileSync(browserCertFile(root), JSON.stringify(issueBrowserCert(createPrivateKey(m.keyPem), "desk.fritz.box")));
      assert.equal(browserLeafFor(root, m), null);
      writeFileSync(browserCertFile(root), JSON.stringify(issueBrowserCert(createPrivateKey(m.keyPem), NAME)));
      assert.equal(browserLeafFor(root, m)?.name, NAME, "another name is served");
    });
  } finally { console.warn = warn; }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /already opens this desktop/);
});

test("the login cookie is Secure at the browser certificate's name and nowhere else", () => {
  configureOrigins({ port: 8770, tlsPort: 8771, tlsName: NAME });
  try {
    assert.equal(isBrowserName(NAME), true);
    for (const n of [null, "", "mac.local", `${NAME}.`]) assert.equal(isBrowserName(n), false);
    assert.match(authCookie("t", true), /; HttpOnly; Secure; SameSite=Lax;/);
    assert.match(authCookie("t"), /^[^=]+=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  } finally { configureOrigins({ port: 8770 }); }
  assert.equal(isBrowserName(null), false);
});
