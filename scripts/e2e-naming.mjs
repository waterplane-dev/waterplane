// Titling a repo's untitled backlog rows — end to end, through a real daemon.
//
// A headline is the only string in this app a MODEL writes FOR a person, over
// words that person typed, sitting in the place they look first. The pure rules
// are pinned without a host (`packages/shared/test/naming.test.mjs`) and the
// host's own without a daemon (`packages/host/test/naming.test.mjs`). What needs
// a real one is the wiring, and each of these is a way the feature could look
// like it worked while quietly doing the wrong thing:
//
//   1. the pass writes the names the model gave, with the AUTHOR on them — the
//      field that decides whether anything may ever write over them again — and
//      both halves reach the phone's own backlog list, not just the store
//   2. a row the model left OUT stays absent: no invented title, no empty
//      string, nothing on the row at all. `naming.ts`'s "heuristics degrade to
//      absent, never to a wrong number", applied to a name
//   3. a row a PERSON titled by hand is untouched, and still takes the kind
//      nobody had set — the two halves are decided separately
//   4. one pass per repo: a second is refused with a SENTENCE, having spent
//      nothing
//   5. a misconfigured route writes nothing and SAYS so — never a silent fall
//      back to claude, since stopping that call is the only reason anyone sets
//      the variable
//
// The naming task is TOOLLESS by contract, which is exactly why it may take the
// local engine — so the model here is a ten-line Node stub speaking
// /chat/completions (`e2e-sidecar.mjs`'s) and CI needs no ollama, no download
// and no GPU.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8836;
const PORT_BAD = 8837;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-naming-`)));
const MODEL = "gemma4:e4b"; // the colon in the tag is the parse this pins

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(100); }
  return false;
};

// ── The stand-in for the model ──────────────────────────────────────────────
//
// It answers from a table keyed on the item's own words, never on position: the
// batch order is the store's, and a stub that depended on it would be pinning
// the wrong thing. `SCROLL` is deliberately ABSENT from the table — that is
// case 2, the row nothing usable came back for.
const TITLES = {
  MIGRATION: { headline: "guide for moving to v2", category: "chore" },
  CRASH: { headline: "uploader dies on large files", category: "bug" },
};
const seen = [];
let holdMs = 0;
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded as null — that is a failure too */ }
    seen.push({ url: req.url, body });
    const prompt = body?.messages?.find((m) => m.role === "user")?.content ?? "{}";
    let items = [];
    try {
      items = (JSON.parse(prompt).items ?? [])
        .map((it) => {
          const key = Object.keys(TITLES).find((k) => String(it.text).startsWith(k));
          return key ? { id: it.id, ...TITLES[key] } : null;
        })
        .filter(Boolean);
    } catch { /* an unreadable prompt answers nothing, which is also a real case */ }
    // Held open so the "a second pass is refused" case has a live pass to be
    // refused by — a race against a 50 ms completion is a race this script
    // would lose on a slow machine.
    if (holdMs) await sleep(holdMs);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "stub", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items }) }, finish_reason: "stop" }],
    }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${stub.address().port}/v1`;

// ── The host ─────────────────────────────────────────────────────────────────
const envFor = (port, spec) => ({
  ...process.env,
  // e2e must never touch the shared tmux server, and the boot doctor must not
  // print into output the script reads.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.SIDECAR_NAME]: spec,
});

