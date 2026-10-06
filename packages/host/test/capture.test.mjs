/**
 * What a capture is allowed to CLAIM — fixture in, verdict out.
 *
 * Everything here is a rule that cannot fail loudly. A capture with the wrong
 * verification level does not crash and does not look broken: it produces a
 * perfectly good screenshot with the word "verified" on it that nothing
 * verified. A `score` of 0 where no scorer exists reads as "this screenshot is
 * terrible" rather than "nobody looked". A `changedPct: 0` where no pixel tool
 * exists reads as "the screen did not change" about a screen nobody examined.
 * None of those three would be caught by a running e2e, which can only see that
 * a PNG appeared — so they are pinned here, against `host/dist`, with no
 * daemon, no browser and no simulator.
 *
 * The three ceilings, stated once so they are not re-argued in each test:
 *   • `verified:*` is the ANCHOR level and nothing else.
 *   • a backend whose `oracle()` returns null can never reach it, whatever its
 *     target's anchors say (that is `capture/window.ts`, permanently).
 *   • one frame is `unverified` on every backend — there was nothing to compare
 *     it against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This layer's whole contract is "no daemon" — so it must not START one either.
// `probeCaptureBackends()` shells `adb devices`, which SPAWNS the adb server on
// whatever machine runs the suite (a real side effect from the layer that is
// supposed to have none), and `ciqkit sim --help`, which can sit for its whole
// 30 s timeout on a machine where ciqkit is installed but wedged. Both binaries
// are resolved from env AT MODULE LOAD, so these two lines must stay above the
// import: they put the probe on its "did not run" branch, which is the branch
// the availability assertion at the bottom of this file is actually about.
process.env.WATERPLANE_ADB_BIN = join(tmpdir(), "waterplane-test-no-such-adb");
process.env.WATERPLANE_CIQKIT_BIN = join(tmpdir(), "waterplane-test-no-such-ciqkit");

const {
  verificationLevel, verdictLine, shouldEmit, classifyOverlay, cleanTarget,
  diffRecord, probeCaptureBackends, intentToCaptureRun, CaptureManager,
} = await import("../dist/capture.js");

/** U+00B7 with spaces. The phone treats the verdict as an opaque string and
 *  never splits it, so this separator lives in exactly one place — here it is
 *  spelled out so a silent change to a hyphen fails a test rather than a read. */
const SEP = " · ";

// ── verificationLevel: the ladder and its ceilings ──────────────────────────

test("an oracle that found every anchor on a settled screen is the only `anchor`", () => {
  assert.equal(
    verificationLevel({ sampled: 3, settled: true, oracle: true, wanted: 1, missing: 0 }),
    "anchor",
  );
});

test("a backend with no oracle can NEVER answer anchor, however many anchors it wants", () => {
  // `capture/window.ts` is permanently in this state: a screen grab of somebody
  // else's window has nothing to query. Its ceiling is `stable`.
  assert.equal(
    verificationLevel({ sampled: 4, settled: true, oracle: false, wanted: 2, missing: 0 }),
    "stable",
  );
});

test("one frame is unverified on every backend, even with the anchor confirmed", () => {
  assert.equal(
    verificationLevel({ sampled: 1, settled: false, oracle: true, wanted: 1, missing: 0 }),
    "unverified",
  );
  // And a `settled: true` that only ever saw one frame is not settled either —
  // there was no second frame for it to have agreed with.
  assert.equal(
    verificationLevel({ sampled: 1, settled: true, oracle: true, wanted: 1, missing: 0 }),
    "unverified",
  );
});

test("a missing anchor downgrades to stable, it does not fail the level", () => {
  assert.equal(
    verificationLevel({ sampled: 2, settled: true, oracle: true, wanted: 2, missing: 1 }),
    "stable",
  );
});

test("anchors nobody asked for do not promote a settled frame", () => {
  assert.equal(
    verificationLevel({ sampled: 2, settled: true, oracle: true, wanted: 0, missing: 0 }),
    "stable",
  );
});

