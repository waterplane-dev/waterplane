// "Of the work still standing in this repo, what is actually still worth
// doing?" — the wiring, end to end.
//
// The rules about what an assessment may CONCLUDE are pure and pinned without a
// host (`packages/shared/test/assess.test.mjs`). What needs a daemon is
// everything around them, and every one of these is a way the feature could
// look like it worked while quietly doing the wrong thing:
//
//   1. the run is a durable INTENT — on disk before the tap returns, and still
//      there after the host is killed mid-run, with a sentence saying so rather
//      than a row that vanished
//   2. `<state>/assess-out.json` is DELETED before the run, so a run that writes
//      nothing fails instead of "succeeding" with the previous run's verdicts —
//      `settle.ts`'s `spendTurn` problem, evidence that belongs to somebody else
//   3. a missing file and an unparseable one each fail and say WHICH
//   4. one at a time per repo: a second run is refused with a sentence
//   5. the run is VISIBLE while it works (`assess.state`), because an assess row
//      is neither `isBacklogRow` nor `isBuildRow` and would otherwise appear in
//      no list at all until it finished
//   6. the run carries the WORDS it judged (`AssessRun.input`), pad notes
//      included — the sheet reads them from there rather than from state that
//      has moved on
//   7. applying is idempotent under a replayed ackId: a merge posts ONE intent,
//      never two
//   8. a merge retires its N with "merged into <the id that replaced them>"
//   9. NOTHING IS DELETED — every assessed row is still in the store, with its
//      words, after applying
//  10. applying `still wanted` to a FAILED row PUTS IT BACK IN THE QUEUE, with
//      its words, its place, its old failure and a note saying who put it back
//      — but ONLY where the revived row could actually run. A row behind a
//      predecessor that is gone is REFUSED at apply time, in words quoting the
//      sentence it would die of, rather than queued for one tick and failed
//      again: "19 put back in the queue … they run again when their turn comes"
//      has to be true of all nineteen. Plus the hand half (`intent.requeue`):
//      the same refusal, at-most-once under a replayed ackId, refused in words
//      on a row already waiting its turn, and refused again when it names a
//      failure the row no longer has.
//  11. the TITLES: applying without `writeNames` titles nothing; with it, a row
//      a person named by hand keeps its own title and still takes the kind
//      nobody set; the author travels to the phone, because it is what decides
//      whether the next pass may write over the name; and a posted merge is
//      titled whatever the answer was, with no `merge of N: <id> <id>` label —
//      that string was machine bookkeeping in the field that means "the name a
//      person gave this".
//  12. a PAD NOTE the run says is still worth doing is OFFERED and can be FILED:
//      the offer carries the note's own words byte for byte (the pure layer
//      copies them — the CLI is never asked to), applying posts a backlog row
//      running exactly those words with NO `from an assessment` label over
//      them, and `<ls>pad` itself comes back from a fresh connection
//      byte-identical to what was set. The host reads that document and never
//      writes it; clearing the note is the phone's half, on the receipt — and
//      that receipt NAMES the notes whose row landed (`op.ack`'s `filed`),
//      because `intents.post` can refuse while the apply still answers `ok`,
//      and this is the one pad delete taken on a remote answer rather than on a
//      durable local copy. A replayed ackId answers the same list.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { E, LS, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8823;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-assess-`));
let REPO = join(ROOT, "proj");
const MODE_FILE = join(ROOT, "stub-mode");
const STUB = join(ROOT, "claude-assess-stub.mjs");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(120); }
  return false;
};

// ── A repo with something in it ──────────────────────────────────────────────
mkdirSync(REPO, { recursive: true });
// Realpath, because `containRepoDir` resolves one (`/var` -> `/private/var` on
// macOS) and every id, cwd and broadcast key downstream is the resolved form.
REPO = realpathSync(REPO);
const git = (args) => new Promise((r) => spawn("git", args, { cwd: REPO, stdio: "ignore" }).on("exit", r));
await git(["init", "-q"]);
writeFileSync(join(REPO, "README.md"), "# proj\n");
await git(["add", "-A"]);
await git(["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"]);

/**
 * The stub `claude`.
 *
 * The real executor is `claude -p --output-format stream-json --verbose
 * --permission-mode acceptEdits` with the prompt on stdin — the stream is READ
 * as it arrives so a running assessment can say what it is doing, and its last
 * line is the same envelope the single-object format printed. The contract
 * itself is unchanged and is two FILES, which is why this stub may print one
 * object and still be a faithful stand-in.
 * So this reads `<state>/assess-in.json`, decides by the words each item starts
 * with (never by position — the input order is the store's, and a test that
 * depended on it would be pinning the wrong thing), and writes the two files
 * back. Its mode is read from a file on every invocation so one booted host can
 * be driven through all of them.
 */
