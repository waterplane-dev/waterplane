/** The summary rows: where it goes, what the button says, why it is refused. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { afterWords, sessionBudgetLabel, describeRule, fmtWhen, type SessionBudget, type Intent } from "@waterplane/shared";
import { type SendTarget, type SendWhen, type SendIntent, type SendNames } from "./sendTypes.ts";
import { launchClause, launchOfTarget, launchWords } from "./sendLaunch.ts";
import { flagWhenDoneOffered } from "./sendFlag.ts";

// ── The summary rows ─────────────────────────────────────────────────

/** The budget a send's target carries — only the two that OPEN sessions have one. */
export const budgetOfTarget = (t: SendTarget): SessionBudget | undefined =>
  t.kind === "repo" || t.kind === "repos" ? t.budget : undefined;

/** The target with its budget set or (null/undefined) removed; a target that
 *  opens no session is returned untouched. No `budget: undefined` key is left behind. */
export function withBudget(t: SendTarget, b: SessionBudget | null | undefined): SendTarget {
  if (t.kind !== "repo" && t.kind !== "repos") return t;
  const { budget: _drop, ...rest } = t;
  void _drop;
  return (b ? { ...rest, budget: b } : rest) as SendTarget;
}

/** The *To* row's own words — short enough for a collapsed row. */
export function targetWords(t: SendTarget, n: SendNames, w?: SendWhen): string {
  // Said only where it will be honoured (`flagWhenDoneOffered`) — a tick left
  // over from a WHEN that no longer takes it is not on the row.
  const flag = (t.kind === "repo" || t.kind === "repos") && t.flagWhenDone && (!w || flagWhenDoneOffered(t, w)) ? ", flagged when done" : "";
  switch (t.kind) {
    case "session": return n.sessionTitle(t.sessionId);
    // `X · work item` went with the retired second reading of a repo target.
    // What is left is one conversation per send, and whether it starts clean or
    // picks up the last one — which is the only difference a person can act on.
    // The item's own close-when-done answer, only when it HAS one — inherit
    // (absent) is the default and says nothing on a collapsed row.
    case "repo": return `${n.repoName(t.cwd)} · a new session${t.resume ? ", continued" : ""}`
      + (t.closeWhenDone === true ? ", closes when done" : t.closeWhenDone === false ? ", kept open" : "")
      + flag
      + launchClause(t.launch)
      + (t.budget ? `, budget ${sessionBudgetLabel(t.budget)}` : "");
    case "repos": return (t.dirs.length === 1 ? n.repoName(t.dirs[0]) : `${t.dirs.length} repos`)
      + flag
      + launchClause(t.launch)
      + (t.budget ? `, budget ${sessionBudgetLabel(t.budget)}` : "");
    case "shell": return `${n.buildName(t.cwd, t.buildId)} · ${n.repoName(t.cwd)}`;
  }
}

// `afterWords`/`whenWords` live in `@waterplane/shared` (`schedule.ts`) — one
// wording for the send sheet and the host's agent route.
export { afterWords, whenWords } from "@waterplane/shared";

/**
 * The primary button restates the WHOLE decision.
 *
 * A sheet with two collapsed rows and one button can be read at a glance or not
 * at all, and "Send" over a screen where three of the four answers are folded
 * away is the version that cannot. The user asked for exactly this, in these
 * words: after picking a time the button should be "save for XY date and time".
 */
export function sendLabel(i: SendIntent, n: SendNames, preview: number | null): string {
  // The model and the cap ride on the button like every other part of the
  // decision: either one set in a collapsed row is otherwise the one answer the
  // button does not say. Nothing is added for a send on the defaults.
  const l = launchOfTarget(i.target);
  const base = sendLabelBase(i, n, preview) + (launchClause(l) ? ` · ${launchWords(l)}` : "");
  return (i.target.kind === "repo" || i.target.kind === "repos") && i.target.budget
    ? `${base} · budget ${sessionBudgetLabel(i.target.budget)}` : base;
}

