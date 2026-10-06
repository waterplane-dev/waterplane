/**
 * **What a running assessment is seen doing.**
 *
 * The run is a twenty-minute headless `claude -p`, and until this existed the
 * phone said one sentence for all twenty minutes of it — indistinguishable from
 * a run that died in its first second. The fix reads the CLI's own
 * `--output-format stream-json` events as they arrive.
 *
 * Every rule pinned here is one where the wrong behaviour is invisible:
 *
 *  1. **A line that will not parse contributes NOTHING, identically.** The
 *     retained stdout of a watched run is a tail, so its first line is torn by
 *     construction; and the caller's "has anything happened?" is an object
 *     comparison, so an unusable line must return the very object it was given.
 *  2. **An unknown tool stays drawable.** A later CLI gaining a tool must make
 *     the list less specific, never undrawable — unknown is `tool` and keeps its
 *     own name.
 *  3. **The tail is a TAIL and the count is not.** A list showing the last
 *     twenty of two hundred steps must not read as a run that did twenty things.
 *  4. **The envelope survives the format change.** `stream-json` prints one
 *     object per line; the completion signal and the error channel are the same
 *     envelope, now at the END. Read as a whole-document parse it is simply
 *     gone, and every failed run would report "the assessment wrote no file"
 *     with nothing to debug from.
 *
 * Nothing here decides anything: progress is a reading, the FILE is still the
 * answer, and `assess.test.mjs`-style verdict rules live in `shared/assess.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSESS_TAIL_MAX, assessProgressInit, foldAssessEvent, resultText } from "../dist/assess.js";
import { ASSESS_OUT_FILE, ASSESS_PLAN_FILE, BRAND } from "@waterplane/shared";

const CWD = "/Users/x/dev/repo";
const NOW = 1_700_000_000_000;

const assistant = (...content) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content } });
const use = (name, input) => ({ type: "tool_use", name, input });
const say = (text) => ({ type: "text", text });

test("a tool call becomes one step, named and shaped", () => {
  const p = foldAssessEvent(assessProgressInit(NOW), assistant(use("Read", { file_path: `${CWD}/packages/host/src/assess.ts` })), CWD, NOW);
  assert.equal(p.steps, 1);
  assert.equal(p.tools, 1);
  assert.deepEqual(p.tail, [{ at: NOW, kind: "read", label: "Read", detail: "packages/host/src/assess.ts" }]);
});

test("a path inside the worktree is said the way the repo says it", () => {
  const p = foldAssessEvent(assessProgressInit(NOW), assistant(use("Read", { file_path: "/etc/hosts" })), CWD, NOW);
  assert.equal(p.tail[0].detail, "/etc/hosts", "a path outside the repo is left exactly as written");
});

test("each tool says what it was about, out of its own arguments", () => {
  const one = (name, input) => foldAssessEvent(assessProgressInit(NOW), assistant(use(name, input)), CWD, NOW).tail[0];
  assert.deepEqual(one("Grep", { pattern: "runAssessment", path: `${CWD}/packages/host` }), { at: NOW, kind: "search", label: "Grep", detail: "runAssessment in packages/host" });
  assert.equal(one("Bash", { command: "git log -20", description: "read recent history" }).detail, "read recent history");
  assert.equal(one("Bash", { command: "git log -20" }).detail, "git log -20", "no description ⇒ the command itself");
  assert.equal(one("WebFetch", { url: "https://example.com/x" }).detail, "https://example.com/x");
  assert.equal(one("Task", { subagent_type: "Explore", description: "find the callers" }).detail, "find the callers");
});

test("an unknown tool keeps its name and is still drawable", () => {
  const step = foldAssessEvent(assessProgressInit(NOW), assistant(use("SomeLaterTool", { thing: "a value" })), CWD, NOW).tail[0];
  assert.equal(step.kind, "tool");
  assert.equal(step.label, "SomeLaterTool");
  assert.equal(step.detail, "a value", "the first string argument is what it named far more often than not");
});

test("a tool that named nothing usable carries no detail — never a guess", () => {
  const step = foldAssessEvent(assessProgressInit(NOW), assistant(use("TodoWrite", { todos: [{ content: "x" }] })), CWD, NOW).tail[0];
  assert.equal(step.label, "TodoWrite");
  assert.equal(step.detail, undefined);
});

test("the run's own words are a step AND the last thing it said", () => {
  const p = foldAssessEvent(assessProgressInit(NOW), assistant(say("Reading the git history first.")), CWD, NOW);
  assert.equal(p.say, "Reading the git history first.");
  assert.equal(p.tail[0].kind, "say");
  assert.equal(p.tools, 0, "words are a step, not a tool call");
  assert.equal(p.steps, 1);
});

test("the two files the contract asks for are noticed as they are written", () => {
  let p = assessProgressInit(NOW);
  p = foldAssessEvent(p, assistant(use("Write", { file_path: `${CWD}/${ASSESS_PLAN_FILE}`, content: "# plan" })), CWD, NOW);
  assert.equal(p.wrotePlan, true);
  assert.equal(p.wroteOut, undefined, "the answer file is a different fact from the human document");
  p = foldAssessEvent(p, assistant(use("Write", { file_path: `${CWD}/${ASSESS_OUT_FILE}`, content: "{}" })), CWD, NOW);
  assert.equal(p.wroteOut, true);
});

test("an unusable line returns the very reading it was given", () => {
  const p0 = assessProgressInit(NOW);
  for (const line of ["", "   ", "not json at all", '{"type":"assistant"', '{"type":"user","message":{"content":[{"type":"tool_result","content":"…"}]}}', '{"type":"rate_limit_event"}']) {
    assert.equal(foldAssessEvent(p0, line, CWD, NOW), p0, `"${line.slice(0, 24)}" must change nothing at all`);
  }
});

test("the tail is a tail and the count keeps counting", () => {
  let p = assessProgressInit(NOW);
  for (let k = 0; k < ASSESS_TAIL_MAX + 12; k++) {
    p = foldAssessEvent(p, assistant(use("Read", { file_path: `${CWD}/f${k}.ts` })), CWD, NOW + k);
  }
  assert.equal(p.tail.length, ASSESS_TAIL_MAX);
  assert.equal(p.steps, ASSESS_TAIL_MAX + 12);
  assert.equal(p.tail[p.tail.length - 1].detail, `f${ASSESS_TAIL_MAX + 11}.ts`, "the END is what is kept");
});

test("the model is read off the run's own first event", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5", cwd: CWD });
  assert.equal(foldAssessEvent(assessProgressInit(NOW), init, CWD, NOW).model, "claude-opus-5");
});

test("the envelope is still found when it is the last line of a stream", () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    assistant(use("Read", { file_path: `${CWD}/a.ts` })),
    JSON.stringify({ type: "result", result: `wrote ${ASSESS_OUT_FILE}`, is_error: false }),
    "",
  ].join("\n");
  assert.deepEqual(resultText(stream), { text: `wrote ${ASSESS_OUT_FILE}`, found: true });
});

test("a torn first line does not hide the envelope behind it", () => {
  const torn = 'e":"tool_result","content":"…"}]}}\n' + JSON.stringify({ type: "result", result: "done" });
  assert.deepEqual(resultText(torn), { text: "done", found: true });
});

test("a stdout with no envelope in it is returned as itself, and says so", () => {
  assert.deepEqual(resultText("Error: command not found\n"), { text: "Error: command not found\n", found: false });
});

test("the single-object envelope still reads — the unwatched run prints one", () => {
  assert.deepEqual(resultText(JSON.stringify({ result: "ok", is_error: false })), { text: "ok", found: true });
});

/**
 * ── The throttle's TRAILING EDGE ────────────────────────────────────────────
 *
 * The rest of this file is pure. These two drive a real child process through
 * `WATERPLANE_CLAUDE_BIN`, because the rule they pin is about the clock and cannot be
 * folded: a reading is pushed at most every `ASSESS_PROGRESS_MS`, and a step
 * folded INSIDE that window must still arrive when the window closes rather
 * than waiting for the next chunk to carry it out.
 *
 * Without a trailing edge the step most worth watching is exactly the one that
 * is withheld: at t=0.4 s the run folds `Bash npm test`, the command runs for
 * four minutes printing nothing, and the phone shows the step BEFORE it as what
 * the run is doing while `assessWatch` counts the quiet age from that older
 * step's `at`. Both halves of the reading are then false about the run, and
 * nothing about the screen says so.
 *
 * The module reads its window from the environment at import, so these import a
 * fresh copy of it (a distinct specifier is a distinct module) with a short one
 * set — the fold is the same fold either way.
 */
