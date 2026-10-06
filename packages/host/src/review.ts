/**
 * Check, validate, and what to do next — the verbs on work that has already
 * settled.
 *
 * These were a third of `backlog.ts` and they never belonged there. Everything
 * else in that file was about WHEN a piece of work runs; this is about what
 * happened after it did: was the task implemented, is the user's expected
 * outcome actually achieved, and what are the two or three things worth doing
 * next. That is a different question with a different lifetime — a verdict
 * outlives the run that produced it and says nothing about whether anything is
 * queued — which is why it also lives in a different place on disk.
 *
 * ── The sidecar, and why the verdicts are not on the intent ────────────────
 *
 * `<STATE_DIR>/reviews.json`, keyed by intent id. The intent store is the
 * lifecycle: state, trigger, target, result. A check verdict is none of those,
 * and putting it there would mean every consumer of `Intent` carrying nine
 * fields that only one sheet reads — while the wire DTO (`BacklogItem`) still
 * has to carry them exactly where it always did, because `backlog.*` is
 * unchanged for the client. A sidecar merged in at render time satisfies both,
 * and is dropped with the row it describes.
 *
 * ── The two reviewers ──────────────────────────────────────────────────────
 *
 * Both run a one-shot headless `claude -p --output-format json` — a clean
 * machine envelope, so parsing never fights the TUI — preferring `--continue` in
 * the item's own repo so the reviewer starts with warm context and tools. When
 * there is no resumable transcript, both fall back to an independent review of
 * the git diff in a fresh session. `check` asks "is this implemented?"; the
 * verdict is about the CODEBASE, not this session's diff, because a task can be
 * satisfied by code that already existed. `validate` asks the harder question —
 * "is the expected OUTCOME achieved, and what next?" — and returns tappable
 * next steps.
 *
 * ── Next steps are posted, not driven ──────────────────────────────────────
 *
 * Tapping a next step used to reach into the item and flip it back to `running`,
 * which meant one row describing two different pieces of work. It now posts a
 * NEW intent carrying that step's prompt, aimed at the item's own session (or at
 * a fresh one that resumes the repo's conversation), with `origin` pointing back
 * at the row it came from. Same delivery path, same at-most-once rules, and the
 * two runs are two rows — which is what "have I dealt with this?" needs.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BacklogCheckStatus, BacklogNextStep, BacklogValidateStatus, Intent } from "@waterplane/shared";
import type { SessionManager } from "./sessions.js";
import type { IntentManager } from "./intents/manager.js";
import type { ReviewSidecar } from "./intents/adapters.js";
import { gitReviewDiff } from "./git.js";
import { detectHeadlessLimit, detectLimitText, limitNote } from "./limit.js";
import { runToolTask } from "./sidecar.js";
import { hostStateDir } from "./branddirs.js";
import { promptText } from "./prompts.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/**
 * The verdicts, keyed by intent id.
 *
 * Written with tmp+rename like everything else that matters here — the file the
 * per-repo backlog used to be was a bare `writeFileSync`, and half a JSON
 * document is worse than none.
 */
export class ReviewStore {
  private rows = new Map<string, ReviewSidecar>();
  private path: string;

  constructor(private root: string, private onChange: () => void) {
    this.path = join(hostStateDir(root), "reviews.json");
    try {
      const raw = readJsonGuarded<any>(this.path, null);
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) this.rows.set(k, v as ReviewSidecar);
    } catch { /* fresh host */ }
    this.relabelQuotaRows();
  }

  /**
   * Rows already on disk that say `Command failed: claude -p …` and carry the
   * banner in their DETAIL were quota blocks all along. Re-label them rather
   * than leave a wrong sentence on the phone until somebody spends a run
   * re-asking — the evidence is already here, and the run costs quota.
   *
   * The reset instant is deliberately DROPPED: a bare clock time out of a
   * three-day-old detail resolves against today, and "try again after 17:10"
   * about a wall that lifted on Tuesday is a new wrong sentence for an old one.
   */
  private relabelQuotaRows(): void {
    let changed = 0;
    for (const [id, row] of this.rows) {
      const patch: ReviewSidecar = {};
      if (row.checkStatus === "error" && detectLimitText(row.checkDetail || "").blocked) {
        patch.checkStatus = "limited";
        patch.checkNote = limitNote({ blocked: true, resetAt: null, weekly: false }, "checked");
      }
      if (row.validateStatus === "error" && detectLimitText(row.validateDetail || "").blocked) {
        patch.validateStatus = "limited";
        patch.validateNote = limitNote({ blocked: true, resetAt: null, weekly: false }, "validated");
      }
      if (!Object.keys(patch).length) continue;
      this.rows.set(id, { ...row, ...patch });
      changed++;
    }
    if (changed) this.persist();
  }

  get(id: string): ReviewSidecar | undefined { return this.rows.get(id); }

  set(id: string, patch: ReviewSidecar): void {
    this.rows.set(id, { ...this.rows.get(id), ...patch });
    this.persist();
    this.onChange();
  }

  drop(id: string): void {
    if (!this.rows.delete(id)) return;
    this.persist();
  }

  /** Verdicts carried over from a legacy `backlog.json`. Existing rows win: a
   *  re-imported backup must never overwrite a newer verdict. */
  importAll(rows: Record<string, ReviewSidecar>): void {
    let added = 0;
    for (const [id, v] of Object.entries(rows)) {
      if (this.rows.has(id)) continue;
      this.rows.set(id, v);
      added++;
    }
    if (added) this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(hostStateDir(this.root), { recursive: true });
      writeJsonAtomic(this.path, Object.fromEntries(this.rows), { space: 2 });
    } catch { /* best-effort — the in-memory map still works for this boot */ }
  }
}

