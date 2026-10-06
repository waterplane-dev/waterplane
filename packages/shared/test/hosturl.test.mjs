// Where "the host" is when the app is NOT served by it — the Android shell
// (`shared/src/hosturl.ts`). The scheme allowlist here is security-relevant:
// this string becomes the base of every request the app makes.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_PORT, isHostPath, normalizeHostBase, resolveHostUrl, wsUrlFor } from "../dist/index.js";

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
