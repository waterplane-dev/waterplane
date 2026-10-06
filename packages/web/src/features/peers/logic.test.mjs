import test from "node:test";
import assert from "node:assert/strict";

import {
  hostForPeerBase, hostPeerAddr, mintPeerToken, noHostText, pairBodies, pairCandidates, pairRefusal, pairedNote, pairedRows,
  pairedTitle, peerJobRowFacts, peerNameFor, peerReplyWhy, peerSignInNote, peerTagFacts, selfAddrs, sidesText,
} from "./logic.ts";

const H = (id, name, base, lan) => ({ id, name, base, ...(lan ? { lan: { base: lan, ssids: [], auto: false } } : {}) });
const mac = H("aaaaaaaa", "Mac", "http://100.64.0.2:8770");
const pc = H("bbbbbbbb", "Work PC", "http://100.64.0.9:8770", "http://192.168.1.5:8770");

test("a saved base becomes host:port only when the shared rule vouches for it", () => {
  assert.deepEqual(hostPeerAddr("http://100.64.0.2:8770"), { addr: "100.64.0.2:8770" });
  assert.deepEqual(hostPeerAddr("http://pc.tail1234.ts.net:8770"), { addr: "pc.tail1234.ts.net:8770" });
  assert.match(hostPeerAddr("https://pc.tail1234.ts.net").why, /no port/);
  assert.match(hostPeerAddr("http://192.168.1.5:8770").why, /Tailscale/);
  assert.match(hostPeerAddr("http://example.com:8770").why, /Tailscale/);
  assert.match(hostPeerAddr("nonsense").why, /cannot be read/);
});

test("a peer's name is a slug the host will accept, and never one already taken", () => {
  assert.equal(peerNameFor("Work PC"), "work-pc");
  assert.equal(peerNameFor("Mac"), "mac");
  assert.equal(peerNameFor("Mac", ["mac"]), "mac-2");
  assert.equal(peerNameFor("Mac", ["mac", "MAC-2"]), "mac-3");
  assert.equal(peerNameFor("日本語"), "peer");
  assert.equal(peerNameFor("--x"), "x");
});

test("tokens are 43 url-safe characters and differ", () => {
  const a = mintPeerToken(), b = mintPeerToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(mintPeerToken(() => new Uint8Array(32).fill(255)), "_".repeat(42) + "8");
});

test("each side's outbound token is the token the other side keeps as inbound", () => {
  const { forA, forB } = pairBodies({ addr: "100.64.0.2:8770" }, { addr: "100.64.0.9:8770" }, "pc", "mac", "TOK_A_TO_B", "TOK_B_TO_A");
  assert.deepEqual(forA, { name: "pc", addr: "100.64.0.9:8770", outboundToken: "TOK_A_TO_B", inboundToken: "TOK_B_TO_A" });
  assert.deepEqual(forB, { name: "mac", addr: "100.64.0.2:8770", outboundToken: "TOK_B_TO_A", inboundToken: "TOK_A_TO_B" });
  assert.equal(forA.outboundToken, forB.inboundToken);
  assert.equal(forB.outboundToken, forA.inboundToken);
});

test("a pairing is refused in words that name the host and the reason", () => {
  const [a, b] = pairCandidates([mac, pc]);
  assert.equal(pairRefusal(a, b), null);
  assert.equal(pairRefusal(a, a), "choose two different desktops");
  assert.equal(pairRefusal(a, undefined), "choose two desktops");
  const [, lan] = pairCandidates([mac, H("cccccccc", "Laptop", "http://192.168.1.7:8770")]);
  assert.match(pairRefusal(a, lan), /^Laptop: only a Tailscale address/);
  const [, twin] = pairCandidates([mac, H("dddddddd", "Twin", "http://100.64.0.2:8770")]);
  assert.match(pairRefusal(a, twin), /same address/);
});

const ledger = (host, rows, error) => ({ host, addr: hostPeerAddr(host.base).addr ?? null, rows, error });
const row = (name, addr, extra = {}) => ({ name, addr, outbound: true, inbound: true, addedAt: 1, ...extra });