let host = null;
let hostErr = "";
function boot(port, spec) {
  host = spawn("node", ["packages/host/dist/main.js"], { env: envFor(port, spec), stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", () => {});
  host.stderr.on("data", (d) => { hostErr += d; process.stderr.write("[host] " + d); });
}
const stop = async () => { host?.kill("SIGKILL"); await sleep(500); };
process.on("exit", () => { try { host?.kill("SIGKILL"); } catch { /* already gone */ } });

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const s = { items: [], naming: undefined, acks: [], toasts: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "backlog.list") { s.items = m.items; s.naming = m.naming; }
    if (m.t === "op.ack") s.acks.push(m);
    if (m.t === "toast") s.toasts.push(m.text);
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(400);
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.close = () => ws.close();
  s.item = (id) => s.items.find((i) => i.id === id);
  s.byText = (head) => s.items.find((i) => (i.text ?? "").startsWith(head));
  s.refresh = async () => { s.send({ t: "backlog.list" }); await sleep(300); };
  return s;
}

const ack = (s, id) => s.acks.find((a) => a.ackId === id);
const die = (m) => { console.log("FAIL: " + m); if (host) host.kill(); stub.close(); process.exit(1); };
setTimeout(() => die("timeout"), 120_000);

try {
  boot(PORT, `openai-compat:${BASE}|${MODEL}`);
  await bootWait(PORT, 900, async () => {});
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "naming" }),
  }).then((r) => r.json());
  if (!repo.path) die("could not create repo");
  const REPO = realpathSync(repo.path);

  const c = await connect(PORT);
  const texts = [
    "MIGRATION: write the guide for moving a store to the v2 shape",
    "SCROLL: the picker forgets where it was scrolled to",
    "CRASH: uploading anything over fifty megabytes kills the tab",
  ];
  texts.forEach((t, i) => c.send({ t: "backlog.add", text: t, repoDir: REPO, ackId: `add-${i}` }));
  await sleep(900);
  await c.refresh();
  const idOf = (head) => c.byText(head)?.id;
  const migrationId = idOf("MIGRATION:"), scrollId = idOf("SCROLL:"), crashId = idOf("CRASH:");
  check(!!migrationId && !!scrollId && !!crashId, "three untitled work items are on the host");

  // ── 3a — a row a PERSON named, before any pass runs ─────────────────────────
  c.send({ t: "backlog.update", id: crashId, headline: "MY OWN TITLE" });
  await sleep(400);
  await c.refresh();
  check(c.item(crashId)?.headline === "MY OWN TITLE", "a typed title lands on the row");
  check(c.item(crashId)?.headlineBy === "hand", "…stamped `hand`, which is the one author nothing may write over");

  // ── 3c — a typed title this app will NOT write is SAID, never dropped ──────
  // It used to write nothing and answer as though it had: the phone closed its
  // editor, the row went on showing the old title, and the words a person had
  // just typed were gone with nothing anywhere about it.
  const beforeRefusal = c.toasts.length;
  c.send({ t: "backlog.update", id: crashId, headline: "CRASH: uploading anything" });
  check(await waitFor(() => c.toasts.length > beforeRefusal, 4000), "a refused title is answered at all");
  check(/^backlog: /.test(c.toasts.slice(-1)[0]) && /already starts/.test(c.toasts.slice(-1)[0]),
    `…in one sentence naming what was refused: “${c.toasts.slice(-1)[0]}”`);
  await c.refresh();
  check(c.item(crashId)?.headline === "MY OWN TITLE",
    "…and refusing is not clearing — the title that was there is still there");

  // ── 1 & 2 — the pass ───────────────────────────────────────────────────────
  const before = seen.length;
  c.send({ t: "backlog.name", repoDir: REPO, ids: [migrationId, scrollId, crashId], ackId: "name-1" });
  check(await waitFor(() => ack(c, "name-1")), "backlog.name is acked");
  check(seen.length > before, "the local server was asked");
  const req = seen[seen.length - 1];
  check(req.url === "/v1/chat/completions", `the route is the OpenAI one (${req.url})`);
  check(req.body?.model === MODEL, `the model tag survives its colon (${req.body?.model})`);
  check(req.body?.tools === undefined, "no tools are offered — this task is toolless by contract, which is why it may be local at all");
  check(String(req.body?.messages?.find((m) => m.role === "user")?.content ?? "").includes("fifty megabytes"),
    "the items' own WORDS travel in the prompt, in full — a title written off a clip could only be the truncation the cleaner refuses");

  await c.refresh();
  check(c.item(migrationId)?.headline === "guide for moving to v2",
    `the row the model titled carries it (got ${JSON.stringify(c.item(migrationId)?.headline)})`);
  check(c.item(migrationId)?.headlineBy === "name",
    `…with the author that says a machine wrote it (got ${c.item(migrationId)?.headlineBy})`);
  check(c.item(migrationId)?.category === "chore" && c.item(migrationId)?.categoryBy === "name",
    "…and the kind, paired with its own author");

  check(c.item(scrollId)?.headline === undefined,
    `a row the model left out stays ABSENT — no invented title, no empty string (got ${JSON.stringify(c.item(scrollId)?.headline)})`);
  check(c.item(scrollId)?.headlineBy === undefined, "…and nothing claims to have named it");

  // ── 3b — the hand-named row ────────────────────────────────────────────────
  check(c.item(crashId)?.headline === "MY OWN TITLE", "a title somebody typed is NOT replaced");
  check(c.item(crashId)?.headlineBy === "hand", "…and still says who wrote it");
  check(c.item(crashId)?.category === "bug" && c.item(crashId)?.categoryBy === "name",
    `…while the kind nobody had set IS written (got ${c.item(crashId)?.category} / ${c.item(crashId)?.categoryBy})`);

  check(c.toasts.some((t) => t.startsWith("named 2")),
    `the finishing sentence goes back to whoever tapped: “${c.toasts.slice(-1)[0]}”`);
  check(c.toasts.some((t) => /kept the name you typed/.test(t)),
    "…and says the refusal out loud, because a silent one looks exactly like a model that said nothing");

  // A second pass over a cut where everything is now named: refused in its own
  // words, and it buys nothing. `scrollId` is deliberately NOT in it — the model
  // said nothing usable about that row, so it is still nameable and a cut
  // containing it is a cut with work in it.
  const beforeSecond = seen.length;
  c.send({ t: "backlog.name", repoDir: REPO, ids: [migrationId, crashId], ackId: "name-nothing" });
  check(await waitFor(() => ack(c, "name-nothing")), "a pass over a named list is answered");
  check(c.toasts.some((t) => /nothing in that cut needs a title/.test(t)),
    `…refused in words: “${c.toasts.slice(-1)[0]}”`);
  check(seen.length === beforeSecond, "…having spent nothing");

  // ── 4 — one at a time per repo ─────────────────────────────────────────────
  // Four fresh rows and a stub that holds its answer open, so the second tap
  // provably lands while the first pass is still thinking.
  holdMs = 2500;
  ["LATER1: something else to do entirely", "LATER2: and one more"].forEach((t, i) =>
    c.send({ t: "backlog.add", text: t, repoDir: REPO, ackId: `later-${i}` }));
  await sleep(700);
  c.send({ t: "backlog.name", repoDir: REPO, ids: [], ackId: "name-slow" });
  await sleep(600);
  await c.refresh();
  // ── 6 — the ack does not wait for the pass ────────────────────────────────
  // `backlog.name` is `durable: true` and used to await the whole thing: up to
  // ten sequential batches at up to 120 s each, against the phone's 20 s ack
  // deadline and 8 attempts. A pass that was working was re-sent eight times
  // and then shown as FAILED while it was still running. The stub is holding
  // its answer open right now, so this ack is provably the one that did not.
  check(!!ack(c, "name-slow"), "the ack lands while the pass is STILL RUNNING");
  check(/^titling 3 items/.test(ack(c, "name-slow")?.reason ?? ""),
    `…saying how many it is working on (got ${JSON.stringify(ack(c, "name-slow")?.reason)})`);
  check((c.naming ?? []).length > 0, "…and the pass really is still in flight");
  // The three rows that still have something a machine may write: the two just
  // added, and the one the model said nothing usable about. The two the first
  // pass finished are NOT in it, which is what makes this a reading of the live
  // pass rather than of the repo.
  const nowNaming = [...(c.naming ?? [])].sort();
  check(nowNaming.length === 3 && nowNaming.includes(scrollId),
    `the rows a live pass is working on ride the backlog snapshot (got ${JSON.stringify(c.naming)})`);
  check(!nowNaming.includes(migrationId),
    "…and a row that already has both halves is not one of them");
  const beforeRace = seen.length;
  c.send({ t: "backlog.name", repoDir: REPO, ids: [], ackId: "name-race" });
  check(await waitFor(() => ack(c, "name-race")), "the second tap is answered");
  check(c.toasts.some((t) => /already running for this repo/.test(t)),
    `…refused in words, not a silence: “${c.toasts.slice(-1)[0]}”`);
  check(seen.length === beforeRace, "…and it bought no completion");
  // The pass's own sentence is what the ack no longer stands in for — it still
  // arrives, as the toast it always was, whenever the pass lands.
  check(await waitFor(() => c.toasts.some((t) => /^nothing written —/.test(t)), 20000),
    `the first pass still finishes and still says what it did: “${c.toasts.slice(-1)[0]}”`);
  await c.refresh();
  check((c.naming ?? []).length === 0, "…and the transient is gone with it");
  holdMs = 0;

  c.close();
  await stop();

  // ── 5 — a misrouted host: nothing written, and a sentence saying why ───────
  // `openai-compat:<url>` with no model cannot be completed by guessing, and
  // falling back to claude would spend the tokens the knob exists to save.
  hostErr = "";
  const beforeBad = seen.length;
  boot(PORT_BAD, `openai-compat:${BASE}`);
  await bootWait(PORT_BAD, 900, async () => {});
  const b = await connect(PORT_BAD);
  b.send({ t: "backlog.add", text: "BROKEN: a row for the misrouted host", repoDir: REPO, ackId: "add-bad" });
  await sleep(800);
  await b.refresh();
  const badId = b.byText("BROKEN:")?.id;
  b.send({ t: "backlog.name", repoDir: REPO, ids: [badId], ackId: "name-bad" });
  check(await waitFor(() => ack(b, "name-bad")), "the misrouted pass is answered");
  await b.refresh();
  check(b.item(badId)?.headline === undefined, "a spec that cannot be read writes no title at all");
  check(seen.length === beforeBad, "…and nothing was sent to the server either");
  check(b.toasts.some((t) => t.startsWith("nothing written —")),
    `…and the person is told, in one sentence: “${b.toasts.slice(-1)[0]}”`);
  check(/\[sidecar\]/.test(hostErr) && hostErr.includes(E.SIDECAR_NAME),
    "the host says which variable is wrong, once, instead of failing silently");
  b.close();
  await stop();
} catch (e) {
  console.log("FAIL: threw", e);
  failed = true;
}

if (host) host.kill("SIGKILL");
stub.close();
// Retried: a daemon that has just been killed may still be finishing a write
// under ROOT, and a bare `rmSync` loses the whole run's verdict to an ENOTEMPTY
// after every check has already passed.
try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the OS will sweep tmp */ }
setTimeout(() => process.exit(failed ? 1 : 0), 200);