// ── verdictLine: the grammar, including every n/a arm ───────────────────────

test("the full verdict line, with every field measured", () => {
  const line = verdictLine({
    verification: "anchor",
    score: 91,
    viewport: { w: 390, h: 844 },
    theme: "dark",
    console: { errors: 0, warnings: 2, lines: [] },
    network: { failed: 0, lines: [] },
  });
  assert.equal(line, ["verified:anchor", "score 91", "390x844 dark", "console: clean", "net: clean"].join(SEP));
  // Warnings do not make a console dirty — only errors do.
  assert.ok(line.includes("console: clean"));
});

test("counts, not booleans, when the console and the network are not clean", () => {
  assert.equal(
    verdictLine({
      verification: "stable",
      score: 40,
      viewport: { w: 1170, h: 2532 },
      console: { errors: 3, warnings: 0, lines: [] },
      network: { failed: 2, lines: [] },
    }),
    ["settled:stable", "score 40", "1170x2532", "console: 3 err", "net: 2 failed"].join(SEP),
  );
});

test("every unmeasured field prints n/a, and none of them prints a zero", () => {
  const line = verdictLine({ verification: "unverified" });
  assert.equal(line, ["unverified", "score n/a", "n/a", "console: n/a", "net: n/a"].join(SEP));
  assert.ok(!/score 0/.test(line));
  assert.ok(!/0x0/.test(line));
});

test("a frame whose PNG header would not parse has no geometry, and says n/a", () => {
  // The whole-desktop `window` grab: the sidecar's `viewport` is optional for
  // exactly this case, and `0x0` would read as a real answer.
  assert.equal(
    verdictLine({ verification: "stable", viewport: undefined, theme: "dark" }),
    ["settled:stable", "score n/a", "n/a dark", "console: n/a", "net: n/a"].join(SEP),
  );
});

test("an error overlay IS the level — the frame is still evidence", () => {
  assert.equal(
    verdictLine({
      verification: "anchor",
      errorOverlay: { kind: "vite-hmr", text: "Failed to resolve import" },
      viewport: { w: 390, h: 844 },
    }),
    ["error-overlay:vite-hmr", "score n/a", "390x844", "console: n/a", "net: n/a"].join(SEP),
  );
});

test("a blank frame outranks the ladder but not an overlay", () => {
  assert.match(verdictLine({ verification: "stable", blank: true }), /^blank · /);
  assert.match(
    verdictLine({ verification: "stable", blank: true, errorOverlay: { kind: "next-error" } }),
    /^error-overlay:next-error · /,
  );
});

test("the separator is the middle dot, never a hyphen", () => {
  const line = verdictLine({ verification: "stable" });
  assert.equal(line.split(SEP).length, 5);
  assert.ok(!line.includes(" - "));
});

// ── shouldEmit: the watch-mode diff gate and both of its degradations ───────

test("the first frame is always worth a file", () => {
  const d = shouldEmit({ first: true, changedPct: null, diffPct: 2, emitted: 0, maxFrames: 60 });
  assert.equal(d.emit, true);
  assert.equal(d.reason, "first frame");
});

test("the threshold is inclusive, and just under it is not", () => {
  assert.equal(shouldEmit({ first: false, changedPct: 2, diffPct: 2, emitted: 1, maxFrames: 60 }).emit, true);
  assert.equal(shouldEmit({ first: false, changedPct: 1.9, diffPct: 2, emitted: 1, maxFrames: 60 }).emit, false);
});

test("a MEASURED zero is a reason not to emit", () => {
  const d = shouldEmit({ first: false, changedPct: 0, diffPct: 2, emitted: 1, maxFrames: 60 });
  assert.equal(d.emit, false);
  assert.match(d.reason, /changed 0%/);
});

test("no pixel tool degrades to emit-every-frame-and-say-so, never to silence", () => {
  const d = shouldEmit({ first: false, changedPct: null, diffPct: 2, emitted: 5, maxFrames: 60 });
  assert.equal(d.emit, true);
  assert.match(d.reason, /no pixel tool/);
});