export class ReviewManager {
  constructor(
    private sessions: SessionManager,
    private intents: IntentManager,
    private store: ReviewStore,
  ) {}

  /**
   * Is this task implemented, with no human grading?
   *
   * Primary: resume the item's own session and ask it to self-report a
   * structured JSON verdict, searching the codebase as needed — the task counts
   * as done if the behaviour exists anywhere, regardless of when it landed.
   * Fallback: an independent review of the git diff in a fresh session.
   */
  async check(id: string): Promise<void> {
    const it = this.intents.get(id);
    if (!it || this.store.get(id)?.checkStatus === "checking") return;
    const dir = it.cwd;
    const task = textOf(it);
    this.setCheck(id, "checking", "Asking the agent…");
    try {
      let res = await this.runReviewer(dir, selfReportPrompt(task), true);
      // A quota block is not a reason to try the fallback: the second run is
      // refused by the same account, and two refusals are one fact.
      if (res.status === "limited") { this.setCheck(id, res.status, res.note, res.detail); return; }
      if (res.status === "error") {
        const { diff, untracked, empty } = await gitReviewDiff(dir);
        if (empty) { this.setCheck(id, "not_done", "No code changes found."); return; }
        res = await this.runReviewer(dir, diffReviewPrompt(task, diff, untracked), false);
      }
      this.setCheck(id, res.status, res.note, res.detail);
    } catch (err) {
      this.setCheck(id, "error", String(err).slice(0, 200));
    }
  }

  private setCheck(id: string, status: BacklogCheckStatus, note: string, detail?: string): void {
    this.store.set(id, {
      checkStatus: status, checkNote: note, checkDetail: detail,
      checkedAt: status === "checking" ? this.store.get(id)?.checkedAt : Date.now(),
    });
  }

  /**
   * Deep validation — a step beyond `check`. Where check asks "is this
   * implemented?", this asks whether the user's EXPECTED OUTCOME is actually
   * achieved, traces the real behaviour, and proposes concrete next steps.
   */
  async validate(id: string): Promise<void> {
    const it = this.intents.get(id);
    if (!it || this.store.get(id)?.validateStatus === "validating") return;
    const dir = it.cwd;
    const task = textOf(it);
    this.setValidate(id, "validating", "Validating outcome…");
    try {
      let res = await this.runValidator(dir, validatePrompt(task), true);
      if (res.status === "limited") { this.setValidate(id, res.status, res.note, res.detail, []); return; }
      if (res.status === "error") {
        const { diff, untracked, empty } = await gitReviewDiff(dir);
        if (empty) { this.setValidate(id, "unlikely", "No code changes found.", undefined, []); return; }
        res = await this.runValidator(dir, validateDiffPrompt(task, diff, untracked), false);
      }
      this.setValidate(id, res.status, res.note, res.detail, res.steps);
    } catch (err) {
      this.setValidate(id, "error", String(err).slice(0, 200));
    }
  }

  private setValidate(id: string, status: BacklogValidateStatus, note: string, detail?: string, steps?: BacklogNextStep[]): void {
    this.store.set(id, {
      validateStatus: status, validateNote: note, validateDetail: detail, validateSteps: steps,
      validatedAt: status === "validating" ? this.store.get(id)?.validatedAt : Date.now(),
    });
  }