writeFileSync(STUB, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const STATE = ${JSON.stringify(STATE)};

const mode = existsSync(${JSON.stringify(MODE_FILE)}) ? readFileSync(${JSON.stringify(MODE_FILE)}, "utf8").trim() : "ok";
const cwd = process.cwd();
const outPath = join(cwd, STATE, "assess-out.json");

// Drain stdin — the host writes the kickoff prompt there and closes it.
process.stdin.resume();
process.stdin.on("data", () => {});

if (mode === "slow") {
  // Long enough that the test can kill the host while this is still running.
  setTimeout(() => { process.stdout.write('{"result":"late"}'); process.exit(0); }, 60000);
} else if (mode === "noout") {
  // Writes NOTHING. If the host did not delete a stale file, this run would
  // "succeed" carrying yesterday's verdicts.
  process.stdout.write('{"result":"I decided not to write anything"}');
} else if (mode === "badjson") {
  mkdirSync(join(cwd, STATE), { recursive: true });
  writeFileSync(outPath, "this is not json {");
  process.stdout.write('{"result":"wrote something"}');
} else {
  const input = JSON.parse(readFileSync(join(cwd, STATE, "assess-in.json"), "utf8"));
  const open = input.items.filter((i) => !i.context);
  const items = [];
  const mergeIds = [];
  // A title and a kind on EVERY open item, which is what the kickoff prompt
  // asks for. Deliberately not derived from \`it.text\`: a headline that is the
  // item's own first words is the one shape \`cleanHeadline\` refuses, so a stub
  // that sliced the prompt would test the refusal instead of the write.
  const titleFor = (it) =>
    it.text.startsWith("DONE:") ? { headline: "health endpoint for the API", category: "feature" }
      : it.text.startsWith("MERGEA:") ? { headline: "scroll position is lost", category: "bug" }
        : it.text.startsWith("MERGEB:") ? { headline: "focus is lost on rotate", category: "bug" }
          : it.text.startsWith("WANT:") ? { headline: "guide for moving to v2", category: "chore" }
            : it.text.startsWith("NOTE:") ? { headline: "the thought from the train", category: "enhancement" }
              : { headline: "something nobody has judged", category: "enhancement" };
  for (const it of open) {
    if (it.text.startsWith("DONE:")) items.push({ id: it.id, verdict: "done", evidence: "src/app.ts:1 — the behaviour is there", ...titleFor(it) });
    else if (it.text.startsWith("MERGE")) mergeIds.push(it.id);
    else if (it.text.startsWith("WANT:")) items.push({ id: it.id, verdict: "wanted", rank: 1, ...titleFor(it) });
    // A pad note judged like everything else, which is what the kickoff prompt
    // now asks for. The stub deliberately does NOT restate it under "new": the
    // offer is synthesised from the note's own text by \`cleanAssessment\`, and a
    // stub that wrote the words itself would be testing the CLI's obedience
    // instead of the guarantee.
    else if (it.text.startsWith("NOTE:")) items.push({ id: it.id, verdict: "wanted", rank: 4, ...titleFor(it) });
    else items.push({ id: it.id, verdict: "unclear", evidence: "could not tell from the repo alone", ...titleFor(it) });
  }
  for (const id of mergeIds) items.push({ id, verdict: "merged", ...titleFor(open.find((o) => o.id === id)) });
  const doc = {
    items,
    merges: mergeIds.length >= 2
      ? [{
        gid: "g1", ids: mergeIds, prompt: "One prompt covering both facets of the same job.",
        rank: 2, rationale: "two facets of one job",
        headline: "picker keeps scroll and focus", category: "bug",
      }]
      : [],
    new: [{ prompt: "a genuinely missing piece", rank: 3, headline: "the piece nobody wrote down", category: "feature" }],
  };
  mkdirSync(join(cwd, STATE), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc));
  writeFileSync(join(cwd, STATE, "plan.md"), "# plan\\n\\nwhat was found, in order.\\n");
  process.stdout.write('{"result":"wrote both files"}');
}
`);
chmodSync(STUB, 0o755);
const setMode = (m) => writeFileSync(MODE_FILE, m);

// The CLI's trust ledger, as a fixture: `runToolTask` refuses a folder Claude
// Code does not trust (`sidecar.ts`'s `workspaceTrust`), and this temp repo
// never is. Re-read on every run, so the script can flip it under one host.
const CONFIG_DIR = join(ROOT, "claude-config");
mkdirSync(CONFIG_DIR, { recursive: true });
const setTrusted = (yes) => writeFileSync(join(CONFIG_DIR, ".claude.json"),
  JSON.stringify({ projects: yes ? { [REPO]: { hasTrustDialogAccepted: true } } : {} }));
setTrusted(true);

// ── The host ─────────────────────────────────────────────────────────────────
let host = null;
function boot() {
  const env = {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CLAUDE_BIN]: STUB,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    // A fast tick, because section 10 is about what the LADDER would do to a row
    // an apply is asked to put back, and at the 2 s default that is a script
    // spending most of its time asleep. Nothing else here depends on the tick's
    // period: every row above is gated by the auto-fire switch, which is off.
    [E.INTENT_TICK_MS]: "400",
  };
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
// SIGKILL, not SIGTERM. Half of what this script pins is what survives the
// daemon dying WITHOUT a chance to tidy up — a graceful shutdown would let the
// flush hide exactly the writes that are supposed to have happened already.
// And wait for the EXIT, never a fixed sleep: a host still dying when the next
// one boots answers `waitForHost` itself, and its sockets then tell nothing.
const stop = async () => {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const gone = new Promise((r) => host.once("exit", r));
  host.kill("SIGKILL");
  await gone;
};
// A script that throws must not leave a daemon holding this port: the next run
// would boot into "port already in use" and report a wall of failures that have
// nothing to do with the code under test.
process.on("exit", () => { try { host?.kill("SIGKILL"); } catch { /* already gone */ } });

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const s = { runs: new Map(), intents: [], acks: [], toasts: [], frames: [], backlog: [], seen: {} };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    s.seen[m.t] = (s.seen[m.t] ?? 0) + 1;
    if (m.t === "assess.state") { s.frames.push(m); if (m.run) s.runs.set(m.repoDir, m.run); else s.runs.delete(m.repoDir); }
    // Both halves, the way the real client does it: the full list on hello and
    // on request, and one row per transition. This script used to read only
    // `intent.list` and got away with it because the host ALSO rebroadcast the
    // whole store on every change — which it no longer does, one row changed
    // being one row on the wire. A reader that ignores `intent.changed` now
    // holds a snapshot as old as its last explicit ask.
    if (m.t === "intent.list") s.intents = m.intents;
    if (m.t === "intent.changed") {
      const at = s.intents.findIndex((i) => i.id === m.intent.id);
      if (at < 0) s.intents.push(m.intent); else s.intents[at] = m.intent;
    }
    if (m.t === "op.ack") s.acks.push(m);
    if (m.t === "toast") s.toasts.push(m.text);
    // §11 is about what a row is CALLED, and the wire has two answers to that:
    // the Intent rows above and the backlog DTO. Both are read, because a
    // title the store holds and the phone's list does not is a title nobody
    // can see — `intentToBacklogItem` is where that gap would be.
    if (m.t === "backlog.list") s.backlog = m.items;
    // §12: the pad, which this host may READ and must never write. The whole
    // document arrives unprompted on hello, which is why the assertion is worth
    // a reconnect rather than a trusted in-memory copy.
    if (m.t === "settings.all") s.settings = m.doc;
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  // `settings.all` is the last of hello's answers this script reads (after
  // `intent.list`): wait for it, not a fixed sleep a loaded machine outruns.
  await waitFor(() => s.settings !== undefined);
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.close = () => ws.close();
  s.run = () => s.runs.get(REPO);
  s.intent = (id) => s.intents.find((i) => i.id === id);
  s.item = (id) => s.backlog.find((i) => i.id === id);
  // A fresh frame of each kind asked for, however long the host takes to answer.
  s.refresh = async () => {
    const kinds = ["intent.list", "backlog.list", "assess.state"];
    const before = Object.fromEntries(kinds.map((k) => [k, s.seen[k] ?? 0]));
    s.send({ t: "intent.list" }); s.send({ t: "backlog.list" }); s.send({ t: "assess.state", repoDir: REPO });
    await waitFor(() => kinds.every((k) => (s.seen[k] ?? 0) > before[k]));
  };
  return s;
}

const ack = (s, id) => s.acks.find((a) => a.ackId === id);
const outPath = join(REPO, STATE, "assess-out.json");

boot();
await waitForHost(PORT);
let c = await connect();

// ── The list the run is about ────────────────────────────────────────────────
// Four work items and one pad note. The pad is a synced SETTING the daemon
// stores blind; the host parses it read-only for exactly this, which is the only
// way "everything left" includes the thoughts that were written for this repo
// without ever being aimed at a session.
const texts = [
  "DONE: add a health endpoint",
  "MERGEA: the picker forgets its scroll position",
  "MERGEB: the picker also loses focus on rotate",
  "WANT: write the migration guide",
];
texts.forEach((t, i) => c.send({ t: "backlog.add", text: t, repoDir: REPO, ackId: `add-${i}` }));
// Kept as constants: §12 asserts the note's words reach a posted row byte for
// byte, and that this VALUE is still on the host unchanged afterwards.
const NOTE_ID = "padnote1";
const NOTE_TEXT = "NOTE: a thought written on a train";
const PAD_VALUE = JSON.stringify([{ id: NOTE_ID, text: NOTE_TEXT, ts: Date.now(), cwd: REPO }]);
c.send({ t: "settings.set", key: `${LS}pad`, ts: Date.now(), value: PAD_VALUE });
await sleep(900);
await c.refresh();
const idOf = (head) => c.intents.find((i) => i.payload?.steps?.[0]?.startsWith(head))?.id;
const doneId = idOf("DONE:"), mergeAId = idOf("MERGEA:"), mergeBId = idOf("MERGEB:"), wantId = idOf("WANT:");
check(!!doneId && !!mergeAId && !!mergeBId && !!wantId, "four work items are on the host");

// ── 0 — a repo Claude Code does not trust is never run ───────────────────────
// `claude -p` there would load the repo's own hooks without asking. The stub
// would write an answer file in "ok" mode, so its absence says it never started.
setTrusted(false);
setMode("ok");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-untrusted" });
check(await waitFor(() => c.run()?.status === "failed"), `an untrusted repo's run FAILS (got ${c.run()?.status})`);
check((c.run()?.detail ?? "").includes("does not trust"), `…and the detail says why, in words: “${c.run()?.detail}”`);
check(!existsSync(outPath), "…and the binary never started: no answer file was written");
setTrusted(true);