function sendLabelBase(i: SendIntent, n: SendNames, preview: number | null): string {
  if (i.when.kind === "at") {
    if (preview != null) return `Save for ${fmtWhen(preview)}`;
    // A window rule anchors to a reset this phone cannot see; saving it is the
    // whole point, and the host arms it on the first scrape.
    if (i.when.rule.kind === "window") return `Save for ${describeRule(i.when.rule)}`;
    return "pick a time it can still reach";
  }
  // A chain restates the whole decision the same way the other three do — where
  // the words go, and what has to finish first. The tail is one clause rather
  // than a second sentence because this is a button, and a button that wraps to
  // three lines on a phone is one nobody reads before tapping.
  if (i.when.kind === "after") {
    const a = afterWords(i.when.title, i.when.onlyIfOk);
    switch (i.target.kind) {
      case "session": return `Send to ${n.sessionTitle(i.target.sessionId)} ${a}`;
      case "repo": return `Queue for ${n.repoName(i.target.cwd)} · a new session ${a}`;
      // `Queue in N repos after …` was the sequential wording — one at a time —
      // on the one target that is never sequential: a `{kind:"repos"}` intent is
      // the fan-out, every repo starts together, and `sequential` is not read in
      // this arm at all. The button now says what the send does.
      case "repos": {
        const many = i.target.dirs.length;
        return `Fan out to ${many === 1 ? n.repoName(i.target.dirs[0]) : `${many} repos`} ${a}`;
      }
      // Never reached with the button live — `sendBlocker` refuses it in words
      // first — but a label is drawn beside that refusal, so it says the same
      // thing rather than a stale "Run …" from the arm below.
      case "shell": return `${n.buildName(i.target.cwd, i.target.buildId)} cannot wait for another item`;
    }
  }
  const later = i.when.kind === "idle";
  switch (i.target.kind) {
    case "session":
      return later ? `Send to ${n.sessionTitle(i.target.sessionId)} when it's free` : `Send to ${n.sessionTitle(i.target.sessionId)}`;
    // One repo target, so one label per WHEN. `Run in X now` and `Open X when
    // it's free` were the other reading's half of the pair and went with it;
    // what is left restates the whole decision, which a collapsed two-row sheet
    // has to do or the button is the only thing on screen that says nothing.
    // ONE clause for the fresh-session wait, and it names the thing that is
    // busy: the repo. The button said *when it's free*, the toast said *when
    // that repo is free* and the hint said *when a slot is free* — three
    // spellings of one condition, met in that order by anybody using this once.
    case "repo":
      return later
        ? `Queue for ${n.repoName(i.target.cwd)} · a new session when this repo is free`
        : `Start in ${n.repoName(i.target.cwd)}`;
    case "repos": {
      const many = i.target.dirs.length;
      const where = many === 1 ? n.repoName(i.target.dirs[0]) : `${many} repos`;
      return i.sequential ? `Queue in ${where}` : `Fan out to ${where}`;
    }
    case "shell":
      return later ? `Queue ${n.buildName(i.target.cwd, i.target.buildId)}` : `Run ${n.buildName(i.target.cwd, i.target.buildId)}`;
  }
}

/**
 * The same button, with the link down.
 *
 * Offline every send is a queued send and the button says so — except where the
 * label ALREADY opens with that verb, which is most of them now that it
 * restates the whole decision. Unconditionally prefixed, a repo send read
 * `Queue · Queue for myapp · a new session when this repo is free`: one decision
 * announced twice, on the one control a person reads before committing.
 */
export function offlineLabel(label: string): string {
  return /^queue\b/i.test(label) ? label : `Queue · ${label}`;
}

/**
 * ── Re-deciding the WHEN of a row that already exists ────────────────────────
 *
 * **The sheet opened ON a row may not leave a second copy of it behind.**
 *
 * The backlog's *when* verb opens this sheet seeded with `scheduleId`, and for
 * a long time exactly one arm of `dispatchIntent` read that field: the `at`
 * one, where `schedule.save` upserts on the id. Every other WHEN posted a NEW
 * row — `backlog.add`, a fresh ackId — while the timed row it was opened on
 * stayed armed. Pick *now* or *when it's free* on a queued timed row and the
 * words ran twice: once when the desktop was free, and again at the instant.
 *
 * So the route is decided here, once, for every arm:
 *
 *  - `upsert` — a wall-clock rule. `schedule.save`, keyed on the same id.
 *  - `patch` — every other WHEN on a live row: `intent.update` carrying the new
 *    trigger, which is the exact contract *drop the clock* already uses.
 *  - `post` — nothing to re-decide. Either the sheet was not opened on a row,
 *    or the row it was opened on is SPENT (`done`/`canceled`): a spent row will
 *    never run again, so a new one beside it is a second row and not a second
 *    RUN, and refusing there would strand the words instead.
 *  - `refuse` — the cases a patch cannot express and a post would double. Each
 *    says which, in a sentence on the button, before the tap.
 *
 * Pure and pinned (`sendIntent.test.mjs`) because a missed case here is a
 * prompt that runs twice, which is the one failure this app spends an ack
 * ledger, a fingerprint and a settle protocol avoiding.
 */
