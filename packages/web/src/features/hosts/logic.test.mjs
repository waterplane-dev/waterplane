import test from "node:test";
import assert from "node:assert/strict";

import {
  codeLeftText, countHostWords, deviceRouteText, devicesEmptyText, hostAddress, hostRows, qrPath, removeLines, revokeLines, seenAgo,
  nextHostId, rowPairTarget, shortHostName, showHostName, switchFailText, wordsText,
} from "./logic.ts";

const KEYS = {
  composeDrafts: "d", composeSheets: "s", compose: "c", backlogDraft: "b", fanoutText: "f",
  pad: "p", composeOutbox: "o", outbox: "ol",
};

test("words are counted by kind; blank drafts and unreadable values count as nothing", () => {
  const store = {
    d: JSON.stringify({ s1: "hello", s2: "   ", s3: "x" }),
    s: JSON.stringify({ send: "sheet words" }),
    c: "",
    b: "an idea",
    f: "\"\"",
    p: JSON.stringify([{ id: "n1", text: "a", ts: 1 }, { id: "n2", text: "b", ts: 2 }]),
    o: JSON.stringify([{ ackId: "1", status: "queued" }, { ackId: "2", status: "failed" }]),
    ol: "{not json",
  };
  assert.deepEqual(countHostWords((k) => store[k] ?? null, KEYS), { drafts: 4, notes: 2, queued: 2 });
  assert.deepEqual(countHostWords(() => null, KEYS), { drafts: 0, notes: 0, queued: 0 });
});

test("the sentence names each kind with its number, and nothing when there is nothing", () => {
  assert.equal(wordsText({ drafts: 3, notes: 0, queued: 1 }), "3 drafts and 1 queued prompt");
  assert.equal(wordsText({ drafts: 1, notes: 2, queued: 3 }), "1 draft, 2 pad notes and 3 queued prompts");
  assert.equal(wordsText({ drafts: 0, notes: 1, queued: 0 }), "1 pad note");
  assert.equal(wordsText({ drafts: 0, notes: 0, queued: 0 }), null);
});

test("the remove question says what STAYS, and where the app goes when it is the host in use", () => {
  assert.deepEqual(removeLines({ drafts: 3, notes: 0, queued: 1 }, false, null),
    ["3 drafts and 1 queued prompt stay saved on this phone; re-add the host to see them."]);
  assert.deepEqual(removeLines({ drafts: 1, notes: 0, queued: 0 }, false, null),
    ["1 draft stays saved on this phone; re-add the host to see them."]);
  const next = { id: "b", name: "laptop", base: "http://100.64.0.9:8770" };
  assert.deepEqual(removeLines({ drafts: 0, notes: 0, queued: 0 }, true, next), [
    "Nothing unsent is saved for it on this phone.",
    "It is the host in use: the app switches to laptop first, then reloads.",
  ]);
  assert.match(removeLines({ drafts: 0, notes: 0, queued: 0 }, true, null)[1], /connect screen/);
});

test("rows: active first; the header names a host only when there are two", () => {
  const a = { id: "a", name: "desk", base: "http://100.64.0.5:8770" };
  const b = { id: "b", name: "laptop", base: "https://laptop.tail.ts.net" };
  assert.deepEqual(hostRows([a, b], "b").map((h) => h.id), ["b", "a"]);
  assert.equal(showHostName([a]), false);
  assert.equal(showHostName([a, b]), true);
  assert.equal(hostAddress(a.base), "100.64.0.5");
  assert.equal(hostAddress(b.base), "laptop.tail.ts.net");
});

test("qrPath: one rectangle per dark run, row by row", () => {
  const grid = ["#.#", "###", "..."];
  const d = qrPath(3, (r, c) => grid[r][c] === "#");
  assert.equal(d, "M0 0h1v1h-1zM2 0h1v1h-1zM0 1h3v1h-3z");
  assert.equal(qrPath(2, () => false), "");
});

test("the code countdown never reads 0:00 while it still works, and is null once spent", () => {
  assert.equal(codeLeftText(600_000), "10:00 left");
  assert.equal(codeLeftText(61_001), "1:02 left");
  assert.equal(codeLeftText(1), "0:01 left");
  assert.equal(codeLeftText(0), null);
  assert.equal(codeLeftText(-5), null);
  assert.equal(codeLeftText(Number.NaN), null);
});