  /** "Select an option and continue in the CLI" — one of validation's proposed
   *  next steps, fed back as its own piece of work. */
  async nextStep(id: string, step: number): Promise<void> {
    const it = this.intents.get(id);
    const chosen = this.store.get(id)?.validateSteps?.[step];
    if (!it || !chosen) return;
    this.resumeWith(it, chosen.prompt, chosen.label);
  }

  /** "Continue the work" — the original task plus whatever the review concluded
   *  (verdict, note, open questions, prose detail), so the agent picks up with
   *  full context instead of from scratch. */
  async continueWork(id: string): Promise<void> {
    const it = this.intents.get(id);
    if (!it) return;
    this.resumeWith(it, continuePrompt(it, this.store.get(id)), it.label || textOf(it));
  }

  /**
   * Post `prompt` as its own intent, aimed at the item's session.
   *
   * Reuses the live session when it is still running; otherwise opens a fresh
   * one that RESUMES the repo's conversation (`--continue`), so the work carries
   * on with warm context in the same worktree. It is a POST rather than a direct
   * delivery for the reason everything else in this daemon is: the words survive
   * a restart, the row says what became of them, and the at-most-once rule is
   * the store's rather than a second one written here.
   */
  private resumeWith(it: Intent, prompt: string, label: string): void {
    const live = it.sessionId && this.sessions.get(it.sessionId)?.running ? it.sessionId : undefined;
    this.intents.post({
      id: `rv_${randomUUID().slice(0, 8)}`,
      cwd: it.cwd,
      payload: { kind: "prompt", steps: [prompt] },
      target: live ? { kind: "session", sessionId: live } : { kind: "repo", fresh: true },
      trigger: { kind: "now" },
      resume: !live || undefined,
      // A person tapped this: it is not machinery, so the auto-fire switch has
      // no say in it, and it is not queued behind the row it came from either.
      interject: true,
      label: label.slice(0, 80),
      title: it.title,
      origin: `review:${it.id}`.slice(0, 40),
    });
  }

  /**
   * Run a one-shot headless `claude -p` (optionally `--continue` to resume the
   * dir's conversation) and parse the structured JSON verdict it emits.
   */
  private async runReviewer(cwd: string, prompt: string, resume: boolean): Promise<{ status: BacklogCheckStatus; note: string; detail?: string }> {
    const args = ["-p", "--output-format", "json"];
    if (resume) args.push("--continue");
    // Through `sidecar.ts` — the engine axis for every unattended call. A
    // reviewer reads the codebase, so the toolless local engine is refused in
    // words rather than run; see that file's header.
    const run = await runToolTask("review", { cwd, args, prompt, timeoutMs: 180_000, maxBuffer: 8 * 1024 * 1024 });
    if (run.refused) return { status: "error", note: run.refused.slice(0, 200), detail: run.refused };
    const text = resultText(run.stdout);
    // Keep the reviewer's full reasoning (minus the machine verdict line) for the detail view.
    const detail = stripVerdictJson(text).slice(0, 8000) || undefined;
    const verdict = parseVerdict(run.stdout);
    if (verdict) return { ...verdict, detail };
    const limit = detectHeadlessLimit(run.stdout, run.stderr);
    if (limit.blocked) return { status: "limited", note: limitNote(limit, "checked"), detail };
    return { status: "error", note: (run.stderr || (run.err && String(run.err)) || "no verdict").toString().trim().slice(0, 200), detail: detail ?? (run.stderr.trim().slice(0, 8000) || undefined) };
  }

  /** The richer verdict: status + note + reasoning + next steps. */
  private async runValidator(cwd: string, prompt: string, resume: boolean): Promise<{ status: BacklogValidateStatus; note: string; detail?: string; steps: BacklogNextStep[] }> {
    const args = ["-p", "--output-format", "json"];
    if (resume) args.push("--continue");
    const run = await runToolTask("review", { cwd, args, prompt, timeoutMs: 240_000, maxBuffer: 8 * 1024 * 1024 });
    if (run.refused) return { status: "error", note: run.refused.slice(0, 200), detail: run.refused, steps: [] };
    const v = parseValidation(run.stdout);
    if (v) return v;
    const limit = detectHeadlessLimit(run.stdout, run.stderr);
    if (limit.blocked) {
      const detail = stripVerdictJson(resultText(run.stdout)).slice(0, 8000) || undefined;
      return { status: "limited", note: limitNote(limit, "validated"), detail, steps: [] };
    }
    return { status: "error", note: (run.stderr || (run.err && String(run.err)) || "no verdict").toString().trim().slice(0, 200), steps: [] };
  }
}