const PROGRESS_MS = 250;

/**
 * Mark `repo` trusted in a scratch CLI config, the way the CLI would after a
 * person answered its trust question. `runToolTask` refuses a folder Claude Code
 * does not trust (`sidecar.ts`'s `workspaceTrust`), and a temp dir never is.
 */
async function trustRepo(repo) {
  const { mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "assessrun-config-"));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ projects: { [realpathSync(repo)]: { hasTrustDialogAccepted: true } } }));
  process.env.CLAUDE_CONFIG_DIR = dir;
}

async function freshAssess() {
  process.env.WATERPLANE_ASSESS_PROGRESS_MS = String(PROGRESS_MS);
  return import("../dist/assess.js?throttle=1");
}

test("a step folded inside the window arrives when the window closes, not with the next chunk", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const repo = mkdtempSync(join(tmpdir(), "assessrun-"));
  mkdirSync(join(repo, BRAND.stateDirName), { recursive: true });
  // init, then a tool call 0.1 s later (inside the window), then a minute's
  // worth of silence in miniature, then the envelope and the answer file.
  const bin = join(repo, "claude-stub.sh");
  writeFileSync(bin, [
    "#!/bin/sh",
    "cat >/dev/null",
    `printf '{"type":"system","subtype":"init","model":"claude-opus-5"}\\n'`,
    "sleep 0.1",
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"description":"run the tests"}}]}}\\n'`,
    "sleep 1.2",
    `printf '{"rows":[]}' > ${ASSESS_OUT_FILE}`,
    `printf '{"type":"result","result":"done"}\\n'`,
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.WATERPLANE_CLAUDE_BIN = bin;
  await trustRepo(repo);

  const { runAssessment } = await freshAssess();
  const seen = [];
  await runAssessment(repo, [], [], Date.now(), undefined, (p) => seen.push({ at: Date.now(), p }));
  const ended = Date.now();

  assert.ok(seen.length >= 2, `both readings were pushed, got ${seen.length}`);
  assert.equal(seen[0].p.steps, 0, "the model-only reading is pushed — it has no step and is worth having");
  assert.equal(seen[0].p.model, "claude-opus-5", "which model is about to spend twenty minutes");

  const withStep = seen.find((s) => s.p.steps > 0);
  assert.ok(withStep, "the tool call became a reading");
  assert.equal(withStep.p.tail.at(-1).label, "Bash");
  assert.ok(
    ended - withStep.at > 800,
    `the step arrived while the run was still quiet, not at the end of it (${ended - withStep.at} ms before the run finished)`,
  );
  assert.ok(withStep.at - seen[0].at >= PROGRESS_MS - 50, "and not before the window it was throttled into closed");
});

test("a settled run pushes nothing more, and leaves no timer behind", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const repo = mkdtempSync(join(tmpdir(), "assessrun2-"));
  mkdirSync(join(repo, BRAND.stateDirName), { recursive: true });
  // Two events back to back: the second is inside the window, so it is still
  // armed when the run ends. A timer that outlived it would push a reading of
  // a run the executor has already settled — and this daemon runs for weeks.
  const bin = join(repo, "claude-stub.sh");
  writeFileSync(bin, [
    "#!/bin/sh",
    "cat >/dev/null",
    `printf '{"type":"system","subtype":"init","model":"claude-opus-5"}\\n'`,
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}\\n'`,
    `printf '{"rows":[]}' > ${ASSESS_OUT_FILE}`,
    `printf '{"type":"result","result":"done"}\\n'`,
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.WATERPLANE_CLAUDE_BIN = bin;
  await trustRepo(repo);

  const { runAssessment } = await freshAssess();
  let after = 0;
  let settled = false;
  await runAssessment(repo, [], [], Date.now(), undefined, () => { if (settled) after++; });
  settled = true;
  await new Promise((done) => setTimeout(done, PROGRESS_MS * 3));
  assert.equal(after, 0, "nothing was pushed after the run answered");
});
