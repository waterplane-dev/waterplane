/**
 * Read tickets (`?wt=`) for opaque loads on a LAN-only phone, and the self-signed port's notice page.
 * Pure over `auth.ts` / `lantls.ts`; a live pass is `scripts/e2e-lantls.mjs`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager, READ_TICKET_MS, admitReadTicket, stripWt } from "../dist/auth.js";
import { ensureSelfSigned, selfSignedNoticeFor, startLanTls, SELF_SIGNED_NOTICE_HEADERS, SELF_SIGNED_NOTICE_HTML } from "../dist/lantls.js";
import { passiveAllows } from "../dist/passive.js";

const scratch = mkdtempSync(join(tmpdir(), "readticket-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const r = join(scratch, `r${n++}`); mkdirSync(r); const a = new AuthManager(r); a.setPassword("pw-readticket"); return a; };
const TLS = { encrypted: true };
const PLAIN = {};
const never = () => false;
const ART = "/api/repos/r1/artifact";
const INBOX = "/api/repos/r1/inbox/photo.png";
const ask = (a, path, o = {}) => admitReadTicket(a, { url: o.url ?? `${path}?wt=${encodeURIComponent(o.wt)}`, method: o.method ?? "GET", path, socket: o.socket ?? TLS }, o.apk ?? never, o.now);
const device = (a, scope) => { const { token } = a.issueToken("phone", null, scope); return a.deviceFor(token); };

test("a valid ticket is accepted on each opaque route, GET and HEAD, over TLS", () => {
  const a = fresh();
  const row = device(a);
  const { ticket, exp } = a.mintReadTicket(row, 1000);
  assert.equal(exp, 1000 + READ_TICKET_MS);
  for (const path of [ART, INBOX]) for (const method of ["GET", "HEAD"]) {
    assert.equal(ask(a, path, { wt: ticket, method, now: 2000 })?.id, row.id, `${method} ${path}`);
  }
});

test("refused: another route, a plain socket, POST/DELETE, expiry, tampering, revoke", () => {
  const a = fresh();
  const { token } = a.issueToken("phone", null);
  const row = a.deviceFor(token);
  const { ticket } = a.mintReadTicket(row, 1000);
  const ok = { wt: ticket, now: 2000 };
  assert.ok(ask(a, ART, ok));
  for (const path of ["/api/health", "/api/repos", "/api/repos/r1/files", "/api/devices", "/api/repos/r1/artifact/x", "/api/repos/r1/inbox"]) assert.equal(ask(a, path, ok), null, path);
  assert.equal(ask(a, ART, { ...ok, socket: PLAIN }), null, "plain socket");
  for (const method of ["POST", "DELETE", "PUT"]) assert.equal(ask(a, INBOX, { ...ok, method }), null, method);
  assert.equal(ask(a, ART, { wt: ticket, now: 1000 + READ_TICKET_MS }), null, "expired");
  assert.equal(ask(a, ART, { wt: ticket, now: 1000 + READ_TICKET_MS - 1 })?.id, row.id, "last millisecond");
  const [body, mac] = ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ deviceId: row.id, scope: "full", exp: 9e15 })).toString("base64url");
  assert.equal(ask(a, ART, { wt: `${forged}.${mac}`, now: 2000 }), null, "body swapped under the old MAC");
  assert.equal(ask(a, ART, { wt: `${body}.${mac.slice(0, -2)}AA`, now: 2000 }), null, "tampered MAC");
  assert.equal(ask(a, ART, { wt: "junk", now: 2000 }), null);
  assert.equal(ask(a, ART, { wt: "", now: 2000 }), null);
  assert.equal(ask(a, ART, { url: ART, now: 2000 }), null, "no wt at all");
  assert.equal(ask(fresh(), ART, ok), null, "another host's key");
  a.revoke(token);
  assert.equal(ask(a, ART, ok), null, "dead with the device row");
});

test("a ticket dies with the password", () => {
  const a = fresh();
  const row = device(a);
  const { ticket } = a.mintReadTicket(row);
  assert.ok(ask(a, ART, { wt: ticket }));
  a.setPassword("another-password");
  assert.equal(ask(a, ART, { wt: ticket }), null);
});

test("a passive row's ticket is held to what a passive token may read", () => {
  const a = fresh();
  const row = device(a, "passive");
  const { ticket } = a.mintReadTicket(row);
  const apk = (repo, rel) => repo === "r1" && rel === ".claude/outbox/app.apk";
  const url = (p, q) => `${p}?${q}&wt=${encodeURIComponent(ticket)}`;
  assert.equal(admitReadTicket(a, { url: url(ART, "path=.claude/outbox/app.apk&download=1"), method: "GET", path: ART, socket: TLS }, apk)?.id, row.id, "the queued APK");
  assert.equal(admitReadTicket(a, { url: url(ART, "path=src/secret.ts"), method: "GET", path: ART, socket: TLS }, apk), null, "any other file");
  assert.equal(admitReadTicket(a, { url: url(INBOX, "x=1"), method: "GET", path: INBOX, socket: TLS }, apk), null, "an inbox file");
  // A full ticket carries no such limit.
  const f = a.mintReadTicket(device(a)).ticket;
  assert.ok(admitReadTicket(a, { url: `${INBOX}?wt=${encodeURIComponent(f)}`, method: "GET", path: INBOX, socket: TLS }, apk));
});

test("the ticket route is on a passive row's allowlist, as POST only", () => {
  assert.equal(passiveAllows("POST", "/api/auth/read-ticket", new URLSearchParams(), never), true);
  assert.equal(passiveAllows("GET", "/api/auth/read-ticket", new URLSearchParams(), never), false);
  assert.equal(passiveAllows("POST", "/api/auth/other", new URLSearchParams(), never), false);
});

test("stripWt removes only wt", () => {
  assert.equal(stripWt("/api/x?wt=abc"), "/api/x");
  assert.equal(stripWt("/api/x?path=a&wt=abc&download=1"), "/api/x?path=a&download=1");
  assert.equal(stripWt("/api/x?path=a"), "/api/x?path=a");
  assert.equal(stripWt("/api/x"), "/api/x");
  assert.equal(stripWt("/api/x?swt=1&wtf=2"), "/api/x?swt=1&wtf=2");
});

test("self-signed port: the notice stands in for the app; an own leaf serves the app; the plain port always does", async () => {
  const root = join(scratch, "tls");
  mkdirSync(root);
  const material = ensureSelfSigned(root, ["127.0.0.1"]);
  assert.ok(!("refused" in material));
  const up = async (m) => {
    const servers = startLanTls({ port: 0, addrs: ["127.0.0.1"], material: m }, (_q, s) => s.end(), () => new EventEmitter());
    await new Promise((r) => servers[0].once("listening", r));
    return servers;
  };
  const a = await up(material);
  try {
    assert.equal(selfSignedNoticeFor(TLS), true, "TLS socket on a self-signed leaf");
    assert.equal(selfSignedNoticeFor(PLAIN), false, "the plain port is unaffected");
  } finally { await new Promise((r) => a[0].close(r)); }
  const b = await up({ ...material, selfSigned: false });
  try {
    assert.equal(selfSignedNoticeFor(TLS), false, "own leaf: the app is served");
  } finally { await new Promise((r) => b[0].close(r)); }
});

test("the notice page is plain and says nothing about the desktop", () => {
  assert.match(SELF_SIGNED_NOTICE_HTML, /This port is for the app/);
  assert.doesNotMatch(SELF_SIGNED_NOTICE_HTML, /<script|<a |href=|src=|waterplane|\d+\.\d+\.\d+|\/Users|\.ts\.net/i);
  assert.equal(SELF_SIGNED_NOTICE_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(SELF_SIGNED_NOTICE_HEADERS["referrer-policy"], "no-referrer");
  assert.match(SELF_SIGNED_NOTICE_HEADERS["content-security-policy"], /default-src 'none'/);
});
