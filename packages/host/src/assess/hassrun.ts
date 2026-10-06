/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssessInput, AssessNote, AssessProgress, AssessProposal, Intent } from "@waterplane/shared";
import { ASSESS_IN_FILE, ASSESS_OUT_FILE, ASSESS_PLAN_FILE, assessCounts, cleanAssessment } from "@waterplane/shared";
import { detectHeadlessLimit, limitNote } from "../limit.js";
import { runToolTask } from "../sidecar.js";
import { assessPrompt, buildAssessInput } from "./hassinput.js";
import { parseLoose, resultText, writeAtomic } from "./hassutil.js";
import { assessProgressMs, assessProgressInit, foldAssessEvent } from "./hassprogress.js";
import { ASSESS_KEEP_BYTES, ASSESS_MAX_BUFFER, ASSESS_TIMEOUT_MS } from "./hassknobs.js";

/** What one run produced. `ok` means a proposal was READ, never that anybody
 *  has approved it. */
export interface AssessRunOutcome {
  ok: boolean;
  /** One line for the row: what came back, or which half of the contract failed. */
  detail: string;
  proposal?: AssessProposal;
  /** The CLI's own words, kept when the FILE was the problem. */
  envelope?: string;
  input: AssessInput;
  /** The human document exists — the artifact worth having in a week. */
  planWritten: boolean;
  /** Which VERSION of that document this run wrote — see `AssessRun.planMtime`.
   *  Absent when there is no plan, or when the stat failed. */
  planMtime?: number;
  /** What the run was seen doing, as of its last event — kept with the settled
   *  run because the stream is gone by the time the proposal is read. */
  progress?: AssessProgress;
}

/**
 * Write the input, run one headless `claude -p` in the repo, read the output
 * file back, and clean it.
 *
 * Deliberately NOT `--continue`: see the header. Deliberately no retry either —
 * a second full read of a repo because the first one wrote malformed JSON is
 * real money spent on a guess, and the failed row says exactly what went wrong
 * so the tap can be repeated by a person who has read it.
 */
export async function runAssessment(
  cwd: string,
  intents: readonly Intent[],
  notes: readonly AssessNote[],
  now: number = Date.now(),
  /** The cut this run was asked about; absent is the whole repo. Comes off the
   *  intent's own payload, so a run reconciled after a restart is scoped to
   *  exactly what the tap asked for and never quietly widens. */
  ids?: readonly string[],
  /** Told, at most every `ASSESS_PROGRESS_MS`, what the run is doing. Absent is
   *  a run nobody is watching, which is exactly the old call. */
  onProgress?: (p: AssessProgress) => void,
): Promise<AssessRunOutcome> {
  const input = buildAssessInput(cwd, intents, notes, now, ids);
  const inPath = join(cwd, ASSESS_IN_FILE);
  const outPath = join(cwd, ASSESS_OUT_FILE);
  const planPath = join(cwd, ASSESS_PLAN_FILE);

  try {
    mkdirSync(dirname(inPath), { recursive: true });
    writeAtomic(inPath, JSON.stringify(input, null, 2));
  } catch (err) {
    return { ok: false, detail: `could not write ${ASSESS_IN_FILE}: ${String(err).slice(0, 160)}`, input, planWritten: false };
  }

  // The previous run's answer is not this run's answer. A run that writes
  // nothing at all must fail, not quietly apply verdicts formed against a repo
  // two days older.
  try { rmSync(outPath, { force: true }); } catch { /* it was not there */ }

  const env = await runClaude(cwd, assessPrompt(input), onProgress);
  const planWritten = existsSync(planPath);
  // Asked in the same breath as "is it there", because both are facts about
  // the moment this run finished and the file is about to be rewritten at the
  // same path by the next one. See `AssessRun.planMtime` for why a run's plan
  // needs a version at all; a stat that throws leaves it ABSENT, never 0 —
  // a 0 is a version that says "unversioned", and every reader keyed on it
  // would file two different documents under one key.
  const planMtime = planWritten ? planFileMtime(planPath) : undefined;
  const progress = env.progress;

  let raw: string;
  try {
    raw = readFileSync(outPath, "utf8");
  } catch {
    return {
      ok: false,
      detail: env.refused ?? env.limitNote ?? `the assessment wrote no ${ASSESS_OUT_FILE}${env.failed ? " and the run did not finish cleanly" : ""}`,
      envelope: env.text || undefined,
      input,
      planWritten,
      planMtime,
      progress,
    };
  }

  const parsed = parseLoose(raw);
  if (parsed === undefined) {
    return {
      ok: false,
      detail: `${ASSESS_OUT_FILE} is not valid JSON — nothing was applied`,
      envelope: (env.text || raw).slice(0, 8000),
      input,
      planWritten,
      planMtime,
      progress,
    };
  }

  // The FILE is the content: a complete, parseable document is the answer even
  // if the process was killed on its way out. The envelope only ever said
  // whether it finished.
  const proposal = cleanAssessment(parsed, input.items);
  return { ok: true, detail: outcomeDetail(proposal, planWritten), proposal, envelope: env.text || undefined, input, planWritten, planMtime, progress };
}

