// R-security-034: a loopback or tailnet request under a name only the local network vouches for has
// none of the trust of its address. The other halves: origin.test.mjs (who gets in at all),
// e2e-rebind.mjs (a live host).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
const { configureOrigins, checkRequestOrigin, knownFrontDoors, unverifiedName } = await import("../dist/origin.js");
const { requestPeerKind, localProcessRefusal, unverifiedNameLine, unprovenName, serveDoorPorts, learnFrontDoors } = await import("../dist/net.js");
const { rateKey } = await import("../dist/ratelimit.js");

const TS = "mac.tail1234.ts.net";
const SELF = hostname().toLowerCase().replace(/\.local$/, "").split(".")[0];
const CFG = { port: 8770, tlsPort: 8771, tailscaleIp: "100.64.0.1", tailscaleDns: TS, lanIps: ["192.168.1.20"], serveUrl: `https://${TS}:8443` };
const keep = { h: process.env.WATERPLANE_ALLOWED_HOSTS, o: process.env.WATERPLANE_ALLOWED_ORIGINS, d: process.env.WATERPLANE_DEV };
const setEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
function configure(over = {}, env = {}) {
  setEnv("WATERPLANE_ALLOWED_HOSTS", env.hosts);
  setEnv("WATERPLANE_ALLOWED_ORIGINS", env.origins);
  setEnv("WATERPLANE_DEV", env.dev);
  configureOrigins({ ...CFG, ...over });
}
beforeEach(() => configure());
after(() => { setEnv("WATERPLANE_ALLOWED_HOSTS", keep.h); setEnv("WATERPLANE_ALLOWED_ORIGINS", keep.o); setEnv("WATERPLANE_DEV", keep.d); });

const LOOP = "127.0.0.1", TAIL = "100.64.0.9", LAN = "192.168.1.30";
const kind = (from, headers) => requestPeerKind(from, headers);

test("rebinding: our own names in Host are worth nothing from loopback or the tailnet", () => {
  for (const name of [SELF, `${SELF}.local`, `${SELF}.local`.toUpperCase(), `${SELF}.local.`]) {
    for (const host of [`${name}:8770`, name, `${name}:80`, `${name}:8771`, `${name}:9000`]) {
      assert.equal(checkRequestOrigin({ host }).ok, true, `${host}: still let in`);
      for (const from of [LOOP, "::1", "::ffff:127.0.0.1", TAIL]) {
        assert.equal(kind(from, { host }), "unknown", `${host} from ${from}`);
        assert.equal(kind(from, { host, origin: `http://${host}` }), "unknown", `${host} from ${from}, with its Origin`);
        assert.notEqual(localProcessRefusal(from, { host }), null);
      }
      assert.equal(kind(LAN, { host }), "lan", "a Wi-Fi client is what it was");
    }
  }
});

test("…and no header a same-origin page can send buys it back", () => {
  const host = `${SELF}.local:8770`;
  for (const h of [{ "x-forwarded-for": "100.64.0.9" }, { "x-forwarded-proto": "https" }, { "x-forwarded-host": TS }, { forwarded: "for=1" },
    { via: "1.1 x" }, { "tailscale-user-login": "a@b" }, { "tailscale-headers-info": "1" }, { "sec-fetch-site": "same-origin" }, { authorization: "Bearer x" }]) {
    for (const from of [LOOP, TAIL]) assert.equal(kind(from, { host, ...h }), "unknown", JSON.stringify(h));
  }
  assert.equal(kind(LOOP, { host, "tailscale-funnel-request": "?1" }), "public", "Funnel stays public");
});

test("no rebinding needed: a page under our name that calls an address outright shows only in Origin", () => {
  for (const origin of [`http://${SELF}.local`, `http://${SELF}.local:8770`, `http://${SELF}`, `https://${SELF}.local`, `https://${SELF}.local:8771`, `http://${SELF}.LOCAL.`]) {
    assert.equal(checkRequestOrigin({ origin, host: "127.0.0.1:8770" }).ok, true, `${origin}: still let in`);
    for (const [from, host] of [[LOOP, "127.0.0.1:8770"], [LOOP, "localhost:8770"], [TAIL, "100.64.0.1:8770"], [TAIL, `${TS}:8770`], [LOOP, TS], [LOOP, undefined]]) {
      assert.equal(kind(from, { origin, ...(host ? { host } : {}) }), "unknown", `${origin} to ${host}`);
    }
    assert.notEqual(localProcessRefusal(LOOP, { origin, host: "127.0.0.1:8770" }), null, "nor is it a process on this desktop");
  }
});