test("the cap stops even the unmeasurable case", () => {
  const d = shouldEmit({ first: true, changedPct: null, diffPct: 2, emitted: 60, maxFrames: 60 });
  assert.equal(d.emit, false);
  assert.match(d.reason, /cap/);
});

// ── diffRecord: a measured 0.0 and an unmeasurable difference stay apart ────

test("a measured zero carries changedPct and no reason", () => {
  const d = diffRecord(".claude/outbox/capture-t_home-a.png", 0, "no pixel tool here");
  assert.equal(d.changedPct, 0);
  assert.equal("reason" in d, false);
});

test("an unmeasurable difference carries a reason and NO changedPct", () => {
  const d = diffRecord(".claude/outbox/capture-t_home-a.png", null, "no pixel tool here");
  assert.equal("changedPct" in d, false);
  assert.equal(d.reason, "no pixel tool here");
  // Serialised, the key must be gone — not present as 0, and not present as null.
  assert.equal(JSON.parse(JSON.stringify(d)).changedPct, undefined);
});

// ── classifyOverlay: three dev servers, and the unreadable case ─────────────

test("Vite's HMR overlay is recognised, with its message", () => {
  const html = `<html><body><div id="app"></div>
    <vite-error-overlay></vite-error-overlay>
    <template><pre class="message-body">Failed to resolve import "./nope" from "src/App.tsx"</pre></template>
  </body></html>`;
  const o = classifyOverlay(html);
  assert.equal(o.kind, "vite-hmr");
  assert.match(o.text, /Failed to resolve import/);
});

test("Next's dev overlay is recognised by its portal", () => {
  const html = `<body><nextjs-portal></nextjs-portal>
    <div id="nextjs__container_errors_desc">ReferenceError: x is not defined</div></body>`;
  const o = classifyOverlay(html);
  assert.equal(o.kind, "next-error");
  assert.match(o.text, /ReferenceError/);
});

test("a React error boundary overlay is recognised", () => {
  const html = `<body><iframe id="react-error-overlay"></iframe><pre>TypeError: undefined is not a function</pre></body>`;
  const o = classifyOverlay(html);
  assert.equal(o.kind, "react-boundary");
  assert.match(o.text, /TypeError/);
});

test("recognised-but-unreadable keeps the kind and drops the text", () => {
  // The marker is there; the message is not. Absent text and a clean screen are
  // different facts, and `text` is optional for exactly this.
  const o = classifyOverlay(`<body><vite-error-overlay></vite-error-overlay></body>`);
  assert.equal(o.kind, "vite-hmr");
  assert.equal(o.text, undefined);
});

test("a clean page, and nothing at all, are both null", () => {
  assert.equal(classifyOverlay("<html><body><h1>TOTAL 42</h1></body></html>"), null);
  assert.equal(classifyOverlay(undefined), null);
  assert.equal(classifyOverlay(""), null);
});

// ── cleanTarget: refusals that can speak ────────────────────────────────────

test("an unknown backend is REFUSED, naming every known id", () => {
  const r = cleanTarget({ id: "t_x", name: "droplet", backend: "ios" }, 0);
  assert.equal(r.ok, false);
  for (const id of ["web", "android", "garmin", "window"]) assert.ok(r.reason.includes(id), `names ${id}`);
  assert.ok(r.reason.includes("droplet"), "names the row it is talking about");
});

test("a missing backend is refused too — never coerced to a default", () => {
  // Silently defaulting to `window` would hand back a real-looking picture of
  // the whole desktop and nothing would say so.
  assert.equal(cleanTarget({ id: "t_x", name: "n" }, 0).ok, false);
  assert.equal(cleanTarget(null, 0).ok, false);
  assert.equal(cleanTarget("nope", 0).ok, false);
});