test("the two halves of one pairing fold into one line", () => {
  const rows = pairedRows([
    ledger(mac, [row("work-pc", "100.64.0.9:8770")]),
    ledger(pc, [row("mac", "100.64.0.2:8770")]),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host.id, "aaaaaaaa");
  assert.equal(pairedTitle(rows[0]), "Mac ⇄ Work PC");
  assert.equal(pairedNote(rows[0]), "");
});

test("a one-sided pairing and an unreachable other side are said, not hidden", () => {
  const one = pairedRows([ledger(mac, [row("work-pc", "100.64.0.9:8770")]), ledger(pc, [])]);
  assert.equal(one.length, 1);
  assert.match(pairedNote(one[0]), /only Mac's side exists/);
  const down = pairedRows([ledger(mac, [row("work-pc", "100.64.0.9:8770")]), ledger(pc, null, "did not answer")]);
  assert.match(pairedNote(down[0]), /Work PC could not be reached/);
  const stranger = pairedRows([ledger(mac, [row("x", "100.64.0.77:8770")])]);
  assert.equal(pairedTitle(stranger[0]), "Mac → x");
  assert.match(pairedNote(stranger[0]), /not one of the desktops saved/);
});

test("a row works one way only: the note says which", () => {
  const rows = pairedRows([
    ledger(mac, [row("work-pc", "100.64.0.9:8770", { inbound: false })]),
    ledger(pc, [row("mac", "100.64.0.2:8770", { outbound: false })]),
  ]);
  assert.match(pairedNote(rows[0]), /Mac can call Work PC but not the reverse/);
});

test("which side failed is named, with what that leaves", () => {
  assert.equal(sidesText("paired", [{ host: "Mac", ok: true }, { host: "Work PC", ok: true }]), "Mac and Work PC paired");
  assert.equal(
    sidesText("paired", [{ host: "Mac", ok: true }, { host: "Work PC", ok: false }]),
    "Work PC did not answer — Mac was written, so the pairing is one-sided until you pair again",
  );
  assert.equal(
    sidesText("unpaired", [{ host: "Mac", ok: false, why: "status 500" }, { host: "Work PC", ok: true }]),
    "Mac (status 500) did not answer — Work PC was removed, the other still holds a row",
  );
  assert.equal(sidesText("paired", [{ host: "A", ok: false }, { host: "B", ok: false }]), "A and B did not answer — nothing was written");
});

test("the host's own sentence wins over a bare status", () => {
  assert.equal(peerReplyWhy(400, { error: "bad address" }), "bad address");
  assert.match(peerReplyWhy(403, null), /not allowed/);
  assert.equal(peerReplyWhy(502, {}), "status 502");
});

test("a peer's base finds the saved host by tailnet or LAN address", () => {
  assert.equal(hostForPeerBase("http://100.64.0.9:8770", [mac, pc]), pc);
  assert.equal(hostForPeerBase("100.64.0.9:8770", [mac, pc]), pc);
  assert.equal(hostForPeerBase("http://192.168.1.5:8770", [mac, pc]), pc);
  assert.equal(hostForPeerBase("http://100.64.0.50:8770", [mac, pc]), null);
  assert.equal(hostForPeerBase(undefined, [mac, pc]), null);
});

test("the row tag: words from the shared wording, target by address, sentence when none matches", () => {
  const now = 10 * 60_000;
  const w = { peer: "pc", jobId: "peer-pc-k", state: "running", since: now - 4 * 60_000, peerSessionId: "s9", peerBase: "http://100.64.0.9:8770" };
  const f = peerTagFacts({ peerWait: w }, [mac, pc], mac.id, now);
  assert.equal(f.text, "waiting on pc · 4 min");
  assert.equal(f.target, pc);
  assert.equal(f.sessionId, "s9");
  assert.match(f.title, /switch to Work PC and open the job's session/);
  const none = peerTagFacts({ peerWait: { ...w, peerBase: "http://100.64.0.50:8770" } }, [mac, pc], mac.id, now);
  assert.equal(none.target, null);
  assert.match(none.title, /not one of the desktops saved/);
  assert.match(noHostText("pc"), /pc is not saved on this phone/);
  assert.equal(peerTagFacts({}, [mac, pc], mac.id, now), null);
  assert.equal(peerTagFacts({ peerWait: { ...w, state: "bogus" } }, [mac, pc], mac.id, now), null);
});

test("a host saved as an https front door pairs by the address it reports for itself", () => {
  const door = H("eeeeeeee", "Door", "https://door.tail1234.ts.net");
  const [plain] = pairCandidates([door]);
  assert.equal(plain.addr, null);
  assert.match(plain.why, /no port/);
  const [viaSelf] = pairCandidates([door], { [door.id]: "100.64.0.7:8770" });
  assert.deepEqual([viaSelf.addr, viaSelf.why], ["100.64.0.7:8770", null]);
  // a self address the shared rule refuses is not used; the saved base is the fallback
  const [bad] = pairCandidates([mac], { [mac.id]: "192.168.1.9:8770" });
  assert.equal(bad.addr, "100.64.0.2:8770");
  const [none] = pairCandidates([door], { [door.id]: "192.168.1.9:8770" });
  assert.equal(none.addr, null);
  assert.equal(selfAddrs([{ host: door, addr: null, rows: [], self: "100.64.0.7:8770" }, { host: mac, addr: null, rows: [] }])[mac.id], null);
});

test("an Activity peer-job row: state, age, the peer's cost with its split, both labels — absent where unmeasured", () => {
  const now = 10 * 60_000 + 1_000_000;
  const row = {
    peer: "pc", jobId: "peer-pc-k1", state: "done", since: 1_000_000, endedAt: 1_400_000, cwd: "/r", sessionId: "s1",
    label: "run e2e", askerLabel: "repo · fix tests", closed: true,
    cost: { usd: 0.84, model: "opus-5-5", durationMs: 360_000, weekPct: 0.05, tokens: { in: 17, out: 1100, cacheRead: 52000, cacheWrite: 4500 } },
  };
  const f = peerJobRowFacts(row, now);
  assert.equal(f.title, "run e2e → pc");
  assert.equal(f.state, "done · sent 10 min ago · closed");
  assert.equal(f.cost, "$0.84 · opus-5-5 · 6 min · ≈0.05% of week");
  assert.equal(f.tokens, "in 17 · out 1.1k · cache read 52k · cache write 4.5k");
  assert.match(f.costNote, /list price on pc, subagents included/);
  assert.equal(f.asker, "repo · fix tests");
  assert.equal(f.bad, false);
  // nothing measured: no figure at all, never $0; a refusal carries its sentence
  const g = peerJobRowFacts({ peer: "pc", jobId: "j", state: "refused", since: 1_000_000, cwd: "/r", detail: "no clone of x", cost: { usd: 0 } }, now);
  assert.equal(g.cost, null);
  assert.equal(g.tokens, null);
  assert.equal(g.costNote, null);
  assert.equal(g.detail, "no clone of x");
  assert.equal(g.bad, true);
  assert.equal(g.title, "a job → pc");
  // tokens but no price: said, not charged zero
  const h = peerJobRowFacts({ peer: "pc", jobId: "j", state: "running", since: now, cwd: "/r", cost: { tokens: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 } } }, now);
  assert.equal(h.cost, null);
  assert.match(h.costNote, /could not price/);
  assert.equal(h.state, "running · sent just now");
});

test("a peer that said it is not signed in gets the sign-in sentence; yes and no answer say nothing", () => {
  const [p] = pairedRows([ledger(mac, [row("work-pc", "100.64.0.9:8770")]), ledger(pc, [row("mac", "100.64.0.2:8770")])]);
  assert.match(peerSignInNote(p, false), /claude is not signed in on Work PC: a job sent there stops at its sign-in screen\. Switch to Work PC/);
  assert.equal(peerSignInNote(p, true), "");
  assert.equal(peerSignInNote(p, undefined), "");
});
