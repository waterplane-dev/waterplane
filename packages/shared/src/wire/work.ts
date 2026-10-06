/** Work the host is doing on the user's behalf: backlog items, builds, fan-out sweeps, downloads. */

import type { AssessInput, AssessProposal } from "../assess.js";
import type { ItemCategory, NameAuthor } from "../naming.js";
import type { ScheduleRule } from "../schedule.js";
import type { SessionBudget } from "../sessionbudget.js";
import type { SmartPickOutcomeFacts } from "../smartpick.js";

/** Backlog item — a queued instruction to fire at a session. */
export type BacklogStatus = "queued" | "running" | "done" | "failed";

export interface BacklogItem {
  id: string;
  text: string;
  status: BacklogStatus;
  /** Repo the item targets. Grouping/scaffolding key; a repo can host several sessions. */
  repoDir: string;
  /**
   * Optional running session to fire this item into — the deliberate "join THIS
   * conversation". Unset ⇒ `fresh`: the item opens a session of its own. It used
   * to mean the repo's one shared backlog conversation, and that conversation is
   * retired (`shared/sessioncost.ts` is why).
   *
   * Items aimed at DIFFERENT sessions in the same repo run in parallel;
   * same-session items serialize. Session ids are per-boot, so this is cleared
   * on host restart — and what it falls back to now is a session of the item's
   * own, never somebody else's.
   */
  targetSessionId?: string;
  /**
   * That target is aimed at a CONVERSATION as well as a process
   * (`Intent.target.resumeConvId` + a clock, i.e. `reopensConversation`): if
   * the session has gone when this row's instant comes round, it reopens that
   * conversation in a session of its own rather than waiting on `sessionGone`
   * for ever.
   *
   * It rides beside `targetSessionId` because the phone cannot derive it — the
   * snapshot is a host field and never reaches the wire — and the backlog says
   * two OPPOSITE things about a closed target depending on it: *target closed —
   * held*, which is true of every session-aimed row that cannot reopen, and
   * *reopens its conversation*, which is true of these. Absent means the old
   * reading, which is the safe one: a promise not made.
   */
  reopensConv?: boolean;
  /**
   * Auto-fire this item when its target session is next ready (idle at the
   * prompt), even while the GLOBAL auto-fire switch is off. Set by the compose
   * bar's *When free* — the user explicitly asked for it, so it is exempt from
   * the "never inject into a hand-driven session" rule.
   */
  autoFire?: boolean;
  /**
   * This item opens a session OF ITS OWN when it fires, rather than joining
   * anything that is already there — the default for everything posted from now
   * on, and the reason the row can say "in a new session" instead of making the
   * reader work out which conversation it will land in.
   *
   * Optional because rows written before the change are still on disk and still
   * render; absent means the retired shared-session reading, which is a fact
   * about an old row and never a control anything offers.
   */
  fresh?: boolean;
  /** The new session picks up the repo's last conversation (`claude
   *  --continue`). Only meaningful with `fresh`; absent = start clean. */
  resume?: boolean;
  /**
   * The item's own *close the session when done* answer (`Intent.
   * closeWhenDone`). ABSENT means it follows the person's global setting
   * (`CLOSE_WHEN_DONE_KEY`, off by default) — draw it as "as set globally",
   * never as off; `false` is an explicit "keep this one open".
   */
  closeWhenDone?: boolean;
  /** The budget the session this row opens is born with (`Intent.budget`).
   *  Absent = none. */
  budget?: SessionBudget;
  /**
   * How many turns the item carries — a COUNT, never the words.
   *
   * The row shows "3 steps" and nothing more: the chain itself is `payload.
   * steps` on the host, kept in full and un-clipped for ever, and shipping it
   * here would put a prompt's whole text into every list every phone renders.
   * Absent (or 1) is the ordinary one-turn item, so nothing older has to be
   * rewritten to keep drawing correctly.
   */
  steps?: number;
  label?: string;
  /**
   * **A title a MACHINE wrote for this row** — a person's own goes in `label`,
   * and the two are never the same field.
   *
   * One field for both would make "whose words are on this row" unanswerable
   * the moment anything wrote a second one, and the answer is the whole point:
   * `itemHeadline` puts a typed `label` above this, always. Absent on the
   * overwhelming majority of rows, which nobody has titled.
   */
  headline?: string;
  /**
   * Who wrote `headline`. **Required together with it, and dropped together
   * with it** (`cleanIntentRow`): a title that cannot say who wrote it cannot
   * say whether a person may be overwritten, and a naming run that overwrites a
   * title somebody typed is the one failure this pair exists to make
   * impossible.
   */
  headlineBy?: NameAuthor;
  /**
   * What KIND of thing this is — one of `ITEM_CATEGORIES` and nothing else.
   *
   * **Absent means NOBODY SAID**, never "chore". A word outside the four is
   * dropped rather than rounded to the nearest one: a row filed under a heading
   * its author never chose is a row they will not find, and "no kind" is a
   * heading a person can act on while a wrong one is not.
   */
  category?: ItemCategory;
  /** Who said so — the same pairing rule as `headlineBy`, for the same reason:
   *  a kind with no author cannot protect a kind a person picked. */
  categoryBy?: NameAuthor;
  /** The session the item last actually fired INTO (resolved target). */
  sessionId?: string;
  /**
   * The live session this WAITING row is held behind — present only while it
   * is blocked `serial` and the sentence (`backlog.list.waiting`) names one:
   * an automatic predecessor mid-turn, on a limit, or with a question open.
   * The row offers to open it; the question is usually the thing to do.
   * Optional: an older host sends nothing and the row offers nothing.
   */
  holderSessionId?: string;
  createdAt: number;
  /** Custom sort order; lower = earlier. Defaults to createdAt at insert. */
  order: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Archived items are hidden from the default backlog view but kept for reference. */
  archived?: boolean;
  /** Waits for a person's tap: auto-fire and the smart pick never start it
   *  (`Intent.manual`, an agent's backlog add). The row says so in
   *  `MANUAL_HOLD_TEXT`. */
  manual?: boolean;
  /** Implementation check: an independent claude review of the item's git diff. */
  checkStatus?: BacklogCheckStatus;
  /** One-line verdict reason from the reviewer. */
  checkNote?: string;
  /** Full reviewer output (the reasoning behind the verdict) — shown on demand, persisted. */
  checkDetail?: string;
  checkedAt?: number;
  /**
   * Deep validation: a claude judgement of whether the item's EXPECTED OUTCOME is
   * achieved (not just "code exists"), plus proposed next steps. Distinct from
   * check — check is "implemented?", validate is "did it actually work + now what?".
   */
  validateStatus?: BacklogValidateStatus;
  /** One-line verdict on whether the expected outcome was achieved. */
  validateNote?: string;
  /** Fuller reasoning behind the verdict — shown on demand, persisted. */
  validateDetail?: string;
  /** A few proposed next steps; the user taps one to feed it back into the CLI. */
  validateSteps?: BacklogNextStep[];
  validatedAt?: number;
  /**
   * This row was written by the smart pick out of these items, which are now
   * archived with their own words intact.
   *
   * A COUNT on the row's chip ("merged from 3"), and the ids beside it, because
   * **a count on a control is a filter**: the tap has to open exactly those
   * three and not the unfiltered list for the reader to re-derive them from.
   * Carrying the ids is the only way the chip can keep that promise.
   */
  mergedFrom?: string[];
  /** The other side of the same fact, on an original: the merged row that now
   *  stands in for it. Renders the "merged into …" chip, which is one tap back. */
  mergedInto?: string;
  /**
   * A person dragged this row to where it is.
   *
   * The smart pick sorts AROUND a row carrying this and never through it — a
   * drag is the one explicit act in the sheet, and a pass that quietly re-places
   * it is the feature undoing a decision somebody made. On the wire because the
   * row says so ("placed by you"): a rule the user cannot see is a rule they
   * cannot trust.
   */
  handOrdered?: boolean;
  /**
   * What put this row here, when it was not a person — `smartpick:<passId>`,
   * `assess:<runId>`. Capped on the host at 40 chars. Absent on everything
   * somebody typed, which is the overwhelming majority.
   */
  origin?: string;
  /**
   * **This item waits on a CLOCK.** Present only on a one-off `at` row aimed at
   * one place (`isTimedWorkRow`) — recurrence, not trigger kind, decides which
   * list a row lives in, and a one-off is waiting work that happens to carry an
   * instant.
   *
   * The whole rule travels, never a rendered sentence: quiet hours, the
   * headroom guard and whatever clause is added next are clauses ON the rule,
   * so a field list here is a list to forget the newest one from — the failure
   * `intentToSchedule`'s round trip is written against, one DTO over. The row
   * says its own words with `describeRule`.
   *
   * `nextAt` is the armed instant, and `null` is the explicit "nothing is armed"
   * — a spent one-off, or a `window` rule with no usage reading yet. It is
   * never a guess: absent `at` means the row has no clock at all, which is
   * every row written before this field and every untimed item.
   */
  at?: { rule: ScheduleRule; graceMin: number; nextAt: number | null };
  /**
   * The schedule vocabulary's *wait until it's free*, host-wide half: this row
   * holds until nothing on the desktop is starting or running.
   *
   * The other half (`serial`, one at a time in this repo) is on every
   * repo-target item by construction and is therefore not worth a field. Absent
   * means "the host being busy elsewhere is none of this row's business", which
   * is what every row written before this meant and still means.
   */
  holdForHost?: true;
  /** A person let this row past the usage budget, for its next start and until
   *  `until` — the reset of the window they did it in (`Intent.pastBudget`).
   *  Every other wait still holds it; past `until` it is no waiver at all
   *  (`budgetWaived`), and the host drops it on its next tick. */
  pastBudget?: { until: number };
  /**
   * **This row was put back after it had already settled** — the LAST time it
   * happened, flattened for the row that draws it.
   *
   * The host keeps the history (`IntentRequeue[]`, capped at `REQUEUE_KEEP`).
   * What travels is the newest entry plus `n`, how many there have been, and
   * the reason is the rule this file already follows for `steps` and
   * `mergedFrom`: a list every phone renders is a list every phone downloads,
   * and the row itself says one sentence — "re-queued by the assessment, after
   * it failed: <the failure>". The older entries answer a question nobody asks
   * from the list; `n` is what says "this is the third time", which is the
   * whole of what the earlier ones would have told the reader anyway, and it is
   * a COUNT ON A CONTROL — the tap opens that row, where the full history is.
   *
   * ── `n` comes from the COUNT, and is optional because the count is ────────
   *
   * `n` is `Intent.requeueCount` and nothing else. It is emphatically **not**
   * `requeues.length`, which is what it used to be: that list is capped at
   * `REQUEUE_KEEP`, so its length stops rising at five and the row then says
   * *(5th time)* on the sixth re-queue and on the ninth — a chip that reads as
   * a warning, frozen at a number that is simply false, exactly the way
   * CLAUDE.md forbids a reading to degrade. **Absent means the host cannot say
   * how many times**, which is every row re-queued before the count existed:
   * the phone then draws the sentence without the ordinal ("put back after it
   * failed") rather than inventing one, and must never fall back to the length
   * of the history to fill it in.
   *
   * `by` says which tap, and the three are three different sentences — see
   * `IntentRequeue.by`. `assess` and `hand` leave the row WAITING and are drawn
   * as *put back in the queue*; `run` was only the first half of *run it now*,
   * so the row it is drawn on is starting or already running and the sentence
   * has to say *started again*, not describe a queue the row is not in.
   *
   * `error` is the failure THAT entry recorded, present only when it recorded
   * one: it is the reason a person had to think twice, and it is gone from
   * `BacklogItem.error` the moment the row runs again. Absent means the entry
   * carried no failure text, never that there was no failure.
   */
  requeued?: { at: number; by: "assess" | "hand" | "run"; n?: number; error?: string };
}