test("a page at our Wi-Fi address, which another network may give to somebody else, is nobody's word over the tailnet", () => {
  for (const origin of ["http://192.168.1.20:8770", "http://192.168.1.20", "https://192.168.1.20:8771"]) {
    assert.equal(kind(TAIL, { origin, host: "100.64.0.1:8770" }), "unknown", origin);
    assert.equal(kind(LOOP, { origin, host: "127.0.0.1:8770" }), "unknown", origin);
    assert.equal(kind(LAN, { origin, host: "192.168.1.20:8770" }), "lan", origin);
  }
});

test("an ALLOWED_HOSTS alias is let in and asked for a token; its https origin, listed, is the certificate's word", () => {
  configure({}, { hosts: "box.home.arpa" });
  for (const from of [LOOP, TAIL]) for (const host of ["box.home.arpa:8770", "box.home.arpa", "box.home.arpa:8443"]) {
    assert.equal(checkRequestOrigin({ host }).ok, true);
    assert.equal(kind(from, { host, "x-forwarded-for": "10.0.0.2" }), "unknown", host);
  }
  configure({}, { hosts: "box.home.arpa", origins: "http://box.home.arpa" });
  assert.equal(kind(LOOP, { host: "box.home.arpa" }), "unknown", "a listed http origin proves nothing");
  assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin: "http://box.home.arpa" }), "unknown");
  configure({}, { hosts: "box.home.arpa", origins: "https://box.home.arpa,https://box.home.arpa:8443" });
  const fwd = { "x-forwarded-for": "10.0.0.2" };
  for (const host of ["box.home.arpa", "box.home.arpa:8443", "BOX.home.arpa."]) {
    assert.equal(kind(LOOP, { host, ...fwd }), "tailscale", `the proxy in front: ${host}`);
    assert.equal(kind(TAIL, { host, ...fwd }), "tailscale", "or on another tailnet machine");
    assert.equal(kind(LOOP, { host: "box.home.arpa", origin: "https://box.home.arpa", ...fwd }), "tailscale");
  }
  // The listing is for the front door. Dialed straight, on the plain port, there was no certificate.
  for (const h of [{ host: "box.home.arpa:8770" }, { host: "box.home.arpa:8770", ...fwd }, { host: "box.home.arpa:8770", origin: "http://box.home.arpa:8770" },
    { host: "box.home.arpa", origin: "http://box.home.arpa:8770" }, { host: "box.home.arpa:9000" }, { host: "x.box.home.arpa" }]) {
    for (const from of [LOOP, TAIL]) assert.equal(kind(from, h), "unknown", JSON.stringify(h));
  }
});

test("a plain-http page under a listed alias is not the certificate's page, whatever port", () => {
  const fwd = { "x-forwarded-for": "10.0.0.2" };
  // The attacker answers DNS for the alias, serves http on 80 and relays 443 untouched to the proxy.
  configure({}, { hosts: "box.home.arpa", origins: "https://box.home.arpa,https://box.home.arpa:8443" });
  for (const from of [LOOP, TAIL]) {
    for (const h of [{ host: "box.home.arpa", origin: "http://box.home.arpa" }, { host: "box.home.arpa", origin: "http://box.home.arpa:80", ...fwd },
      { host: "box.home.arpa:8443", origin: "http://box.home.arpa:8443" }, { host: "BOX.home.arpa.", origin: "http://box.home.arpa" }]) {
      assert.equal(kind(from, h), "unknown", JSON.stringify(h));
    }
    assert.equal(kind(from, { host: "box.home.arpa", origin: "https://box.home.arpa", ...fwd }), "tailscale", "its https page keeps the trust");
  }
  assert.notEqual(localProcessRefusal(LOOP, { host: "127.0.0.1:8770", origin: "http://box.home.arpa" }), null);
  // A tailnet name has the tailnet's resolver behind it: its plain page stays as it was.
  assert.equal(kind(LOOP, { host: TS, origin: `http://${TS}` }), "tailscale");
});