export type WhenRoute =
  | { kind: "post" }
  | { kind: "upsert" }
  | { kind: "patch" }
  | { kind: "refuse"; why: string };

/** The three refusals, as the button says them. */
export const WHEN_EDIT_RUNNING =
  "those words are running now — changing their when would describe a run that never happened, and posting them again would run them twice";
export const WHEN_EDIT_SWEEP =
  "this row is one repo's work — send it to several repos and it would be a second copy beside it, so drop its clock first";
export const WHEN_EDIT_BUILD =
  "this row runs a prompt — a build is a different thing, so post it as its own and delete this one";

export function whenRoute(i: SendIntent, row: Intent | null | undefined): WhenRoute {
  // A clock is the one WHEN with an upsert of its own, and it works whether or
  // not the host has heard of the id yet — which is what makes an offline edit
  // of an armed schedule replace the row rather than arm a second one.
  //
  // **Except aimed at a SESSION**, which `ScheduleEntry` cannot say: that pair
  // rides `intent.post`, and `post()` is at-most-once BY ID — re-sent on a row
  // that exists it hands the old row straight back, so a re-timing would report
  // success and change nothing. On a live row it is a `patch` like every other
  // re-decision; with no row in hand it is the ordinary post below.
  if (i.when.kind === "at") {
    if (i.target.kind !== "session") return { kind: "upsert" };
    if (!row) return { kind: "post" };
    if (row.state === "done" || row.state === "canceled") return { kind: "post" };
    if (row.state === "starting" || row.state === "running") return { kind: "refuse", why: WHEN_EDIT_RUNNING };
    return { kind: "patch" };
  }
  // No row in hand: either the sheet was not opened on one, or the id names
  // something this phone cannot see. Nothing here can be re-decided.
  if (!row) return { kind: "post" };
  // Already run, or called off. `update()` refuses a terminal row and it is
  // right to: there is nothing left to re-time. A new row beside it is what the
  // person is asking for, and it cannot double anything.
  if (row.state === "done" || row.state === "canceled") return { kind: "post" };
  // Mid-flight. The host refuses a patch here, and a post would be the same
  // words running a second time while the first is still typing.
  if (row.state === "starting" || row.state === "running") return { kind: "refuse", why: WHEN_EDIT_RUNNING };
  // One row cannot become N. A sweep is a different shape of work (`fanout`
  // reads `steps[0]`, one session per repo) and re-aiming this row at it would
  // leave the original armed beside the new ones.
  if (i.target.kind === "repos") return { kind: "refuse", why: WHEN_EDIT_SWEEP };
  // A build carries no prompt and is not an intent this sheet posts at all.
  if (i.target.kind === "shell") return { kind: "refuse", why: WHEN_EDIT_BUILD };
  return { kind: "patch" };
}

/**
 * The receipt for a WHEN re-decided on a row that already exists.
 *
 * It names the row's CONTINUITY — "the same row" — because that is the fact a
 * person cannot see from the outside and the one this whole route exists to
 * keep true: the alternative receipt ("queued") is word-for-word what a second
 * copy would have said. It does NOT assert a state: the host kicks
 * synchronously, so the row may already be blocked behind the ladder or firing
 * by the time this is read.
 */
export function whenPatchToast(w: SendWhen): string {
  if (w.kind === "now") return "re-timed — the same row, and it goes as soon as the desktop can take it";
  if (w.kind === "idle") return "re-timed — the same row, waiting its turn instead of waiting for its clock";
  if (w.kind === "after") return `re-timed — the same row, and it goes ${afterWords(w.title, w.onlyIfOk)}`;
  return "re-timed — the same row";
}
/** …and when the link is down. A re-timing is a decision about an instant that
 *  may arrive in the meantime, so it is never queued for later delivery. */
