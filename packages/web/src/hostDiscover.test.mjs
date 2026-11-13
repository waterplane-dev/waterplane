/**
 * Add a desktop: found rows (already-paired marked), the phone's own health
 * verdict, and the text copy/share put in another app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foundRows, healthVerdict, passwordSentence, emptyFoundText, foundSub } from "./hostDiscover.ts";
import { pairLinkOf, pairShareText, canCopyDirectly, CLIPBOARD_NEEDS_HTTPS } from "./pairShare.ts";

const peer = (name, addr, gated = false) => ({ name, addr, os: "linux", gated });
const saved = (id, base) => ({ id, name: id, base });

test("foundRows marks a desktop already on the phone, and lists it last", () => {
  const rows = foundRows(
    [peer("a", "100.64.0.2:8770"), peer("b", "100.64.0.3:8770"), peer("c", "100.64.0.4:9000")],
    [saved("h1", "http://100.64.0.2:8770")],
  );
  assert.deepEqual(rows.map((r) => r.peer.name), ["b", "c", "a"]);
  assert.equal(rows[2].saved.id, "h1");
  assert.equal(rows[0].saved, null);
  assert.equal(rows[0].base, "http://100.64.0.3:8770");
  assert.equal(rows[1].base, "http://100.64.0.4:9000");
});

test("foundRows matches a saved address typed without the default port", () => {
  const rows = foundRows([peer("a", "100.64.0.2:8770")], [saved("h1", "100.64.0.2")]);
  assert.ok(rows[0].saved);
});

test("foundRows drops an address that is not one", () => {
  assert.deepEqual(foundRows([peer("x", "")], []), []);
});

test("healthVerdict: open, password, other", () => {
  assert.equal(healthVerdict(200, { ok: true, protocol: 3 }), "open");
  assert.equal(healthVerdict(401, { authRequired: true }), "password");
  assert.equal(healthVerdict(401, {}), "other");
  assert.equal(healthVerdict(200, { ok: false }), "other");
  assert.equal(healthVerdict(500, null), "other");
});

test("the password sentence names the desktop and the CLI command", () => {
  const s = passwordSentence("orb-linux");
  assert.match(s, /orb-linux has a password/);
  assert.match(s, / pair/);
});

test("an empty list says why: the host's note, else which of the two empties", () => {
  assert.equal(emptyFoundText("Tailscale is not installed", false), "Tailscale is not installed");
  assert.match(emptyFoundText(undefined, true), /already on this device/);
  assert.match(emptyFoundText(undefined, false), /No other .* desktop/);
});

test("a gated row says so in text", () => {
  assert.match(foundSub({ peer: peer("a", "100.64.0.2:8770", true), base: "", saved: null }), /has a password/);
});

test("share text carries the link and the code, readable as text", () => {
  const t = pairShareText({ landingUrl: "http://100.1.2.3:8770/pair/ABCDEFGH", code: "ABCDEFGH" }, "orb");
  assert.match(t, /with orb: http:\/\/100\.1\.2\.3:8770\/pair\/ABCDEFGH/);
  assert.match(t, /Code: ABCD-EFGH/);
  assert.doesNotMatch(pairShareText({ landingUrl: "u", code: "ABCDEFGH" }, null), /with/);
});

test("a desktop with no tailnet shows the deep link: its landing URL would burn the code on a plain socket", () => {
  const m = { base: "http://192.168.1.20:8770", lanBase: "http://192.168.1.20:8770", landingUrl: "http://192.168.1.20:8770/pair/ABCDEFGH", deepLink: "waterplane://pair?u=x&c=ABCDEFGH&s=1", code: "ABCDEFGH" };
  assert.equal(pairLinkOf(m), m.deepLink);
  assert.match(pairShareText(m, null), /waterplane:\/\/pair/);
  assert.doesNotMatch(pairShareText(m, null), /\/pair\/ABCDEFGH/);
  assert.equal(pairLinkOf({ ...m, base: "http://100.64.0.5:8770" }), m.landingUrl, "a tailnet base's landing page is on a protected socket");
  assert.equal(pairLinkOf({ ...m, base: "http://100.64.0.5:8770", lanBase: undefined }), m.landingUrl);
});

test("a new phone with no Tailscale gets the LAN deep link, and a landing URL never carries the LAN address", () => {
  const m = { base: "http://100.64.0.5:8770", lanBase: "http://192.168.1.20:8770", landingUrl: "http://100.64.0.5:8770/pair/ABCDEFGH", deepLink: "waterplane://pair?u=t&c=ABCDEFGH&l=x", lanDeepLink: "waterplane://pair?u=lan&c=ABCDEFGH", code: "ABCDEFGH" };
  assert.equal(pairLinkOf(m), m.landingUrl, "the sheet opens as it always did");
  assert.equal(pairLinkOf(m, true), m.lanDeepLink);
  assert.match(pairShareText(m, null, true), /waterplane:\/\/pair\?u=lan/);
  assert.doesNotMatch(pairShareText(m, null, true), /\/pair\/ABCDEFGH/);
  assert.equal(pairLinkOf({ ...m, lanDeepLink: undefined }, true), m.landingUrl, "no LAN bound: nothing to offer");
});

test("clipboard: direct only in a secure context that has one; the sentence says https", () => {
  assert.equal(canCopyDirectly(true, true), true);
  assert.equal(canCopyDirectly(false, true), false);
  assert.equal(canCopyDirectly(true, false), false);
  assert.match(CLIPBOARD_NEEDS_HTTPS, /https/);
});
