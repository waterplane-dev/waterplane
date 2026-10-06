// The verified capture loop, end to end: a picture taken, a CLAIM made about
// it, and both of them in `.claude/outbox/` where a phone and an agent can
// reach them.
//
// Driven through the `garmin` backend against `scripts/capture-stub.mjs`,
// because it is the only one of the four that can run on a build machine —
// `web` needs Playwright and a dev server, `android` a device, `window` would
// photograph whoever's desktop the suite happens to be running on. The stub
// satisfies ciqkit's argv and its exit-code contract, which is the only part of
// ciqkit the host reasons over.
//
// What this pins that no other layer can:
//
//   1. The run LIFECYCLE over the wire — `capture.run` rows arrive unasked on
//      the socket that is already open, and the row reaches a terminal status.
//      `packages/host/test/capture.test.mjs` can pin the ladder but not the
//      broadcast.
//   2. BOTH artifacts land: the PNG and the JSON sidecar beside it, and both
//      are served by the artifact route the gallery and the download button
//      already use — `.claude/outbox/capture-t_shot-….png` and
//      `.claude/outbox/capture-t_shot-….json`.
//   3. The verdict line's GRAMMAR, separator and level vocabulary — asserted as
//      a grammar, never as one frozen string, so the wording can improve
//      without a test that has to be edited to let it.
//   4. `capture.cancel` ends a LIVE run, and says so about one that is not.
//   5. A `web` target with no Playwright fails with a SENTENCE naming what is
//      missing. The row settles `failed` — never silently, never `done`. This
//      is "never grey out a button to mean not clickable" at the e2e layer: the
//      refusal has to be readable text, because that text is all a phone gets.
//   6. A traversal-shaped `dir` is refused, and the target is dropped from the
//      list rather than being offered as a button that would run somewhere else.
//   7. ciqkit's exit 3 DOWNGRADES rather than fails: the frame is kept as
//      evidence, `anchor.missing` is recorded, the level drops from
//      `verified:anchor` to `settled:stable`, and the run is still `done`. A
//      picture of the wrong screen is the most useful thing you can be handed
//      when you asked for a screen and got a different one.
//   8. `score` ABSENT is absent. With no scorer the sidecar must OMIT the
//      field, not write `0` — "heuristics degrade to null or absent, never to a
//      wrong number", pinned where it can actually break, because `0` and
//      "nobody measured" would render identically on a phone.
//   9. …and a score that WAS measured arrives. The mirror of (8), and the only
//      thing standing between the loop and a `score` that is absent FOREVER:
//      `ciqkit shot-score` can only report on a frame that is really at the path
//      it is handed, so `capture/garmin.ts` has to ask about the KEPT frame —
//      not a per-sample scratch directory the run has since emptied or deleted.
//      Get that wrong and every run answers "score n/a", which is
//      indistinguishable from the honest no-scorer case in (8) — which is
//      exactly why (8) cannot catch it and this leg has to exist.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8888;
/** Nothing ever binds this — the `web` target's url has to be local (the
 *  backend refuses anything else) and has to be dead. */
const DEAD_PORT = 8889;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-capture-`));
/** The stub reads this path, not a fixed env value: a daemon's environment
 *  cannot be changed after it is spawned, and one run of this script needs both
 *  the exit-0 and the exit-3 outcome out of the same host. */
const EXIT3_FLAG = join(ROOT, "ciqkit-exit3.flag");
/** Same trick, for the scorer: the file holds the number `shot-score` reports,
 *  and its ABSENCE is "no scorer installed here" — so one host can produce both
 *  the unscored run (8) and the scored one (9). */
const SCORE_FLAG = join(ROOT, "ciqkit-score.txt");

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.CIQKIT_BIN]: process.cwd() + "/scripts/capture-stub.mjs",
  [E.CAPTURE_STUB_EXIT3]: EXIT3_FLAG,
  [E.CAPTURE_STUB_SCORE]: SCORE_FLAG,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const api = (p) => `http://127.0.0.1:${PORT}${p}`;

