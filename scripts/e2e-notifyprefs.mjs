// Which notification KINDS may fire at all.
//
// Every alert goes two places — the in-app feed and, when subscribed, an OS
// push — and until this existed every one of them went to both. `idle` ("Turn
// finished") fires once per turn per session, so a handful of agents working a
// backlog is a notification a minute and the two kinds a person must actually
// answer (a waiting question, a usage limit) end up buried under a wall of
// identical rows.
//
// The gate is on the HOST, not in the client's synced settings: muting a kind
// the phone hides afterwards still buzzes the phone, and `settings.ts` stores
// opaque strings the daemon deliberately never parses.
//
// Asserts:
//   1. a fresh client is told the prefs unprompted on `hello`
//   2. a kind that is ON produces a feed item (the control)
//   3. muting it is BROADCAST to every socket, not just the writer's — the mute
//      follows the account, and a second device must not keep showing a switch
//      the desktop just flipped
//   4. a muted kind then fires NOTHING: no feed row, no broadcast
//   5. the mute survives a host restart (`npm run restart` is routine)
//   6. unmuting brings the kind straight back
//   7. a hand-edited store cannot invent a kind
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8871;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-notifyprefs-`));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  // The clock is re-asked on a tick rather than armed with a timer, so the
  // probe schedule below only fires as fast as the tick allows.
  [E.SCHEDULE_TICK_MS]: "500",
};

let host = null;
function boot() {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
const stop = async () => { host?.kill(); await sleep(700); };

boot();
await waitForHost(PORT);

async function connect(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const state = { label, prefs: null, prefsFrames: [], notifs: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "notify.prefs") { state.prefs = m.prefs; state.prefsFrames.push(m.prefs); }
    if (m.t === "notification") state.notifs.push(m.item);
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(400);
  state.send = (msg) => ws.send(JSON.stringify(msg));
  state.close = () => ws.close();
  return state;
}

const waitFor = async (pred, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};

/** Fire ONE `info` notification, without a session and without `claude`: a
 *  one-shot schedule two seconds out, aimed at a directory that is not a repo.
 *  It fails, and a failed schedule is exactly the kind of thing this feed is
 *  for — which is the point. `id` keeps each round distinct. */
let round = 0;
function fireInfo(client) {
  round += 1;
  client.send({
    t: "schedule.save",
    entry: {
      id: `sched-notif-${round}`, name: `probe ${round}`, enabled: true, graceMin: 120,
      rule: { kind: "once", at: Date.now() + 1500 },
      action: { kind: "fanout", dirs: [join(ROOT, "no-such-repo")], text: "never runs" },
    },
  });
}

const a = await connect("A");
const b = await connect("B");

// 1 — the prefs arrive unprompted, and a fresh host mutes nothing explicitly.
check(a.prefs !== null, "hello carries the notification prefs");
check(JSON.stringify(a.prefs) === "{}", `a fresh host stores no explicit mute (${JSON.stringify(a.prefs)})`);

// 2 — the control: an `info` alert lands in the feed while the kind is on.
fireInfo(a);
const gotFirst = await waitFor(() => a.notifs.some((n) => n.kind === "info"));
check(gotFirst, "an `info` notification reaches the feed while the kind is on");
check(b.notifs.some((n) => n.kind === "info"), "…on every attached socket, not just the one that asked");

// 3 — muting is the account's, so it is broadcast to both devices.
b.prefsFrames.length = 0;
a.send({ t: "notify.prefs.set", prefs: { info: false } });
const broadcast = await waitFor(() => b.prefsFrames.length > 0);
check(broadcast && b.prefs?.info === false, "a mute set on one device is broadcast to the other");
check(a.prefs?.info === false, "…including back to the device that set it");

// 4 — and now the same alert produces nothing at all.
a.notifs.length = 0; b.notifs.length = 0;
fireInfo(a);
await sleep(4000);
check(a.notifs.length === 0 && b.notifs.length === 0,
  `a muted kind fires nothing (${a.notifs.length + b.notifs.length} slipped through)`);

// It is not merely hidden: the host never recorded it, so a client that asks
// for the whole feed does not find it either.
const c = await connect("C");
check(c.prefs?.info === false, "a client connecting later is told about the mute");
c.close(); a.close(); b.close();

// 5 — a mute a restart forgets is a mute you re-discover the hard way.
const onDisk = JSON.parse(readFileSync(join(ROOT, STATE, "notify.json"), "utf8"));
check(onDisk.info === false, "the mute is on disk, not just in memory");
await stop();
boot();
await waitForHost(PORT);
const d = await connect("D");
check(d.prefs?.info === false, "the mute survives a host restart");

// 6 — and it is reversible.
d.notifs.length = 0;
d.send({ t: "notify.prefs.set", prefs: { info: true } });
await waitFor(() => d.prefs?.info === true);
fireInfo(d);
check(await waitFor(() => d.notifs.some((n) => n.kind === "info")), "unmuting brings the kind straight back");
d.close();

// 7 — the store is hand-editable JSON; a kind it invents must not survive the
// read, or a typo silently mutes something nobody can find in the UI.
await stop();
writeFileSync(join(ROOT, STATE, "notify.json"), JSON.stringify({ idle: true, nonsense: false, prompt: "yes" }));
boot();
await waitForHost(PORT);
const e = await connect("E");
check(JSON.stringify(e.prefs) === '{"idle":true}', `a hand-edited store is cleaned on the way in (${JSON.stringify(e.prefs)})`);
e.close();

await stop();
console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
