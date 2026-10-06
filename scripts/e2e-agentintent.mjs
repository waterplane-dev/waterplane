// An AGENT posting later work through the host's loopback route
// (`POST|GET|DELETE /api/agent/intents`, `packages/host/src/agentintents.ts`).
//
// What is pinned, one assertion per promise the route makes:
//  - a post lands in the SAME store the phone's `intent.post` writes, marked
//    `origin: "agent"`, and the phone's own `intent.list` shows it;
//  - a retried curl with the same `key` — sequential AND racing — is ONE row;
//  - the answer says when it fires in the send sheet's words (`whenWords`);
//  - a window rule, a chain `after` another row, and a named repo all post;
//  - list/read return only the agent's rows; DELETE calls one off, and a
//    person's row is refused;
//  - a backlog ADD (`POST /api/agent/backlog`) is one item per key, marked, and
//    never fires by itself — not even with auto on;
//  - a browser (Origin, cross- or same-origin), a proxied request and a phone's
//    socket claiming `origin: "agent"` are all refused or stripped.
//
// Every row is timed a day out or chained behind one, so nothing fires.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8921;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-agentintent-`));
const REPO = join(ROOT, "proj");
mkdirSync(REPO);
execFileSync("git", ["init", "-q", REPO]);
writeFileSync(join(REPO, "README.md"), "x\n");

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.INTENT_TICK_MS]: "300",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

function http(path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      host: "127.0.0.1", port: PORT, path, method,
      headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers },
    }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function phone() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const waiters = [];
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === "welcome") resolve(api);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.res(msg); }
    });
    const api = {
      send: (m) => ws.send(JSON.stringify(m)),
      next: (pred, ms = 4000) => new Promise((res) => { waiters.push({ pred, res }); setTimeout(() => res(null), ms); }),
      close: () => ws.close(),
    };
  });
}

const DAY = 24 * 3600e3;