export const WHEN_PATCH_OFFLINE =
  "no connection — this row's clock lives on the desktop and nothing here changed. Its words are still in the box.";

/** Only a `once` can be out of time (a weekly always finds a day; a window's null is "not armed
 *  YET"). Every form that saves a rule asks this — `sendBlocker`, `buildSchedule.ts`. */
export const clockBlocker = (when: SendWhen, preview: number | null): string | null =>
  when.kind === "at" && preview == null && when.rule.kind === "once" ? "the time it resolves to has already passed" : null;

/**
 * Why the button is off, or null when it is on.
 *
 * The rule `ScheduleSheet` already followed and nothing else did: a disabled
 * button that says nothing is indistinguishable from a broken one. It is
 * enabled the moment there is text — every other answer has a working default,
 * which is the whole point of pre-filling them from context.
 */
/**
 * The one refusal the sheet does not print beside the button: the empty box's
 * own placeholder already asks for the words, and the line under it said the
 * same thing twice. The button still refuses, and still carries it as `title`.
 */
export const EMPTY_PROMPT_BLOCKER = "write the prompt first";

export function sendBlocker(i: SendIntent, preview: number | null, editing?: Intent | null): string | null {
  const text = i.prompts.map((p) => p.trim()).filter(Boolean);
  if (i.target.kind !== "shell" && !text.length) return EMPTY_PROMPT_BLOCKER;
  if (i.target.kind === "repos" && !i.target.dirs.length) return "pick at least one repo";
  if (i.target.kind === "repo" && !i.target.cwd) return "pick the repo it runs in";
  if (i.target.kind === "session" && !i.target.sessionId) return "pick where it goes";
  const late = clockBlocker(i.when, preview); if (late) return late;
  if (i.when.kind === "at" && i.target.kind === "shell") return "a build cannot be scheduled — the clock only fires prompts";
  // A clock aimed at a session is no longer refused: the row remembers the
  // CONVERSATION as well as the process, so a session that has gone by the time
  // the rule fires is reopened rather than waited for (`clockSessionNote`, and
  // `reopensConversation` on both ends). Without a `cwd` there is nothing to
  // reopen it in, and that one case keeps the old sentence.
  if (i.when.kind === "at" && i.target.kind === "session" && !i.target.cwd) {
    return "this session has no repo on it — the clock has nowhere to reopen its conversation";
  }
  // A chain with nothing named is the one shape `cleanTrigger` refuses outright
  // (a trigger with an empty id can never be released and can never say what it
  // is waiting for), so it is refused HERE too, where there is still a picker
  // on screen to answer it with.
  if (i.when.kind === "after" && !i.when.id) return "pick the item it waits for";
  // A build is not an intent this sheet posts — `dispatchIntent` sends it as a
  // `build.run`, which carries no trigger at all — so a chained one would be a
  // control that silently ran straight away. Said, rather than dimmed.
  if (i.when.kind === "after" && i.target.kind === "shell") return "a build cannot wait for another item — a chain only queues prompts";
  // A sweep is ONE prompt: the fan-out executor reads `steps[0]` and nothing
  // else. Chained into several repos, turns 2..n were dropped on the desktop
  // with no sentence at all — the words were typed, reported sent, and gone.
  // Said here, where the *To* row and the composer are both one tap away.
  if (i.when.kind === "after" && i.target.kind === "repos" && text.length > 1) {
    return "a sweep is one prompt — chain a single repo, or send one turn";
  }
  // **The row this sheet was opened ON, when it cannot take the new WHEN.**
  // Said on the button rather than discovered after the tap, because the
  // alternative outcome is a second live row for one piece of work — the words
  // typed twice. `whenRoute` is the one decision; this is it, as a sentence.
  const route = whenRoute(i, editing);
  if (route.kind === "refuse") return route.why;
  // Deliberately NO refusal for a session target here. A chain is released by
  // an event that is usually minutes away, the store can hold a `session`
  // target natively, and the ladder already says out loud what happened when
  // that session went (`sessionGone`). Refusing "when the migration finishes,
  // tell this session" would be refusing the shape people ask for most — and
  // the clock, which fires days out, now keeps its session target too by
  // remembering the conversation instead of the process (`clockSessionNote`).
  return null;
}

