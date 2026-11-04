import test from "node:test";
import assert from "node:assert/strict";

import { linkErrorWord, linkStateWord, linksStateText, MAX_SHELL_LINKS, shellLinkSet, shellLinkToken } from "./shellLinkSet.ts";

const h = (id, name, base) => ({ id, name, base });

test("one link per saved desktop, the active one FIRST, tailnet base as ws url, the person's name as label", () => {
  const hosts = [h("aaaa1111", "studio", "https://studio.tail.ts.net"), h("bbbb2222", "zenbook", "http://100.64.0.7:8770")];
  assert.deepEqual(shellLinkSet(hosts, "bbbb2222"), [
    { hostId: "bbbb2222", url: "ws://100.64.0.7:8770/ws", label: "zenbook" },
    { hostId: "aaaa1111", url: "wss://studio.tail.ts.net/ws", label: "studio" },
  ]);
  assert.deepEqual(shellLinkSet(hosts, null).map((l) => l.hostId), ["aaaa1111", "bbbb2222"], "no active: list order");
});

test("never a LAN address, never an unusable row, one socket per address", () => {
  const lan = { ...h("aaaa1111", "studio", "https://studio.tail.ts.net"), lan: { base: "http://192.168.1.5:8770", ssids: [], auto: true } };
  assert.deepEqual(shellLinkSet([lan], "aaaa1111").map((l) => l.url), ["wss://studio.tail.ts.net/ws"]);
  assert.deepEqual(shellLinkSet([h("BAD", "x", "https://a.ts.net"), h("cccc3333", "y", "ftp://a")], null), []);
  const dup = [h("aaaa1111", "a", "https://a.ts.net"), h("bbbb2222", "b", "https://a.ts.net")];
  assert.deepEqual(shellLinkSet(dup, "bbbb2222").map((l) => l.hostId), ["bbbb2222"], "the active row keeps the address");
  const many = Array.from({ length: 12 }, (_, i) => h(`host${String(i).padStart(4, "0")}`, `d${i}`, `https://d${i}.ts.net`));
  assert.equal(shellLinkSet(many, null).length, MAX_SHELL_LINKS);
});

test("the settings line says each link's state apart, and nothing for one link", () => {
  assert.equal(linksStateText(undefined), null);
  assert.equal(linksStateText([{ label: "studio", state: "connected" }]), null);
  assert.equal(
    linksStateText([{ label: "studio", state: "connected" }, { label: "zenbook", state: "reconnecting" }, { label: "mini", state: "auth" }]),
    "studio connected · zenbook not answering — retrying · mini needs this phone signed in there",
  );
});

const TOK_A = "tokA_0123456789abcdef";
const TOK_B = "tokB_0123456789abcdef";

test("each link carries ONLY its own desktop's token, and only to its saved base", () => {
  const hosts = [h("aaaa1111", "studio", "https://studio.tail.ts.net"), h("bbbb2222", "zenbook", "http://100.64.0.7:8770")];
  const creds = { aaaa1111: { token: TOK_A }, bbbb2222: { token: TOK_B } };
  const links = shellLinkSet(hosts, "aaaa1111", (x) => creds[x.id] ?? null);
  assert.deepEqual(links.map((l) => [l.hostId, l.token]), [["aaaa1111", TOK_A], ["bbbb2222", TOK_B]]);
  assert.deepEqual(shellLinkSet(hosts, "aaaa1111").map((l) => "token" in l), [false, false], "no creds: no field at all (the old shape)");
});

test("no token for a LAN base, a passive token, a hand-edited one, or a desktop holding none", () => {
  const lanSaved = { ...h("aaaa1111", "studio", "http://192.168.1.5:8770"), lan: { base: "http://192.168.1.5:8770", ssids: [], auto: true } };
  assert.equal(shellLinkSet([lanSaved], null, () => ({ token: TOK_A }))[0].token, undefined, "a base that IS its LAN address");
  const tail = h("bbbb2222", "zenbook", "https://zen.tail.ts.net");
  assert.equal(shellLinkSet([tail], null, () => ({ token: TOK_B, passive: true }))[0].token, undefined, "passive: the host refuses it anyway");
  assert.equal(shellLinkSet([tail], null, () => ({ token: "not a token!" }))[0].token, undefined);
  assert.equal(shellLinkSet([tail], null, () => ({ token: null }))[0].token, undefined);
  assert.equal(shellLinkSet([tail], null, () => null)[0].token, undefined);
  assert.equal(shellLinkToken(h("cccc3333", "x", "ftp://x"), { token: TOK_A }), null, "not an http(s) base");
});