test("a proxy on its own https port that forwards Host without the port is still the listed certificate", () => {
  configure({}, { hosts: "box.example.com", origins: "https://box.example.com:8443" });
  const fwd = { "x-forwarded-for": "10.0.0.2" };
  assert.equal(kind(LOOP, { host: "box.example.com", origin: "https://box.example.com:8443", ...fwd }), "tailscale");
  assert.equal(kind(LOOP, { host: "box.example.com", ...fwd }), "tailscale");
  assert.equal(kind(LOOP, { host: "other.example.com", ...fwd }), "unknown");
  assert.equal(kind(LOOP, { host: "box.example.com:8770", ...fwd }), "unknown", "straight to the plain port: no certificate");
});

test("a daemon on port 80 or 443: a bare Host is the port it really means", () => {
  configure({ port: 80 }, { hosts: "box.home.arpa", origins: "https://box.home.arpa" });
  assert.equal(kind(LOOP, { host: "box.home.arpa" }), "unknown", "http://box.home.arpa, dialed straight");
  configure({ port: 443 }, { hosts: "box.home.arpa", origins: "https://box.home.arpa" });
  assert.equal(kind(LOOP, { host: "box.home.arpa:443" }), "unknown", "http on 443 spells its port");
});

test("a tailnet name: the tailnet's word on the tailnet, and through serve; not dialed straight to loopback", () => {
  for (const host of [`${TS}:8770`, TS, `${TS}:8443`, TS.toUpperCase(), `${TS}.:8770`]) assert.equal(kind(TAIL, { host, origin: `http://${host}` }), "tailscale", host);
  // `tailscale serve`: loopback socket, the name with the front door's port, proxy headers.
  for (const host of [TS, `${TS}:8443`]) {
    assert.equal(kind(LOOP, { host, origin: `https://${host}`, "x-forwarded-for": TAIL, "tailscale-user-login": "a@b" }), "tailscale", host);
    assert.equal(kind(LOOP, { host }), "tailscale", "TLS-terminated TCP adds no headers");
  }
  assert.equal(kind(LOOP, { host: TS, origin: `http://${TS}`, "x-forwarded-for": TAIL }), "tailscale", "serve --http");
  // With Tailscale off the LAN answers for the name: the page dials our own port, or 127.0.0.1.
  for (const h of [{ host: `${TS}:8770` }, { host: `${TS}:8770`, "x-forwarded-for": TAIL }, { host: "127.0.0.1:8770", origin: `http://${TS}:8770` }, { host: "127.0.0.1:8770", origin: `http://${TS}` }]) {
    assert.equal(kind(LOOP, h), "unknown", JSON.stringify(h));
  }
  // Another desktop's name is not ours, whatever proxy header the caller adds.
  assert.equal(kind(TAIL, { host: "evil.other.ts.net:8770", "x-forwarded-for": "1.2.3.4" }), "unknown");
});

test("a tailnet name on loopback counts on a front door's port, not on a hand-made forward's", () => {
  const serve = { "x-forwarded-for": TAIL, "tailscale-user-login": "a@b" };
  // The serve config was never read (no CLI): any port may be a door, as no better is known.
  assert.equal(kind(LOOP, { host: `${TS}:9000` }), "tailscale");
  configure({ doorPorts: [8443, 10000] });
  for (const host of [TS, `${TS}:80`, `${TS}:443`, `${TS}:8443`, `${TS}:10000`, `${TS}.:8443`, TS.toUpperCase() + ":8443"]) {
    for (const h of [{ host }, { host, ...serve }, { host, origin: "http://localhost", ...serve }]) assert.equal(kind(LOOP, h), "tailscale", JSON.stringify(h));
  }
  // `ssh -L 9000:127.0.0.1:8770`, Tailscale off, and the network answers for the name. A same-origin
  // GET sends no Origin; the proxy headers are any page's to send.
  for (const h of [{ host: `${TS}:9000` }, { host: `${TS}.:9000` }, { host: `${TS}:9000`, ...serve }, { host: `${TS}:9000`, origin: `http://${TS}:9000` }]) {
    assert.equal(kind(LOOP, h), "unknown", JSON.stringify(h));
    assert.notEqual(localProcessRefusal(LOOP, h), null);
  }
  assert.equal(kind(LOOP, { host: "localhost:9000" }), "loopback", "the forward itself, by the name it is meant to be opened with");
  assert.equal(kind(LOOP, { host: "127.0.0.1:9000", origin: "http://127.0.0.1:9000" }), "loopback");
  assert.equal(kind(TAIL, { host: `${TS}:9000` }), "tailscale", "over the tailnet its resolver answered, whatever port");
  assert.equal(kind(LOOP, { host: "100.64.0.1:9000" }), "tailscale", "an address is not a name");
  // A proxy or forward the operator listed is a door.
  configure({ doorPorts: [] }, { origins: `https://${TS}:9443,http://${TS}:9000` });
  for (const p of [9443, 9000]) assert.equal(kind(LOOP, { host: `${TS}:${p}` }), "tailscale", String(p));
  assert.equal(kind(LOOP, { host: `${TS}:9001` }), "unknown");
  // Nor does a door buy the daemon's own port, where a name is dialed straight.
  configure({ doorPorts: [8770] });
  assert.equal(kind(LOOP, { host: `${TS}:8770` }), "unknown");
});

