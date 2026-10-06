// The scrub's policy, pinned on synthetic recordings (no host): each forbidden
// shape fails the run, each denylisted record is dropped, ids and seq are renumbered.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../packages/shared/dist/index.js";
import { buildScenario, findLeaks, ScrubError, CLOCK_START } from "./demo-scenario.mjs";

const ROOT = "/var/folders/ab/xyz/T/waterplane-x-1";
const b64 = (s) => Buffer.from(s).toString("base64");
const welcome = { t: "welcome", protocol: PROTOCOL_VERSION, bootId: "7d64ef77-cfa3-4903-983d-205ee605a87f", tailscaleIp: "100.71.1.2", lanIps: ["192.168.0.5"], root: ROOT, port: 53538, hostName: "box", hostId: "abc", auth: { enabled: true } };
const rec = (extra = []) => [
  { at: 1e12 + 1000, dir: "out", msg: welcome },
  { at: 1e12 + 1001, dir: "out", msg: { t: "usage.status", usage: { pct: 41 } } },
  { at: 1e12 + 1002, dir: "in", msg: { t: "session.create", cwd: `/private${ROOT}/app` } },
  { at: 1e12 + 1100, dir: "out", msg: { t: "session.created", session: { id: "3a72e1e6", cwd: `/private${ROOT}/app`, createdAt: 1e12 + 1100 } } },
  { at: 1e12 + 1200, dir: "out", msg: { t: "pty", id: "3a72e1e6", dataB64: b64(`in ${ROOT}/app\r\n`), seq: 9999 } },
  ...extra,
];
const build = (r) => buildScenario(r, { id: "t" });

test("a clean recording scrubs: welcome redacted, denylisted frame dropped, roots and ids rewritten", () => {
  const { scenario } = build(rec());
  const hs = scenario.state.model.recording.handshake;
  assert.equal(hs[0].root, "demo");
  assert.equal(hs[0].tailscaleIp, null);
  assert.deepEqual(hs[0].lanIps, []);
  assert.ok(!JSON.stringify(scenario).includes("usage.status"));
  const created = scenario.script.map((e) => e.event.msg).find((m) => m.t === "session.created");
  assert.equal(created.session.id, "s1");
  assert.equal(created.session.cwd, "~/dev/app");
  assert.equal(created.session.createdAt, CLOCK_START + 100);
  const pty = scenario.script.map((e) => e.event.msg).find((m) => m.t === "pty");
  assert.equal(Buffer.from(pty.dataB64, "base64").toString(), "in ~/dev/app\r\n");
  assert.equal(pty.seq, Buffer.from(pty.dataB64, "base64").length, "seq is recomputed from the scrubbed bytes");
  assert.equal(scenario.meta.protocol, PROTOCOL_VERSION);
  assert.equal(findLeaks(scenario).length, 0);
});

