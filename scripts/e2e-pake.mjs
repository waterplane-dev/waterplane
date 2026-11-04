// PAKE pairing through a live host (`pair.ts`, `pairpake.ts`): temp root, real HTTP, node playing
// the phone with the same `shared/pake` a phone runs.
//
// With no password `start` is refused and nothing is spent. After one: mint → the deep link carries
// s=1 and k= → `start`, `finish` carrying no `Authorization` → the seal opens → the sealed facts match
// the commitment → the token works as a Bearer → the replayed `finish` finds nothing → the code is
// spent. A wrong code is a typed miss that leaves the right one live. A share that is no group element
// is refused. Every refusal from this host is a typed non-404, the answer a phone tells an older
// host by. A plain-socket burn is pinned in `packages/host/test/pairpake.test.mjs`, because a host
// bound on loopback has no plain peer to burn for.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { pairCommit, pakeEncode, pakePhoneFinish, pakePhoneOpen, pakePhoneStart, parsePairDeepLink } from "../packages/shared/dist/index.js";
import { bootWait } from "./lib-e2e.mjs";
import { watchdog } from "./lib-watchdog.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8964;
const B = `http://127.0.0.1:${PORT}`;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT),
  ...rootEnv(ROOT),
  [E.HOST]: "127.0.0.1",
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
delete env[E.ALLOW_PUBLIC];

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write(d));
const finishUp = async () => {
  await new Promise((r) => { if (host.exitCode !== null) return r(); host.once("exit", r); host.kill(); });
  process.exit(failed ? 1 : 0);
};
watchdog(() => { console.error("FAIL: timed out"); failed = true; void finishUp(); });

async function post(path, body, headers = {}) {
  const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const mint = () => post("/api/pair/mint", {});

bootWait(PORT, 600, async () => {
  try {
    // ── No password: refused at start, nothing spent ──
    const m0 = await mint();
    const phone0 = await pakePhoneStart(m0.json.code);
    const none = await post("/api/pair/pake/start", phone0.request);
    check(none.status === 403 && none.json?.error === "no-password", "no password: start is refused, typed");
    check(!parsePairDeepLink(m0.json.deepLink).secure, "no password: the link does not promise PAKE");
    const plain = await post("/api/pair/redeem", { code: m0.json.code, deviceName: "e2e" });
    check(plain.status === 200, "the refused code was not spent: redeem still takes it");

    // From the trusted path, as Settings does.
    const mgr = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => mgr.once("open", r));
    mgr.send(JSON.stringify({ t: "auth.set", password: "e2e-pake-password" }));
    for (let i = 0; i < 100; i++) {
      const st = await (await fetch(`${B}/api/auth/status`)).json();
      if (st.enabled) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    mgr.close();

    const none2 = await pakePhoneStart("ABCDEFGH");
    const noCodes = await post("/api/pair/pake/start", none2.request);
    check(noCodes.status === 409 && noCodes.json?.error === "no-codes", "no live code: no-codes, typed, and not a 404");

    // ── Mint: the deep link's promises ──
    const m = await mint();
    const code = m.json.code;
    const link = parsePairDeepLink(m.json.deepLink);
    check(link?.secure === true && /^[0-9a-f]{32}$/.test(link?.commit ?? ""), "the deep link says s=1 and k=");
    check(/^[0-9a-f]{64}$/.test(m.json.updateKeyFingerprint ?? ""), "mint gives the update key's fingerprint");

    // ── A wrong code: a typed miss, the right code still live ──
    const wrong = await pakePhoneStart("ZZZZZZZZ");
    const ws = await post("/api/pair/pake/start", wrong.request);
    check(ws.status === 200 && ws.json.yb.length === 1, "start offers one share for the one live code");
    const wf = await pakePhoneFinish(wrong.state, ws.json, { deviceName: "e2e" });
    const miss = await post("/api/pair/pake/finish", wf.request);
    check(miss.status === 403 && miss.json?.error === "unknown", "a wrong code is a typed miss");

    // ── A share that is no group element ──
    const bad = await post("/api/pair/pake/start", { sidP: pakeEncode(new Uint8Array(16).fill(1)), ya: pakeEncode(new Uint8Array(32)) });
    check(bad.status === 400 && bad.json?.error === "bad-request", "the identity point is refused at start");

    // ── The exchange ──
    const p = await pakePhoneStart(code);
    const s = await post("/api/pair/pake/start", p.request);
    check(s.status === 200 && typeof s.json.nh === "string" && s.json.yb.length === 1, "start answers nh and a share");
    const f = await pakePhoneFinish(p.state, s.json, { deviceName: "e2e phone" });
    const done = await post("/api/pair/pake/finish", f.request);
    check(done.status === 200 && typeof done.json?.seal === "string", "finish answers a seal, carrying no Authorization");
    check(done.json?.token === undefined, "the token is not outside the seal");
    const reply = await pakePhoneOpen(f.candidates, done.json.seal);
    check(reply?.ok === true && typeof reply.token === "string", "the seal opens and holds a token");
    check(typeof reply?.hostId === "string" && reply.lanIdentity?.hostId === reply.hostId && !!reply.lanIdentity?.secret, "the seal holds hostId and the LAN identity");
    check(typeof reply?.updateKey === "string", "the seal holds the update key");
    check((await pairCommit(reply?.updateKey, reply?.tls?.spki)) === link.commit, "the sealed facts match the QR's commitment");

    // ── The token works ──
    const list = await fetch(`${B}/api/devices`, { headers: { authorization: `Bearer ${reply.token}` } });
    const devices = await list.json();
    const cur = devices?.devices?.find((d) => d.current);
    check(list.status === 200 && cur?.id === reply.deviceId && cur?.name === "e2e phone", "the token works as a Bearer, its row named from the box");

    // ── One try, one spend ──
    const replay = await post("/api/pair/pake/finish", f.request);
    check(replay.status === 410 && replay.json?.error === "no-session", "a replayed finish finds nothing");
    const again = await post("/api/pair/redeem", { code, deviceName: "e2e" });
    check(again.status === 410 && again.json?.error === "used", "the code is spent exactly as a redeem spends it");
  } catch (e) {
    console.error(e);
    failed = true;
  }
  await finishUp();
});
