// Where "the host" is when the app is NOT served by it — the Android shell
// (`shared/src/hosturl.ts`). The scheme allowlist here is security-relevant:
// this string becomes the base of every request the app makes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_HOST_PORT, PLAIN_ROUTE_NO_APK, PLAIN_ROUTE_NO_FINGERPRINT, PLAIN_ROUTE_NO_UPDATE, PLAIN_ROUTE_TOAST, PLAIN_ROUTE_WARNING, isHostPath, isPlainRoute, isProxyBase, needsTunnel, normalizeHostBase, resolveHostUrl, tlsBaseOf, wsUrlFor } from "../dist/index.js";

test("a bare address gets the daemon's own scheme and port", () => {
  assert.equal(normalizeHostBase("100.64.0.1"), `http://100.64.0.1:${DEFAULT_HOST_PORT}`);
  assert.equal(normalizeHostBase("  desk.tail1234.ts.net  "), `http://desk.tail1234.ts.net:${DEFAULT_HOST_PORT}`);
  assert.equal(normalizeHostBase("//100.64.0.1"), `http://100.64.0.1:${DEFAULT_HOST_PORT}`);
});

test("an explicit port is kept, and https implies 443 implicitly", () => {
  assert.equal(normalizeHostBase("http://100.64.0.1:9000"), "http://100.64.0.1:9000");
  assert.equal(normalizeHostBase("https://desk.tail1234.ts.net"), "https://desk.tail1234.ts.net");
  assert.equal(normalizeHostBase("https://desk.tail1234.ts.net:8443"), "https://desk.tail1234.ts.net:8443");
});

test("an IPv6 literal keeps its brackets, or the port re-parses as garbage", () => {
  assert.equal(normalizeHostBase("http://[fd7a::1]:8770"), "http://[fd7a::1]:8770");
  assert.equal(normalizeHostBase("[fd7a::1]"), `http://[fd7a::1]:${DEFAULT_HOST_PORT}`);
});

test("only http and https survive — this string is fed to fetch", () => {
  assert.equal(normalizeHostBase("javascript:alert(1)"), null);
  assert.equal(normalizeHostBase("data:text/html,x"), null);
  assert.equal(normalizeHostBase("file:///etc/passwd"), null);
  assert.equal(normalizeHostBase("ws://100.64.0.1:8770"), null);
  assert.equal(normalizeHostBase(""), null);
  assert.equal(normalizeHostBase("   "), null);
  assert.equal(normalizeHostBase("http://"), null);
});

test("a base is an origin — a path would silently prefix every API call", () => {
  assert.equal(normalizeHostBase("http://100.64.0.1:8770/some/path?x=1#f"), "http://100.64.0.1:8770");
  assert.equal(normalizeHostBase("HTTP://DESK.TAIL1234.TS.NET:8770"), "http://desk.tail1234.ts.net:8770");
});

test("isHostPath is path-absolute only — a protocol-relative URL is not a path", () => {
  assert.equal(isHostPath("/api/repos"), true);
  assert.equal(isHostPath("/api"), true);
  assert.equal(isHostPath("/api?x=1"), true);
  assert.equal(isHostPath("/ws"), true);
  assert.equal(isHostPath("//evil.example/api/repos"), false); // would splice in their authority
  assert.equal(isHostPath("/apixyz"), false);
  assert.equal(isHostPath("/index.html"), false);
  assert.equal(isHostPath("https://desk/api/repos"), false);
});

test("resolveHostUrl rewrites only host paths, and only with a base", () => {
  const base = "http://100.64.0.1:8770";
  assert.equal(resolveHostUrl(base, "/api/repos"), "http://100.64.0.1:8770/api/repos");
  assert.equal(resolveHostUrl(base + "/", "/api/repos"), "http://100.64.0.1:8770/api/repos");
  assert.equal(resolveHostUrl(base, "/index.html"), "/index.html");   // shell paths stay local
  assert.equal(resolveHostUrl(null, "/api/repos"), "/api/repos");     // the browser case
  assert.equal(resolveHostUrl("", "/api/repos"), "/api/repos");
});

test("wsUrlFor upgrades the scheme, and refuses a base it cannot", () => {
  assert.equal(wsUrlFor("http://100.64.0.1:8770"), "ws://100.64.0.1:8770/ws");
  assert.equal(wsUrlFor("https://desk.tail1234.ts.net"), "wss://desk.tail1234.ts.net/ws");
  assert.equal(wsUrlFor("https://desk.tail1234.ts.net/", "/ws2"), "wss://desk.tail1234.ts.net/ws2");
  assert.equal(wsUrlFor(null), null);
  assert.equal(wsUrlFor("ftp://x"), null);
});

test("a route is plain unless this device or the tailnet carries it: https alone proves nothing", () => {
  for (const b of ["http://192.168.1.20:8770", "http://10.0.0.2:8770", "http://desktop.local:8770", "http://100.63.0.1:8770",
    "http://100.128.0.1:8770", "http://example.com", "http://[fe80::1]:8770", "not a url",
    "https://192.168.1.20", "https://203.0.113.5", "https://r.example", "https://100.64.0.1", "http://127.evil.example", "http://127.0.0.1.evil.example",
    "file:///etc/hosts", "ftp://100.64.0.1"]) assert.equal(isPlainRoute(b), true, b);
  for (const b of ["https://desk.tail1.ts.net", "http://100.64.0.1:8770", "http://100.127.255.1:8770",
    "http://desk.tail1.ts.net:8770", "http://[fd7a:115c:a1e0::1]:8770", "http://127.0.0.1:8770", "http://localhost:8770", "http://[::1]:8770",
    null, undefined, ""]) assert.equal(isPlainRoute(b), false, String(b));
});