const leaky = (text) => rec([{ at: 1e12 + 1300, dir: "out", msg: { t: "pty", id: "3a72e1e6", dataB64: b64(text), seq: 1 } }]);
for (const [name, text] of [
  ["a home path", "see /Users/someone/dev/x"],
  ["a tailscale ip", "ssh 100.101.102.103"],
  ["a lan ip", "at 192.168.1.20"],
  ["an api key", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
  ["a google key", "AIzaSyA1234567890abcdefghijklmnop"],
  ["a bearer token", "Authorization: Bearer abcdef123456789"],
  ["a uuid that is not a known id", "id 11111111-2222-3333-4444-555555555555"],
  ["a long opaque run", "x".repeat(45)],
  ["a tailnet name", "box.tail1234.ts.net"],
]) {
  test(`fails closed on ${name}, even inside decoded pty bytes`, () => {
    assert.throws(() => build(leaky(text)), (e) => e instanceof ScrubError && e.finds.length > 0);
  });
}

test("a secret-named key holding a value fails; an empty one passes", () => {
  assert.equal(findLeaks({ token: "abc" }).length, 1);
  assert.equal(findLeaks({ token: "" }).length, 0);
  assert.equal(findLeaks({ nested: [{ password: "p" }] }).length, 1);
});

test("a recording from another protocol is refused, not converted", () => {
  const r = rec(); r[0] = { ...r[0], msg: { ...welcome, protocol: PROTOCOL_VERSION + 1 } };
  assert.throws(() => build(r), /protocol/);
});

// ── adversarial review (2026-10): shapes that used to pass the scrub ─────────
// Each is planted where it would really arrive: in decoded pty bytes, in a
// kept non-pty string, or in a client frame.
const kept = (msg) => rec([{ at: 1e12 + 1300, dir: "out", msg }]);
for (const [name, r] of [
  ["a JSON-escaped home path inside a string", kept({ t: "file.text", text: '{"p":"\\/Users\\/someone\\/x"}' })],
  ["a percent-encoded home path", kept({ t: "file.text", text: "open?f=%2FUsers%2Fsomeone%2Fx" })],
  ["a \\u002f-escaped home path", kept({ t: "file.text", text: "\\u002fUsers\\u002fsomeone" })],
  ["a Windows user path", leaky("C:\\Users\\someone\\dev\\x")],
  ["a Linux home path", leaky("cd /home/someone/dev")],
  ["a Tailscale IPv6 address", leaky("ping fd7a:115c:a1e0::4b01:2c3d")],
  ["a link-local IPv6 address", leaky("fe80::1c2b:3a4d:5e6f:7a8b")],
  ["an email address", leaky("Co-Authored-By: Some One <some.one@example.org>")],
  ["a remote URL with credentials", leaky("origin https://someone:hunter2pw@code.example.com/a/b.git")],
  ["a token in a query string", kept({ t: "file.text", text: "/api/thing?x=1&token=abc123" })],
  ["an env-dump secret assignment", leaky("GEMINI_API_KEY=abc123def")],
  ["a cookie header", leaky("Cookie: sid=abc123")],
  ["a secret-named key inside nested JSON text", kept({ t: "file.text", text: '{"token":"abc"}' })],
  ["a short base64 path outside pty", kept({ t: "file.chunk", contentB64: b64("/Users/x/y") })],
  ["a home path split across two pty chunks", rec([
    { at: 1e12 + 1300, dir: "out", msg: { t: "pty", id: "3a72e1e6", dataB64: b64("see /Us"), seq: 1 } },
    { at: 1e12 + 1301, dir: "out", msg: { t: "pty", id: "3a72e1e6", dataB64: b64("ers/someone/x"), seq: 2 } },
  ])],
  ["a home path broken by an ANSI colour code", leaky("/\x1b[1mUsers\x1b[0m/someone")],
]) {
  test(`fails closed on ${name}`, () => {
    assert.throws(() => build(r), (e) => e instanceof ScrubError && e.finds.length > 0);
  });
}

test("this machine's VCS identity (user.name / user.email) is forbidden", () => {
  for (const key of ["user.name", "user.email"]) {
    let v = "";
    try { v = execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim(); } catch { /* unset */ }
    if (v.length >= 3) assert.ok(findLeaks({ x: `by ${v} today` }).length > 0, `${key} survives`);
  }
});

test("this machine's home directory is forbidden, whatever its shape", () => {
  assert.ok(findLeaks({ x: `in ${homedir()}/x` }).length > 0);
});

test("a client frame that sets a secret is dropped, not merely flagged", () => {
  const { scenario } = build(rec([
    { at: 1e12 + 1300, dir: "in", msg: { t: "auth.set", password: "pw" } },
    { at: 1e12 + 1301, dir: "in", msg: { t: "settings.set", key: "k", value: "v", ts: 1 } },
    { at: 1e12 + 1302, dir: "in", msg: { t: "plugin.set", id: "p", config: { a: 1 } } },
  ]));
  const s = JSON.stringify(scenario);
  assert.ok(!s.includes("auth.set") && !s.includes("settings.set") && !s.includes("plugin.set"));
});

test("a recording of a real tree (root outside a temp dir) is refused", () => {
  const r = rec(); r[0] = { ...r[0], msg: { ...welcome, root: join(homedir(), "dev") } };
  assert.throws(() => build(r), /temp/);
});
