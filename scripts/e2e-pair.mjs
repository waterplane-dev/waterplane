// Pairing through a live host (`pair.ts`), bound on loopback.
//
// Before a password: a redeem answers the host, NO token and a sentence saying
// why, plus the LAN identity (loopback is a trusted path). After one: mint →
// the landing page names this desktop → the APK route streams the
// <ENV>_APK_PATH fixture with the Android content type → redeem hands out a
// token that works as a Bearer (the device list marks it current) → the same
// code fails the second time → an expired code fails. A bad code's landing
// page says nothing about the host. <ENV>_PAIR_TTL_MS shortens the lifetime so
// "expired" is reachable in seconds.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, PAIR_SCHEME, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8814;
const TTL = 3000;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const APK = join(mkdtempSync(join(tmpdir(), `${SLUG}-apk-`)), "fixture.apk");
const APK_BYTES = Buffer.from("PK\u0003\u0004 not really an apk, but bytes " + "x".repeat(4096));
writeFileSync(APK, APK_BYTES);
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  ...rootEnv(ROOT),
  [E.HOST]: "127.0.0.1",
  [E.APK_PATH]: APK,
  [E.PAIR_TTL_MS]: String(TTL),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
delete env[E.ALLOW_PUBLIC];

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const finish = async () => {
  await new Promise((r) => { if (host.exitCode !== null) return r(); host.once("exit", r); host.kill(); });
  process.exit(failed ? 1 : 0);
};

const B = `http://127.0.0.1:${PORT}`;
async function api(path, { method = "GET", headers = {}, body } = {}) {
  const r = await fetch(B + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, json };
}
const mint = () => api("/api/pair/mint", { method: "POST" });
const redeem = (code, deviceName = "e2e phone") => api("/api/pair/redeem", { method: "POST", body: { code, deviceName } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 600, async () => {
  try {
    // ── no password yet ──
    const m0 = await mint();
    check(m0.status === 200 && /^[2-9A-HJ-NP-Z]{8}$/.test(m0.json?.code ?? ""), "mint answers an 8-character code");
    check(m0.json?.landingUrl?.endsWith(`/pair/${m0.json.code}`) && m0.json?.deepLink?.startsWith(`${PAIR_SCHEME}://pair?u=`), "mint carries the landing URL and the deep link");
    check(m0.headers.get("cache-control") === "no-store", "mint is not cacheable");
    const r0 = await redeem(m0.json.code);
    check(r0.status === 200 && r0.json?.ok === true && r0.json.token === undefined, "no password: redeem answers, with no token");
    check(/no password/.test(r0.json?.note ?? ""), "…and says why there is no token");
    check(typeof r0.json?.host?.name === "string" && typeof r0.json?.host?.base === "string", "redeem answers the host's name and base");
    check(typeof r0.json?.lanIdentity?.secret === "string", "a loopback redeemer gets the LAN identity");

    // ── set the password from the trusted path, as Settings does ──
    const mgr = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => mgr.once("open", r));
    mgr.send(JSON.stringify({ t: "auth.set", password: "e2e-pair-password" }));
    await sleep(300);
    mgr.close();

    const m1 = await mint();
    const code = m1.json?.code;
    const page = await fetch(`${B}/pair/${code}`);
    const html = await page.text();
    const name = hostname().replace(/\.local$/i, "");
    check(page.status === 200 && html.includes(name), "landing page is 200 and names this desktop");
    check(page.headers.get("x-frame-options") === "DENY" && /default-src 'none'/.test(page.headers.get("content-security-policy") ?? ""), "landing carries the security headers");
    check(page.headers.get("cache-control") === "no-store", "landing is not cacheable");
    check(html.includes(`/pair/${code}/apk`) && html.includes("Download the Android app"), "landing offers the APK");
    check(!/<script/i.test(html), "landing runs no script");

    const apk = await fetch(`${B}/pair/${code}/apk`);
    const bytes = Buffer.from(await apk.arrayBuffer());
    check(apk.status === 200 && apk.headers.get("content-type") === "application/vnd.android.package-archive", "APK route streams with the Android content type");
    check(new RegExp(`attachment; filename="${SLUG}-\\d{8}-\\d{4}\\.apk"`).test(apk.headers.get("content-disposition") ?? ""), "APK carries a dated file name");
    check(bytes.equals(APK_BYTES), "APK bytes are the APK_PATH fixture");

    const bad = await fetch(`${B}/pair/ABCDEFGH`);
    const badHtml = await bad.text();
    check(bad.status === 404 && !badHtml.includes(name), "a bad code's page is 404 and names nothing");
    check((await fetch(`${B}/pair/ABCDEFGH/apk`)).status === 404, "a bad code gets no APK");

    const r1 = await redeem(code);
    check(r1.status === 200 && typeof r1.json?.token === "string" && typeof r1.json?.deviceId === "string", "redeem after a password hands out a token");
    const list = await api("/api/devices", { headers: { authorization: `Bearer ${r1.json.token}` } });
    const cur = list.json?.devices?.find((d) => d.current);
    check(cur?.id === r1.json.deviceId && cur?.name === "e2e phone", "the token works as a Bearer (its device row is current, named)");

    const r2 = await redeem(code);
    check(r2.status === 410 && r2.json?.ok === false && r2.json.error === "used" && r2.json.token === undefined, "a second redeem of the same code fails (used)");
    check((await fetch(`${B}/pair/${code}`)).status === 404, "a spent code's landing page is gone");

    const m2 = await mint();
    await sleep(TTL + 300);
    const r3 = await redeem(m2.json.code);
    check(r3.json?.ok === false && r3.json.error === "expired", "an expired code fails (expired)");

    // ── L2: a funnel request (public internet via the serve proxy) is never loopback-trusted ──
    const fm = await api("/api/pair/mint", { method: "POST", headers: { "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.9" } });
    check(fm.status === 401 || fm.status === 403, "a Tailscale-Funnel-Request mint is refused (needs a token / cannot manage)");

    // ── M2: password login is rate-limited before the hash is checked ──
    const codes = [];
    for (let i = 0; i < 16; i++) codes.push((await api("/api/auth/login", { method: "POST", body: { password: "wrong-" + i } })).status);
    const lr = await api("/api/auth/login", { method: "POST", body: { password: "wrong-x" } });
    check(codes.includes(401) && lr.status === 429 && Number(lr.headers.get("retry-after")) >= 1, "a login flood is answered 429 with retry-after");
  } catch (e) {
    console.error(e);
    failed = true;
  }
  await finish();
});
