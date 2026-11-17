// The background link's timestamped record (`linklog.ts`): opens and closes of the APK's
// notify socket with their time, and each attention alert with how many links were open to carry it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkLog, LINK_LOG } from "../dist/linklog.js";
import { createClients } from "../dist/server/clients.js";
import { hostStateDir } from "../dist/branddirs.js";

const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const rows = (root) => readFileSync(join(hostStateDir(root), LINK_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("an open then a close are written with ISO times and the link's lifetime", () => {
  const root = mkdtempSync(join(tmpdir(), "linklog-"));
  mkdirSync(hostStateDir(root), { recursive: true });
  let now = Date.parse("2026-11-15T18:43:00Z");
  const log = createLinkLog(root, () => now);
  const ws = {};
  quiet(() => {
    log.opened(ws, { role: "notify", via: "user-agent", device: "d1", peer: "tailscale" });
    log.opened(ws, { role: "notify", via: "hello", device: "d1" }); // the hello after the UA: not a second open
    now += 61_000;
    log.closed(ws, { role: "notify", code: 1006, device: "d1" });
  });
  const r = rows(root);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { at: "2026-11-15T18:43:00.000Z", ev: "open", role: "notify", via: "user-agent", device: "d1", peer: "tailscale" });
  assert.deepEqual(r[1], { at: "2026-11-15T18:44:01.000Z", ev: "close", role: "notify", code: 1006, openMs: 61_000, device: "d1" });
});

test("a full client's socket closing is not recorded", () => {
  const seen = [];
  const log = createLinkLog(undefined);
  const orig = console.log; console.log = (l) => seen.push(l);
  try { log.closed({}, { role: undefined, code: 1001 }); } finally { console.log = orig; }
  assert.deepEqual(seen, []);
});

test("an attention alert records how many background links were open (0 ⇒ none to carry it)", () => {
  const events = [];
  const c = createClients({
    auth: { passive: {} }, notifyPrefs: { enabled: () => true }, push: { notify: async () => {} },
    sessions: { setWatched: () => {} }, linkLog: { event: (e) => events.push(e) },
  });
  c.notify("approval", { title: "t", body: "b", plugin: "vault", level: "attention" });
  const ws = { OPEN: 1, readyState: 1, send() {} };
  c.clients.add(ws); c.wsRole.set(ws, "notify");
  c.notify("approval", { title: "t", body: "b", plugin: "vault", level: "attention", key: "k2" });
  c.notify("artifact", { title: "t", body: "b", level: "info" });
  assert.deepEqual(events, [
    { ev: "alert", kind: "approval", plugin: "vault", links: 0 },
    { ev: "alert", kind: "approval", plugin: "vault", links: 1 },
  ]);
});

test("a phone's link.log lands as phone rows on the host's clock, with the device and the skew", () => {
  const root = mkdtempSync(join(tmpdir(), "linklog-"));
  const now = Date.parse("2026-11-16T09:00:10Z");
  const log = createLinkLog(root, () => now);
  const phoneNow = now - 2_000; // the phone's clock runs 2 s behind
  const n = quiet(() => log.phone("d1", [
    { at: phoneNow - 8_000, ev: "fail", d: "SocketTimeoutException" },
    { at: phoneNow - 1_000, ev: "open" },
    { at: "junk", ev: "open" },
  ], phoneNow));
  assert.equal(n, 2);
  assert.deepEqual(rows(root), [
    { at: "2026-11-16T09:00:02.000Z", ev: "phone", what: "fail", d: "SocketTimeoutException", device: "d1", skewMs: 2000 },
    { at: "2026-11-16T09:00:09.000Z", ev: "phone", what: "open", device: "d1", skewMs: 2000 },
  ]);
  assert.equal(quiet(() => log.phone("d1", "not a list", phoneNow)), 0);
});