// ── 1 — a stale output file must not be believed ─────────────────────────────
mkdirSync(join(REPO, STATE), { recursive: true });
writeFileSync(outPath, JSON.stringify({ items: [{ id: doneId, verdict: "done", evidence: "from a run two days ago" }] }));
setMode("noout");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-noout" });
check(await waitFor(() => ack(c, "run-noout")), "assess.run is acked");
check(ack(c, "run-noout")?.ok === true, "…and accepted: the row is on disk");
check(await waitFor(() => c.run()?.status === "failed"), `a run that wrote no file FAILS (got ${c.run()?.status})`);
check((c.run()?.detail ?? "").includes("assess-out.json"), `…and the detail names which half of the contract failed: “${c.run()?.detail}”`);
check(!existsSync(outPath), "the PREVIOUS run's output file was deleted before the run — its verdicts can never be read as this run's");
check(!!c.run()?.envelope, "the CLI's own words are kept when the FILE was the problem — otherwise a red row cannot be debugged");

// ── 2 — an unparseable file fails, and says so ───────────────────────────────
setMode("badjson");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-bad" });
check(await waitFor(() => c.run()?.status === "failed" && (c.run()?.detail ?? "").includes("not valid JSON")),
  `an unparseable output file fails and says which: “${c.run()?.detail}”`);