/** The plan document's mtime, in whole milliseconds, or ABSENT. Rounded because
 *  the number travels to a phone and is compared for equality there: a
 *  sub-millisecond fraction is a difference no two readers agree on. */
function planFileMtime(path: string): number | undefined {
  try { return Math.round(statSync(path).mtimeMs); } catch { return undefined; }
}

/** One line for the row, from the proposal's own counts — so the row and the
 *  sheet cannot disagree about what came back. */
function outcomeDetail(p: AssessProposal, planWritten: boolean): string {
  const c = assessCounts(p);
  const parts = [
    `${c.done} already done`,
    `${c.obsolete} no longer apply`,
    `${c.superseded} covered elsewhere`,
    `${c.wanted} still wanted`,
    `${c.unclear} undecided`,
  ];
  if (p.merges.length) parts.push(`${p.merges.length} merge${p.merges.length === 1 ? "" : "s"}`);
  if (p.news.length) parts.push(`${p.news.length} new`);
  return `${p.rows.length} item(s) assessed: ${parts.join(", ")}${planWritten ? `; ${ASSESS_PLAN_FILE} written` : ""}`;
}

/**
 * The headless run. `review.ts`'s shape — prompt on stdin, an envelope out —
 * minus `--continue`, plus permission to write the two files it is being asked
 * for, plus the one thing this run needs that the others do not: it can be
 * WATCHED.
 *
 * `--output-format stream-json --verbose` prints one JSON event per line as the
 * run makes it, and the final event is the same envelope `json` would have
 * printed — so the completion signal and the error channel are unchanged, and
 * `resultText` reads both shapes. The difference is that a run taking twenty
 * minutes is now visible while it takes them, which is all this buys: the FILE
 * is still the content, and nothing on the stream is ever treated as an answer.
 *
 * The stream is also why the run is spawned rather than `execFile`d
 * (`sidecar.ts`'s `onOut`): a stream-json run prints every tool result it takes,
 * and `maxBuffer` would kill the process for succeeding loudly.
 */