// ── the verdict grammar ─────────────────────────────────────────────────────
//
// `{level} · score {n|n/a} · {w}x{h}[ {theme}]|n/a · console: … · net: …`,
// separator U+00B7 with a space each side. The phone treats the whole line as
// opaque; this is the only place entitled to take it apart, and it does so to
// check the SHAPE, not the wording.
const SEP = " · ";
const GRAMMAR = [
  /^(verified:anchor|settled:stable|unverified|error-overlay:[a-z][a-z0-9-]*|blank)$/,
  /^score (\d{1,3}|n\/a)$/,
  // ` +N more` is the multi-pass arm: a run whose passes did not all share a
  // shape records the FIRST pass's geometry and says how many others differed,
  // rather than letting the last pass quietly speak for the run.
  /^(\d+x\d+( (light|dark))?( \+\d+ more)?|n\/a)$/,
  /^console: (clean|\d+ err|n\/a)$/,
  /^net: (clean|\d+ failed|n\/a)$/,
];

function checkVerdict(v, where) {
  if (typeof v !== "string" || !v.trim()) fail(`${where}: no verdict line at all`);
  if (!v.includes(SEP)) fail(`${where}: the verdict separator must be " U+00B7 ": ${JSON.stringify(v)}`);
  const parts = v.split(SEP);
  if (parts.length !== GRAMMAR.length) fail(`${where}: verdict has ${parts.length} fields, expected ${GRAMMAR.length}: ${JSON.stringify(v)}`);
  parts.forEach((p, i) => {
    if (!GRAMMAR[i].test(p)) fail(`${where}: verdict field ${i + 1} ${JSON.stringify(p)} does not match ${GRAMMAR[i]} — whole line ${JSON.stringify(v)}`);
  });
  return parts;
}

/** A refusal has to be READABLE, because text is all the phone gets. */
function checkSentence(s, where, mustMention) {
  if (typeof s !== "string" || s.trim().length < 20) fail(`${where}: expected a sentence, got ${JSON.stringify(s)}`);
  if (mustMention && !mustMention.test(s)) fail(`${where}: the sentence must name what is missing (${mustMention}): ${JSON.stringify(s)}`);
}

// ── the repo under test ─────────────────────────────────────────────────────

const TARGETS = [
  // The one that works. `dir` is a real subdirectory, the way a 16-app monorepo
  // gives each app its own target.
  { id: "t_shot", name: "watch face - home", backend: "garmin", dir: "apps/x", screen: "home", device: "venu3", anchor: ["TOTAL"], settleMs: 4000 },
  // The one this machine cannot drive.
  { id: "t_web", name: "droplet - home", backend: "web", url: `http://127.0.0.1:${DEAD_PORT}/` },
  // The one that must never become a button.
  { id: "t_bad", name: "escapes the repo", backend: "garmin", dir: "../../../etc", screen: "home" },
];