// ── 3 — one at a time per repo, and visible while it works ───────────────────
setMode("slow");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-slow" });
check(await waitFor(() => c.run()?.status === "running"),
  "a running assessment is pushed to the phone WHILE it works — not only when it finishes");
const slowRunId = c.run()?.runId;
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-second" });
check(await waitFor(() => ack(c, "run-second")), "the second run is answered");
check(ack(c, "run-second")?.ok === false, "…refused: one assessment at a time per repo");
check((ack(c, "run-second")?.reason ?? "").includes("already running"), `…with a sentence, not a silence: “${ack(c, "run-second")?.reason}”`);

// ── 4 — the durable row survives the host dying mid-run ──────────────────────
c.close();
await stop();
boot();
await waitForHost(PORT);
c = await connect();
await c.refresh();
check(!!c.intent(slowRunId), "the run's intent row is still there after a restart — it was on disk before the tap returned");
const revived = c.intent(slowRunId);
check(revived && revived.state !== "running" && revived.state !== "starting",
  `…and is no longer claimed to be running (got ${revived?.state})`);
check((revived?.result?.detail ?? "").length > 0, `…with a sentence saying what became of it: “${revived?.result?.detail}”`);
// The sidecar's half. Without it `running()` would refuse every future run for
// this repo, for ever, with no way back from the phone.
check(c.runs.get(REPO)?.status === "failed", `the sidecar's crashed run is reconciled too (got ${c.runs.get(REPO)?.status})`);

// ── 5 — a real run: the proposal, and the words it judged ────────────────────
setMode("ok");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-ok" });
check(await waitFor(() => c.run()?.status === "done", 20000), `the run comes back done (got ${c.run()?.status})`);
const run = c.run();
const runId = run?.runId;
check(!!run?.proposal, "…carrying a proposal");
check(run?.planPath === `${STATE}/plan.md`, "…and naming the human document it wrote");
const inputTexts = (run?.input?.items ?? []).map((i) => i.text);
check(!!run?.input, "the run carries the INPUT it judged — the sheet reads the words from here, never from state that has moved on");
check(inputTexts.some((t) => t.startsWith("NOTE:")), "…including the pad note carrying this cwd: a thought written for this repo and aimed at nothing");
check((run?.input?.items ?? []).some((i) => i.source === "note"), "…marked as coming from the pad, not from the work list");
const wrote = JSON.parse(readFileSync(join(REPO, STATE, "assess-in.json"), "utf8"));
check(wrote.cwd === REPO && wrote.version === 1, "the file the CLI reads is versioned and names its repo");

const rows = run.proposal.rows;
const verdictOf = (id) => rows.find((r) => r.id === id)?.verdict;
check(verdictOf(doneId) === "done", `the cited "done" survives as done (got ${verdictOf(doneId)})`);
check(verdictOf(mergeAId) === "merged" && verdictOf(mergeBId) === "merged", "both merge members are `merged`");
check(run.proposal.merges.length === 1 && run.proposal.merges[0].ids.length === 2, "one merge group of two");
check(run.proposal.news.filter((n) => !n.fromNote).length === 1, "one proposed new item");
// …and the OFFER, which the CLI never wrote: a `wanted` pad note is copied into
// the new list by `cleanAssessment`, from the note's own text.
const noteOffer = run.proposal.news.find((n) => n.fromNote === NOTE_ID);
check(!!noteOffer, "a pad note judged still wanted is OFFERED as a new item — the verdict that used to do nothing");
check(noteOffer?.prompt === NOTE_TEXT,
  `…carrying the note's own words, byte for byte (got ${JSON.stringify(noteOffer?.prompt)})`);

// ── 6 — applying, twice, with the same ackId ─────────────────────────────────
const before = c.intents.length;
const choices = { rows: [doneId, wantId], merges: ["g1"], news: [0] };
c.send({ t: "assess.apply", runId, choices, ackId: "apply-1" });
check(await waitFor(() => ack(c, "apply-1")), "assess.apply is acked");
check(ack(c, "apply-1")?.ok === true, "…and applied");
await c.refresh();
const posted = c.intents.filter((i) => i.origin === `assess:${runId}`);
check(posted.length === 2, `applying posted exactly two intents — the merge and the new item (got ${posted.length})`);
// Found by its WORDS, not by its label. The label used to be `merge of 2: <id>
// <id>` — machine bookkeeping in the field that means "the name a person gave
// this" — and §11 pins that it is gone. The link to the sentences it replaces
// is not lost with it: the ids are on the run's own proposal, and every retired
// member says `merged into <id>` in its result (§7).
const mergeRow = posted.find((i) => (i.payload?.steps?.[0] ?? "").startsWith("One prompt covering both facets"));
check(!!mergeRow, "the merge posted the prompt it wrote to cover both of them");