test("a traversal working dir is refused", () => {
  assert.equal(cleanTarget({ id: "t", name: "n", backend: "web", dir: "../../etc" }, 0).ok, false);
  assert.equal(cleanTarget({ id: "t", name: "n", backend: "web", dir: "/etc" }, 0).ok, false);
  // A legitimate subdir of a monorepo survives.
  const ok = cleanTarget({ id: "t", name: "n", backend: "web", dir: "apps/droplet" }, 0);
  assert.equal(ok.ok, true);
  assert.equal(ok.target.dir, "apps/droplet");
});

test("a half-configured target is KEPT — the backend refuses it at run time", () => {
  // Dropping it would delete a target out from under the person typing it.
  const r = cleanTarget({ id: "t_home", name: "home", backend: "web" }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.target.url, undefined);
});

test("a full target round-trips, with anchors de-duplicated and junk viewports dropped", () => {
  const r = cleanTarget({
    id: "t_home", name: "  droplet · home  ", backend: "web", dir: "apps/droplet",
    anchor: ["TOTAL", "TOTAL", "  ", 7, "SUM"],
    settleMs: 8000, diffPct: 5,
    url: "http://localhost:5173/",
    viewports: [{ w: 390, h: 844 }, { w: 0, h: 10 }, { w: "wide" }],
    theme: "both",
  }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.target.name, "droplet · home");
  assert.deepEqual(r.target.anchor, ["TOTAL", "SUM"]);
  assert.deepEqual(r.target.viewports, [{ w: 390, h: 844 }]);
  assert.equal(r.target.theme, "both");
  assert.equal(r.target.settleMs, 8000);
  assert.equal(r.target.diffPct, 5);
});

test("out-of-range numbers go ABSENT rather than being clamped into a lie", () => {
  const r = cleanTarget({ id: "t", name: "n", backend: "window", settleMs: -1, diffPct: 400 }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.target.settleMs, undefined);
  assert.equal(r.target.diffPct, undefined);
});

// ── the store, and the refusals a tap gets back synchronously ──────────────

/**
 * A CaptureManager over a fake intent store — nothing is spawned or spun up.
 *
 * The store keeps the rows it was handed, because `cancel()` reads them: a run
 * that has been POSTED but not yet started lives only there, and answering it
 * out of the live map alone is how a cancel used to be dropped on the floor.
 */
function manager() {
  const posted = [];
  const rows = new Map();
  const canceled = [];
  const intents = {
    list: () => [],
    get: (id) => rows.get(id),
    cancel: (id) => {
      const row = rows.get(id);
      if (!row || row.state !== "queued") return false;
      row.state = "canceled";
      canceled.push(id);
      return true;
    },
    post: (draft) => {
      const row = { ...draft, state: "queued", createdAt: 1 };
      posted.push(draft);
      rows.set(draft.id, row);
      return { ok: true, intent: row };
    },
  };
  return { cap: new CaptureManager(intents), posted, rows, canceled };
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-capture-"));
  mkdirSync(join(dir, ".usmc"), { recursive: true });
  mkdirSync(join(dir, ".claude", "outbox"), { recursive: true });
  return dir;
}

function writeTargets(dir, targets) {
  writeFileSync(join(dir, ".usmc", "capture.json"), JSON.stringify({ version: 1, targets }, null, 2));
}

test("save and list round-trip through .usmc/capture.json, dropping what cleanTarget refuses", () => {
  const dir = repo();
  const { cap } = manager();
  const kept = cap.save(dir, [
    { id: "t_ok", name: "ok", backend: "window" },
    { id: "t_bad", name: "bad", backend: "ios" },
  ]);
  assert.equal(kept.length, 1);
  assert.deepEqual(cap.list(dir).map((t) => t.id), ["t_ok"]);
  const onDisk = JSON.parse(readFileSync(join(dir, ".usmc", "capture.json"), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.targets.length, 1);
});

test("a repo with no capture.json has no targets and no crash", () => {
  const { cap } = manager();
  assert.deepEqual(cap.list(repo()), []);
});

test("running an unknown target is refused in words, not queued", () => {
  const dir = repo();
  const { cap, posted } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "window" }]);
  const r = cap.run(dir, "t_missing");
  assert.ok(r.error, "answers a sentence");
  assert.match(r.error, /t_missing/);
  assert.equal(posted.length, 0);
});