test("paired devices: route words, ages, and the revoke question for this phone vs another", () => {
  assert.equal(deviceRouteText("lan"), "over the Wi-Fi (LAN)");
  assert.equal(deviceRouteText(null), "route not recorded");
  assert.equal(seenAgo(10_000), "just now");
  assert.equal(seenAgo(5 * 60_000), "5 min ago");
  assert.deepEqual(revokeLines({ name: "Pixel", current: false }), ["Pixel will need a new pairing code to connect again."]);
  const mine = revokeLines({ name: "Pixel", current: true }).join(" ");
  assert.match(mine, /signs this phone out/);
  assert.match(devicesEmptyText(false), /Set a host password to give each phone its own sign-in/);
  assert.doesNotMatch(devicesEmptyText(true), /password/);
});

test("shortHostName: first word, capped to fit beside the cog, never blank for a named host", () => {
  assert.equal(shortHostName("DeskMini-von-Alex"), "DeskM…");
  assert.equal(shortHostName("laptop.tail.ts.net"), "laptop");
  assert.equal(shortHostName("  wp peer "), "wp");
  assert.equal(shortHostName("Supercalifragilistic").length, 6);
  assert.equal(shortHostName(""), "");
});

test("nextHostId: two flip, three go round, one or none is no toggle", () => {
  const h = (id) => ({ id, name: id, base: "http://x" });
  assert.equal(nextHostId([h("a"), h("b")], "a"), "b");
  assert.equal(nextHostId([h("a"), h("b")], "b"), "a");
  assert.equal(nextHostId([h("a"), h("b"), h("c")], "c"), "a");
  assert.equal(nextHostId([h("a"), h("b"), h("c")], "b"), "c");
  // In the demo (not in the list): the first real host.
  assert.equal(nextHostId([h("a"), h("b")], "demo"), "a");
  assert.equal(nextHostId([h("a")], "a"), null);
  assert.equal(nextHostId([], null), null);
});