// ── Smart pick: the look a repo takes before its next item fires ────────────

/**
 * What the last smart-pick pass for one repo did, as the strip under the repo
 * bar reads it.
 *
 * Every number here is measured or absent — never zero standing in for
 * "nobody said". `tokens` and `usd` come out of the `claude -p` envelope when it
 * carried them and are ABSENT when it did not, because a cost line that reads
 * `$0.00` for an unmeasured call is a wrong number, and CLAUDE.md's rule is that
 * heuristics degrade to absent rather than to a wrong number. The local-runner
 * engine reports neither, and says so by omitting both.
 *
 * `merged` and `mergedInto` are both kept: "merged 5 → 2" is not derivable from
 * either one on its own, and the sentence is the contract
 * (`smartpickOutcomeText`).
 *
 * The whole object is optional on `backlog.list` and absent until a pass has
 * ever run for the repo, so an old bundle that never asks for it renders exactly
 * what it rendered before.
 */
export interface SmartPickSummary extends SmartPickOutcomeFacts {
  passId: string;
  /** When the pass finished (or gave up). */
  at: number;
  /** The model's own sentence about what it did. */
  why?: string;
  /** How many items the pass was shown. Items past the cap are not in it, and a
   *  note says how many were not looked at. */
  looked: number;
  /** Every refusal the sanitiser made, one sentence each — the `details`
   *  disclosure under the strip. */
  notes: string[];
  /** The model the pass actually ran on. Absent when the engine does not name
   *  one. */
  model?: string;
  engine: "claude-p" | "openai-compat";
  tokens?: { inTok: number; outTok: number; cacheRead: number; cacheWrite: number };
  usd?: number;
}