const textOf = (i: Intent): string => (i.payload.kind === "prompt" ? i.payload.steps[0] : "");

/** The JSON contract both prompts share — what the app parses. */
const VERDICT_CONTRACT =
  'Respond with ONLY a JSON object, no prose, no code fence:\n' +
  '{"status":"done|partial|questions|not_done","note":"<short summary or open questions, <240 chars>"}\n' +
  'done = task fully implemented. partial = started but incomplete. ' +
  'questions = blocked by open questions or assumptions that need the user. not_done = not implemented.';

const CHECK_PREAMBLE = [
  "Do not make any changes. Determine whether this task is implemented in the current codebase.",
  "Search the code (grep/read files) as needed to confirm — do NOT assume it had to be done in this session;",
  "the task counts as done if the behavior exists anywhere in the codebase, regardless of when or where it landed.",
].join("\n");

/**
 * Verification prompt sent to the RESUMED session. The agent has tools, so ask
 * it to judge whether the task is implemented IN THE CURRENT CODEBASE —
 * searching the code as needed — not merely whether this session happened to do
 * the work. A task can be satisfied by code that already existed or landed in
 * another session.
 */
function selfReportPrompt(task: string): string {
  return [
    promptText("review-check", CHECK_PREAMBLE),
    "",
    `TASK:\n${task}`,
    "",
    VERDICT_CONTRACT,
  ].join("\n");
}

const CHECK_DIFF_PREAMBLE = [
  "You are an impartial reviewer. Judge ONLY whether the task was implemented by the changes shown — do not edit anything.",
].join("\n");

/** Independent fallback — judge from the git diff alone (fresh session). */
function diffReviewPrompt(task: string, diff: string, untracked: string[]): string {
  const untrackedNote = untracked.length ? `\nUntracked new files: ${untracked.join(", ")}\n` : "";
  return [
    promptText("review-check-diff", CHECK_DIFF_PREAMBLE),
    "",
    `TASK:\n${task}`,
    untrackedNote,
    "GIT DIFF (vs the main branch):",
    "```diff",
    diff || "(no textual diff)",
    "```",
    "",
    VERDICT_CONTRACT,
  ].join("\n");
}

/** Pull the assistant text out of a `claude -p --output-format json` envelope. */
function resultText(stdout: string): string {
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === "string") return env.result;
  } catch { /* not an envelope */ }
  return stdout;
}

/** Drop the machine verdict line ({"status":…}) so the detail shows only prose. */
function stripVerdictJson(text: string): string {
  return text.replace(/\{[^{}]*"status"[^{}]*\}/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse the verdict from a `claude -p --output-format json` envelope. The
 * envelope is `{type:"result", result:"<assistant text>", …}`; the verdict JSON
 * lives in that text. Tolerant: works on the raw text too, picks the last
 * brace-object that carries a "status" field.
 */
function parseVerdict(stdout: string): { status: BacklogCheckStatus; note: string } | null {
  let text = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === "string") text = env.result;
  } catch { /* not an envelope — scan raw */ }

  const matches = text.match(/\{[^{}]*"status"[^{}]*\}/g);
  if (!matches) return null;
  for (const frag of matches.reverse()) {
    try {
      const obj = JSON.parse(frag);
      const s = String(obj.status || "").toLowerCase().replace(/[\s-]/g, "_");
      const status: BacklogCheckStatus | null =
        s === "done" ? "done" : s === "partial" ? "partial" : s === "questions" ? "questions" : s === "not_done" ? "not_done" : null;
      if (status) return { status, note: String(obj.note || "").trim().slice(0, 240) || "(no note)" };
    } catch { /* try the next fragment */ }
  }
  return null;
}

/** The richer JSON contract for validation — verdict + reasoning + next steps. */
const VALIDATE_CONTRACT =
  'Respond with ONLY a JSON object, no prose, no code fence:\n' +
  '{"status":"achieved|likely|unlikely|unclear","note":"<short verdict, <240 chars>","reason":"<2-4 sentences of evidence>","steps":[{"label":"<button label, <40 chars>","prompt":"<full instruction to send to Claude>"}]}\n' +
  'Provide 2-4 next-step options in "steps" (the most useful first). Each prompt must be a complete, ready-to-run instruction.\n' +
  'achieved = expected outcome clearly met. likely = probably met, minor gaps. unlikely = probably not met. unclear = cannot tell.';