// The replay. Same ackId, same everything: the ledger must re-ack it without
// running anything — a merge posted twice is two agents on one job in one
// worktree.
c.send({ t: "assess.apply", runId, choices, ackId: "apply-1" });
await sleep(900);
await c.refresh();
check(c.intents.filter((i) => i.origin === `assess:${runId}`).length === 2,
  "a REPLAYED ackId posts nothing more — applying is at-most-once like every durable op");
check(c.intents.length === before + 2, "…and adds no rows at all the second time");

// ── 7 — what applying did to the rows ────────────────────────────────────────
const dn = c.intent(doneId);
check(dn?.state === "canceled", `an accepted "done" is retired (got ${dn?.state})`);
check(!!dn?.dismissedAt, "…and marked seen, which is the gate a terminal row must pass before it may ever be compacted away");
check((dn?.result?.detail ?? "").includes("already done"), `…with the verdict ON the row: “${dn?.result?.detail}”`);
check((dn?.result?.detail ?? "").includes("src/app.ts:1"), "…and the evidence it was retired on, not just the word");
const ma = c.intent(mergeAId);
check(ma?.state === "canceled" && (ma?.result?.detail ?? "").includes(`merged into ${mergeRow?.id}`),
  `a merged row names the id that replaced it: “${ma?.result?.detail}”`);
check(c.intent(wantId)?.order === 1, `a "wanted" row gets its position in the order (got ${c.intent(wantId)?.order})`);
check(c.intent(wantId)?.state !== "canceled", "…and is NOT retired: ranking is the whole content of that verdict");

// ── 8 — nothing is deleted ───────────────────────────────────────────────────
const survived = [doneId, mergeAId, mergeBId, wantId].every((id) => {
  const row = c.intent(id);
  return !!row && typeof row.payload?.steps?.[0] === "string" && row.payload.steps[0].length > 0;
});
check(survived, "every assessed row is still in the store, with its words — retired is not deleted");
check(c.runs.get(REPO)?.status === "applied", "the run is `applied`, which is a different question from `done`: one is a diff waiting, the other is a record of what was decided");
check(c.runs.get(REPO)?.applied?.posted === 2, `…and says what it did (posted ${c.runs.get(REPO)?.applied?.posted})`);

// A second apply of an already-applied proposal, with a FRESH ackId, is the
// guard past the ledger's 45 minutes.
c.send({ t: "assess.apply", runId, choices, ackId: "apply-2" });
check(await waitFor(() => ack(c, "apply-2")), "a fresh-ackId re-apply is answered");
check(ack(c, "apply-2")?.ok === false, "…and refused: an applied proposal is not applied again");
await c.refresh();
check(c.intents.filter((i) => i.origin === `assess:${runId}`).length === 2, "…having posted nothing");

// ── 9 — discard ──────────────────────────────────────────────────────────────
c.send({ t: "assess.discard", runId });
check(await waitFor(() => !c.runs.get(REPO) || c.runs.get(REPO).runId !== runId), "a discarded proposal leaves the sidecar");
await c.refresh();
check(!!c.intent(doneId), "…and discarding touched none of the words it was about");