/**
 * Verdict of an implementation check (CLI self-reports structured JSON).
 * "checking" = in flight; "questions" = done-ish but the agent has open questions.
 *
 * "limited" is deliberately NOT "error": the reviewer never ran, so nothing was
 * judged. Reported as an error it reads as a broken install (and as a claim
 * about the work), when the true fact is a quota that lifts by itself.
 */
export type BacklogCheckStatus = "checking" | "done" | "partial" | "questions" | "not_done" | "error" | "limited";

/**
 * Verdict of a deep outcome validation (CLI self-reports structured JSON).
 * "validating" = in flight; achieved/likely/unlikely/unclear grade how well the
 * user's expected outcome appears to be met.
 */
export type BacklogValidateStatus = "validating" | "achieved" | "likely" | "unlikely" | "unclear" | "error" | "limited";

/** A proposed next step from validation: a short button label + the full instruction to send. */
export interface BacklogNextStep {
  /** Short label shown on the tappable option button. */
  label: string;
  /** Full instruction fed into the session's CLI when the option is chosen. */
  prompt: string;
}

/**
 * A named build command wired to a repo, runnable from the phone WITHOUT a
 * claude session — the token-limit escape hatch (still build an APK when you're
 * rate-limited). Persisted per-repo in <repoDir>/.waterplane/builds.json.
 */