// `ShellRouteTest.java`'s TABLE, read off the file so the page and the shell cannot drift: each row
// is {url, protected with no pin, protected with a pin}, and a pin is what `trusted` says here.
test("the route rule agrees with ShellRoute.java, row by row", () => {
  const java = readFileSync(new URL("../../app/android/app/src/test/java/dev/waterplane/app/ShellRouteTest.java", import.meta.url), "utf8");
  const rows = [...java.matchAll(/\{"([^"]*)", (true|false), (true|false)\}/g)];
  assert.ok(rows.length > 30, "the table was found");
  for (const [, url, bare, pinned] of rows) {
    if (url === "") continue; // Java's "not protected" for no address; here `plain` is false for no route at all
    assert.equal(isPlainRoute(url), bare !== "true", `no pin: ${url}`);
    assert.equal(isPlainRoute(url, { trusted: true }), pinned !== "true", `pinned: ${url}`);
  }
});

test("trusted speaks only for https: nothing makes plain HTTP protected", () => {
  for (const b of ["https://192.168.1.5:8771", "https://r.example", "https://203.0.113.5"]) {
    assert.equal(isPlainRoute(b, { trusted: true }), false, b);
    assert.equal(isPlainRoute(b, { trusted: false }), true, b);
  }
  for (const b of ["http://192.168.1.5:8770", "http://r.example", "not a url"]) assert.equal(isPlainRoute(b, { trusted: true }), true, b);
});

test("tailnet: false takes the name's word away, and nothing else", () => {
  const off = { tailnet: false };
  for (const b of ["http://100.64.0.1:8770", "http://x.tail1.ts.net:8770", "https://x.tail1.ts.net", "http://[fd7a:115c:a1e0::1]:8770"]) {
    assert.equal(isPlainRoute(b), false, b);
    assert.equal(isPlainRoute(b, { tailnet: true }), false, b);
    assert.equal(isPlainRoute(b, off), true, b);
  }
  for (const b of ["http://127.0.0.1:8770", "http://localhost:8770", "http://[::1]:8770"]) assert.equal(isPlainRoute(b, off), false, b);
  assert.equal(isPlainRoute("https://192.168.1.5:8771", { ...off, trusted: true }), false, "a pin holds with Tailscale off");
  assert.equal(isPlainRoute("https://x.tail1.ts.net", { ...off, trusted: true }), false, "so does an address the person typed");
  assert.equal(isPlainRoute(null, off), false, "no route is still no route");
});

test("tlsBaseOf rewrites only a plain http address: a tailnet one has no listener", () => {
  const tls = { port: 8771, spki: "a".repeat(64) };
  assert.equal(tlsBaseOf("http://192.168.1.5:8770", tls), "https://192.168.1.5:8771");
  assert.equal(tlsBaseOf("http://studio.local:8770", tls), "https://studio.local:8771");
  assert.equal(tlsBaseOf("http://[fe80::1]:8770", tls), "https://[fe80::1]:8771");
  assert.equal(tlsBaseOf("http://192.168.1.5:8770", { port: 443 }), "https://192.168.1.5", "the form normalizeHostBase gives");
  for (const b of ["http://100.64.0.1:8770", "http://x.tail1.ts.net:8770", "https://x.tail1.ts.net", "http://127.0.0.1:8770", "http://localhost:8770",
    "https://r.example", "https://192.168.1.5:8771"]) assert.equal(tlsBaseOf(b, tls), b, b);
  for (const none of [null, undefined, { port: 0 }, { port: 70000 }, { port: 1.5 }]) assert.equal(tlsBaseOf("http://192.168.1.5:8770", none), "http://192.168.1.5:8770");
  assert.equal(tlsBaseOf("not a url", tls), "not a url");
});

test("the plain-route sentences are true of an https address too, and say what to do", () => {
  for (const s of [PLAIN_ROUTE_WARNING, PLAIN_ROUTE_TOAST, PLAIN_ROUTE_NO_FINGERPRINT, PLAIN_ROUTE_NO_UPDATE, PLAIN_ROUTE_NO_APK]) {
    assert.doesNotMatch(s, /plain HTTP|HTTPS|encrypted/, s);
    assert.match(s, /tailnet/, s);
  }
});

test("a proxy is https to a name of its own; a tailnet name or plain http is not one", () => {
  assert.equal(isProxyBase("https://desk.example.com"), true);
  assert.equal(isProxyBase("https://mac.tail1.ts.net"), false);
  assert.equal(isProxyBase("http://192.168.1.20:8770"), false);
  assert.equal(isProxyBase("http://100.64.0.5:8770"), false);
});

test("only what the tailnet alone protects needs the tunnel", () => {
  assert.equal(needsTunnel("http://100.64.0.5:8770"), true);
  assert.equal(needsTunnel("https://mac.tail1.ts.net"), true);
  assert.equal(needsTunnel("http://192.168.1.20:8770"), false);
  assert.equal(needsTunnel("https://desk.example.com"), false);
  assert.equal(needsTunnel("http://127.0.0.1:8770"), false);
});
