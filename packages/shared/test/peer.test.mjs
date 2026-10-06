// Peer desktops (`shared/src/peer.ts`): the repo-identity key, the address rule,
// the report prompt, the tag's words and the version sentence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PEER_API_VERSION, PEER_REPORT_MAX_CHARS, cleanPeerRow, isPeerPosted, parsePeerApiHeader, peerAddressOk,
  peerJobId, peerJobTerminal, peerOfOrigin, peerReportId, peerReportPrompt, peerVersionMismatchText,
  peerVersionRefusalText, peerWaitWords, remoteKey, isAgentPosted,
} from "../dist/index.js";

test("remoteKey: every spelling of one remote is one key", () => {
  const want = "github.com/acme/widget";
  for (const u of [
    "git@github.com:acme/widget.git",
    "git@github.com:acme/widget",
    "https://github.com/acme/widget.git",
    "https://github.com/acme/widget/",
    "https://user:pw@GitHub.com/Acme/Widget.git",
    "ssh://git@github.com:22/acme/widget.git",
    "  https://github.com/acme/widget  ",
  ]) assert.equal(remoteKey(u), want, u);
  assert.notEqual(remoteKey("https://github.com/acme/other"), want);
});

test("remoteKey: garbage and local paths are no key, never a guess", () => {
  for (const u of ["", "   ", "nonsense", "/home/me/repo", "file:///home/me/repo", "C:\\dev\\repo", "https://github.com", "https://github.com/", "a b", "https://h/../x", null, undefined, 4])
    assert.equal(remoteKey(u), null, String(u));
});

test("peerAddressOk: tailnet, tailscale IP and loopback only", () => {
  for (const a of ["100.64.0.1:8770", "100.127.255.254:8770", "pc.tail1234.ts.net:8770", "127.0.0.1:9001"])
    assert.equal(peerAddressOk(a), null, a);
  for (const a of [
    "pc.local:8770", "192.168.1.5:8770", "10.0.0.2:8770", "198.19.249.3:8770", "8.8.8.8:8770", "100.63.0.1:8770",
    "100.128.0.1:8770", "localhost:8770", "pc:8770", "evil.com:8770", "tail1234.ts.net:8770", "127.0.0.2:8770",
    "100.64.0.1", "100.64.0.1:0", "100.64.0.1:70000", "", "http://100.64.0.1:8770", "100.064.0.1:8770", "100.64.0.256:1",
  ]) assert.ok(typeof peerAddressOk(a) === "string" && peerAddressOk(a).length > 0, a);
});

test("cleanPeerRow drops what cannot authenticate or be reached", () => {
  const ok = { name: "pc", addr: "100.64.0.1:8770", token: "t", addedAt: 5 };
  assert.deepEqual(cleanPeerRow(ok), ok);
  assert.deepEqual(cleanPeerRow({ ...ok, token: undefined, tokenSha256: "a".repeat(64) }), { name: "pc", addr: ok.addr, tokenSha256: "a".repeat(64), addedAt: 5 });
  assert.equal(cleanPeerRow({ ...ok, token: undefined }), null);
  assert.equal(cleanPeerRow({ ...ok, tokenSha256: "short", token: undefined }), null);
  assert.equal(cleanPeerRow({ ...ok, addr: "pc.local:1" }), null);
  assert.equal(cleanPeerRow({ ...ok, name: "a/b" }), null);
  assert.equal(cleanPeerRow({ ...ok, addedAt: 0 }), null);
  assert.equal(cleanPeerRow("x"), null);
});

test("ids: one key, the same id on both hosts", () => {
  assert.equal(peerJobId("mac", "k1"), "peer-mac-k1");
  assert.equal(peerReportId("pc", "k1"), "peer-pc-k1-report");
});

test("the version sentence names both numbers and the older side", () => {
  const a = peerVersionMismatchText("pc", 1, 2);
  assert.match(a, /pc runs peer API 2, this host 1 — upgrade this host/);
  const b = peerVersionMismatchText("pc", 2, 1);
  assert.match(b, /peer API 1, this host 2 — upgrade pc/);
  assert.equal(peerVersionMismatchText("pc", 1, 1), "");
  assert.equal(peerVersionMismatchText("pc", 1, NaN), "");
  assert.match(peerVersionRefusalText(1, 2), /this host runs peer API 1, the caller 2/);
  assert.match(peerVersionRefusalText(2, 1), /upgrade the caller/);
  assert.match(peerVersionRefusalText(1, null), /named no version/);
  assert.equal(peerVersionRefusalText(1, 1), "");
  assert.equal(PEER_API_VERSION, 1);
});

test("parsePeerApiHeader: whole numbers or null", () => {
  assert.equal(parsePeerApiHeader("1"), 1);
  assert.equal(parsePeerApiHeader(" 12 "), 12);
  for (const v of [undefined, null, "", "x", "1.5", "-1", "1e3"]) assert.equal(parsePeerApiHeader(v), null);
});