export interface BuildConfig {
  id: string;
  /** Button label, e.g. "Release APK". */
  name: string;
  /** Shell command line, run via the login shell in the repo (or `dir`).
   *  May carry `{{param}}` placeholders — see `params`. */
  cmd: string;
  /** Optional working dir RELATIVE to the repo root (traversal-guarded). Empty = repo root.
   *  May carry `{{param}}` placeholders too, which is how one entry serves one
   *  member of a monorepo (`apps/{{app}}`). Substituted BEFORE the guard. */
  dir?: string;
  /**
   * What this button asks for before it runs (absent = nothing, the constant
   * command every build used to be).
   *
   * The rules — verbatim substitution at `{{id}}`, a value is one line, an
   * undeclared placeholder is left alone, a missing value REFUSES the run
   * rather than defaulting — all live in `shared/buildparams.ts`, which both
   * ends ask.
   */
  params?: BuildParam[];
}

/**
 * One thing a build asks for at the moment you tap run.
 *
 * `kind` is the shape of the question, not a type: every value is a string on a
 * command line by the time it matters. A `choice` gets its options from a static
 * `options` list, or from `optionsCmd` — a shell one-liner run in the repo when
 * the form opens, so a monorepo's members are read rather than transcribed and
 * a list that changes weekly cannot go stale in a config file.
 *
 * `optionsCmd` runs BEFORE anybody has confirmed a run, which is the one thing
 * about it worth knowing: it is a command out of the same file as the build it
 * belongs to, written by the same hand, but it executes when the form opens and
 * not when the button is pressed. The form shows it for that reason.
 */