async function runClaude(
  cwd: string,
  prompt: string,
  onProgress?: (p: AssessProgress) => void,
): Promise<{ text: string; failed: boolean; limited: boolean; limitNote?: string; refused?: string; progress?: AssessProgress }> {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  let progress = assessProgressInit();
  /** The reading nothing has happened in yet, kept so "did anything arrive?"
   *  is one identity comparison rather than a rule about which field counts. */
  const empty = progress;
  // The reading last handed over, compared by IDENTITY: `foldAssessEvent`
  // returns the very object it was given for a line it cannot use, so a stream
  // of noise pushes nothing and the comparison never has to look inside.
  let sent: AssessProgress | undefined = progress;
  let sentAt = 0;
  let pending = "";
  let flush: ReturnType<typeof setTimeout> | undefined;
  let over = false;

  const unarm = (): void => { if (flush) { clearTimeout(flush); flush = undefined; } };
  const push = (): void => {
    unarm();
    if (over || !onProgress || progress === sent) return;
    sent = progress;
    sentAt = Date.now();
    onProgress(progress);
  };
  const onOut = (chunk: string): void => {
    // Past the answer there is no run left to be a reading OF. `sidecar.ts`
    // already refuses to hand a chunk over after it has resolved; this is the
    // same rule stated on this side of it, because the cost of being wrong is
    // a `setLive` on a row the executor has already settled.
    if (over) return;
    // A chunk boundary falls mid-line; only whole lines are events.
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) progress = foldAssessEvent(progress, line, cwd, Date.now());
    if (progress === sent) return;
    /**
     * The THROTTLE HAS A TRAILING EDGE, and that is the whole point of it.
     *
     * Pushing only when a chunk arrives late enough withholds every step folded
     * inside the window until the NEXT chunk — and the step most worth watching
     * is exactly the one with no next chunk behind it: at t=0.4 s the run folds
     * `Bash npm test`, the command runs for four minutes printing nothing, and
     * the phone shows the PREVIOUS step as what it is doing while
     * `assessWatch`'s quiet-age counts "nothing new for 4m" from that older
     * step's `at`. Both halves of the reading are then false about the run.
     *
     * So a throttled reading arms one timer for the rest of the window instead
     * of being dropped. One, because a second would only push the same object;
     * cleared on every push and on the way out, because this daemon outlives
     * every run and a timer holding a closure over a finished one is a leak
     * with a `setLive` on the end of it.
     *
     * There is no `steps` gate: the `system/init` event carries the MODEL and
     * no step, and a reading that says which model is about to spend twenty
     * minutes is worth arriving before the first tool call rather than never.
     */
    const wait = assessProgressMs() - (Date.now() - sentAt);
    if (wait <= 0) push();
    else if (!flush) { flush = setTimeout(push, wait); flush.unref?.(); }
  };
  // Through `sidecar.ts`, which owns the engine axis for every unattended call.
  // For this task that axis has exactly one position: an assessment reads a
  // repo and writes two files, so a toolless local completion cannot do it and
  // is refused in words rather than run — see `sidecar.ts`'s header.
  //
  // `onOut` unconditionally, not `onProgress ? onOut : undefined`: watching is
  // what the READINGS are for, but streaming is what stops `maxBuffer` killing
  // a run that prints a lot on its way to a good answer — see
  // `ASSESS_MAX_BUFFER`. A run nobody is watching costs one folded object per
  // chunk and pushes nothing.
  const run = await runToolTask("assess", {
    cwd, args, prompt,
    timeoutMs: ASSESS_TIMEOUT_MS,
    maxBuffer: ASSESS_MAX_BUFFER,
    onOut,
    keepBytes: ASSESS_KEEP_BYTES,
  });
  // The process has answered: no later chunk is a reading of it, and no timer
  // may outlive it. Both are said here as well as in `sidecar.ts` because the
  // reading is this file's and a settled row must not move again.
  over = true;
  unarm();
  if (run.refused) return { text: "", failed: true, limited: false, refused: run.refused };
  const res = resultText(run.stdout);
  // A found result is the CLI's own last words and reads from the front; a
  // stream nobody could find a result in is a TAIL, and its useful end is the
  // last thing printed before it stopped.
  const text = res.found
    ? res.text.trim().slice(0, 8000)
    : (res.text || run.stderr || (run.err ? String(run.err) : "")).trim().slice(-8000);
  // A run the account refused wrote no files and judged nothing. Said as
  // "wrote no assess-out.json" it reads as a model that ignored the
  // contract, which is the one conclusion that is certainly wrong.
  //
  // The PARSED result text goes in first, because the detector's own envelope
  // reader (`limit.ts`'s `envelopeResult`) is a whole-document `JSON.parse` of
  // stdout — written for `--output-format json`, and on NDJSON it throws by
  // construction and contributes "". Detection then rests entirely on the raw
  // regex backstop, i.e. on the banner happening to sit inside the result line
  // where the escaping leaves it readable. That is luck, not a contract, and
  // `limit.ts` is the heuristics layer with its own rules — so the fix is to
  // hand the detector the text it was written to read, here. The raw tail
  // follows it so nothing that is detectable today stops being detectable: the
  // notice can also arrive on a line that is not the envelope.
  const limit = detectHeadlessLimit(res.found ? `${res.text}\n${run.stdout}` : run.stdout, run.stderr);
  return {
    text,
    failed: run.failed,
    limited: limit.blocked,
    limitNote: limit.blocked ? limitNote(limit, "assessed") : undefined,
    // Anything that was folded, not just steps: a run that got as far as
    // naming its model and no further published that live, and settling with
    // `undefined` here would take it off the screen the reader is looking at.
    progress: progress === empty ? undefined : progress,
  };
}