// ── 10 — "still wanted" on a FAILED row, and what it may NOT make runnable ───
//
// The verdict every other section exercises is a retirement. This is the other
// half, and until it existed it was the half that did nothing: a `wanted`
// verdict on a failed row wrote a sort position, and a failed row is not in any
// order — the ladder never looks at it again. On the desktop this was written
// on the repo's own backlog was 0 queued and 19 failed, so it was the only
// verdict the run could usefully reach and it was a no-op.
//
// Two rows, one verdict, opposite answers — because putting a row back into the
// state it died in is that same no-op with a delay on it. One is stranded behind
// a predecessor that does not exist: the ladder re-derives that every tick, so
// the rung that failed it is still there to fail it again, and the apply refuses
// it in words rather than queueing it for one tick. The other is a one-off whose
// instant went past, which is exactly the shape dropping the clock makes
// runnable again.
const STRANDED = "stranded1";
c.send({
  t: "intent.post", ackId: "post-stranded",
  intent: {
    id: STRANDED, cwd: REPO,
    payload: { kind: "prompt", steps: ["WANT: finish the stranded chain"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "after", id: "nobody-has-this-id", title: "a predecessor that was removed" },
    title: "a row behind a ghost",
  },
});
const TIMED = "timedwant1";
c.send({
  t: "intent.post", ackId: "post-timed",
  intent: {
    id: TIMED, cwd: REPO,
    payload: { kind: "prompt", steps: ["WANT: the one-off that missed its window"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule: { kind: "once", at: Date.now() - 4 * 3600_000, offsetMin: 0 }, graceMin: 1 },
    title: "a one-off that missed",
  },
});
check(await waitFor(() => c.intent(STRANDED)?.state === "failed"),
  `a row whose predecessor is gone fails on its own (got ${c.intent(STRANDED)?.state})`);
check(await waitFor(() => c.intent(TIMED)?.state === "failed"),
  `a one-off past its grace fails on its own (got ${c.intent(TIMED)?.state})`);
const firstFailure = c.intent(STRANDED)?.result?.detail ?? "";
const timedFailure = c.intent(TIMED)?.result?.detail ?? "";
check(firstFailure.length > 0, `…with a sentence: \u201c${firstFailure}\u201d`);

setMode("ok");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-requeue" });
check(await waitFor(() => c.run()?.status === "done", 20000), `a run over the failed rows comes back done (got ${c.run()?.status})`);
const runId2 = c.run()?.runId;
const judged = (id) => c.run()?.input?.items?.find((i) => i.id === id && !i.context);
check(!!judged(STRANDED) && !!judged(TIMED),
  "a FAILED row is a candidate, not context — it is exactly the row this verdict is for");
// WHICH failure the run was looking at, stamped on the item it judged. Without
// it the apply cannot tell the row it read from a row that merely has the same
// state — `failed` is a state, not an event.
check(judged(STRANDED)?.failedAt === c.intent(STRANDED)?.settledAt,
  `…carrying the instant it settled failed (got ${judged(STRANDED)?.failedAt})`);
check(c.run()?.proposal?.rows?.find((r) => r.id === STRANDED)?.verdict === "wanted", "…and it is judged still wanted");
check(c.run()?.proposal?.rows?.find((r) => r.id === TIMED)?.verdict === "wanted", "…both of them");

c.send({ t: "assess.apply", runId: runId2, choices: { rows: [STRANDED, TIMED] }, ackId: "apply-requeue" });
check(await waitFor(() => ack(c, "apply-requeue")), "the apply is acked");
check(ack(c, "apply-requeue")?.ok === true, "…and applied: a row it could not put back is not a failure of the apply");
await c.refresh();

// ── the row that could come back ─────────────────────────────────────────────
const put = c.intent(TIMED);
check(put?.requeues?.length === 1, `it is put back, with exactly one re-queue recorded (got ${put?.requeues?.length})`);
check(put?.requeues?.[0]?.by === "assess", `…which says an assessment put it back (got ${put?.requeues?.[0]?.by})`);
check(put?.requeues?.[0]?.runId === runId2, "…and names the run, so the row is one tap from the verdicts it came out of");
check(put?.requeues?.[0]?.result?.detail === timedFailure, "…carrying the failure it had, in full");
check(put?.requeues?.[0]?.clockDropped === true, "…and saying the one thing that was CHANGED about it");
check(put?.requeueCount === 1, `…with the uncapped count started at one (got ${put?.requeueCount})`);
check(put?.trigger?.kind === "idle", `…the spent clock dropped, so it waits its turn instead (got ${put?.trigger?.kind})`);
check(put?.order === 1, `…at the position the assessment gave it (got ${put?.order})`);
check(!!put?.result, "…and `result` is NOT cleared: a re-queue is not a claim that the run never happened");
// Its STATE is deliberately not asserted: it is runnable now, this host's tick
// is 400 ms, and a row that has already started is the feature working.

// ── the row that could not ───────────────────────────────────────────────────
const stuck = c.intent(STRANDED);
check(stuck?.state === "failed", `a DEAD CHAIN is left exactly where it was (got ${stuck?.state})`);
check(stuck?.requeues === undefined, "…with nothing written down about a re-queue that did not happen");
check(stuck?.requeueCount === undefined, "…including the count");
check(stuck?.order === 1, "…and it is still RANKED: where it sits in the list is true of a failed row too");
check(c.run()?.applied?.requeued === 1,
  `…and exactly one row is counted as put back (got ${c.run()?.applied?.requeued})`);

// The replay, at-most-once like every durable op. A second entry here would be
// the row claiming somebody approved it twice.
c.send({ t: "assess.apply", runId: runId2, choices: { rows: [STRANDED, TIMED] }, ackId: "apply-requeue" });
await sleep(900);
await c.refresh();
check(c.intent(TIMED)?.requeues?.length === 1, "a REPLAYED apply ackId adds no second re-queue");

// ── …and the hand half ───────────────────────────────────────────────────────
//
// The same pre-flight, reached by a tap instead of a verdict: a phone offering
// the button on a row nothing could ever run is the bug in its other form, and
// the answer is the sentence the ladder itself would have used.
c.send({ t: "intent.requeue", id: STRANDED, ackId: "requeue-stranded" });
check(await waitFor(() => ack(c, "requeue-stranded")), "intent.requeue is acked");
check(ack(c, "requeue-stranded")?.ok === false, "…and refused on a row that could not get anywhere");
check((ack(c, "requeue-stranded")?.reason ?? "").startsWith("it would stop again straight away:"),
  `…quoting what it would die of: \u201c${ack(c, "requeue-stranded")?.reason}\u201d`);
check((ack(c, "requeue-stranded")?.reason ?? "").includes(firstFailure),
  "…in the ladder's own words, not a second wording of them");
await c.refresh();
check(c.intent(STRANDED)?.requeues === undefined, "…having written nothing on the row");

// A failure the row no longer has. This op is durable and may be delivered an
// hour late; `failed` is a state, not an event, so the live-state guard on its
// own would revive a row that has since failed differently and retire a
// sentence nobody has read.
const settledAt = c.intent(STRANDED)?.settledAt;
check(typeof settledAt === "number", "the row says when it settled");
c.send({ t: "intent.requeue", id: STRANDED, failedAt: settledAt - 60_000, ackId: "requeue-stale" });
check(await waitFor(() => ack(c, "requeue-stale")), "a requeue naming an older failure is answered");
check(ack(c, "requeue-stale")?.ok === false, "…and refused");
check((ack(c, "requeue-stale")?.reason ?? "").includes("failed again since you looked"),
  `…saying WHY, so the new failure gets read: \u201c${ack(c, "requeue-stale")?.reason}\u201d`);

c.send({ t: "intent.requeue", id: wantId, ackId: "requeue-queued" });
check(await waitFor(() => ack(c, "requeue-queued")), "a requeue of a row that is already waiting is answered");
check(ack(c, "requeue-queued")?.ok === false, "…and refused");
check((ack(c, "requeue-queued")?.reason ?? "").includes("already waiting its turn"),
  `…in words, not a silence: \u201c${ack(c, "requeue-queued")?.reason}\u201d`);
check(c.intent(wantId)?.requeues === undefined, "…having written nothing on the row");

// ── 11 — what the run says these things should be CALLED ─────────────────────
//
// The one write an apply makes that a person READS rather than one the ladder
// acts on, and the only place in this app where a machine's words go on top of
// somebody's, in the field they look at first. Four things, and the middle two
// are the whole safety case:
//
//   • applying WITHOUT `writeNames` titles no existing row — absent is no, so
//     an older client's apply changes nothing;
//   • a row a person titled by hand KEEPS its own title, and still takes the
//     kind nobody had set: the two halves are decided separately, or every kind
//     on a hand-named row stays unset for ever;
//   • a titled row carries its AUTHOR to the phone, because that is what decides
//     whether the next pass may write over it;
//   • a POSTED row (a merge, a new item) is titled whatever the answer was — its
//     prompt is the run's own words, so there is nothing to stand on top of —
//     and carries NO `merge of N: <id> <id>` label, which was machine
//     bookkeeping in the field that means "the name a person gave this".
await c.refresh();
check(c.intent(doneId)?.headline === undefined,
  `the §6 apply carried no writeNames, so no existing row was titled (got ${JSON.stringify(c.intent(doneId)?.headline)})`);
check(c.intent(wantId)?.headline === undefined, "…none of them");
const postedMerge = c.intent(mergeRow?.id);
check(postedMerge?.headline === "picker keeps scroll and focus",
  `…while the row the merge POSTED is titled anyway (got ${JSON.stringify(postedMerge?.headline)})`);
check(postedMerge?.headlineBy === "assess", `…stamped by the run (got ${postedMerge?.headlineBy})`);
check(postedMerge?.category === "bug" && postedMerge?.categoryBy === "assess", "…kind and author together, or neither");
check(!/merge of/.test(postedMerge?.label ?? ""),
  `…and its label is not machine bookkeeping: “${postedMerge?.label}”`);
check(c.item(mergeRow?.id)?.headlineBy === "assess", "…and all four fields reach the phone's own list, not just the store");

// A title a PERSON typed, on a row the next run will also have an opinion about.
c.send({ t: "backlog.update", id: wantId, headline: "MY OWN TITLE" });
await sleep(400);
await c.refresh();
check(c.intent(wantId)?.headline === "MY OWN TITLE", "a typed title lands");
check(c.intent(wantId)?.headlineBy === "hand", "…stamped `hand`, which is the one author nothing may write over");
check(c.intent(wantId)?.category === undefined, "…and typing a title says nothing about what KIND of thing it is");

setMode("ok");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-names" });
check(await waitFor(() => c.run()?.status === "done" && c.run()?.runId !== runId2, 20000),
  `a run over the named rows comes back done (got ${c.run()?.status})`);
const runId3 = c.run()?.runId;
const proposed = (id) => c.run()?.proposal?.rows?.find((r) => r.id === id);
check(proposed(wantId)?.headline === "guide for moving to v2",
  `the run proposes a title for the hand-named row too (got ${JSON.stringify(proposed(wantId)?.headline)})`);

c.send({ t: "assess.apply", runId: runId3, choices: { writeNames: true }, ackId: "apply-names" });
check(await waitFor(() => ack(c, "apply-names")), "the naming apply is acked");
check(ack(c, "apply-names")?.ok === true, "…and applied");
await c.refresh();

check(c.intent(wantId)?.headline === "MY OWN TITLE",
  `a title somebody typed is NOT replaced (got ${JSON.stringify(c.intent(wantId)?.headline)})`);
check(c.intent(wantId)?.headlineBy === "hand", "…and still says who wrote it");
check(c.intent(wantId)?.category === "chore",
  `…while the kind nobody had set IS written (got ${c.intent(wantId)?.category})`);
check(c.intent(wantId)?.categoryBy === "assess", "…by the run, so a later pass may replace it and a tap wins over it");
check(c.item(wantId)?.headline === "MY OWN TITLE" && c.item(wantId)?.headlineBy === "hand",
  "…and the phone's list says the same thing, from the same store");

// The rows the run had no typed words to defer to: titled outright.
const newRow = c.intents.find((i) => (i.payload?.steps?.[0] ?? "").startsWith("a genuinely missing piece"));
check(!!newRow?.headline && newRow?.headlineBy === "assess",
  `an untitled row takes the run's title, stamped by the run (got ${JSON.stringify(newRow?.headline)} / ${newRow?.headlineBy})`);
check((c.runs.get(REPO)?.applied?.named ?? 0) > 0,
  `the run records how many rows it titled (got ${c.runs.get(REPO)?.applied?.named})`);
check(c.toasts.some((t) => / \d+ titled/.test(t)),
  `…and the line a person reads says it: “${c.toasts.filter((t) => t.startsWith("applied")).slice(-1)[0]}”`);

// ── 12 — a pad note that is still worth doing ────────────────────────────────
//
// The verdict that used to be read, judged, counted and left. It is an OFFER
// now: a row in the run's `new` list carrying the note's own sentence, ticked
// and applied like every other row on the sheet. Two things are load-bearing
// and neither is visible in a diff — the words on the offer are COPIED by
// `cleanAssessment` from the input item (so "in its own words" is true by
// construction, not because a model complied), and the pad itself is untouched
// by everything on this side.
setMode("ok");
c.send({ t: "assess.run", repoDir: REPO, ackId: "run-note" });
check(await waitFor(() => c.run()?.status === "done" && c.run()?.runId !== runId3, 20000),
  `a run over the pad note comes back done (got ${c.run()?.status})`);
const runId4 = c.run()?.runId;
const news = c.run()?.proposal?.news ?? [];
const offerAt = news.findIndex((n) => n.fromNote === NOTE_ID);
check(offerAt >= 0, "the note judged still wanted is offered as a new item, naming the note it came from");
check(news[offerAt]?.prompt === NOTE_TEXT,
  `…carrying the note's own words, byte for byte (got ${JSON.stringify(news[offerAt]?.prompt)})`);

const beforeFiling = c.intents.length;
c.send({ t: "assess.apply", runId: runId4, choices: { news: [offerAt] }, ackId: "apply-note" });
check(await waitFor(() => ack(c, "apply-note")), "the filing apply is acked");
check(ack(c, "apply-note")?.ok === true, "…and applied");
await c.refresh();
const filedRow = c.intents.find((i) => i.origin === `assess:${runId4}`);
check(!!filedRow, "the ticked offer posted a backlog row");
check(c.intents.length === beforeFiling + 1, "…exactly one — the offer is one row, not a row plus a copy");
check(filedRow?.payload?.steps?.[0] === NOTE_TEXT,
  `…which runs the note's own sentence (got ${JSON.stringify(filedRow?.payload?.steps?.[0])})`);
check(!filedRow?.label,
  `…with NO label over the person's own words: “from an assessment” would read as their title (got ${JSON.stringify(filedRow?.label)})`);
check(filedRow?.headlineBy === "assess",
  `…while the machine's half is still stamped as the machine's (got ${filedRow?.headlineBy})`);
check(c.toasts.some((t) => /1 filed from the pad/.test(t)),
  `…and the line a person reads says where it came from: “${c.toasts.filter((t) => t.startsWith("applied")).slice(-1)[0]}”`);

// ── …and the RECEIPT, which is what a note is deleted on ────────────────────
//
// `ok` used to be the whole signal, and `intents.post` REFUSES on its own
// (`PENDING_MAX`, an unrunnable draft) while `applyProposal` moves on — so an
// apply that posted nothing still answered `ok`, and a phone clearing every
// ticked offer on it tombstoned words with no row anywhere. The ids travel now,
// and the phone clears `ticked ∩ filed`.
check(Array.isArray(ack(c, "apply-note")?.filed),
  `the receipt SAYS which pad notes were filed (got ${JSON.stringify(ack(c, "apply-note")?.filed)})`);
check(JSON.stringify(ack(c, "apply-note")?.filed) === JSON.stringify([NOTE_ID]),
  `…by id, and only the one whose row actually landed (got ${JSON.stringify(ack(c, "apply-note")?.filed)})`);

// A replay of the same ackId is answered out of the ledger, and the list has to
// survive that trip through disk: a receipt that LOST it leaves words on the pad
// (one tap), one that WIDENED it deletes them (nothing).
c.acks.length = 0;
c.send({ t: "assess.apply", runId: runId4, choices: { news: [offerAt] }, ackId: "apply-note" });
check(await waitFor(() => ack(c, "apply-note")), "a replay of that ackId is re-acked from the ledger");
check(JSON.stringify(ack(c, "apply-note")?.filed) === JSON.stringify([NOTE_ID]),
  `…carrying the SAME filed list, not a fresh empty one (got ${JSON.stringify(ack(c, "apply-note")?.filed)})`);
await c.refresh();
check(c.intents.length === beforeFiling + 1, "…and still exactly one row: the replay posted nothing");

// THE thing this whole design rests on: the host posted a row and did not touch
// the document the words came off. A fresh connection, because the assertion is
// worthless against an in-memory copy this script never let go of — `<ls>pad`
// is a synced setting the daemon stores BLIND, and the note is cleared by the
// phone on the receipt for that post, which is the only half that owns it.
c.close();
const c2 = await connect();
check(c2.settings?.[`${LS}pad`]?.value === PAD_VALUE,
  `the pad is byte-identical to what was set — the host reads it and never writes it (got ${JSON.stringify(c2.settings?.[`${LS}pad`]?.value)})`);
c2.close();

await stop();
rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