export interface BuildParam {
  /** Referenced as `{{id}}`, exported as `WATERPLANE_PARAM_<ID>`. `[A-Za-z][A-Za-z0-9_]*`. */
  id: string;
  /** What the form calls it ("Garmin app"). Absent ⇒ the id. */
  label?: string;
  kind: "text" | "choice";
  /** A choice's fixed options. */
  options?: string[];
  /** A choice's options, read by running this in the repo root when the form
   *  opens: one option per line of stdout. */
  optionsCmd?: string;
  /** Used when nobody is asked — an unattended fire (a schedule, a chain,
   *  Activity's *run it now*). Absent ⇒ such a run is REFUSED, never guessed. */
  default?: string;
  /** One line under the field. */
  hint?: string;
}

export type BuildRunStatus = "running" | "done" | "failed" | "cancelled";

/** One artifact a build produced (a build-output file that appeared/changed
 *  under the repo during the run) — tapped to download via the artifact endpoint. */
export interface BuildArtifact {
  repoId: string;
  name: string;
  /** Worktree-relative path (forward slashes). */
  relPath: string;
  size: number;
  /** Last-modified time, so a UI can say how old a file is. */
  mtime?: number;
  /**
   * The run did NOT write this file — it was already there, untouched.
   *
   * An incremental build whose outputs are current writes nothing (gradle:
   * "50 up-to-date"), so a strict "modified since the run started" rule reports
   * zero artifacts for a successful build whose APK is sitting right there.
   * The host offers the newest matching files anyway and flags them, because
   * "here is the APK" and "this run produced it" are different claims and only
   * one of them is true.
   */
  stale?: boolean;
}

/**
 * A single execution of a BuildConfig. Output streams separately as
 * `build.output` frames keyed by runId; artifacts are attached on completion.
 */
export interface BuildRun {
  runId: string;
  /** The repo (worktree path) this run belongs to — matches BuildConfig's repoDir. */
  repoDir: string;
  buildId: string;
  /** The build's name at fire time (config may change later). */
  name: string;
  cmd: string;
  /** Absolute dir the command runs in. */
  cwd: string;
  status: BuildRunStatus;
  /** Process exit code once finished (null while running / on signal kill). */
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  /** New/changed build outputs detected on completion (biggest first). */
  artifacts?: BuildArtifact[];
  /**
   * The parameter values this run was given, as they were resolved at fire time.
   *
   * On the row for the same reason `name` and `cmd` are snapshotted: with
   * parameters, two runs of one button are two different builds, and a row that
   * cannot say which app it screenshotted is a row that cannot be told from the
   * four above it.
   */
  params?: Record<string, string>;
}

// ── Assessment (one repo, everything still open, judged with evidence) ───────

/**
 * Where one assessment run is.
 *
 * `applied` is a separate terminal state from `done` because the sheet has two
 * quite different jobs to offer: a finished run is a diff waiting for a person,
 * and an applied one is a record of what that person decided. Collapsing them
 * would make "have I dealt with this?" — the question every list in this app is
 * read with — unanswerable from the row.
 */
export type AssessRunStatus = "running" | "done" | "failed" | "applied";

/**
 * What one step of a running assessment WAS.
 *
 * `kind` is the shape of the step and not the CLI's tool name, because the
 * phone draws an icon off it and a new tool in a later CLI must not make the
 * list undrawable: an unrecognised tool is `tool`, which still carries the name
 * in `label`. `say` is the run's own prose — the one kind that is not an
 * action.
 */