test("running a target whose backend is unknown names the known ids, at run time", () => {
  const dir = repo();
  const { cap, posted } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "ios" }]);
  const r = cap.run(dir, "t_a");
  for (const id of ["web", "android", "garmin", "window"]) assert.ok(r.error.includes(id), `names ${id}`);
  assert.equal(posted.length, 0);
});

test("a traversal-shaped working dir never reaches an executor", () => {
  const dir = repo();
  const { cap, posted } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "window", dir: "../../etc" }]);
  assert.ok(cap.run(dir, "t_a").error);
  assert.equal(posted.length, 0);
});

test("a half-configured target is refused by its backend, in words, before anything spawns", () => {
  const dir = repo();
  const { cap, posted } = manager();
  writeTargets(dir, [
    { id: "t_web", name: "web", backend: "web" },                 // no url
    { id: "t_garmin", name: "garmin", backend: "garmin" },        // no screen
    { id: "t_far", name: "far", backend: "web", url: "http://example.com/" },
  ]);
  assert.match(cap.run(dir, "t_web").error, /url/);
  assert.match(cap.run(dir, "t_garmin").error, /screen/);
  // Capture never starts a dev server, and never photographs another machine.
  assert.match(cap.run(dir, "t_far").error, /local/);
  assert.equal(posted.length, 0);
});

test("a runnable target is posted as a capture intent with a cr_ id", () => {
  const dir = repo();
  const { cap, posted } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "window", windowTitle: "Simulator" }]);
  const run = cap.run(dir, "t_a", true);
  assert.equal(run.error, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0].id, /^cr_[0-9a-f]{8}$/);
  assert.equal(posted[0].payload.kind, "capture");
  assert.equal(posted[0].payload.targetId, "t_a");
  assert.equal(posted[0].payload.backend, "window");
  assert.equal(posted[0].payload.watch, true);
  assert.deepEqual(posted[0].target, { kind: "shell" });
  assert.equal(run.runId, posted[0].id);
});

test("cancelling a run nobody has ever heard of answers a sentence, not a throw", () => {
  const { cap } = manager();
  const why = cap.cancel("cr_deadbeef");
  assert.equal(typeof why, "string", "a refusal the phone can print, never a bare false");
  assert.match(why, /no capture run/i);
});

test("a run POSTED but not yet started is really called off — never told it had finished", () => {
  // `cancel()` used to consult only the LIVE map, so a run still waiting its
  // turn in the intent store was answered "already finished" and then went
  // ahead and ran. A cancel that lies and a cancel that does nothing are the
  // same failure from the phone, and this is the window they both sat in.
  const dir = repo();
  const { cap, rows, canceled } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "window", windowTitle: "Simulator" }]);
  const run = cap.run(dir, "t_a");
  assert.equal(cap.cancel(run.runId), null, "nothing to say — it was genuinely called off");
  assert.deepEqual(canceled, [run.runId]);
  assert.equal(rows.get(run.runId).state, "canceled");
});

test("a run that really has finished is the only one told so", () => {
  const dir = repo();
  const { cap, rows } = manager();
  writeTargets(dir, [{ id: "t_a", name: "a", backend: "window", windowTitle: "Simulator" }]);
  const run = cap.run(dir, "t_a");
  rows.get(run.runId).state = "done";
  assert.match(cap.cancel(run.runId), /already finished/i);
});

// ── the run row reads its verdict out of the sidecar ────────────────────────

function sidecarRow(dir, sidecar) {
  const rel = ".claude/outbox/capture-t_home-2026-09-13.json";
  writeFileSync(join(dir, rel), JSON.stringify(sidecar, null, 2));
  return {
    id: "cr_11112222", cwd: dir, state: "done", createdAt: 10, startedAt: 11, settledAt: 20,
    payload: { kind: "capture", targetId: "t_home", name: "home", backend: "web" },
    result: {
      detail: "the executor's own sentence",
      exitCode: 0,
      artifacts: [
        { repoId: "r", name: "f.png", relPath: ".claude/outbox/capture-t_home-2026-09-13.png", size: 1, mtime: 1 },
        { repoId: "r", name: "f.json", relPath: rel, size: 1, mtime: 1 },
      ],
    },
  };
}

