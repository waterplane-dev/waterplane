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
import { createServer as netServer } from "node:net";
import { connect } from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envName } from "@waterplane/shared";
import { WebSocketServer } from "ws";
import { bitString, integer, oid, seq, time } from "../dist/der.js";
import { checkLanTls } from "../dist/doctor.js";
import { ensureSelfSigned, issueLeaf, lanTlsFacts, lanTlsFile, lanTlsNames, lanTlsPlan, lanTlsSelfSigned, lanTlsWelcome, listenOrCarryOn, ownLeaf, pinShort, prepareLanTls, spkiPin, startLanTls } from "../dist/lantls.js";
import { isEncryptedSocket, requestPeerKind } from "../dist/net.js";

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