export type AssessStepKind = "read" | "search" | "edit" | "run" | "task" | "web" | "tool" | "say";

export interface AssessStep {
  at: number;
  kind: AssessStepKind;
  /** The verb as the CLI named it (`Read`, `Grep`, `Bash`…), or `said`. */
  label: string;
  /** What it acted on — a repo-relative path, a pattern, a command — clipped
   *  by the host. Absent when the call named nothing readable. */
  detail?: string;
}

/**
 * **What a running assessment is doing, while it does it.**
 *
 * The run takes up to twenty minutes and until this existed the screen said one
 * sentence for all of it ("the assessment is reading the repo"), which is
 * indistinguishable from a run that died in its first second — the phone is not
 * the desktop, so there is no terminal to glance at and no other way to tell.
 *
 * It is a READING, never a lifecycle: the status still comes from `status`, the
 * verdicts still only from the proposal, and nothing on this object is ever
 * used to decide anything. It degrades to absent — an older host sends none, a
 * stream that cannot be parsed contributes no steps — and absent is exactly the
 * old screen.
 *
 * `tail` is a TAIL and says so: `steps` is how many there have been, so a list
 * showing the last twenty of two hundred cannot read as a run that did twenty
 * things. The words are the CLI's own, clipped by the host and never
 * re-narrated here.
 */
export interface AssessProgress {
  /** The most recent steps, oldest first. Capped by the host. */
  tail: AssessStep[];
  /** How many steps there have been in total — `tail` is the end of it. */
  steps: number;
  /** How many of those were tool calls (the rest are the run's own words). */
  tools: number;
  /** The run's last words, clipped — what it says it is doing. */
  say?: string;
  /** The model the run is actually on, as its own first event named it. */
  model?: string;
  /** Whether the two files the contract asks for have appeared yet. The run
   *  writes them at the very end, so this is the difference between "still
   *  reading" and "writing its answer". */
  wroteOut?: boolean;
  wrotePlan?: boolean;
  /** When this reading was taken. */
  at: number;
}

/**
 * One run of "what is left here, and what is already done", plus the proposal
 * it produced.
 *
 * `runId` IS the intent id: the run is an Intent (`target: shell`), so it is on
 * disk before the tap returns, shows in Activity while it works, and is
 * reconciled after a restart — exactly as a build run is. The proposal itself
 * lives in a sidecar keyed by this id rather than on the intent, for
 * `reviews.json`'s reason: a proposal is not lifecycle, it outlives the run, and
 * putting it on `Intent` puts fields on every row that one sheet reads.
 */