test("serve's doors: https, http, raw and TLS-terminated TCP, foreground and Services; ours only", () => {
  const web = (port, proxy) => ({ [`${TS}:${port}`]: { Handlers: { "/": { Proxy: proxy } } } });
  const cfg = {
    TCP: { 443: { HTTPS: true }, 8765: { TCPForward: "127.0.0.1:8765" }, 9001: { TCPForward: "127.0.0.1:8770" }, 9002: { TCPForward: "localhost:8770", TerminateTLS: TS } },
    Web: { ...web(443, "http://127.0.0.1:3000"), ...web(8443, "http://127.0.0.1:8770"), ...web(8080, "http://localhost:8770/app"), ...web(8444, "https+insecure://localhost:8770") },
    Foreground: { abc: { TCP: { 10000: { HTTPS: true } }, Web: web(10000, "http://127.0.0.1:8770") } },
    Services: { "svc:wp": { Web: { "wp.tail1234.ts.net:7443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8770" }, "/t": { Text: "hi" } } } } } },
  };
  assert.deepEqual(serveDoorPorts(JSON.stringify(cfg), 8770).sort((a, b) => a - b), [7443, 8080, 8443, 8444, 9001, 9002, 10000]);
  assert.deepEqual(serveDoorPorts("{}", 8770), [], "read, and there is none");
  for (const bad of ["not json", "null", "[]", "3"]) assert.equal(serveDoorPorts(bad, 8770), null, bad);
});

test("a door set up since the last reading is read before it is judged; a page cannot make it read often", async () => {
  configure({ doorPorts: [8443] });
  let reads = 0, doors = [8443, 9443];
  const read = async () => { reads++; return doors; };
  let now = 1_000_000;
  const ask = (host, from = LOOP) => learnFrontDoors(from, { host }, 8770, read, now);
  for (const h of [TS, `${TS}:8443`, `${TS}:443`, `${TS}:8770`, "127.0.0.1:9443", `${SELF}.local:9443`, undefined]) assert.equal(ask(h), null, `${h}: nothing to learn`);
  assert.equal(ask(`${TS}:9443`, TAIL), null, "only loopback is asked");
  assert.equal(kind(LOOP, { host: `${TS}:9443` }), "unknown");
  await Promise.all([ask(`${TS}:9443`), ask(`${TS}:9443`)]);
  assert.equal(reads, 1, "shared");
  assert.equal(kind(LOOP, { host: `${TS}:9443` }), "tailscale");
  assert.equal(ask(`${TS}:9000`), null, "too soon");
  now += 60_000;
  doors = null;
  await ask(`${TS}:9000`);
  assert.equal(kind(LOOP, { host: `${TS}:9443` }), "tailscale", "a failed reading leaves what is known");
  assert.equal(kind(LOOP, { host: `${TS}:9000` }), "unknown");
  now += 60_000;
  await learnFrontDoors(LOOP, { host: `${TS}:9000` }, 8770, () => Promise.reject(new Error("no")), now);
  assert.equal(reads, 2);
  assert.deepEqual(knownFrontDoors(), [8443, 9443], "what a re-arm after a failed reading keeps");
});

test("the name a request is unproven under, for the sign-in made there", () => {
  assert.equal(unprovenName(LOOP, { host: `${SELF}.LOCAL:8770` }), `${SELF}.local`);
  assert.equal(unprovenName(TAIL, { host: SELF }), SELF);
  assert.equal(unprovenName(LOOP, { host: "127.0.0.1:8770", origin: `http://${SELF}.local:8770` }), `${SELF}.local`);
  assert.equal(unprovenName(LAN, { host: `${SELF}.local:8770` }), null, "the LAN door is not asked");
  assert.equal(unprovenName(LOOP, { host: "localhost:8770" }), null);
  assert.equal(unprovenName(LOOP, { host: `${SELF}.local`, "tailscale-funnel-request": "?1" }), null);
});