bootWait(PORT, 800, async () => {
  await fetch(api("/api/repo"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "capturerepo" }),
  }).then((r) => r.json());
  const repos = await fetch(api("/api/repos")).then((r) => r.json());
  const wt = repos.targets[0].worktreePath, rid = repos.targets[0].id;

  mkdirSync(join(wt, "apps", "x"), { recursive: true });
  mkdirSync(join(wt, STATE), { recursive: true });
  // Written straight to disk rather than through `capture.save`, deliberately:
  // `save` runs the same sanitizer and would drop `t_bad` before it ever got
  // there, so the traversal guard would be asserted against a row that does not
  // exist. A hand-edited config is also how a bad row really arrives.
  writeFileSync(join(wt, STATE, "capture.json"), JSON.stringify({ version: 1, targets: TARGETS }, null, 2));

  // ── one socket, everything on it ──────────────────────────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  const runFrames = [];        // every `capture.run` row, in arrival order
  const acks = [];
  const toasts = [];
  const lists = [];
  const output = new Map();    // runId → the streamed tail
  let welcomed = false;

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("error", (e) => fail("ws error: " + e.message));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") welcomed = true;
    else if (m.t === "capture.list") lists.push(m);
    else if (m.t === "capture.run") runFrames.push(m.run);
    else if (m.t === "capture.output") output.set(m.runId, (m.full ? "" : output.get(m.runId) ?? "") + Buffer.from(m.dataB64, "base64").toString("utf8"));
    else if (m.t === "op.ack") acks.push(m);
    else if (m.t === "toast") toasts.push(m.text);
  });

  const waitFor = async (what, pred, ms = 30_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > until) fail(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const rowOf = (runId) => [...runFrames].reverse().find((r) => r.runId === runId);
  const settled = (runId) => waitFor(`run ${runId} to settle`, () => {
    const r = rowOf(runId);
    return r && r.status !== "running" ? r : null;
  });

  let acks_n = 0;
  const startRun = async (targetId, watch) => {
    const ackId = `cap-${++acks_n}`;
    send({ t: "capture.run", repoDir: wt, targetId, watch, ackId });
    return waitFor(`the op.ack for ${targetId}`, () => acks.find((a) => a.ackId === ackId));
  };

  const artifact = (rel) => fetch(api(`/api/repos/${rid}/artifact?path=${encodeURIComponent(rel)}`));

  await waitFor("the welcome frame", () => welcomed);

  // ── 1. the list, and what it says about this desktop ──────────────────────
  send({ t: "capture.list", repoDir: wt });
  const list = await waitFor("capture.list", () => lists.find((l) => l.repoDir === wt));
  const ids = list.targets.map((t) => t.id);
  if (ids.includes("t_bad")) fail("a target whose working dir climbs out of the repo must not be offered at all: " + JSON.stringify(ids));
  if (ids.length !== 2 || !ids.includes("t_shot") || !ids.includes("t_web")) fail("wrong target list: " + JSON.stringify(ids));
  const backendOf = (id) => (list.backends || []).find((b) => b.id === id);
  for (const id of ["web", "android", "garmin", "window"]) {
    const b = backendOf(id);
    if (!b) fail(`capture.list must carry every backend's availability; ${id} is missing: ` + JSON.stringify(list.backends));
    if (b.available !== true && b.available !== false) fail(`${id}: availability must be decided: ` + JSON.stringify(b));
    // A phone renders this as TEXT. A bare `false` would leave it with a button
    // it cannot explain, which is the failure `Unavailable.tsx` exists to stop.
    if (!b.available) checkSentence(b.reason, `backend ${id} unavailable`);
  }
  const garmin = backendOf("garmin");
  if (!garmin.available) fail("the ciqkit stub did not satisfy the garmin probe: " + garmin.reason);
  const web = backendOf("web");
  if (!web.available) checkSentence(web.reason, "the web backend", /playwright/i);
  console.log(`PASS: capture.list offered 2 targets (the traversal one dropped) and said what each backend can do — web: ${web.available ? "available" : "unavailable, in words"}`);

  // ── 2. a run, its two artifacts, and its claim ────────────────────────────
  const ack = await startRun("t_shot");
  if (!ack.ok) fail("capture.run refused: " + ack.reason);
  if (typeof ack.runId !== "string" || !ack.runId.startsWith("cr_")) fail("the ack must name the run it wrote down: " + JSON.stringify(ack));
  const runId = ack.runId;
  if (!runFrames.some((r) => r.runId === runId)) {
    // Not fatal by itself — the first frame may not have landed yet — but the
    // terminal wait below is only meaningful because these arrive unasked.
    await waitFor("the first capture.run frame on the open socket", () => runFrames.some((r) => r.runId === runId));
  }
  const done = await settled(runId);
  if (done.status !== "done") fail("the capture did not succeed: " + JSON.stringify(done));
  if (done.exitCode !== 0) fail("a done capture must carry exit 0: " + JSON.stringify(done));
  if (done.targetId !== "t_shot" || done.backend !== "garmin") fail("the row must say what it captured: " + JSON.stringify(done));
  if (done.name !== "watch face - home") fail("the row is titled by the target's NAME: " + JSON.stringify(done.name));
  const level = checkVerdict(done.verdict, "run row")[0];
  if (level !== "verified:anchor") fail(`an anchor the oracle confirmed on a settled screen is the one case entitled to "verified:anchor": ${done.verdict}`);
  if (done.verification !== "anchor") fail("the row's verification must agree with its verdict: " + JSON.stringify(done));

  const files = done.files || [];
  const png = files.find((f) => f.relPath.endsWith(".png"));
  const doc = files.find((f) => f.relPath.endsWith(".json"));
  if (!png || !doc) fail("a capture produces a frame AND its sidecar: " + JSON.stringify(files));
  for (const f of [png, doc]) {
    if (!f.relPath.startsWith(".claude/outbox/capture-t_shot-")) {
      fail(`artifacts go to .claude/outbox/ under the target's id so the gallery, the badge and the download button need no new plumbing: ${f.relPath}`);
    }
  }
  if (done.sidecarRelPath !== doc.relPath) fail(`the row must point at .claude/outbox/ sidecar it wrote: ${done.sidecarRelPath} vs ${doc.relPath}`);

  const pngRes = await artifact(png.relPath);
  if (!pngRes.ok) fail(`${png.relPath} is not served by the artifact route (${pngRes.status})`);
  const pngBuf = Buffer.from(await pngRes.arrayBuffer());
  if (pngBuf.readUInt32BE(0) !== 0x89504e47) fail(`${png.relPath} came back without a PNG signature (${pngBuf.length} B)`);
  const docRes = await artifact(doc.relPath);
  if (!docRes.ok) fail(`${doc.relPath} is not served by the artifact route (${docRes.status})`);
  const side = JSON.parse(Buffer.from(await docRes.arrayBuffer()).toString("utf8"));

  if (side.v !== 1) fail("sidecar version: " + JSON.stringify(side.v));
  if (side.runId !== runId) fail(`the sidecar's runId IS the intent id: ${side.runId} vs ${runId}`);
  if (side.target?.id !== "t_shot" || side.target?.backend !== "garmin") fail("sidecar target: " + JSON.stringify(side.target));
  if (side.verification !== "anchor") fail("sidecar verification: " + JSON.stringify(side.verification));
  if (side.verdict !== done.verdict) fail(`the row and the sidecar must not word one run two ways:\n  row: ${done.verdict}\n  doc: ${side.verdict}`);
  if (!side.anchor || side.anchor.found?.[0] !== "TOTAL" || (side.anchor.missing || []).length !== 0) {
    fail("a confirmed anchor must be recorded as found: " + JSON.stringify(side.anchor));
  }
  // (8) `score` ABSENT is absent — the stub's scorer answered an empty list.
  if ("score" in side) fail(`no scorer ran, so the sidecar must OMIT score rather than write one: ${JSON.stringify(side.score)}`);
  if (checkVerdict(side.verdict, "sidecar")[1] !== "score n/a") fail("an unscored capture prints `score n/a`: " + side.verdict);
  if (!side.viewport || side.viewport.w !== 16 || side.viewport.h !== 16) fail("geometry is read off the PNG's own header: " + JSON.stringify(side.viewport));
  if (!(side.frames?.sampled >= 2)) fail("a settled run sampled at least twice: " + JSON.stringify(side.frames));
  if (typeof side.frames?.stableAfterMs !== "number") fail("a settled run says WHEN it settled: " + JSON.stringify(side.frames));
  if (side.files?.[0]?.relPath !== png.relPath) fail("the sidecar names the frame by its full transport path: " + JSON.stringify(side.files));
  const tail = output.get(runId) || "";
  if (!tail.includes(done.verdict)) fail("the run's output never printed its verdict:\n" + tail);
  if (!tail.includes(png.relPath) || !tail.includes(doc.relPath)) fail("the output names both files by their full path:\n" + tail);
  console.log(`PASS: ${png.relPath} + ${doc.relPath} landed, both served, verdict "${done.verdict}"`);

  // ── 2b. the same run, asked for by an AGENT with no socket ───────────────
  //
  // `POST /api/repos/:id/capture/run` with `{"wait":true}` is the token-free
  // trigger: the answer is the ~50-token verdict and the sidecar's path, so an
  // agent never has to be handed the PNG to know what is on the screen.
  const httpRes = await fetch(api(`/api/repos/${rid}/capture/run`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "t_shot", wait: true }),
  });
  const httpRun = await httpRes.json();
  if (httpRun.ok !== true || httpRun.status !== "done") fail("the HTTP trigger did not complete: " + JSON.stringify(httpRun));
  checkVerdict(httpRun.verdict, "the HTTP answer");
  if (!httpRun.sidecarRelPath?.startsWith(".claude/outbox/")) fail("the answer must name the sidecar by its full transport path: " + JSON.stringify(httpRun.sidecarRelPath));
  if (!(httpRun.files || []).some((f) => f.endsWith(".png"))) fail("the answer must name the frame it took: " + JSON.stringify(httpRun.files));
  console.log(`PASS: POST /api/repos/:id/capture/run {"wait":true} answered "${httpRun.verdict}" and ${httpRun.sidecarRelPath} — no socket, no image`);

  // ── 2c. a score that WAS measured reaches the sidecar and the line ────────
  //
  // The mirror of (8), and the leg that pins WHICH PATH `capture/garmin.ts`
  // hands to `shot-score`. It has to be somewhere the frame really is — the
  // kept frame itself. Ask about a per-sample scratch directory the run has
  // already emptied or deleted (which is what this once did, scoring `--out-dir`
  // after renaming the frame out of it) and a real ciqkit finds nothing, so
  // `score` is absent on every run for ever — while (8) goes on passing, because
  // "nobody measured" is exactly what that looks like. The stub answers only
  // about frames that are actually at the path it is given, so the number below
  // can only arrive if the frame was there when it was asked.
  writeFileSync(SCORE_FLAG, "91");
  const ackS = await startRun("t_shot");
  if (!ackS.ok) fail("the scored run was refused: " + ackS.reason);
  const runS = await settled(ackS.runId);
  rmSync(SCORE_FLAG, { force: true });
  if (runS.status !== "done") fail("the scored run did not succeed: " + JSON.stringify(runS));
  if (checkVerdict(runS.verdict, "scored run row")[1] !== "score 91") {
    fail(`a measured score must reach the verdict line — \`shot-score\` has to be asked about a path the frame is really at, never a scratch dir the run has already emptied: ${runS.verdict}`);
  }
  const docS = (runS.files || []).find((f) => f.relPath.endsWith(".json"));
  if (!docS) fail("the scored run wrote no sidecar: " + JSON.stringify(runS.files));
  const sideS = JSON.parse(await (await artifact(docS.relPath)).text());
  if (sideS.score !== 91) fail(`the sidecar must record the score that was measured: ${JSON.stringify(sideS.score)}`);
  console.log(`PASS: a measured score survived to both ${docS.relPath} and the verdict — "${runS.verdict}"`);

  // ── 3. cancelling a run that is no longer live SAYS so ────────────────────
  send({ t: "capture.cancel", runId });
  await waitFor("a toast about the finished run", () => toasts.some((t) => /already finished/i.test(t)));
  console.log("PASS: capture.cancel on a settled run answers in words instead of silently");

  // ── 4. exit 3 — the downgrade, with the evidence kept ─────────────────────
  writeFileSync(EXIT3_FLAG, "on");
  const ack3 = await startRun("t_shot");
  if (!ack3.ok) fail("the exit-3 run was refused: " + ack3.reason);
  const run3 = await settled(ack3.runId);
  rmSync(EXIT3_FLAG, { force: true });
  if (run3.status !== "done") fail(`ciqkit exit 3 is a DOWNGRADE, not a failure — the run must still settle done: ${JSON.stringify(run3)}`);
  const level3 = checkVerdict(run3.verdict, "exit-3 run row")[0];
  if (level3 !== "settled:stable") fail(`a contradicted anchor may not claim "verified": ${run3.verdict}`);
  if (run3.verification !== "stable") fail("exit-3 verification: " + JSON.stringify(run3.verification));
  const doc3 = (run3.files || []).find((f) => f.relPath.endsWith(".json"));
  const png3 = (run3.files || []).find((f) => f.relPath.endsWith(".png"));
  if (!png3) fail("exit 3 still captured a frame — deleting it leaves nobody able to see the wrong screen: " + JSON.stringify(run3.files));
  const kept = await artifact(png3.relPath);
  if (!kept.ok) fail(`the contradicted frame must stay readable as evidence: ${png3.relPath} (${kept.status})`);
  const side3 = JSON.parse(await (await artifact(doc3.relPath)).text());
  if (!side3.anchor || (side3.anchor.missing || [])[0] !== "TOTAL") fail("the anchor that was NOT on the frame must be recorded: " + JSON.stringify(side3.anchor));
  if ((side3.anchor.found || []).length !== 0) fail("nothing was found; it must not say otherwise: " + JSON.stringify(side3.anchor));
  console.log(`PASS: ciqkit exit 3 kept ${png3.relPath}, recorded the missing anchor and dropped to "${level3}"`);

  // ── 5. a backend this desktop cannot drive fails IN WORDS ─────────────────
  const ackW = await startRun("t_web");
  if (!ackW.ok) {
    // Refused before the row was written — acceptable only if the refusal says
    // why. (It does not happen today: `validate` passes, the probe is what
    // fails, and that is inside the executor.)
    checkSentence(ackW.reason, "the web refusal", web.available ? undefined : /playwright/i);
  } else {
    const runW = await settled(ackW.runId);
    if (runW.status === "done") fail("a capture that never happened must never settle done: " + JSON.stringify(runW));
    if (runW.status !== "failed") fail("the web run must settle failed: " + JSON.stringify(runW));
    checkSentence(runW.verdict, "the web run's verdict", web.available ? undefined : /playwright/i);
    if (!(output.get(runW.runId) || "").includes(runW.verdict.slice(0, 40))) fail("the reason must also reach the run's output:\n" + output.get(runW.runId));
    if ((runW.files || []).length) fail("nothing was captured, so nothing may be offered: " + JSON.stringify(runW.files));
  }
  console.log("PASS: the web target failed with a sentence naming what is missing, never silently and never done");

  // ── 6. the traversal-shaped dir is refused ────────────────────────────────
  const before = runFrames.length;
  const ackBad = await startRun("t_bad");
  if (ackBad.ok) fail("a target whose working dir is outside the repo must be refused: " + JSON.stringify(ackBad));
  checkSentence(ackBad.reason, "the traversal refusal", /outside this repo|outside the repo/i);
  await waitFor("a toast about the refused target", () => toasts.some((t) => /^capture: /.test(t) && /outside/i.test(t)));
  await new Promise((r) => setTimeout(r, 300));
  if (runFrames.slice(before).some((r) => r.targetId === "t_bad")) fail("the refused target must not produce a run row at all");
  console.log("PASS: a traversal-shaped `dir` is refused in words and never becomes a run");

  // ── 7. cancelling a LIVE run ends it ──────────────────────────────────────
  const ackWatch = await startRun("t_shot", true);
  if (!ackWatch.ok) fail("the watch run was refused: " + ackWatch.reason);
  await waitFor("the watch loop to start", () => /watching/.test(output.get(ackWatch.runId) || ""));
  send({ t: "capture.cancel", runId: ackWatch.runId });
  const stopped = await settled(ackWatch.runId);
  if (stopped.status !== "cancelled") fail("a cancelled capture settles cancelled: " + JSON.stringify(stopped));
  if (toasts.filter((t) => /already finished/i.test(t)).length !== 1) {
    fail("cancelling a LIVE run must not claim it had already finished: " + JSON.stringify(toasts));
  }
  console.log("PASS: capture.cancel ended a live watch run (status cancelled)");

  console.log("PASS: capture — lifecycle on the one socket, frame + sidecar in .claude/outbox/, verdict grammar, cancel both ways, an unavailable backend in words, a refused traversal, exit 3 downgraded with its evidence kept, a measured score carried through and an absent score left absent");
  host.kill();
  process.exit(0);
});

setTimeout(() => fail("timeout — the capture suite did not finish"), 90_000);