const VALIDATE_PREAMBLE = [
  "Do not make any changes. Deeply VALIDATE whether the user's EXPECTED OUTCOME for this task is achieved —",
  "not merely whether some code exists. Trace the actual behavior end-to-end, consider edge cases and error paths,",
  "inspect or run relevant tests if present, and look for partial work, regressions, or unmet acceptance criteria.",
  "Search the code (grep/read files) as needed. Then grade how likely the expected outcome is met and propose next steps.",
].join("\n");

/**
 * Deep validation prompt sent to the RESUMED session. Unlike check (which only
 * asks "is it implemented"), this asks the agent to judge whether the user's
 * EXPECTED OUTCOME is actually achieved — tracing behavior, edge cases, tests —
 * and to propose concrete next steps.
 */
function validatePrompt(task: string): string {
  return [
    promptText("review-validate", VALIDATE_PREAMBLE),
    "",
    `TASK / EXPECTED OUTCOME:\n${task}`,
    "",
    VALIDATE_CONTRACT,
  ].join("\n");
}

const VALIDATE_DIFF_PREAMBLE = [
  "You are an impartial reviewer. Judge whether the user's EXPECTED OUTCOME was achieved by the changes shown — do not edit anything.",
  "Consider edge cases and whether the change is complete enough to actually deliver the outcome, then propose next steps.",
].join("\n");

/** Independent fallback — validate from the git diff alone (fresh session). */
function validateDiffPrompt(task: string, diff: string, untracked: string[]): string {
  const untrackedNote = untracked.length ? `\nUntracked new files: ${untracked.join(", ")}\n` : "";
  return [
    promptText("review-validate-diff", VALIDATE_DIFF_PREAMBLE),
    "",
    `TASK / EXPECTED OUTCOME:\n${task}`,
    untrackedNote,
    "GIT DIFF (vs the main branch):",
    "```diff",
    diff || "(no textual diff)",
    "```",
    "",
    VALIDATE_CONTRACT,
  ].join("\n");
}

/**
 * Parse the validation verdict from a `claude -p --output-format json` envelope.
 * The verdict JSON has nested braces (the steps array), so the check parser's
 * flat regex won't do — extract the outermost {...} from the assistant text.
 */
function parseValidation(stdout: string): { status: BacklogValidateStatus; note: string; detail?: string; steps: BacklogNextStep[] } | null {
  const text = resultText(stdout);
  const candidates = [text.trim()];
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i >= 0 && j > i) candidates.push(text.slice(i, j + 1));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      const s = String(obj.status || "").toLowerCase().replace(/[\s-]/g, "_");
      const status: BacklogValidateStatus | null =
        s === "achieved" ? "achieved" : s === "likely" ? "likely" : s === "unlikely" ? "unlikely" : s === "unclear" ? "unclear" : null;
      if (!status) continue;
      const steps: BacklogNextStep[] = Array.isArray(obj.steps)
        ? obj.steps
            .map((x: { label?: unknown; prompt?: unknown }) => ({
              label: String(x?.label || "").trim().slice(0, 60),
              prompt: String(x?.prompt || "").trim().slice(0, 2000),
            }))
            .filter((x: BacklogNextStep) => x.label && x.prompt)
            .slice(0, 4)
        : [];
      const reason = String(obj.reason || "").trim().slice(0, 8000) || undefined;
      return { status, note: String(obj.note || "").trim().slice(0, 240) || "(no note)", detail: reason, steps };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Build the "continue the work" prompt: the original task plus the latest
 * check/validate findings (verdict, note, open questions, prose detail) so the
 * resumed session has the full context to pick up and finish — paying special
 * attention to any open questions the review surfaced.
 */
function continuePrompt(it: Intent, review?: ReviewSidecar): string {
  const lines: string[] = [
    "Continue working on this task. A prior review left the findings below — address them, resolve any open questions, and carry the work forward.",
    "",
    `TASK:\n${textOf(it)}`,
  ];
  if (review?.checkStatus && review.checkStatus !== "checking") {
    lines.push("", `CHECK VERDICT: ${review.checkStatus}${review.checkNote ? ` — ${review.checkNote}` : ""}`);
    if (review.checkDetail) lines.push(review.checkDetail);
  }
  if (review?.validateStatus && review.validateStatus !== "validating") {
    lines.push("", `VALIDATION VERDICT: ${review.validateStatus}${review.validateNote ? ` — ${review.validateNote}` : ""}`);
    if (review.validateDetail) lines.push(review.validateDetail);
  }
  return lines.join("\n");
}