test("a removed desktop's token is absent, and two rows on one address carry the surviving row's token", () => {
  const a = h("aaaa1111", "studio", "https://studio.tail.ts.net");
  const b = h("bbbb2222", "zenbook", "https://zen.tail.ts.net");
  const creds = { aaaa1111: { token: TOK_A }, bbbb2222: { token: TOK_B } };
  const after = shellLinkSet([a], "aaaa1111", (x) => creds[x.id] ?? null);
  assert.ok(!JSON.stringify(after).includes(TOK_B), "the removed desktop's token is nowhere in the list");
  const dup = [a, { ...b, base: a.base }];
  assert.deepEqual(shellLinkSet(dup, "bbbb2222", (x) => creds[x.id]).map((l) => [l.hostId, l.token]), [["bbbb2222", TOK_B]]);
});

test("a refused token words itself apart from a missing one", () => {
  assert.equal(linkStateWord("signedOut"), "signed out there — pair again");
  assert.equal(linkStateWord("auth"), "needs this phone signed in there");
  assert.equal(linkStateWord("locked"), "locked — open the app");
});

test("sealed on a shell that would store them: every link stays, none carries a token", () => {
  const hosts = [h("aaaa1111", "studio", "https://studio.tail.ts.net"), h("bbbb2222", "zenbook", "http://100.64.0.7:8770")];
  const creds = { aaaa1111: { token: TOK_A }, bbbb2222: { token: TOK_B } };
  const links = shellLinkSet(hosts, "aaaa1111", (x) => creds[x.id] ?? null, { carry: false });
  assert.deepEqual(links.map((l) => [l.hostId, "token" in l]), [["aaaa1111", false], ["bbbb2222", false]]);
  assert.deepEqual(shellLinkSet(hosts, "aaaa1111", (x) => creds[x.id] ?? null, { carry: true }).map((l) => l.token), [TOK_A, TOK_B]);
});

test("a LAN-only row with a pin is watched on its TLS address, where this shell enforces it", () => {
  const row = { ...h("aaaa1111", "desk", "http://192.168.1.20:8770"), tls: { port: 8771, spki: "ab".repeat(32) } };
  assert.equal(shellLinkSet([row], null, undefined, { enforcing: true })[0].url, "wss://192.168.1.20:8771/ws");
  assert.equal(shellLinkSet([row], null)[0].url, "ws://192.168.1.20:8770/ws", "a shipped shell ignores the pin");
  assert.equal(shellLinkSet([{ ...row, tls: undefined, tlsOff: true }], null, undefined, { enforcing: true })[0].url, "ws://192.168.1.20:8770/ws");
  const tail = { ...h("bbbb2222", "desk", "http://100.64.0.7:8770"), tls: row.tls };
  assert.equal(shellLinkSet([tail], null, undefined, { enforcing: true })[0].url, "ws://100.64.0.7:8770/ws", "a tailnet base is never rewritten");
});

test("the pin's two link states reach the screen in words, neither as the raw state", () => {
  assert.match(linkStateWord("keyChanged"), /key does not match.*pair again by code/);
  const locked = linkStateWord("locked: open the app");
  assert.match(locked, /not protected/);
  assert.notEqual(locked, linkStateWord("locked"), "no token handed back opens this one");
  assert.equal(linksStateText([{ label: "a", state: "keyChanged" }, { label: "b", state: "connected" }]), `a ${linkStateWord("keyChanged")} · b connected`);
});

test("the adopt refusal says only what happened: a vouched address is not unprotected to the page", () => {
  const w = linkErrorWord("a new file was not fetched in the background: this address is not a protected route. Open the app");
  assert.doesNotMatch(w, /protected/);
  assert.match(w, /when you open it/);
  assert.equal(linkErrorWord("socket failed"), "socket failed");
  assert.equal(linkErrorWord(undefined), null);
});