test("a switch that ran out of room names where the phone still is", () => {
  const hosts = [{ id: "mac", name: "MacStudio", base: "http://100.64.0.5:8770" }, { id: "zen", name: "zenbookJ", base: "http://100.64.0.9:8770" }];
  const park = switchFailText({ stage: "park", from: "mac", to: "zen" }, hosts);
  assert.match(park, /Could not switch to zenbookJ: this phone's storage is full\. Still on MacStudio/);
  assert.match(park, /Storage on this phone/);
  assert.match(switchFailText({ stage: "restore", from: "mac", to: "zen" }, hosts), /^On zenbookJ, but .* kept/);
  assert.match(switchFailText({ stage: "park", from: "mac", to: "gone" }, hosts), /switch to the other desktop/);
});

// ── Waiting elsewhere ──────────────────────────────────────────────────
import {
  ELSEWHERE_BACKOFF_MAX_MS, ELSEWHERE_FRESH_MS, ELSEWHERE_POLL_MS, elsewhereChipText, elsewhereRiseText, elsewhereRose, elsewhereRowText,
  elsewhereRows, elsewhereSaidText, elsewhereTotal, itemOpenTarget, nextAskIn, nextRead,
} from "./logic.ts";
import { bearerForSaved } from "../../deviceToken.ts";
import { takeOpenAfter, writeOpenAfter } from "../../hosts.ts";
import { LS } from "../../storage.ts";

const A = { id: "aaa111", name: "mac studio", base: "http://100.64.0.1:8770" };
const B = { id: "bbb222", name: "zenbook", base: "http://100.64.0.2:8770" };
const C = { id: "ccc333", name: "office", base: "http://100.64.0.3:8770" };
const summary = (sessions = 0, items = []) => ({ ts: 1, sessions: { n: sessions, ids: Array.from({ length: sessions }, (_, i) => `s${i}`) }, attention: { n: items.length, items } });
const vault = { id: "n1", ts: 900, kind: "approval", title: "vault: approve gcp key", plugin: "vault", tag: "plugin-vault-ask:x" };
const ok = (at, s) => ({ ok: { at, summary: s }, fail: null, fails: 0 });

test("elsewhere: a fresh read with something waiting is a row; the active desktop and a zero read are not", () => {
  const now = 10_000;
  const reads = { [A.id]: ok(now, summary(1)), [B.id]: ok(now - 1000, summary(0, [vault])), [C.id]: ok(now, summary(0)) };
  const rows = elsewhereRows([A, B, C], A.id, reads, now);
  assert.deepEqual(rows.map((r) => [r.host.id, r.state]), [[B.id, "waiting"]]);
  assert.equal(elsewhereTotal(rows), 1);
  assert.equal(elsewhereChipText(rows), "zenbo… · 1 waiting", "the short name, as the host key draws it");
  assert.equal(elsewhereRowText(rows[0].summary), "1 approval request (vault)");
});

test("elsewhere: several desktops are counted together, most waiting first", () => {
  const now = 5_000;
  const reads = { [B.id]: ok(now, summary(1, [vault])), [C.id]: ok(now, summary(0, [vault, { ...vault, id: "n2" }])) };
  const rows = elsewhereRows([A, B, C], A.id, reads, now);
  assert.equal(elsewhereTotal(rows), 4);
  assert.equal(elsewhereChipText(rows), "2 desktops · 4 waiting");
  assert.equal(elsewhereRowText(rows[0].summary), "1 approval request (vault) · 1 session on a question");
});

test("elsewhere: nothing waiting anywhere ⇒ no chip; a desktop never read is absent", () => {
  assert.equal(elsewhereChipText(elsewhereRows([A, B], A.id, {}, 0)), null);
  assert.equal(elsewhereChipText(elsewhereRows([A, B], A.id, { [B.id]: ok(0, summary(0)) }, 0)), null);
});

test("elsewhere: a stale or failing read never shows its number — a sentence instead, and no chip", () => {
  const at = 1_000;
  const stale = elsewhereRows([A, B], A.id, { [B.id]: ok(at, summary(0, [vault])) }, at + ELSEWHERE_FRESH_MS + 1);
  assert.deepEqual(stale.map((r) => r.state), ["stale"]);
  assert.equal(elsewhereTotal(stale), 0);
  assert.equal(elsewhereChipText(stale), null);
  assert.match(elsewhereSaidText(stale[0], at + ELSEWHERE_FRESH_MS + 1), /zenbook is not answering — its last answer, .* said 1 waiting/);
  const failed = nextRead(ok(at, summary(0, [vault])), at + 10, { status: 0, summary: null });
  const rows = elsewhereRows([A, B], A.id, { [B.id]: failed }, at + 20);
  assert.deepEqual(rows.map((r) => r.state), ["stale"], "an offline answer right after a good one is no longer counted");
});

test("elsewhere: 401 is signed out — a sentence with the way back, a chip that says so, never a number", () => {
  const r = nextRead(undefined, 5, { status: 401, summary: null });
  assert.deepEqual(r.fail, { at: 5, why: "signedOut" });
  const rows = elsewhereRows([A, B], A.id, { [B.id]: r }, 6);
  assert.equal(elsewhereChipText(rows), "zenbo… · signed out");
  assert.match(elsewhereSaidText(rows[0], 6), /signed out on zenbook — pair again/);
});

test("elsewhere: the read ladder — 403 refused, 200 unreadable, network offline; a good read resets the backoff", () => {
  assert.equal(nextRead(undefined, 1, { status: 403, summary: null }).fail.why, "refused");
  assert.equal(nextRead(undefined, 1, { status: 200, summary: null }).fail.why, "unreadable");
  assert.equal(nextRead(undefined, 1, { status: 0, summary: null }).fail.why, "offline");
  const two = nextRead(nextRead(undefined, 1, { status: 0, summary: null }), 2, { status: 0, summary: null });
  assert.equal(two.fails, 2);
  assert.equal(nextRead(two, 3, { status: 200, summary: summary(0) }).fails, 0);
  assert.equal(nextAskIn(0), ELSEWHERE_POLL_MS);
  assert.ok(nextAskIn(1) > ELSEWHERE_POLL_MS);
  assert.equal(nextAskIn(30), ELSEWHERE_BACKOFF_MAX_MS);
});

test("elsewhere: the toast fires on a rise only, never on the first read", () => {
  assert.equal(elsewhereRose(undefined, 3), false);
  assert.equal(elsewhereRose(0, 1), true);
  assert.equal(elsewhereRose(2, 2), false);
  assert.equal(elsewhereRose(2, 1), false);
  assert.match(elsewhereRiseText(B, summary(0, [vault])), /^zenbook: 1 approval request \(vault\) waiting/);
});

test("elsewhere: an item lands on its plugin's screen or its session", () => {
  assert.equal(itemOpenTarget({ plugin: "vault" }), "plugin:vault");
  assert.equal(itemOpenTarget({ sessionId: "a1b2c3d4" }), "a1b2c3d4");
  assert.equal(itemOpenTarget({}), undefined);
});

test("bearerForSaved: that desktop's tailnet origin only — never its LAN address, never another origin", () => {
  const tok = "t".repeat(32);
  const host = { base: "http://100.64.0.7:8770", lan: { base: "http://192.168.1.7:8770" } };
  assert.equal(bearerForSaved(host, tok, "http://100.64.0.7:8770/api/attention"), `Bearer ${tok}`);
  assert.equal(bearerForSaved(host, tok, "http://192.168.1.7:8770/api/attention"), null, "the LAN address");
  assert.equal(bearerForSaved(host, tok, "http://100.64.0.8:8770/api/attention"), null, "another desktop");
  assert.equal(bearerForSaved(host, tok, "http://100.64.0.7:9999/api/attention"), null, "another port is another origin");
  assert.equal(bearerForSaved(host, tok, "https://evil.example/api/attention"), null);
  assert.equal(bearerForSaved(host, tok, "javascript:alert(1)"), null);
  assert.equal(bearerForSaved(host, null, "http://100.64.0.7:8770/api/attention"), null, "no token, no header");
  assert.equal(bearerForSaved(host, "short", "http://100.64.0.7:8770/api/attention"), null, "a hand-edited token is not sent");
  // A LAN address saved AS the base origin is still refused: the LAN rule wins.
  assert.equal(bearerForSaved({ base: "http://192.168.1.7:8770", lan: { base: "http://192.168.1.7:8770" } }, tok, "http://192.168.1.7:8770/api/attention"), null);
});

test("hostOpenAfter: written for one switch, drained once, only on the desktop it was for", () => {
  const m = new Map();
  const kv = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  writeOpenAfter(kv, "bbb222", "plugin:vault");
  assert.equal(takeOpenAfter(kv, "bbb222"), "plugin:vault");
  assert.equal(takeOpenAfter(kv, "bbb222"), null, "drained once");
  writeOpenAfter(kv, "bbb222", "a1b2c3d4");
  assert.equal(takeOpenAfter(kv, "aaa111"), null, "a note for another desktop is dropped");
  assert.equal(m.has(LS.hostOpenAfter), false);
  // Stage 2 changed the rule: a whole alert and the notification list are targets now.
  const alert = "notif:" + JSON.stringify({ id: "n1", title: "Health moved", kind: "health", body: "x", ts: 1 });
  writeOpenAfter(kv, "bbb222", alert);
  assert.equal(takeOpenAfter(kv, "bbb222"), alert, "a whole alert round-trips");
  assert.equal(takeOpenAfter(kv, "bbb222"), null, "and is drained once");
  writeOpenAfter(kv, "bbb222", alert);
  assert.equal(takeOpenAfter(kv, "aaa111"), null, "an alert note for another desktop is dropped");
  writeOpenAfter(kv, "bbb222", "view:notifications");
  assert.equal(takeOpenAfter(kv, "bbb222"), "view:notifications", "the summary target (notification list)");
  for (const bad of ["notif:{\"id\":1}", "notif:{not json", "notif:" + "x".repeat(9000), "view:other", "https://evil.example/", "javascript:alert(1)", "host:a|b", ""]) {
    writeOpenAfter(kv, "bbb222", bad);
    assert.equal(m.has(LS.hostOpenAfter), false, `never written: ${bad.slice(0, 30)}`);
    m.set(LS.hostOpenAfter, JSON.stringify({ to: "bbb222", open: bad }));
    assert.equal(takeOpenAfter(kv, "bbb222"), null, `dropped on read: ${bad.slice(0, 30)}`);
  }
  m.set(LS.hostOpenAfter, JSON.stringify({ to: "bbb222", open: "plugin:../x" }));
  assert.equal(takeOpenAfter(kv, "bbb222"), null, "an invalid target read back is dropped");
  m.set(LS.hostOpenAfter, "{not json");
  assert.equal(takeOpenAfter(kv, "bbb222"), null);
});

test("use plain HTTP: says what it costs and the way back; a changed key leads with why and with pairing", async () => {
  const { plainHttpDoneText, plainHttpLines } = await import("./logic.ts");
  const calm = plainHttpLines(false).join(" ");
  assert.match(calm, /could read/);
  assert.match(calm, /until you pair again by code/);
  const changed = plainHttpLines(true);
  assert.match(changed[0], /different key.*someone is in between/);
  assert.match(changed[1], /Pairing by code proves/);
  assert.match(plainHttpDoneText("desk"), /^desk now uses plain HTTP\. Pair by code/);
});

test("pair by code from a row: the row's own address, with its LAN address beside it when it has one", () => {
  const base = "http://100.64.0.5:8770", lan = "http://192.168.1.20:8770";
  assert.deepEqual(rowPairTarget({ base, lan: { base: lan, ssids: [], auto: false } }), { base, code: "", lan });
  assert.deepEqual(rowPairTarget({ base }), { base, code: "" });
});