test("MagicDNS name unread: the suffix is for what serve hands over, and a forged proxy header is not that", () => {
  configure({ tailscaleDns: null, serveUrl: null });
  const serve = { host: TS, origin: `https://${TS}`, "x-forwarded-for": TAIL };
  assert.equal(checkRequestOrigin(serve, { proxied: true }).ok, true);
  assert.equal(kind(LOOP, serve), "tailscale");
  const forged = { host: `${TS}:8770`, origin: `http://${TS}:8770`, "x-forwarded-for": TAIL };
  assert.equal(checkRequestOrigin(forged, { proxied: true }).ok, true, "the origin gate cannot tell");
  assert.equal(kind(LOOP, forged), "unknown");
  assert.equal(kind(TAIL, forged), "unknown");
});

test("what must keep its trust: addresses, localhost, the app, serve, dev, no Origin at all", () => {
  for (const host of ["127.0.0.1:8770", "127.1.2.3:8770", "localhost:8770", "LOCALHOST:8770", "[::1]:8770", "0.0.0.0:8770", undefined, ""]) {
    const h = host === undefined ? {} : { host };
    assert.equal(kind(LOOP, h), "loopback", String(host));
    assert.equal(localProcessRefusal(LOOP, h), null, String(host));
  }
  for (const origin of ["http://localhost", "capacitor://localhost", "http://localhost:8770", "http://127.0.0.1:8770", "http://[::1]:8770", ""]) {
    assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin }), "loopback", origin);
    assert.equal(kind(TAIL, { host: "100.64.0.1:8770", origin }), "tailscale", origin);
    assert.equal(kind(LOOP, { host: TS, origin, "x-forwarded-for": TAIL }), "tailscale", `the app through serve, ${origin}`);
  }
  assert.equal(kind(TAIL, { host: "100.64.0.1:8770" }), "tailscale", "curl over the tailnet");
  assert.equal(kind(TAIL, { host: "100.64.0.1:8770", origin: "http://100.64.0.1:8770" }), "tailscale");
  assert.equal(kind(LOOP, { host: "100.64.0.1:8770", origin: "http://100.64.0.1:8770" }), "tailscale", "a port forward that keeps Host");
  assert.equal(kind("100.64.0.1", { host: `${TS}:8770`, origin: `http://${TS}:8770` }), "tailscale", "this desktop's own browser, by its tailnet name");
  // A page of the tailnet address calling 127.0.0.1 may be the LAN's while Tailscale is off; vite's proxy in dev is not.
  const vite = { host: "127.0.0.1:8770", origin: "http://100.64.0.1:5173", "x-forwarded-for": "100.64.0.9" };
  assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin: "http://100.64.0.1:8770" }), "unknown");
  assert.equal(kind(LOOP, vite), "unknown");
  configure({}, { dev: "1" });
  assert.equal(kind(LOOP, vite), "tailscale");
  assert.equal(kind(LOOP, { host: vite.host, origin: vite.origin }), "unknown", "a page calling us directly says it is no proxy");
  assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin: "http://localhost:5173", "x-forwarded-for": "127.0.0.1" }), "tailscale");
  assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin: `http://${SELF}.local:5173` }), "unknown", "dev trusts no name either");
});

test("a tailnet with its own base domain: this desktop's exact name is the tailnet's word, no other is", () => {
  const own = "mac.tailnet.example.com";
  configure({ tailscaleDns: own, serveUrl: `https://${own}` });
  assert.equal(kind(TAIL, { host: `${own}:8770`, origin: `http://${own}:8770` }), "tailscale");
  assert.equal(kind(LOOP, { host: own, origin: `https://${own}`, "x-forwarded-for": TAIL }), "tailscale", "through serve");
  assert.equal(kind(LOOP, { host: `${own}:8770` }), "unknown", "dialed straight to loopback");
  for (const n of ["other.tailnet.example.com", `x.${own}`]) assert.equal(kind(TAIL, { host: `${n}:8770` }), "unknown", n);
});