export interface AssessRun {
  runId: string;
  /** The worktree it was run in and about. */
  repoDir: string;
  status: AssessRunStatus;
  startedAt: number;
  finishedAt?: number;
  /** One line: what ran, or which half of the contract failed. */
  detail?: string;
  /**
   * The CLI's own envelope text, kept when the FILE was the problem.
   *
   * The envelope is the completion signal and the error channel; the file is
   * the content. When the file is missing or unparseable this is all there is
   * to go on, and throwing it away leaves a failed run that cannot be debugged
   * from the phone.
   */
  envelope?: string;
  /** How many items went in, context rows included. */
  itemCount?: number;
  /** How many of those the run was allowed to decide about. */
  assessableCount?: number;
  /**
   * **What the run was SCOPED to, when it was scoped** — absent means the whole
   * repo, which is every run before this field.
   *
   * Written when the run STARTS rather than derived from `input` when it ends,
   * and the difference is the whole point: `input` is absent while the run is
   * still `running`, so a sheet reading only that would draw a scoped run as an
   * unscoped one for the twenty minutes it takes — exactly the window in which
   * somebody is watching it and deciding whether it is doing what they asked.
   *
   * `assessableCount` is the number, so this is only ever read as "was it
   * scoped, and to which rows" — the second half being what lets the sheet's
   * count open exactly those rows, the rule every other count in that list
   * already follows.
   */
  scopedIds?: string[];
  /**
   * What was actually assessed — the document the host wrote for the CLI.
   *
   * On the RUN rather than assembled by whoever renders it, and the difference
   * is not tidiness. `AssessProposal.rows` carries ids, verdicts and evidence
   * and no prose at all, so a sheet showing "this will be retired" has to find
   * the words somewhere; the obvious source is current state, and current state
   * has moved on — a row posted, edited or sent since the run began is not the
   * row the verdict was formed against, and rendering today's words under
   * yesterday's verdict is `settle.ts`'s `spendTurn` problem in a screen a
   * person approves with one tap. Keeping the input here means the run holds
   * exactly what it judged, for as long as the proposal exists to be judged
   * back.
   *
   * Absent while the run is still `running` (it is written when the run
   * settles) and on a run that failed before it could write its input file.
   */
  input?: AssessInput;
  proposal?: AssessProposal;
  /** Repo-relative path of the human document, when the run wrote one. */
  planPath?: string;
  /**
   * **Which version of that document this run wrote** — its mtime, in whole
   * milliseconds, at the moment the run settled.
   *
   * `planPath` is the same path for every run of a repo, because the contract
   * names one file (`.waterplane/plan.md`) and each run rewrites it. A reader that
   * caches documents by where they came from therefore has one key for every
   * plan that repo has ever produced, and *read the plan* on a run from
   * Tuesday can open the plan written this morning — an earlier run's document
   * shown under this run's verdicts, which is `settle.ts`'s `spendTurn` failure
   * (evidence that belongs to somebody else) in a screen a person approves with
   * one tap. The mtime is what makes the two versions different keys.
   *
   * Absent on every run made before this field existed, on a run that wrote no
   * plan, and on one whose file could not be stat'd. Never 0: a zero is a
   * version that says "unversioned", and two documents would share it.
   */
  planMtime?: number;
  /** When a person applied it, and what that did. Counts only — the words are
   *  on the rows the mutations touched. */
  appliedAt?: number;
  /**
   * `requeued` is how many settled rows the apply put back — a fourth count
   * beside the three, not folded into `ranked`. They are different events: a
   * rank moves a row inside a queue, a re-queue is the row rejoining one, and a
   * run whose whole effect was to revive nineteen dead rows must not report
   * itself as having re-sorted them. Absent on every run applied before this
   * existed, which is why it is optional rather than 0.
   */
  /**
   * `named` is how many rows the apply TITLED, and it postdates the persisted
   * row exactly the way `requeued` does — optional rather than 0, so a run
   * applied before titles existed says "nobody counted" rather than "none".
   * Its own count for its own reason: writing a title changes nothing about
   * where a row sits or whether it will run, so folding it into `ranked` would
   * report a naming pass as a re-sort of work nobody moved.
   */
  applied?: { dismissed: number; ranked: number; posted: number; requeued?: number; named?: number };
  /**
   * **What the run has been doing** — live while it runs, kept as the record of
   * what it did once it has finished.
   *
   * Live it is written to memory and broadcast but NOT to disk (a reading that
   * is only true while a child process of this daemon is alive has nothing to
   * survive a restart for — `AssessStore`'s reconciliation fails every
   * `running` row on boot anyway); the last one is persisted with the settled
   * run, because "what did it actually look at" is the first question a
   * surprising proposal raises and the stream is gone by then.
   */
  progress?: AssessProgress;
}

// ── Auto-download (repo → phone, resumable) ──────────────────────────

/**
 * Per-repo rule for what the phone should pull DOWN on its own, persisted in
 * <repoDir>/.waterplane/autopull.json. The mirror image of the inbox: the agent drops
 * a build/report into the outbox, and a matching phone starts fetching it
 * without anyone tapping — which is the only way it works on a link that is
 * down when the file appears and up ten minutes later.
 */
