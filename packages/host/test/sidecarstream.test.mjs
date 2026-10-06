/**
 * **The watched headless run** — `sidecar.ts`'s second way of reading a process.
 *
 * `execFile` buffers the whole of stdout and kills the child the moment that
 * passes `maxBuffer`. That is right for a run whose output is one small
 * envelope, and wrong for the one caller that wants to watch: an assessment
 * asked for `--output-format stream-json` prints every tool result it takes on
 * its way to a twenty-minute answer, so the buffered reader would kill the
 * process for succeeding loudly. Hence `onOut`, which spawns instead and keeps
 * only the tail.
 *
 * Five things here fail silently and are therefore pinned rather than
 * described:
 *
 *  1. **The tail is the END.** The envelope and any usage-limit notice are the
 *     last thing printed; a reader keeping the head would drop exactly the part
 *     every caller's contract reads.
 *  2. **A watched run still reports failure the way the buffered one does.**
 *     `failed` and an `err` that says what happened are what the callers turn
 *     into a row's detail — a run that exits 1 silently would become "the
 *     assessment wrote no file", which blames the model for the machine.
 *  3. **A timeout kills the GROUP and says so.** `claude -p` is a shell away
 *     from every tool it runs, so a signal aimed at the direct child leaves the
 *     grandchild alive holding the pipe: this file used to spend 30.5 s waiting
 *     for a `sleep 30` behind a killed `sh`, and in the daemon an orphaned run
 *     can write `.myapp/assess-out.json` after the NEXT run deleted it — the
 *     stale output file `assess.ts` is built around preventing. Without the
 *     sentence, separately, the row cannot explain itself.
 *  4. **Nothing is handed over after the promise has answered.** The timeout
 *     resolves at the deadline and chases the corpse afterwards, so a run that
 *     has been reported is still printing — and every chunk `assess.ts` is
 *     handed becomes a reading written onto a row it has already settled.
 *  5. **The prompt still goes in on stdin**, which is the whole call.
 *
 * It drives a real child process, through the one env knob that says which
 * binary a claude run is (`WATERPLANE_CLAUDE_BIN`), so it needs neither an account
 * nor a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "waterplane-sidecar-"));

/** A stand-in for the binary: whatever shell we are handed, spelled once. */
function fakeBin(name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function run(bin, over = {}) {
  process.env.WATERPLANE_CLAUDE_BIN = bin;
  const { runHeadlessClaude } = await import("../dist/sidecar.js");
  return runHeadlessClaude({
    cwd: dir, args: [], prompt: "the prompt\n",
    timeoutMs: 5000, maxBuffer: 1024 * 1024,
    ...over,
  });
}

test("a watched run hands over every chunk and still answers with the streams", async () => {
  const bin = fakeBin("stream.sh", 'printf \'{"type":"system"}\\n{"type":"result","result":"ok"}\\n\'');
  const seen = [];
  const r = await run(bin, { onOut: (c) => seen.push(c) });
  assert.equal(r.failed, false);
  assert.equal(r.err, null);
  assert.equal(seen.join("").trim().split("\n").length, 2, "both events reached the watcher");
  assert.match(r.stdout, /"result":"ok"/);
});

test("what is KEPT is the tail — the envelope is at the end of it", async () => {
  // 200 lines of noise, then the envelope: exactly the shape of a repo read.
  const bin = fakeBin("big.sh", 'i=0; while [ $i -lt 200 ]; do printf \'{"type":"user","content":"%s"}\\n\' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; i=$((i+1)); done; printf \'{"type":"result","result":"last"}\\n\'');
  let bytes = 0;
  const r = await run(bin, { onOut: (c) => { bytes += c.length; }, keepBytes: 4096 });
  assert.ok(bytes > 4096, "the watcher saw everything");
  assert.ok(r.stdout.length <= 4096 + 4096, "what was kept is bounded");
  assert.match(r.stdout.trim().split("\n").pop(), /"result":"last"/, "the END is what survives");
});

test("the prompt goes in on stdin, as it always did", async () => {
  const bin = fakeBin("echo.sh", "cat");
  const r = await run(bin, { onOut: () => {} });
  assert.equal(r.stdout, "the prompt\n");
});

test("a non-zero exit is a failure that says what happened", async () => {
  const bin = fakeBin("fail.sh", 'printf "boom\\n" >&2; exit 3');
  const r = await run(bin, { onOut: () => {} });
  assert.equal(r.failed, true);
  assert.match(String(r.err), /3/);
  assert.match(r.stderr, /boom/, "stderr is kept — it is the only thing left to debug from");
});

test("a run past its timeout is killed — the whole GROUP of it — and reported as one", async () => {
  // `sleep 30` behind the shell is the shape that matters: `claude -p` is a
  // shell away from every tool it runs, so a kill aimed at the direct child
  // leaves the grandchild holding the pipe. That is what made this case take
  // 30.5 s of every `npm run test:host`, and in the daemon it is how an
  // orphaned run writes `.myapp/assess-out.json` after the NEXT run deleted it.
  // The shell prints its own pid first, which (the child being a group leader)
  // IS the group — so the kill can be asked about rather than assumed.
  const bin = fakeBin("slow.sh", "echo $$\nsleep 30");
  let seen = "";
  const started = Date.now();
  // The deadline must be long enough for the shell to START and print its pid
  // even when the whole suite is running in parallel: at 300 ms this failed
  // ("the shell told us its pid") whenever the machine was busy, while
  // passing alone — the kill was fine, the witness had not spoken yet.
  const timeoutMs = 1500;
  const r = await run(bin, { onOut: (c) => { seen += c; }, timeoutMs });
  assert.equal(r.failed, true);
  assert.match(String(r.err), /timed out/);
  assert.ok(Date.now() - started < timeoutMs + 700, "the timeout ANSWERS at the deadline — it does not wait for the child");

  const pid = Number(seen.trim());
  assert.ok(pid > 0, "the shell told us its pid");
  /** Nothing of that group is left. ESRCH is the good case. */
  const gone = () => { try { process.kill(-pid, 0); return false; } catch { return true; } };
  const by = Date.now() + 2000;
  while (!gone() && Date.now() < by) await new Promise((r2) => setTimeout(r2, 20));
  assert.ok(gone(), "SIGTERM reached the group, so the sleep behind the shell died with it");
});

test("a corpse still printing is handed to nobody — the answer was final", async () => {
  // A timeout answers at the deadline and chases the process afterwards, so
  // there is always a window in which a run that has already been reported is
  // still writing. `assess.ts` turns every chunk into a `setLive` on its row;
  // one arriving after the executor settled that row puts memory out of step
  // with the disk, and the next `set()` on any run persists the divergence.
  // This shell ignores SIGTERM to make that window wide enough to assert on —
  // the group kill still ends it, with the SIGKILL behind it.
  const bin = fakeBin("stubborn.sh", "trap '' TERM\nsleep 30\nprintf 'late\\n'\nsleep 30");
  let seen = "";
  const r = await run(bin, { onOut: (c) => { seen += c; }, timeoutMs: 200 });
  assert.equal(r.failed, true);
  await new Promise((done) => setTimeout(done, 400));
  assert.ok(!seen.includes("late"), "nothing printed after the answer reached the watcher");
  assert.ok(!r.stdout.includes("late"), "and nothing printed after the answer is in what was KEPT");
});

test("a binary that does not exist is a failure, never a hang", async () => {
  const r = await run(join(dir, "nope-not-here"), { onOut: () => {} });
  assert.equal(r.failed, true);
  assert.ok(r.err);
});

test("a watcher that throws does not take the run down with it", async () => {
  const bin = fakeBin("stream2.sh", 'printf \'{"type":"result","result":"ok"}\\n\'');
  const r = await run(bin, { onOut: () => { throw new Error("the reader is broken"); } });
  assert.equal(r.failed, false);
  assert.match(r.stdout, /"result":"ok"/);
});