test("odd headers fail closed: several, unparsable, another scheme", () => {
  assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin: ["http://127.0.0.1:8770", `http://${SELF}.local`] }), "loopback", "the first, as the origin gate reads it");
  for (const origin of ["null", "nonsense", `ws://127.0.0.1:8770`, `http://${SELF}.local, http://127.0.0.1:8770`]) {
    assert.equal(kind(LOOP, { host: "127.0.0.1:8770", origin }), "unknown", origin);
  }
  for (const host of ["localhost.:8770", "localhost.evil.example", "127.0.0.1.evil.example:8770", "127.0.0.1.:8770", "1.2.3:8770", "mac.local:1:2", "xts.net", "ts.net.evil.example"]) {
    assert.equal(kind(LOOP, { host }), "unknown", host);
  }
  assert.equal(unverifiedName({}, "loopback"), null);
});

test("the name's login attempts have a bucket of their own, which no header can choose", () => {
  const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  const at = `${SELF}.local:8770`;
  const own = rateKey(req(LOOP, { host: "127.0.0.1:8770" }));
  const a = rateKey(req(LOOP, { host: at, "x-forwarded-for": "9.9.9.1" }));
  assert.equal(a, rateKey(req(LOOP, { host: at, "x-forwarded-for": "9.9.9.2" })));
  assert.notEqual(a, own);
  assert.equal(a, rateKey(req(LOOP, { host: "127.0.0.1:8770", origin: `http://${SELF}.local` })), "a page that calls the address shares it");
  const stranger = { host: TS, "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.5" };
  assert.equal(rateKey(req(LOOP, { ...stranger, origin: `http://${SELF}.local:8770` })), "203.0.113.5", "a Funnel stranger does not pick the bucket");
  const funnel = (xff) => rateKey(req(LOOP, { host: at, "x-forwarded-for": xff, "tailscale-funnel-request": "?1" }));
  assert.equal(funnel("10.9.9.1"), a, "a Funnel header on the name does not pick the key either");
  assert.equal(funnel("10.9.9.2"), a);
  assert.equal(rateKey(req(LOOP, { host: TS, "x-forwarded-for": TAIL })), TAIL, "through serve: the real source, as before");
});

test("the log names the name once, and says what to open instead", () => {
  const line = unverifiedNameLine(LOOP, { host: `${SELF}.local:8770` });
  assert.match(line, /\.local:8770/);
  assert.match(line, /Tailscale address/);
  assert.match(line, /WATERPLANE_ALLOWED_ORIGINS/);
  assert.equal(unverifiedNameLine(LOOP, { host: `${SELF}.local:8770`.toUpperCase() }), null);
  assert.equal(unverifiedNameLine(LOOP, { host: "127.0.0.1:8770" }), null);
  assert.equal(unverifiedNameLine(LAN, { host: "x.local" }), null);
});

test("the doctor names the aliases that ask for the password, and stays quiet without one", async () => {
  const { aliasesWithoutCertificate } = await import("../dist/origin.js");
  const { checkHostNames } = await import("../dist/doctor.js");
  assert.equal(checkHostNames({ port: 8770 }), null);
  configure({}, { hosts: `Box.home.arpa,door.home.arpa.,10.0.0.5,${TS}`, origins: "https://door.home.arpa:8443,http://box.home.arpa" });
  assert.deepEqual(aliasesWithoutCertificate(), ["box.home.arpa"]);
  const row = checkHostNames({ port: 8770 });
  assert.equal(row.status, "warn");
  assert.match(row.detail, /box\.home\.arpa/);
  assert.match(row.fix, /ALLOWED_ORIGINS.*localhost:8770/);
});

test("a serve front door on the daemon's own port number is not advertised: it reads as a plain dial", async () => {
  const { sortFrontDoors } = await import("../dist/net.js");
  const status = (...ports) => JSON.stringify({ Web: Object.fromEntries(ports.map((p) => [`${TS}:${p}`, { Handlers: { "/": { Proxy: "http://127.0.0.1:8770" } } }])) });
  assert.deepEqual(sortFrontDoors(status(8770), 8770), { usable: null, shadowed: `https://${TS}:8770` });
  assert.deepEqual(sortFrontDoors(status(8770, 8443), 8770), { usable: `https://${TS}:8443`, shadowed: `https://${TS}:8770` });
  assert.deepEqual(sortFrontDoors(status(443), 8770), { usable: `https://${TS}`, shadowed: null });
  assert.deepEqual(sortFrontDoors(status(443).replace("8770", "80"), 80), { usable: null, shadowed: `https://${TS}` }, "443 spells no port, as 80 does");
  assert.deepEqual(sortFrontDoors("not json", 8770), { usable: null, shadowed: null });
});