export interface AutoPullConfig {
  enabled: boolean;
  /** Where new files are watched: the outbox dirs (default) or the whole repo. */
  scope: "outbox" | "repo";
  /** Glob-ish patterns (`*`, `?`) matched against the file NAME, or against the
   *  repo-relative path when the pattern contains a slash. Empty = everything
   *  the scope surfaces. */
  match: string[];
  /** Skip anything bigger than this (bytes) — a phone should not silently pull a
   *  2 GB tarball over a metered link. 0 = no cap. */
  maxBytes: number;
  /** Also queue the artifacts a BUILD produces (builds.ts), not just outbox drops. */
  builds: boolean;
  /** Keep only the NEWEST version of an artifact: when a new file lands that is
   *  the same thing as one already queued (`familyKey`), the older entries are
   *  dropped and a download in flight for them is cancelled. Five 23 MB APKs of
   *  the same build queued over an afternoon is 115 MB of a roaming link spent
   *  on four files nobody wants. Default on. */
  supersede: boolean;
}

export const DEFAULT_AUTOPULL: AutoPullConfig = {
  enabled: false,
  scope: "outbox",
  match: [],
  maxBytes: 256 * 1024 * 1024,
  builds: true,
  supersede: true,
};

/**
 * One file the host has decided a subscribed phone should have. Queued on the
 * host (and persisted) rather than pushed at a live socket, because the phone is
 * routinely NOT connected when the file lands — the queue is what survives that.
 * Which devices already fetched it is deliberately not tracked here: several
 * phones can subscribe, so "done" is per-device client state.
 */
export interface PullItem {
  /** Stable across re-emits: derived from repo + path + mtime. */
  id: string;
  repoId: string;
  repoDir: string;
  repoName: string;
  name: string;
  /** Worktree-relative path (forward slashes) — what the artifact endpoint takes. */
  relPath: string;
  size: number;
  mtime: number;
  /** When the host queued it. */
  ts: number;
  source: "outbox" | "build" | "manual";
  /** "Which artifact IS this" — repo path + name with the variable part (hash,
   *  build number, timestamp, version) folded out, so two builds of the same APK
   *  share it while a debug and a release build do not. Optional only for queue
   *  entries persisted by an older host. */
  family?: string;
  /** Ids this item replaced when it was queued (same `family`, older mtime).
   *  The client drops those records and ABORTS one that is downloading — the
   *  bytes of a build that has already been rebuilt are worth nothing. */
  supersedes?: string[];
}

// ── Fan-out (one prompt, N repos, a fresh session each) ──────────────

export type FanoutStatus = "pending" | "starting" | "running" | "done" | "failed";

/** One repo in a fan-out run: a fresh `claude` session in `dir`, fed the run's prompt. */
export interface FanoutTarget {
  /** Absolute worktree path the session runs in. */
  dir: string;
  /** Display label ("repo · branch") resolved at fire time. */
  title: string;
  /** The session spawned for this repo (set once it exists — tap to open it). */
  sessionId?: string;
  status: FanoutStatus;
  /** Why it failed / couldn't be confirmed. */
  error?: string;
}

/**
 * One fan-out: the same prompt delivered into a fresh session per selected repo,
 * all at once. Kept in host memory only (a run is a transient action, not state
 * worth persisting) — the sessions it spawns are the durable result.
 */
/**
 * How many fan-out runs the host keeps (and the client should keep) — a run is
 * a transient action, the sessions it spawns are the durable part. Shared so the
 * two ring sizes can't drift: a client keeping MORE than the host would show
 * runs the host has already forgotten and can never update again.
 */
export const FANOUT_MAX_RUNS = 10;

export interface FanoutRun {
  id: string;
  /** The prompt or slash command sent to every target. */
  text: string;
  startedAt: number;
  /** Set once every target reached a terminal status. */
  finishedAt?: number;
  targets: FanoutTarget[];
  /**
   * Follow-up instructions typed into the run's EXISTING sessions afterwards
   * (newest last) — a sweep is rarely one prompt ("...now commit that"), and
   * re-driving the same set beats reopening N sessions by hand. `dirs` records
   * which targets each one went to (a follow-up may address a subset).
   */
  followUps?: { text: string; at: number; dirs: string[] }[];
}