bootWait(PORT, 1500, async () => {
  try {
    const repos = (await http("/api/repos")).json;
    const repoId = (repos?.targets ?? []).find((r) => r.worktreePath?.endsWith("/proj"))?.id;
    check(!!repoId, "the test repo is listed");

    // ── post, and the retry ──────────────────────────────────────────
    const at = Date.now() + DAY;
    const body = { key: "e2e-one", repo: repoId, prompt: "AGENT-POSTED-MUST-NOT-FIRE", label: "e2e one", when: { kind: "at", at } };
    const first = await http("/api/agent/intents", { method: "POST", body });
    check(first.status === 200 && first.json?.ok === true && first.json.id === "agent-e2e-one", `post → 200 with the row id (${first.status} ${JSON.stringify(first.json)?.slice(0, 160)})`);
    check(first.json?.existing === false, "first post is not `existing`");
    check(typeof first.json?.fires === "string" && / · in (23h|1d)/.test(first.json.fires), `fires says when, in the send sheet's words (${first.json?.fires})`);
    check(first.json?.state === "queued" || first.json?.state === "blocked", `the row waits (${first.json?.state})`);

    const again = await http("/api/agent/intents", { method: "POST", body });
    check(again.json?.ok === true && again.json.existing === true && again.json.id === first.json?.id, "a retry with the same key returns the same row, `existing: true`");
    const race = await Promise.all([1, 2, 3].map(() => http("/api/agent/intents", { method: "POST", body: { ...body, key: "e2e-race" } })));
    check(race.every((r) => r.json?.ok && r.json.id === "agent-e2e-race"), "three racing posts under one key all answer the same id");

    // ── the other triggers ───────────────────────────────────────────
    const win = await http("/api/agent/intents", { method: "POST", body: { key: "e2e-win", dir: REPO, prompt: "window", when: { kind: "window", window: "weekly", leadMin: 180 } } });
    check(win.json?.ok === true, `a weekly-window one-shot posts (${JSON.stringify(win.json)?.slice(0, 160)})`);
    check(/weekly/.test(win.json?.fires ?? ""), `…and says which window (${win.json?.fires})`);
    const chain = await http("/api/agent/intents", { method: "POST", body: { key: "e2e-after", repo: repoId, steps: ["step one", "step two"], when: { kind: "after", id: "agent-e2e-one" } } });
    check(chain.json?.ok === true && /^after “e2e one”/.test(chain.json.fires ?? ""), `a chain posts and names what it waits for (${chain.json?.fires})`);
    check(chain.json?.steps?.length === 2, "the whole chain is kept");
    const recurring = await http("/api/agent/intents", { method: "POST", body: { key: "e2e-rec", repo: repoId, prompt: "x", when: { kind: "window", window: "session", oneShot: false } } });
    check(recurring.status === 400, "a standing rule is refused in words");
    const outside = await http("/api/agent/intents", { method: "POST", body: { key: "e2e-out", dir: "/etc", prompt: "x" } });
    check(outside.status === 400 && /outside the configured root/.test(outside.json?.error ?? ""), "a dir outside the root is refused");
    const nokey = await http("/api/agent/intents", { method: "POST", body: { repo: repoId, prompt: "x" } });
    check(nokey.status === 400 && /key/.test(nokey.json?.error ?? ""), "no key → refused");

    // ── the phone sees it, marked ────────────────────────────────────
    const p = await phone();
    p.send({ t: "intent.list" });
    const list = await p.next((m) => m.t === "intent.list");
    const row = list?.intents?.find((i) => i.id === "agent-e2e-one");
    check(row?.origin === "agent", "the phone's intent.list carries the row, origin `agent`");
    check((list?.intents ?? []).filter((i) => i.id === "agent-e2e-race").length === 1, "one row for the raced key");

    // A phone may not CLAIM the mark: `postClientDraft` strips it off the wire.
    p.send({ t: "intent.post", ackId: "ack-claim", intent: { id: "i_claim", cwd: REPO, payload: { kind: "prompt", steps: ["claim"] }, target: { kind: "repo" }, trigger: { kind: "at", rule: { kind: "once", at }, graceMin: 60 }, auto: true, origin: "agent" } });
    const ack = await p.next((m) => m.t === "op.ack" && m.ackId === "ack-claim");
    check(ack?.ok === true, "the phone's own post is accepted");
    p.send({ t: "intent.list" });
    const list2 = await p.next((m) => m.t === "intent.list");
    check(list2?.intents?.find((i) => i.id === "i_claim")?.origin == null, "…with the `agent` mark stripped");

    // ── list, read, cancel ───────────────────────────────────────────
    const mine = await http(`/api/agent/intents?repo=${repoId}`);
    const ids = (mine.json?.intents ?? []).map((i) => i.id).sort();
    check(ids.join(",") === ["agent-e2e-after", "agent-e2e-one", "agent-e2e-race", "agent-e2e-win"].sort().join(","), `list → only the agent's rows (${ids.join(",")})`);
    const one = await http("/api/agent/intents/agent-e2e-one");
    check(one.json?.ok === true && one.json.steps?.[0] === "AGENT-POSTED-MUST-NOT-FIRE", "read one → the words, never clipped");
    const theirs = await http("/api/agent/intents/i_claim", { method: "DELETE" });
    check(theirs.status === 403, "a person's row cannot be called off here");
    const cancel = await http("/api/agent/intents/agent-e2e-one", { method: "DELETE" });
    check(cancel.json?.ok === true && cancel.json.state === "canceled", `DELETE calls it off (${cancel.json?.state})`);
    const repost = await http("/api/agent/intents", { method: "POST", body });
    check(repost.json?.existing === true && repost.json.state === "canceled", "a retry after the cancel does not revive it");

    // ── who may call ─────────────────────────────────────────────────
    const evil = await http("/api/agent/intents", { method: "POST", body: { ...body, key: "e2e-evil" }, headers: { origin: "http://evil.example" } });
    check(evil.status === 403, "cross-origin browser → 403");
    const same = await http("/api/agent/intents", { method: "POST", body: { ...body, key: "e2e-same" }, headers: { origin: `http://127.0.0.1:${PORT}` } });
    check(same.status === 403, "same-origin browser → 403 (a browser is not an agent)");
    const proxied = await http("/api/agent/intents", { method: "POST", body: { ...body, key: "e2e-proxy" }, headers: { "x-forwarded-for": "100.100.1.2" } });
    check(proxied.status === 403, "a proxied request (tailscale serve) → 403");
    const after = await http("/api/agent/intents");
    check(!(after.json?.intents ?? []).some((i) => /evil|same|proxy/.test(i.id)), "none of the refused posts wrote a row");

    // ── a backlog ADD: on the list, never started by itself ──────────
    // Auto ON first, so "it did not fire" means the row held, not the switch.
    p.send({ t: "backlog.setAuto", enabled: true });
    const blBody = { key: "e2e-bl", repo: repoId, prompt: "AGENT-BACKLOG-MUST-NOT-FIRE", label: "e2e backlog" };
    const bl = await http("/api/agent/backlog", { method: "POST", body: blBody });
    check(bl.json?.ok === true && bl.json.id === "agent-e2e-bl" && bl.json.existing === false, `backlog add → the row (${JSON.stringify(bl.json)?.slice(0, 160)})`);
    check(/waits for your tap/.test(bl.json?.fires ?? ""), `…which says it waits for a tap (${bl.json?.fires})`);
    const blAgain = await http("/api/agent/backlog", { method: "POST", body: blBody });
    check(blAgain.json?.ok === true && blAgain.json.existing === true && blAgain.json.id === "agent-e2e-bl", "a retried add with the same key is the same item");
    const blRace = await Promise.all([1, 2, 3].map(() => http("/api/agent/backlog", { method: "POST", body: { ...blBody, key: "e2e-bl-race" } })));
    check(blRace.every((r) => r.json?.ok && r.json.id === "agent-e2e-bl-race"), "three racing adds under one key answer one id");
    const blWhen = await http("/api/agent/backlog", { method: "POST", body: { ...blBody, key: "e2e-bl-when", when: { kind: "now" } } });
    check(blWhen.status === 400, "a backlog add with a `when` is refused — that is the intents route");
    await new Promise((r) => setTimeout(r, 2000)); // several ticks with auto on
    p.send({ t: "backlog.list" });
    const bll = await p.next((m) => m.t === "backlog.list");
    const items = (bll?.items ?? []).filter((it) => it.id === "agent-e2e-bl" || it.id === "agent-e2e-bl-race");
    check(items.length === 2, `the phone's backlog lists one item per key (${items.length})`);
    check(items.every((it) => it.origin === "agent" && it.manual === true), "…each marked posted-by-agent and manual");
    check(items.every((it) => it.status === "queued"), `…and still queued with auto on — neither fired (${items.map((i) => i.status)})`);
    check(/waits for your tap/.test(bll?.waiting?.["agent-e2e-bl"] ?? ""), `…and the backlog says why (${bll?.waiting?.["agent-e2e-bl"]})`);
    p.send({ t: "backlog.setAuto", enabled: false });

    // Tidy: nothing here may ever fire.
    for (const id of ["agent-e2e-bl", "agent-e2e-bl-race"]) await http(`/api/agent/intents/${id}`, { method: "DELETE" });
    for (const id of ["agent-e2e-race", "agent-e2e-win", "agent-e2e-after"]) await http(`/api/agent/intents/${id}`, { method: "DELETE" });
    p.send({ t: "intent.cancel", id: "i_claim" });
    p.close();
  } catch (e) {
    check(false, `threw: ${e?.stack || e}`);
  }
  done();
});
