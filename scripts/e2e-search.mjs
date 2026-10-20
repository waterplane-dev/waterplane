// session.search — word search over terminal text, three scopes:
//  - "recent"  = current rendered PTY output (renderCapture of the scrollback)
//  - "history" = persisted prompt+output of every recorded turn (with turn label)
//  - "prompts" = the persisted prompts ALONE — what was sent in, never the reply
// Also covers scoping: id set = one session (in-CLI find); id absent = all sessions.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-search-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 800, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const created = [];              // session ids in creation order
  let lastResults = null;          // newest session.searchResults payload
  // Fire a search and wait for the matching reply (matched by query+scope+id).
  const searchFor = async (query, scope, id) => {
    lastResults = null;
    ws.send(JSON.stringify({ t: "session.search", query, scope, id }));
    const mine = () => lastResults && lastResults.query === query && lastResults.scope === scope && lastResults.id === id;
    for (let i = 0; i < 30 && !mine(); i++) await sleep(100);
    return mine() ? lastResults : null;
  };
  // A positive search asks again until the text has landed (PTY echo, idle render), up to a
  // deadline: under a loaded suite a fixed nap before ONE search read an empty scrollback.
  const searchUntil = async (query, scope, id, ok, ms = 15000) => {
    const deadline = Date.now() + ms;
    let r = await searchFor(query, scope, id);
    while (!(r && ok(r)) && Date.now() < deadline) { await sleep(250); r = await searchFor(query, scope, id); }
    return r;
  };
  try {
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") created.push(m.session.id);
      if (m.t === "session.searchResults") lastResults = m;
    });

    // Two sessions in two repos.
    const repoA = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alpha" }) }).then((r) => r.json());
    const repoB = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "bravo" }) }).then((r) => r.json());
    ws.send(JSON.stringify({ t: "session.create", cwd: repoA.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && created.length < 1; i++) await sleep(100);
    ws.send(JSON.stringify({ t: "session.create", cwd: repoB.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && created.length < 2; i++) await sleep(100);
    check(created.length === 2, "two sessions created");
    const [sidA, sidB] = created;

    // ── Recent scope: echo a marker into A's terminal, then find it. ──
    ws.send(JSON.stringify({ t: "session.input", id: sidA, data: "echo apricotmarker_recent\n" }));
    let r = await searchUntil("apricotmarker_recent", "recent", sidA, (x) => x.results.length >= 1);
    check(r != null && r.results.length >= 1 && r.results[0].id === sidA, "recent: token found in session A");
    const hitA = r?.results?.[0];
    check(!!hitA && hitA.total >= 1 && hitA.matches.length >= 1, "recent: hit carries matches + total");
    check(!!hitA && hitA.matches[0].hit.toLowerCase().includes("apricotmarker_recent"), "recent: hit line contains the token");
    check(!!hitA && hitA.matches[0].turn === undefined, "recent: no turn label (not a history hit)");

    // Scoped to A only, a token echoed nowhere → no results.
    r = await searchFor("zzzznotpresent", "recent", sidA);
    check(r != null && r.results.length === 0, "recent: absent token → no results");

    // ── History scope: record a prompt, then find it with a turn label. ──
    ws.send(JSON.stringify({ t: "session.record", id: sidB, text: "please add a bananamarker_history export", kind: "prompt" }));
    r = await searchUntil("bananamarker_history", "history", sidB, (x) => x.results.length >= 1);
    check(r != null && r.results.length === 1 && r.results[0].id === sidB, "history: recorded prompt found in session B");
    const hitB = r?.results?.[0]?.matches?.[0];
    check(!!hitB && hitB.turn && hitB.turn.kind === "prompt", "history: hit carries the turn label (kind=prompt)");
    check(!!hitB && hitB.hit.toLowerCase().includes("bananamarker_history"), "history: hit line contains the token");

    // ── Prompts scope: the prompt matches, the output of that turn does not. ──
    // A recorded turn whose OUTPUT carries the token and whose prompt does not:
    // "history" must find it and "prompts" must not, or the scope is a label
    // over the same search.
    // Its own turn, opened right before the keys — as `deliver.ts` records then types. Reusing the
    // banana turn lost a race under the full suite: a late stub repaint plus the 600 ms idle sealed
    // that capture while the searches above ran, so the echo landed with nothing capturing it.
    ws.send(JSON.stringify({ t: "session.record", id: sidB, text: "run the echo", kind: "prompt" }));
    ws.send(JSON.stringify({ t: "session.input", id: sidB, data: "echo cherrymarker_out\n" }));
    // The output lands on the entry once the turn goes idle (the idle knob) and its async render
    // finishes: wait for THAT, then ask the prompts scope the same question. 45 s: under the
    // pre-push run's ten parallel scripts the idle + render took past the 15 s default.
    r = await searchUntil("cherrymarker_out", "history", sidB, (x) => x.results.length >= 1, 45_000);
    const outInHistory = r != null && r.results.length === 1;
    check(outInHistory, "history: a token only in the turn's OUTPUT is found");
    r = await searchFor("bananamarker_history", "prompts", sidB);
    check(r != null && r.results.length === 1 && r.results[0].matches[0].turn?.kind === "prompt", "prompts: the recorded prompt is found, with its turn label");
    r = await searchFor("cherrymarker_out", "prompts", sidB);
    check(r != null && r.results.length === 0, "prompts: that same output token is NOT found");

    // A history search of A (no recorded prompt with this token) → no results.
    r = await searchFor("bananamarker_history", "history", sidA);
    check(r != null && r.results.length === 0, "history: token not in session A → no results");

    // ── All-sessions scope (id omitted). ──
    r = await searchFor("apricotmarker_recent", "recent", undefined);
    check(r != null && r.id === undefined, "all: reply echoes id=undefined");
    check(r != null && r.results.some((s) => s.id === sidA), "all: recent search across sessions includes A");
    check(r != null && r.results.every((s) => s.repoLabel && s.title), "all: each result carries repoLabel + title");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e); failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
