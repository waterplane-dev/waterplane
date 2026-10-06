// Host-address resolution for the Android shell (packages/app): what a typed
// address normalises to, and which URLs are re-aimed at the daemon vs left on
// the app's own local origin. (No network — pure functions.)
//
// These rules are the difference between an APK that works offline and one that
// does not: the shell (index.html, /assets/*, /sw.js) MUST stay local, because
// serving it from the host is exactly the failure the APK exists to remove, and
// only `/api` + `/ws` may be re-pointed. The address itself is attacker-adjacent
// input — it is typed on a phone keyboard and becomes the target of every
// request the app makes.
import { normalizeHostBase, isHostPath, resolveHostUrl, wsUrlFor, DEFAULT_HOST_PORT } from "../packages/shared/dist/hosturl.js";
let failed = false; const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const eq = (a, b, l) => check(a === b, `${l}${a === b ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

// ── normalizeHostBase: what someone actually types ────────────────────────
eq(normalizeHostBase("100.64.0.5"), "http://100.64.0.5:8770", "bare IP gets http + the daemon port");
eq(normalizeHostBase("  100.64.0.5  "), "http://100.64.0.5:8770", "surrounding whitespace trimmed");
eq(normalizeHostBase("100.64.0.5:9000"), "http://100.64.0.5:9000", "explicit port kept");
eq(normalizeHostBase("mac.tailnet.ts.net"), "http://mac.tailnet.ts.net:8770", "bare MagicDNS name gets the daemon port");
eq(normalizeHostBase("MAC.Tailnet.TS.net"), "http://mac.tailnet.ts.net:8770", "host lowercased");
eq(normalizeHostBase("//100.64.0.5"), "http://100.64.0.5:8770", "leading slashes are not a protocol-relative URL here");
eq(DEFAULT_HOST_PORT, 8770, "default port matches the daemon's PORT default");

// https means the `tailscale serve` front door, which is on 443 — appending the
// daemon's own port there would aim at something nothing listens on.
eq(normalizeHostBase("https://mac.tailnet.ts.net"), "https://mac.tailnet.ts.net", "https keeps its implicit 443");
eq(normalizeHostBase("https://mac.tailnet.ts.net:8443"), "https://mac.tailnet.ts.net:8443", "https with an explicit port kept");
eq(normalizeHostBase("http://mac.local"), "http://mac.local:8770", "explicit http with no port still means the daemon");

// A base is an ORIGIN. A surviving path would silently prefix every API call.
eq(normalizeHostBase("http://100.64.0.5:8770/some/where?q=1#f"), "http://100.64.0.5:8770", "path/query/hash dropped");
eq(normalizeHostBase("http://100.64.0.5:8770/"), "http://100.64.0.5:8770", "trailing slash dropped");

// IPv6 has to come back out bracketed — `http://fd7a::1:8770` is not the same
// address, it is a parse error waiting to happen.
eq(normalizeHostBase("[fd7a:1::2]"), "http://[fd7a:1::2]:8770", "bare bracketed IPv6");
eq(normalizeHostBase("http://[fd7a:1::2]:9000"), "http://[fd7a:1::2]:9000", "IPv6 with a port");

// Scheme allowlist — this string is fed to fetch().
for (const bad of ["javascript:alert(1)", "data:text/html,<b>x", "file:///etc/passwd", "ftp://h/x", "ws://h:8770"]) {
  eq(normalizeHostBase(bad), null, `refuses ${bad.split(":")[0]}: scheme`);
}
for (const empty of ["", "   ", "http://", "///"]) eq(normalizeHostBase(empty), null, `refuses ${JSON.stringify(empty)}`);

// ── isHostPath: only the daemon's two roots ───────────────────────────────
for (const p of ["/api", "/api/health", "/api/repos/x/artifact?path=y", "/api?x=1", "/ws", "/ws?x=1"]) {
  check(isHostPath(p), `host path: ${p}`);
}
// The shell. Every one of these must keep coming out of the APK.
for (const p of ["/", "/index.html", "/assets/index-abc.js", "/sw.js", "/manifest.webmanifest", "/assets/icon-512.png"]) {
  check(!isHostPath(p), `stays local: ${p}`);
}
// Prefix must end on a segment/query boundary, or `/apidocs` would be proxied.
for (const p of ["/apix/y", "/apidocs", "/wsx", "/websocket"]) check(!isHostPath(p), `not a host path: ${p}`);
// Absolute URLs are not paths.
for (const p of ["//evil.example/api/x", "https://evil.example/api/x", "http://evil.example/ws", "api/x", ""]) {
  check(!isHostPath(p), `not path-absolute: ${JSON.stringify(p)}`);
}

// ── resolveHostUrl ────────────────────────────────────────────────────────
const B = "http://100.64.0.5:8770";
eq(resolveHostUrl(B, "/api/health"), `${B}/api/health`, "api path re-aimed at the host");
eq(resolveHostUrl(B, "/ws"), `${B}/ws`, "ws path re-aimed at the host");
eq(resolveHostUrl(`${B}/`, "/api/health"), `${B}/api/health`, "trailing slash on the base does not double up");
eq(resolveHostUrl(B, "/assets/index-abc.js"), "/assets/index-abc.js", "shell asset untouched");
eq(resolveHostUrl(B, "/sw.js"), "/sw.js", "service worker untouched");

// The one that matters: a protocol-relative URL is ABSOLUTE. Splicing it behind
// our base would send the request to whoever owns that authority.
eq(resolveHostUrl(B, "//evil.example/api/x"), "//evil.example/api/x", "protocol-relative URL left alone");
eq(resolveHostUrl(B, "https://evil.example/api/x"), "https://evil.example/api/x", "absolute URL left alone");
eq(resolveHostUrl(B, "api/x"), "api/x", "relative URL left alone");

// Browser: no base, so the client behaves exactly as it did before this existed.
eq(resolveHostUrl("", "/api/health"), "/api/health", "empty base = same-origin (browser)");
eq(resolveHostUrl(null, "/api/health"), "/api/health", "null base = same-origin (browser)");
eq(resolveHostUrl(undefined, "/api/health"), "/api/health", "undefined base = same-origin (browser)");

// ── wsUrlFor ──────────────────────────────────────────────────────────────
eq(wsUrlFor(B), `ws://100.64.0.5:8770/ws`, "http base ⇒ ws://");
eq(wsUrlFor("https://mac.tailnet.ts.net"), "wss://mac.tailnet.ts.net/ws", "https base ⇒ wss://");
eq(wsUrlFor(`${B}/`), `ws://100.64.0.5:8770/ws`, "trailing slash on the base does not double up");
eq(wsUrlFor(null), null, "no base ⇒ no socket URL (the shell shows the pairing screen instead)");
eq(wsUrlFor(""), null, "empty base ⇒ no socket URL");

// A normalised base always round-trips into a usable socket URL.
for (const typed of ["100.64.0.5", "mac.tailnet.ts.net:8770", "https://mac.tailnet.ts.net", "[fd7a:1::2]"]) {
  const url = wsUrlFor(normalizeHostBase(typed));
  check(!!url && /^wss?:\/\/.+\/ws$/.test(url), `"${typed}" ⇒ socket URL ${url}`);
}

console.log(failed ? "\nFAILURES" : "\nALL PASS");
process.exit(failed ? 1 : 0);