const view = (over = {}) => ({ id: "j", state: "done", peerApi: 1, version: "x", intentId: "i", sessionId: "s9", ...over });

test("peerReportPrompt: starts with the peer mark and carries the answer", () => {
  const p = peerReportPrompt("pc", view({ report: { ok: true, text: "all green", truncated: false, artifacts: [{ name: "a.png", size: 12 }], pushedBranch: "fix" } }), 100);
  assert.ok(p.startsWith("[report from peer pc]"));
  assert.match(p, /finished on pc/);
  assert.match(p, /all green/);
  assert.match(p, /- a\.png \(12 bytes\)/);
  assert.match(p, /pushed branch fix/);
  assert.doesNotMatch(p, /\[cut/);
});

test("peerReportPrompt: a cut says how much and names the session", () => {
  const p = peerReportPrompt("pc", view({ report: { ok: true, text: "x".repeat(130), truncated: false, artifacts: [] } }), 100);
  assert.match(p, /\[cut: 30 more characters not shown — open session s9 on pc for the rest\]/);
  assert.equal(p.split("\n").filter((l) => l === "x".repeat(100)).length, 1);
  const q = peerReportPrompt("pc", view({ report: { ok: true, text: "short", truncated: true, artifacts: [] } }), 100);
  assert.match(q, /\[cut: the peer cut its answer/);
  assert.ok(PEER_REPORT_MAX_CHARS > 0);
});

test("peerReportPrompt: failure, refusal and no report each say so", () => {
  assert.match(peerReportPrompt("pc", view({ state: "failed", detail: "the session was lost", report: { ok: false, text: "", truncated: false, artifacts: [] } })), /failed on pc\.\nthe session was lost/);
  const r = peerReportPrompt("pc", view({ state: "refused", detail: "no clone of github.com/x/y" }));
  assert.match(r, /was refused on pc with no report/);
  assert.match(r, /no clone of github\.com\/x\/y/);
  assert.match(peerReportPrompt("pc", view({ report: { ok: true, text: "  ", truncated: false, artifacts: [] } })), /answer was empty/);
  // a nonsense cap falls back to the default rather than cutting everything
  assert.match(peerReportPrompt("pc", view({ report: { ok: true, text: "hello", truncated: false, artifacts: [] } }), -5), /hello/);
});

test("peerWaitWords: per state, age only when it can be believed", () => {
  const w = (state, since = 1_000_000) => ({ peer: "pc", jobId: "j", state, since });
  const now = 1_000_000 + 4 * 60_000;
  assert.equal(peerWaitWords(w("running"), now), "waiting on pc · 4 min");
  assert.equal(peerWaitWords(w("queued")), "waiting on pc");
  assert.equal(peerWaitWords(w("limit"), now), "pc is at its usage limit · 4 min");
  assert.equal(peerWaitWords(w("unreachable"), now), "pc unreachable · 4 min");
  assert.equal(peerWaitWords(w("done")), "pc has answered");
  assert.equal(peerWaitWords(w("failed")), "pc's job failed");
  assert.equal(peerWaitWords(w("refused")), "pc refused the job");
  assert.equal(peerWaitWords(w("running"), 1_000_000 + 10_000), "waiting on pc · just now");
  assert.equal(peerWaitWords(w("running"), 1_000_000 + 3 * 3_600_000), "waiting on pc · 3 h");
  assert.equal(peerWaitWords(w("running"), 1_000_000 + 3 * 86_400_000), "waiting on pc · 3 d");
  assert.equal(peerWaitWords(w("running"), 1), "waiting on pc"); // a clock before `since` is not an age
  assert.equal(peerWaitWords(w("running", 0), now), "waiting on pc");
  assert.equal(peerWaitWords(undefined), "");
  assert.equal(peerWaitWords(w("bogus")), "");
  assert.equal(peerWaitWords({ ...w("running"), peer: "" }), "");
});

test("terminal states", () => {
  for (const s of ["done", "failed", "refused"]) assert.ok(peerJobTerminal(s));
  for (const s of ["queued", "waiting", "running", "limit", "unreachable", undefined, "x"]) assert.ok(!peerJobTerminal(s));
});

test("peer origin: a prefix with a name, and never an agent's", () => {
  assert.ok(isPeerPosted({ origin: "peer:mac" }));
  assert.ok(!isPeerPosted({ origin: "peer:" }));
  assert.ok(!isPeerPosted({ origin: "agent" }));
  assert.ok(!isPeerPosted({}));
  assert.ok(!isAgentPosted({ origin: "peer:mac" }));
  assert.equal(peerOfOrigin("peer:mac"), "mac");
  assert.equal(peerOfOrigin("peer:"), undefined);
  assert.equal(peerOfOrigin("agent"), undefined);
  assert.equal(peerOfOrigin(undefined), undefined);
});