test("the row's verdict, verification and score come from the sidecar", () => {
  const dir = repo();
  const row = sidecarRow(dir, {
    v: 1, runId: "cr_11112222", target: { id: "t_home", name: "home", backend: "web" },
    startedAt: 11, finishedAt: 20, verification: "anchor", score: 91,
    frames: { sampled: 3, stableAfterMs: 1300 }, files: [], verdict: "verified:anchor" + SEP + "score 91",
  });
  const run = intentToCaptureRun(row);
  assert.equal(run.verification, "anchor");
  assert.equal(run.score, 91);
  assert.match(run.verdict, /^verified:anchor/);
  assert.equal(run.sidecarRelPath, ".claude/outbox/capture-t_home-2026-09-13.json");
  assert.equal(run.status, "done");
  assert.equal(run.backend, "web");
});

test("an unscorable run has NO score — never 0", () => {
  const dir = repo();
  const row = sidecarRow(dir, {
    v: 1, runId: "cr_11112222", target: { id: "t_home", name: "home", backend: "window" },
    startedAt: 11, finishedAt: 20, verification: "stable",
    frames: { sampled: 2, stableAfterMs: 600 }, files: [],
    verdict: ["settled:stable", "score n/a", "n/a", "console: n/a", "net: n/a"].join(SEP),
  });
  const run = intentToCaptureRun(row);
  assert.equal(run.score, undefined);
  assert.ok(!("score" in JSON.parse(JSON.stringify(run))));
  assert.match(run.verdict, /score n\/a/);
});

test("a run whose sidecar cannot be read falls back to the executor's sentence, not to a claim", () => {
  const dir = repo();
  const row = sidecarRow(dir, { v: 1 });          // wrong shape: no verdict in it
  writeFileSync(join(dir, ".claude/outbox/capture-t_home-2026-09-13.json"), "{not json");
  const run = intentToCaptureRun(row);
  assert.equal(run.verification, undefined);
  assert.equal(run.score, undefined);
  assert.equal(run.verdict, "the executor's own sentence");
});

test("a running row has no verdict yet — absent reads as `not yet`, never as unverified", () => {
  const dir = repo();
  const row = { ...sidecarRow(dir, { v: 1, verdict: "x" }), state: "running", result: undefined };
  const run = intentToCaptureRun(row);
  assert.equal(run.status, "running");
  assert.equal(run.verdict, undefined);
  assert.equal(run.verification, undefined);
});

// ── availability is a sentence, for every backend, always ──────────────────

test("every backend answers with an id and, when unavailable, a sentence to act on", async () => {
  const infos = await probeCaptureBackends();
  assert.deepEqual(infos.map((i) => i.id).sort(), ["android", "garmin", "web", "window"]);
  for (const i of infos) {
    assert.equal(typeof i.available, "boolean");
    if (!i.available) {
      assert.equal(typeof i.reason, "string", `${i.id} says why not`);
      assert.ok(i.reason.length > 10, `${i.id}'s reason is a sentence, not a flag`);
    }
  }
  // The two that shell a binary are pinned to a path nothing can execute (top of
  // this file), so their answer is decided rather than ambient — and a missing
  // binary has to name the env knob that moves it, or the sentence is a dead end
  // on the phone, which is the whole reason `reason` exists.
  for (const id of ["android", "garmin"]) {
    const i = infos.find((x) => x.id === id);
    assert.equal(i.available, false, `${id} was pinned at a binary that does not exist`);
    assert.match(i.reason, id === "android" ? /WATERPLANE_ADB_BIN/ : /WATERPLANE_CIQKIT_BIN/);
  }
});
