// Settings that follow the USER, not the browser.
//
// Prompt templates, fan-out presets, header commands, the pad and the toolbar
// layout used to live only in one browser's localStorage, so a template written
// on the phone did not exist on the desktop and a reinstalled PWA lost the lot.
// The host now holds them: opaque values, last write wins on the writer's
// timestamp, an allow-list of keys.
//
// Asserts:
//   1. a fresh client gets the document unprompted on `hello` (empty at first)
//   2. `settings.set` is stored and BROADCAST to every socket, the writer's
//      included — the echo is what confirms the write landed
//   3. last write wins on the client `ts`, and an OLDER write does not just get
//      dropped: the loser is sent the winning value back, so it stops holding a
//      version nobody else has
//   4. an EQUAL timestamp is not a win (a re-push after a reconnect must not
//      re-broadcast to every device for nothing)
//   5. a key that is not on the allow-list is refused — syncing the send outbox
//      to a second device would be a prompt typed twice
//   6. an over-cap value is refused rather than truncated
//   7. the document survives a host RESTART (`npm run restart` is routine, and
//      an in-memory prompt library would be wiped by it)
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, LS, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8852;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-settings-`));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
};

let host = null;
function boot() {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
const stop = async () => { host?.kill(); await sleep(700); };

boot();
await waitForHost(PORT);

/** One connected client. Keeps every settings frame it was sent, in order. */
async function connect(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const state = { label, doc: null, updates: [], errors: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "settings.all") state.doc = m.doc;
    if (m.t === "settings.update") state.updates.push(m);
    if (m.t === "error") state.errors.push(m);
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(400);
  state.send = (msg) => ws.send(JSON.stringify(msg));
  state.close = () => ws.close();
  return state;
}

const SNIPPETS = `${LS}snippets`;
const a = await connect("A");
const b = await connect("B");

// 1 — the document arrives without being asked for.
check(a.doc && typeof a.doc === "object", `hello carries the settings document (got ${JSON.stringify(a.doc)})`);
check(a.doc && Object.keys(a.doc).length === 0, "a host with no settings yet answers an empty document");

// 2 — a write is stored and broadcast to BOTH sockets.
const v1 = JSON.stringify([{ id: "s1", title: "ship it", text: "commit and push" }]);
a.send({ t: "settings.set", key: SNIPPETS, value: v1, ts: 1000, device: "phone" });
await sleep(300);
const aGot = a.updates.filter((u) => u.key === SNIPPETS);
const bGot = b.updates.filter((u) => u.key === SNIPPETS);
check(aGot.length === 1 && aGot[0].value === v1, `the writer gets its own write echoed (${aGot.length} update(s))`);
check(bGot.length === 1 && bGot[0].value === v1, `the OTHER client is told immediately (${bGot.length} update(s))`);
check(bGot[0]?.device === "phone", `the update names the device that wrote it (${bGot[0]?.device})`);

// 3 — last write wins, and the loser is corrected rather than ignored.
const v2 = JSON.stringify([{ id: "s1", title: "ship it", text: "commit, push, and tag" }]);
b.send({ t: "settings.set", key: SNIPPETS, value: v2, ts: 2000, device: "desktop" });
await sleep(300);
check(a.updates.at(-1)?.value === v2, "a newer write from another device replaces the older value everywhere");

a.updates.length = 0;
b.updates.length = 0;
a.send({ t: "settings.set", key: SNIPPETS, value: JSON.stringify([{ id: "s1", title: "stale", text: "old" }]), ts: 1500 });
await sleep(300);
check(a.updates.length === 1 && a.updates[0].value === v2, "an OLDER write is answered with the winning value, not silently dropped");
check(b.updates.length === 0, "…and the correction goes only to the loser, not to every device");

// 4 — an equal timestamp is a re-push, not a change.
a.updates.length = 0;
b.updates.length = 0;
b.send({ t: "settings.set", key: SNIPPETS, value: v2, ts: 2000 });
await sleep(300);
check(b.updates.length <= 1 && a.updates.length === 0, "a re-push at the same timestamp does not re-broadcast to the other devices");

// 5 — the allow-list. The send outbox is the one that must never travel.
a.errors.length = 0;
a.send({ t: "settings.set", key: `${LS}outbox`, value: "[]", ts: 3000 });
await sleep(300);
const fresh = await connect("C");
check(!(`${LS}outbox` in (fresh.doc || {})), "a key outside the allow-list is not stored");
check(a.errors.some((e) => /not stored/.test(e.message)), `…and the client is told why (${JSON.stringify(a.errors[0]?.message)})`);

// 6 — an over-cap value is refused, not truncated: a value silently cut in half
// is a corrupt prompt list on every other device.
a.errors.length = 0;
a.send({ t: "settings.set", key: `${LS}pad`, value: "x".repeat(1024 * 1024 + 10), ts: 4000 });
await sleep(400);
const fresh2 = await connect("D");
check(!(`${LS}pad` in (fresh2.doc || {})), "an over-cap value is refused rather than truncated");
check(a.errors.some((e) => /too big/.test(e.message)), `…with the reason named (${JSON.stringify(a.errors[0]?.message)})`);

a.close(); b.close(); fresh.close(); fresh2.close();

// 7 — the library survives the restart that `npm run restart` performs
// constantly. This is the whole reason the store is on disk.
await stop();
boot();
await waitForHost(PORT);
const after = await connect("E");
check(after.doc?.[SNIPPETS]?.value === v2, "settings survive a host restart");
check(after.doc?.[SNIPPETS]?.ts === 2000, "…including the timestamp that decides who wins next");
after.close();

await stop();
console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
