/**
 * What the send sheet SAYS about a time it cannot resolve.
 *
 * `previewOf` returns null for two unrelated reasons and the sheet used to word
 * them as one: a `once` rule whose instant is behind us (genuinely dead), and a
 * `window` rule whose anchor is a usage reset the host has not scraped yet
 * (the normal state of a rule the moment it is written). The second one was
 * told "never — the time it resolves to has passed" and the primary button was
 * BLOCKED, so a schedule anchored to the weekly window could not be saved at
 * all — while the same screen explained, two paragraphs up, that nothing is
 * armed until the host has read the window once.
 *
 *     node --test packages/web/src/sendIntent.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanRule, describeRule } from "@waterplane/shared";
import {
  CHAIN_EMPTY, CHAIN_NOTE, CHAIN_RECENT_MS, GUARD_LABEL, WHEN_EDIT_BUILD, WHEN_EDIT_RUNNING,
  WHEN_EDIT_SWEEP, WINDOW_LABEL, afterWords, anchorWindowOf,
  chainCandidates, chainOkWords, guardWindowOf, guardWords, hoursWords, offlineLabel, previewOf,
  clockSessionNote, leadChoices, leadLabel, leadOk, leadWords, pctChoices, pctOk, pctWords, resumeWhen, sendBlocker, sendLabel, sequentialMeans,
  targetWords, whenPatchToast, seedAfterRescue, whenRoute, whenWords, budgetOfTarget, withBudget, withoutLaunch,
  launchOfTarget, launchWords, withLaunch,
} from "./sendIntent.ts";

const NOW = Date.now();
const names = { repoName: () => "app", sessionTitle: () => "a session", buildName: () => "build" };
const at = (rule) => ({ kind: "at", rule, graceMin: 120 });
const intent = (when) => ({ prompts: ["sweep it"], target: { kind: "repos", dirs: ["/a", "/b"] }, when });

/** The screenshot's rule: 3h before the weekly window resets, 10% headroom. */
const WEEKLY = { kind: "window", window: "weekly", edge: "before", offsetMin: -180, minPctLeft: 10 };

test("a window rule with no reading yet is not armed, and is not refused", () => {
  const when = at(WEEKLY);
  const preview = previewOf(when);
  assert.equal(preview, null, "no reset read ⇒ no instant — the host arms it on the first scrape");
  assert.equal(sendBlocker(intent(when), preview), null, "an unread meter must not block the save");
  const words = whenWords(when, preview);
  assert.match(words, /before the weekly window resets/);
  assert.doesNotMatch(words, /passed/, "it has not passed — it has not been read");
  assert.match(sendLabel(intent(when), names, preview), /^Save for /);
});

test("a window rule resolves to a real instant once the reset is known", () => {
  const weeklyResetAt = NOW + 20 * 3600e3;
  const preview = previewOf(at(WEEKLY), { weeklyResetAt, weeklyPct: 40 });
  assert.equal(preview, weeklyResetAt - 180 * 60e3, "the lead time comes off the reset, not off a clock");
  assert.equal(sendBlocker(intent(at(WEEKLY)), preview), null);
});

test("a reset closer than the lead time is still not a dead schedule", () => {
  // reset − 3h is behind us, so THIS occurrence cannot run. The rule stands:
  // the host re-asks every tick and the next reset arms it again.
  const preview = previewOf(at(WEEKLY), { weeklyResetAt: NOW + 3600e3, weeklyPct: 90 });
  assert.equal(preview, null);
  assert.equal(sendBlocker(intent(at(WEEKLY)), preview), null, "a standing rule is never spent");
});

test("a one-off in the past is the case that IS refused", () => {
  const when = at({ kind: "once", at: NOW - 3600e3, offsetMin: 0 });
  const preview = previewOf(when);
  assert.equal(preview, null);
  assert.equal(sendBlocker(intent(when), preview), "the time it resolves to has already passed");
  assert.equal(whenWords(when, preview), "never — the time it resolves to has passed");
  assert.equal(sendLabel(intent(when), names, preview), "pick a time it can still reach");
});

test("a weekly wall-clock rule always has a next day", () => {
  const when = at({ kind: "weekly", hour: 9, minute: 0, days: [1], offsetMin: 0 });
  const preview = previewOf(when);
  assert.ok(preview != null && preview > NOW);
  assert.equal(sendBlocker(intent(when), preview), null);
});

test("the other blockers still speak first", () => {
  const when = at(WEEKLY);
  assert.equal(sendBlocker({ ...intent(when), prompts: ["  "] }, null), "write the prompt first");
  // A clock aimed at a session is no longer refused — see below — so the one
  // that still speaks here is the session with no repo behind it.
  assert.equal(
    sendBlocker({ prompts: ["x"], target: { kind: "session", sessionId: "s1", cwd: "" }, when }, null),
    "this session has no repo on it — the clock has nowhere to reopen its conversation");
});

/**
 * ── The vocabulary, pinned ───────────────────────────────────────────────────
 *
 * These strings ARE the deliverable of the collapse. Five spellings of "run
 * these words in a new conversation in repo X" and three of "into this session,
 * when it's free" were what made a person open three screenshots and say they
 * could not tell how the features related to each other. A reword here is a
 * decision about that vocabulary, so it is a decision that edits this file.
 */

const NOWISH = { kind: "now" };
const IDLE = { kind: "idle" };
const send = (target, when) => ({ prompts: ["do the thing"], target, when, sequential: false });

test("a repo target is ONE conversation, and says whether it is a new one", () => {
  assert.equal(targetWords({ kind: "repo", cwd: "/a" }, names), "app · a new session");
  assert.equal(targetWords({ kind: "repo", cwd: "/a", resume: true }, names), "app · a new session, continued");
  // The item's own close-when-done answer; absent (inherit) says nothing.
  assert.equal(targetWords({ kind: "repo", cwd: "/a", closeWhenDone: true }, names), "app · a new session, closes when done");
  assert.equal(targetWords({ kind: "repo", cwd: "/a", resume: true, closeWhenDone: false }, names), "app · a new session, continued, kept open");
  // The retired second reading. `work item` named the repo's ONE shared backlog
  // conversation — a thing this UI never drew and could not name — and it is
  // gone from the model, not merely from the segmented control.
  assert.doesNotMatch(targetWords({ kind: "repo", cwd: "/a" }, names), /work item/);
});

test("the repo label restates the whole decision, one per WHEN", () => {
  assert.equal(sendLabel(send({ kind: "repo", cwd: "/a" }, NOWISH), names, null), "Start in app");
  // ONE clause for this wait, and it names what is busy. The button said "when
  // it's free", the toast said "when that repo is free" and the hint said "when
  // a slot is free" — three spellings of one condition, met in that order by
  // anybody using it once.
  assert.equal(
    sendLabel(send({ kind: "repo", cwd: "/a" }, IDLE), names, null),
    "Queue for app · a new session when this repo is free");
  // `Run in X now` and `Open X when it's free` were the other reading's half of
  // the pair. One target means one label: a second wording for the same send is
  // how two surfaces end up describing one thing as two.
  assert.doesNotMatch(sendLabel(send({ kind: "repo", cwd: "/a" }, NOWISH), names, null), /Run in/);
});

test("a live session still reads as joining what is already there", () => {
  const t = { kind: "session", sessionId: "s1", cwd: "/a" };
  assert.equal(sendLabel(send(t, NOWISH), names, null), "Send to a session");
  assert.equal(sendLabel(send(t, IDLE), names, null), "Send to a session when it's free");
});

test("“one at a time” means something different per shape, and nowhere else", () => {
  const repos = sequentialMeans({ kind: "repos", dirs: ["/a", "/b"] });
  assert.match(repos.off, /a fresh session in each repo/);
  // `backlog` is the surviving noun for a repo's waiting work; `work item` is
  // not a word this app uses any more.
  assert.match(repos.on, /backlog/);
  assert.doesNotMatch(repos.on, /work item/);
  assert.ok(sequentialMeans({ kind: "repo", cwd: "/a" }), "a new session can be serialized per repo");
  assert.equal(sequentialMeans({ kind: "session", sessionId: "s", cwd: "/a" }), null);
  assert.equal(sequentialMeans({ kind: "shell", cwd: "/a", buildId: "b" }), null);
});

test("a repo send is never blocked for want of a session", () => {
  // It opens one. The old reading needed somebody to have started the repo's
  // shared conversation first, which is what "open a session for this item
  // first" was refusing on a dimmed button.
  assert.equal(sendBlocker(send({ kind: "repo", cwd: "/a" }, IDLE), null), null);
  assert.equal(sendBlocker(send({ kind: "repo", cwd: "" }, IDLE), null), "pick the repo it runs in");
});

/**
 * ── Picking a time while To names a session ──────────────────────────────────
 *
 * The composer's one errand (*elsewhere or later…*) opens the sheet seeded To =
 * *this session*. Picking *at a time* on top of that used to be refused ("a
 * session id is per-boot"), and the sheet softened the refusal by re-aiming the
 * send at that session's repo. Both were right about the ID and wrong about the
 * ASK: somebody scheduling a reply to a waiting session for after the weekly
 * reset got a NEW, EMPTY session in that repo, with nothing the reply was about
 * in its window.
 *
 * The row remembers the CONVERSATION instead (`IntentTarget.resumeConvId`,
 * snapshotted host-side), so the pair is sayable and the target stands.
 */
test("a clock may name a session, and the sheet says what happens if it has gone", () => {
  const t = { kind: "session", sessionId: "s1", cwd: "/dev/myapp" };
  assert.equal(sendBlocker({ prompts: ["x"], target: t, when: at(WEEKLY), sequential: false }, NOW + 3600e3), null,
    "the pair the composer seeds must not open on a dead button");
  // The To row keeps saying what it always said: nothing was re-aimed.
  assert.equal(targetWords(t, names), "a session");
  const said = clockSessionNote(t, at(WEEKLY), names.sessionTitle("s1"));
  assert.match(said, /a session/, "it names where the words are going");
  assert.match(said, /reopens the conversation/i, "it says what happens when the process has gone");
  assert.doesNotMatch(said, /work item/, "the retired noun stays retired");
});

test("nothing is promised about a clock the sheet is not on, or a session with no repo", () => {
  const t = { kind: "session", sessionId: "s1", cwd: "/dev/myapp" };
  // `now`, `when it's free` and a chain all name a session natively and reopen
  // nothing — the promise is the clock's alone.
  assert.equal(clockSessionNote(t, { kind: "now" }, "a session"), null);
  assert.equal(clockSessionNote(t, IDLE, "a session"), null);
  assert.equal(clockSessionNote(t, AFTER, "a session"), null);
  // No repo ⇒ nowhere to reopen the conversation, so no promise and no send.
  assert.equal(clockSessionNote({ kind: "session", sessionId: "s1", cwd: "" }, at(WEEKLY), "a session"), null);
  assert.equal(clockSessionNote({ kind: "repo", cwd: "/dev/myapp" }, at(WEEKLY), "a session"), null);
});

test("a session with no repo is still refused — there is nowhere to reopen it", () => {
  // The honest half of the same rule: a clock over a target the sheet cannot
  // derive a repo from has no directory to open the conversation in, and
  // guessing one would run somebody's prompt somewhere nobody chose.
  const t = { kind: "session", sessionId: "s1", cwd: "" };
  assert.equal(
    sendBlocker({ prompts: ["x"], target: t, when: at(WEEKLY), sequential: false }, null),
    "this session has no repo on it — the clock has nowhere to reopen its conversation");
});

/**
 * ── Phase 3: the three additions to WHEN, and the words for each ─────────────
 *
 * The scheduling half of this sheet is the one part that was asked to get MORE
 * expressive rather than smaller, and every clause below is a sentence somebody
 * reads before committing to a rule they will then not look at again for a
 * week. A reword here is a decision about what a schedule PROMISES, so it is a
 * decision that edits this file.
 */

const AFTER = { kind: "after", id: "i_mig", title: "migrate the schema" };
const chained = (target, when = AFTER) => ({ prompts: ["review it"], target, when, sequential: false });

test("a chain names what it waits for, and whether the condition is on", () => {
  assert.equal(afterWords("migrate the schema"), "after “migrate the schema”");
  assert.equal(afterWords("migrate the schema", true), "after “migrate the schema”, only if it worked");
  // The snapshot is optional (`IntentTrigger.after.title`), so every sentence
  // has to read without it. Vague is fixable by looking; invented is not.
  assert.equal(afterWords(undefined), "after the item before it");
  assert.equal(afterWords("", true), "after the item before it, only if it worked");
  // The collapsed *When* row is the glance, so it carries the whole clause.
  assert.equal(whenWords(AFTER, null), "after “migrate the schema”");
  assert.equal(whenWords({ ...AFTER, onlyIfOk: true }, null), "after “migrate the schema”, only if it worked");
});

test("the chain label restates the whole decision, one per WHERE", () => {
  assert.equal(
    sendLabel(chained({ kind: "repo", cwd: "/a" }), names, null),
    "Queue for app · a new session after “migrate the schema”");
  assert.equal(
    sendLabel(chained({ kind: "session", sessionId: "s1", cwd: "/a" }), names, null),
    "Send to a session after “migrate the schema”");
  // NOT `Queue in 2 repos` — that is the sequential wording, on the one target
  // that is never sequential. A `{kind:"repos"}` intent is the fan-out: every
  // repo starts together and `sequential` is not read in that arm at all.
  assert.equal(
    sendLabel(chained({ kind: "repos", dirs: ["/a", "/b"] }), names, null),
    "Fan out to 2 repos after “migrate the schema”");
  assert.equal(
    sendLabel(chained({ kind: "repos", dirs: ["/a"] }), names, null),
    "Fan out to app after “migrate the schema”");
});

/**
 * A sweep is ONE prompt.
 *
 * The fan-out executor reads `steps[0]` and nothing else. Chained into several
 * repos, turns 2..n were dropped on the DESKTOP with no sentence anywhere: the
 * words were typed, the sheet reported a send and cleared the draft, and the
 * turns were gone. The `at` arm has toasted about exactly this since it was
 * written; the `after` arm said nothing.
 */
test("a chain into several repos is refused in words while the composer is still on screen", () => {
  const two = { ...chained({ kind: "repos", dirs: ["/a", "/b"] }), prompts: ["first", "second"] };
  assert.equal(sendBlocker(two, null), "a sweep is one prompt — chain a single repo, or send one turn");
  // One turn is fine, and so is a chain into ONE repo — that rides as a work
  // item carrying the whole chain, which is what `deliverChain` runs.
  assert.equal(sendBlocker(chained({ kind: "repos", dirs: ["/a", "/b"] }), null), null);
  assert.equal(
    sendBlocker({ ...chained({ kind: "repo", cwd: "/a" }), prompts: ["first", "second"] }, null),
    null);
});

/**
 * The button with the link down.
 *
 * Every offline send is a queued send and the button says so — except where the
 * label already opens with that verb. Unconditionally prefixed, the commonest
 * label on this sheet read `Queue · Queue for app · a new session when this
 * repo is free`: one decision announced twice, on the one control a person
 * reads before committing.
 */
test("the offline prefix is not added to a label that already says Queue", () => {
  assert.equal(offlineLabel("Queue for app · a new session when this repo is free"),
    "Queue for app · a new session when this repo is free");
  assert.equal(offlineLabel("Start in app"), "Queue · Start in app");
  assert.equal(offlineLabel("Fan out to 2 repos"), "Queue · Fan out to 2 repos");
  assert.equal(offlineLabel("Send to a session"), "Queue · Send to a session");
});

/**
 * The headroom guard's own control is labelled by its VERB.
 *
 * Ten lines above it the anchor segmented already reads `session window` /
 * `weekly window`. Wearing the same two nouns twice on one screen asks the
 * reader the same question twice, with the difference carried only in a
 * section-hint — and the two questions are about different windows as often as
 * the same one, which is why `guardWindow` exists at all.
 */
test("the guard segmented and the anchor segmented do not wear the same two labels", () => {
  assert.equal(GUARD_LABEL.session, "checks the session meter");
  assert.equal(GUARD_LABEL.weekly, "checks the weekly meter");
  assert.notEqual(GUARD_LABEL.session, WINDOW_LABEL.session);
  assert.notEqual(GUARD_LABEL.weekly, WINDOW_LABEL.weekly);
  // The prose keeps the nouns — `guardWords` and `describeRule` are sentences,
  // not controls, and "checks the session meter" does not read as English there.
  assert.match(guardWords({ kind: "window", window: "session", edge: "before", minPctLeft: 30, guardWindow: "weekly" }),
    /the weekly window/);
});

test("a chain with nothing picked is refused in words, not on a dimmed segment", () => {
  assert.equal(
    sendBlocker(chained({ kind: "repo", cwd: "/a" }, { kind: "after", id: "" }), null),
    "pick the item it waits for");
  assert.equal(
    sendBlocker(chained({ kind: "shell", cwd: "/a", buildId: "b" }), null),
    "a build cannot wait for another item — a chain only queues prompts");
});

test("a chain may name a live session — and so may a clock now", () => {
  // A chain is released by an event minutes away and the store holds a
  // `session` target natively; a clock may fire days out, and holds one because
  // the row remembers the CONVERSATION as well as the process. Refusing either
  // would refuse the shape people ask for most: "when the migration finishes,
  // tell THIS session", and "after the reset, answer THIS session".
  const t = { kind: "session", sessionId: "s1", cwd: "/dev/myapp" };
  assert.equal(sendBlocker(chained(t), null), null);
  assert.equal(sendBlocker({ prompts: ["x"], target: t, when: at(WEEKLY), sequential: false }, NOW + 3600e3), null);
});

test("the chip says what it does BOTH ways, and the off state carries the case for it", () => {
  assert.match(chainOkWords(true), /fails too and says so/);
  assert.match(chainOkWords(undefined), /runs either way/);
  assert.match(chainOkWords(undefined), /tell me what happened/, "the sentence names the case it is the default for");
  assert.match(CHAIN_NOTE, /no deadline/, "a chain waits through a shut desktop — that is the whole default");
  assert.match(CHAIN_NOTE, /not a schedule/, "it lands in Activity as work, and the reader is told where to look");
  assert.match(CHAIN_EMPTY, /Nothing to wait for/, "an empty picker is a sentence, never a dimmed control");
});

/** A durable row as the host holds one — the same shape `activityRows.test.mjs`
 *  builds, because there is one store and one vocabulary over it. */
const row = (over = {}) => ({
  id: "i1", cwd: "/dev/myapp",
  payload: { kind: "prompt", steps: ["add the export button"] },
  target: { kind: "repo" }, trigger: { kind: "idle" },
  state: "queued", createdAt: NOW, ...over,
});

test("the chain picker offers what is running, then what waits, then what just finished", () => {
  const rows = [
    row({ id: "done", state: "done", settledAt: NOW - 60e3 }),
    row({ id: "queued", state: "queued", order: 1 }),
    row({ id: "running", state: "running" }),
    row({ id: "older", state: "done", settledAt: NOW - 120e3 }),
    row({ id: "blocked", state: "blocked", order: 0 }),
  ];
  assert.deepEqual(
    chainCandidates(rows, NOW).map((i) => i.id),
    ["running", "blocked", "queued", "done", "older"],
    "a flat newest-first order buried the running row under everything queued after it");
});

test("the picker drops what cannot release a chain, and the row being edited", () => {
  const rows = [
    row({ id: "stale", state: "done", settledAt: NOW - CHAIN_RECENT_MS - 1 }),
    row({ id: "fresh", state: "done", settledAt: NOW - CHAIN_RECENT_MS + 1 }),
    // Settled, and releasing a chain behind it immediately with `ok: false` —
    // a surprising thing to offer and a pointless one to pick.
    row({ id: "canceled", state: "canceled", settledAt: NOW }),
    row({ id: "self", state: "running" }),
  ];
  assert.deepEqual(chainCandidates(rows, NOW, "self").map((i) => i.id), ["fresh"]);
  // A FAILED row stays: whether the predecessor succeeded is exactly what the
  // chip is about, so a picker that hid it would be asking about something it
  // had refused to show.
  assert.deepEqual(
    chainCandidates([row({ id: "f", state: "failed", settledAt: NOW })], NOW).map((i) => i.id), ["f"]);
});

test("a RECURRING rule is never offered as a predecessor — it never finishes", () => {
  // The pin, and why it exists: `facts.settled` is terminal-only by contract
  // and a standing rule never goes terminal, so a chain hung off one reads
  // "waits for … to finish" on every tick for ever, under the most reassuring
  // sentence in the vocabulary. Offering it is offering a way to lose work.
  const daily = { kind: "at", rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", offsetMin: 0 }, graceMin: 60 };
  const rows = [
    row({ id: "daily", state: "queued", trigger: daily }),
    row({ id: "window", state: "queued", trigger: { kind: "at", rule: { kind: "window", window: "session", edge: "after", offsetMin: 0 }, graceMin: 60 } }),
    row({ id: "work", state: "running" }),
  ];
  assert.deepEqual(chainCandidates(rows, NOW).map((i) => i.id), ["work"]);

  // A ONE-OFF is a real predecessor: it runs once and settles, which is
  // exactly what a chain is waiting for. Recurrence, not the anchor, is the
  // question — a `weekly` or `window` rule marked `oneShot` ends like any
  // other row (`ruleRecurs`, the one reading both ends share).
  const once = [
    row({ id: "once", state: "queued", trigger: { kind: "at", rule: { kind: "once", at: NOW + 60e3 }, graceMin: 60 } }),
    row({ id: "oneshot", state: "queued", trigger: { kind: "at", rule: { ...daily.rule, oneShot: true }, graceMin: 60 } }),
  ];
  assert.deepEqual(chainCandidates(once, NOW).map((i) => i.id).sort(), ["once", "oneshot"]);
});

/**
 * ── S3: which meter the headroom condition reads ─────────────────────────────
 *
 * One `window` field answered two questions — what this rule waits for, and
 * what it asks about — so naming one meant giving up the other, and the shape
 * people kept asking for was exactly the one it could not hold.
 */
const winRule = (over = {}) => ({ kind: "window", window: "session", edge: "before", offsetMin: -60, ...over });

test("a guard on the same window is the condition it always was", () => {
  const said = guardWords(winRule({ minPctLeft: 40 }));
  assert.match(said, /40% of the session window is left/);
  assert.match(said, /unreadable one stops it too/, "failing closed is stated, not left to be discovered");
  assert.equal(guardWindowOf(winRule({ minPctLeft: 40 })), "session", "absent ⇒ the anchor's own meter");
  assert.equal(anchorWindowOf(winRule({})), "session");
  assert.equal(anchorWindowOf(winRule({ window: "weekly" })), "weekly");
});

test("the instruction the whole field exists for reads as two windows", () => {
  // "right after the session window resets, but only if 30% of the week is left"
  const rule = winRule({ edge: "after", offsetMin: 0, minPctLeft: 30, guardWindow: "weekly" });
  assert.equal(guardWindowOf(rule), "weekly");
  const said = guardWords(rule);
  assert.match(said, /waits for the session window to reset/, "which one it is ANCHORED to");
  assert.match(said, /asks about the weekly window/, "which one it READS");
  assert.match(said, /at least 30%/);
  // And the shared sentence on the row agrees, so the sheet and the card say
  // the same thing about one rule.
  assert.match(describeRule(rule), /right after the session window resets, only if 30% of the week is left/);
});

test("the one shape that cannot be evaluated is SAID, never dimmed and never refused", () => {
  const rule = winRule({ edge: "after", offsetMin: 0, minPctLeft: 30 });
  const said = guardWords(rule);
  assert.match(said, /empty by definition/, "why it cannot be asked");
  assert.match(said, /the condition is dropped and the rule runs every time/, "what will actually happen");
  assert.match(said, /Point it at the weekly window/, "what to do instead");
  // Savable exactly as written — the clause goes, the rule does not.
  assert.equal(sendBlocker({ prompts: ["x"], target: { kind: "repo", cwd: "/a" }, when: at(rule), sequential: false }, null), null);
});

/**
 * ── S2: quiet hours ──────────────────────────────────────────────────────────
 *
 * Not a second anchor: it never moves the occurrence, it only decides whether
 * the instant the anchor landed on is one the machine may speak at.
 */
test("no window is the old behaviour, and says what setting one would do", () => {
  const said = hoursWords({ kind: "weekly", hour: 3, minute: 0 });
  assert.match(said, /^Any hour\./);
  assert.match(said, /measured from that opening, not from the anchor/,
    "the grace moving with the window is the surprising half, so it is the half that is said");
});

test("a window that wraps midnight is expressible and reads as one", () => {
  const rule = { kind: "weekly", hour: 3, minute: 0, hours: { from: 22 * 60, to: 7 * 60 } };
  const said = hoursWords(rule);
  assert.match(said, /Only 22:00–07:00 — overnight, through midnight/);
  assert.match(said, /waits for 22:00/, "the opening, which is what lateness is counted from");
  // The row says it the same way — one spelling (`describeHours`), two screens.
  assert.match(describeRule(rule), /, only 22:00–07:00$/);
});

test("a daytime window names its zone where there is one", () => {
  assert.match(
    hoursWords({ kind: "weekly", hour: 3, tz: "Europe/Berlin", hours: { from: 7 * 60, to: 22 * 60 } }),
    /Only 07:00–22:00, Europe\/Berlin\./);
});

test("a window with no width is a sentence, not a silently dropped clause", () => {
  const said = hoursWords({ kind: "weekly", hours: { from: 9 * 60, to: 9 * 60 } });
  assert.match(said, /no width/);
  assert.match(said, /would run at any hour/, "what the host will actually do with it");
  assert.match(said, /move one of them/, "and how to fix it");
  // `cleanRule` is the other half of the same claim: it drops rather than guesses.
  assert.equal(cleanRule({ kind: "weekly", hours: { from: 540, to: 540 } }).hours, undefined);
});

/**
 * ── The decision survives the annotator, not just the words ──────────────────
 *
 * This sheet promises two things across a trip out to the annotator and back:
 * the WORDS survive (the persisted draft) and the DECISION survives
 * (`SendResume`). The second promise had a hole exactly where the sheet says
 * out loud that it does not: leaving the clock for `now` parks the whole rule
 * and the row reads *"The schedule you set is kept — tap at a time or a usage
 * window to get it back."* Attaching a picture then reported only the three
 * live answers, so the sheet remounted with the rule gone and the sentence
 * gone with it — seven taps deleted, after being told they were kept.
 */
test("a parked schedule comes back from the round trip, rule and all", () => {
  const rule = { kind: "weekly", days: [4], hour: 16, minute: 0, graceMin: 120 };
  const parked = { kind: "at", rule, name: "thursday sweep", waitUntilFree: true };

  // The journey: set a rule, tap `now` to see what it says (which parks it),
  // hand the sheet to the annotator, come back.
  const reported = { target: { kind: "repo", cwd: "/r" }, when: { kind: "now" }, sequential: false, parkedAt: parked };
  const back = resumeWhen(reported, { kind: "idle" });
  assert.deepEqual(back.when, { kind: "now" }, "the live answer is the one that was showing");
  assert.deepEqual(back.parkedAt, parked, "…and the rule behind it is still there");
  // The whole `when`, never just its rule: grace, the name and *wait until
  // free* are part of the same decision, and restoring three of four fields is
  // its own small delete.
  assert.equal(back.parkedAt.name, "thursday sweep");
  assert.equal(back.parkedAt.waitUntilFree, true);

  // A first mount has no resume: the seed opens the sheet, and nothing is
  // parked — a hint about a kept schedule with no schedule behind it is worse
  // than no hint.
  const fresh = resumeWhen(null, { kind: "idle" });
  assert.deepEqual(fresh.when, { kind: "idle" });
  assert.equal(fresh.parkedAt, null);
  // …and with neither, the app's default answer.
  assert.deepEqual(resumeWhen(null, undefined).when, { kind: "now" });
  // A resume ALWAYS wins, including when what it resumed was `now`.
  assert.deepEqual(resumeWhen({ when: { kind: "now" } }, { kind: "at", rule }).when, { kind: "now" });
});


/**
 * ── The `when` button may not leave two live rows for one intent ─────────────
 *
 * The backlog's *when* verb opens this sheet seeded with the row's id, and for
 * a while exactly one arm read it: `at`, where `schedule.save` upserts. Pick
 * *now* or *when it's free* on a queued timed row and the sheet posted a NEW
 * row — fresh ackId, `backlog.add` — while the timed one stayed armed. The
 * words ran twice: once in turn, once at their instant.
 *
 * These pin the route itself rather than the call sites, because the route is
 * the thing a new WHEN anchor would have to be added to.
 */
const liveRow = (over = {}) => ({
  id: "i1", cwd: "/dev/myapp", state: "queued",
  payload: { kind: "prompt", steps: ["tidy"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: { kind: "once", at: NOW + 3600e3 }, graceMin: 120 },
  nextAt: NOW + 3600e3, createdAt: NOW - 3600e3, ...over,
});
const reSend = (when, target = { kind: "repo", cwd: "/dev/myapp" }) => ({ prompts: ["tidy"], target, when, sequential: false });

test("every WHEN on a live row re-decides that row — none of them posts a second one", () => {
  for (const when of [{ kind: "now" }, { kind: "idle" }, { kind: "after", id: "i0", title: "the migration" }]) {
    assert.deepEqual(whenRoute(reSend(when), liveRow()), { kind: "patch" }, `${when.kind} must patch, never post`);
  }
  // A clock keeps its own upsert: `schedule.save` is keyed on the same id, and
  // it works whether or not the host has heard of the row yet.
  assert.deepEqual(whenRoute(reSend(at({ kind: "once", at: NOW + 3600e3 })), liveRow()), { kind: "upsert" });
  // …except aimed at a SESSION, which no `ScheduleEntry` can name: that pair
  // rides `intent.post`, and posting is at-most-once BY ID — re-sent on a live
  // row it hands the old row back, so a re-timing would report success and
  // change nothing. On a live row it patches like every other re-decision, and
  // with no row in hand it is an ordinary post.
  const clockAtSession = at({ kind: "once", at: NOW + 3600e3 });
  const sessTarget = { kind: "session", sessionId: "s1", cwd: "/dev/myapp" };
  assert.deepEqual(whenRoute(reSend(clockAtSession, sessTarget), liveRow()), { kind: "patch" });
  assert.deepEqual(whenRoute(reSend(clockAtSession, sessTarget), null), { kind: "post" });
  assert.deepEqual(whenRoute(reSend(clockAtSession, sessTarget), liveRow({ state: "done" })), { kind: "post" });
  assert.deepEqual(whenRoute(reSend(clockAtSession, sessTarget), liveRow({ state: "running" })),
    { kind: "refuse", why: WHEN_EDIT_RUNNING });
  // A blocked row is still a live row — it is waiting on a rung, not finished.
  assert.deepEqual(whenRoute(reSend({ kind: "idle" }), liveRow({ state: "blocked" })), { kind: "patch" });
  // …and a FAILED one is the case the whole feature is for: its instant went by
  // while the desktop slept, and the host's own carve-out revives it on a patch
  // that carries a trigger.
  assert.deepEqual(whenRoute(reSend({ kind: "idle" }), liveRow({ state: "failed", nextAt: null })), { kind: "patch" });
});

test("no row to re-decide ⇒ an ordinary post, and a SPENT row is not a double run", () => {
  assert.deepEqual(whenRoute(reSend({ kind: "idle" }), null), { kind: "post" });
  // Already run, or called off: the host refuses a patch on a terminal row and
  // is right to. A new row beside it cannot double anything — the old one will
  // never run again — and refusing here would strand the words instead.
  assert.deepEqual(whenRoute(reSend({ kind: "now" }), liveRow({ state: "done" })), { kind: "post" });
  assert.deepEqual(whenRoute(reSend({ kind: "now" }), liveRow({ state: "canceled" })), { kind: "post" });
});

test("the three cases a re-decide cannot express are REFUSED, on the button, in words", () => {
  // Mid-flight: the host refuses the patch, and a post would be the same words
  // typed a second time while the first lot is still going in.
  for (const state of ["starting", "running"]) {
    assert.deepEqual(whenRoute(reSend({ kind: "idle" }), liveRow({ state })), { kind: "refuse", why: WHEN_EDIT_RUNNING });
  }
  // One row cannot become N. A sweep is a different shape of work, and posting
  // one would leave the original armed beside it.
  assert.deepEqual(
    whenRoute(reSend({ kind: "idle" }, { kind: "repos", dirs: ["/a", "/b"] }), liveRow()),
    { kind: "refuse", why: WHEN_EDIT_SWEEP },
  );
  assert.deepEqual(
    whenRoute(reSend({ kind: "now" }, { kind: "shell", cwd: "/a", buildId: "b1" }), liveRow()),
    { kind: "refuse", why: WHEN_EDIT_BUILD },
  );
  // And the sentence reaches the BUTTON, not a toast after the tap: a title is
  // invisible on a phone, and this is a refusal a person has to read first.
  assert.equal(sendBlocker(reSend({ kind: "idle" }), null, liveRow({ state: "running" })), WHEN_EDIT_RUNNING);
  assert.equal(sendBlocker(reSend({ kind: "idle" }), null, liveRow()), null, "an ordinary re-decide is not blocked");
  assert.equal(sendBlocker(reSend({ kind: "idle" }), null), null, "and neither is a plain send");
});

test("the receipt says the row is the SAME row — the one fact a second copy would have hidden", () => {
  assert.match(whenPatchToast({ kind: "idle" }), /^re-timed — the same row, waiting its turn/);
  assert.match(whenPatchToast({ kind: "now" }), /^re-timed — the same row, and it goes as soon as/);
  assert.equal(
    whenPatchToast({ kind: "after", id: "i0", title: "the migration", onlyIfOk: true }),
    "re-timed — the same row, and it goes after \u201cthe migration\u201d, only if it worked",
  );
});

// ── A refused rescue keeps the words and drops the SOURCE ────────────
// `seedSheetDraft` may refuse (the pad is full), and then it writes nothing:
// the slot still holds the OLD draft and `SendSheet` opens on that. The seed's
// `padId`/`ackId`, left on, make the next Send post the stale draft and then
// retire a pad note and a queue row whose words never went anywhere.

test("a refused rescue drops the seed's source, and keeps everything else", () => {
  const seed = { prompts: ["new words"], padId: "note-1", ackId: "ack-1", cwdHint: "/r", origin: "From the pad" };
  const out = seedAfterRescue(seed, "refused");
  assert.equal(out.padId, undefined, "the sheet is composing the RESCUED draft, not this note");
  assert.equal(out.ackId, undefined, "and not this queue row either");
  assert.equal(out.cwdHint, "/r", "where the words came from is still true");
  assert.equal(out.origin, "From the pad");
  assert.deepEqual(out.prompts, ["new words"]);
  // The caller's object is not mutated — `openSend` holds the seed it was
  // handed and a sheet may be re-seeded from it.
  assert.equal(seed.padId, "note-1");
});

test("a rescue that WORKED leaves the seed exactly as it is", () => {
  const seed = { prompts: ["x"], padId: "note-1", ackId: "ack-1" };
  // `seeded` (nothing was in the slot) and `kept` (it became a pad note) both
  // mean the sheet opens on THIS seed's words, so the source is still this
  // seed's to retire.
  assert.equal(seedAfterRescue(seed, "seeded"), seed);
  assert.equal(seedAfterRescue(seed, "kept"), seed);
});

test("a refusal on a seed with no source is the same object", () => {
  const seed = { prompts: ["x"] };
  assert.equal(seedAfterRescue(seed, "refused"), seed, "nothing to drop, nothing to copy");
});

// ── The headroom condition's own value ───────────────────────────────

test("a typed percentage is kept only when it is one", () => {
  assert.equal(pctOk("30"), 30);
  assert.equal(pctOk(" 30 "), 30, "a number field hands back what was typed, spaces included");
  assert.equal(pctOk("30.4"), 30, "rounded, because the host stores an int");
  assert.equal(pctOk(1), 1);
  assert.equal(pctOk(100), 100);
  assert.equal(pctOk("0"), null, "0% left is every meter — `no condition` written the long way");
  assert.equal(pctOk("101"), null);
  assert.equal(pctOk("-5"), null);
  assert.equal(pctOk(""), null);
  assert.equal(pctOk("half"), null);
  assert.equal(pctOk(null), null, "an unset key reads as nothing saved, never as 0");
  assert.equal(pctOk(undefined), null);
});

test("the chips are the fixed four plus whatever was actually typed, in order", () => {
  assert.deepEqual(pctChoices(null, null), [10, 25, 50, 75], "nothing typed, nothing added");
  assert.deepEqual(pctChoices(30, null), [10, 25, 30, 50, 75], "a saved value sits among its equals");
  assert.deepEqual(pctChoices(null, 90), [10, 25, 50, 75, 90],
    "a rule written elsewhere opens with its own condition offered, so it can be lit");
  assert.deepEqual(pctChoices(30, 90), [10, 25, 30, 50, 75, 90]);
  assert.deepEqual(pctChoices(25, 50), [10, 25, 50, 75], "a typed value that matches a preset is not a second chip");
  assert.deepEqual(pctChoices(0, 101), [10, 25, 50, 75], "an unusable value never becomes a chip");
});

test("the field says what it wants and refuses nothing", () => {
  assert.equal(pctWords("30"), null, "usable — the hint says what is kept, not what is wrong");
  assert.equal(pctWords("100"), null);
  assert.match(pctWords(""), /1 to 100/, "empty asks rather than complains");
  assert.match(pctWords("0"), /no condition/, "the 0 case names the control that already means it");
  assert.match(pctWords("120"), /100%/, "out of range says what the meter reads at either end");
  assert.match(pctWords("half"), /not a number/);
});

// ── How long before the reset: a typed lead ─────────────────────────

test("a typed lead is read as a duration, a bare number as minutes", () => {
  assert.equal(leadOk("45"), 45);
  assert.equal(leadOk("45m"), 45);
  assert.equal(leadOk("4h"), 240);
  assert.equal(leadOk("1.5h"), 90);
  assert.equal(leadOk("1h30"), 90);
  assert.equal(leadOk(" 1h 30m "), 90, "spaces are what a phone keyboard puts in");
  assert.equal(leadOk("24h"), 1440);
  assert.equal(leadOk("25h"), null, "past a day the host would clamp it, and the chip would lie");
  assert.equal(leadOk("0"), null, "zero before the reset is `right after it resets`");
  assert.equal(leadOk("-2h"), null);
  assert.equal(leadOk("soon"), null);
  assert.equal(leadOk(""), null);
  assert.equal(leadOk(null), null);
});

test("lead chips are the presets plus what was typed, in order and labelled", () => {
  assert.deepEqual(leadChoices(null, null), [30, 60, 120, 180, 360]);
  assert.deepEqual(leadChoices(240, 60), [30, 60, 120, 180, 240, 360]);
  assert.deepEqual(leadChoices(null, 720), [30, 60, 120, 180, 360, 720], "a rule's own lead is offered so it can be lit");
  assert.deepEqual(leadChoices(0, 2000), [30, 60, 120, 180, 360]);
  assert.deepEqual([45, 60, 90, 720].map(leadLabel), ["45m", "1h", "1h30m", "12h"]);
});

test("the lead field says what it wants and refuses nothing", () => {
  assert.equal(leadWords("4h"), null);
  assert.match(leadWords(""), /45m, 4h/);
  assert.match(leadWords("0"), /right after it resets/);
  assert.match(leadWords("-2h"), /minus/);
  assert.match(leadWords("30h"), /24h/);
  assert.match(leadWords("soon"), /not a duration/);
});

test("re-time mode refuses only on the WHEN — no words, no target to ask about", async () => {
  const { retimeBlocker, retimeWhenLabel } = await import("./sendIntent.ts");
  const once = (at) => ({ kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 });
  assert.equal(retimeBlocker(once(Date.now() + 3600e3), Date.now() + 3600e3, 3), null, "no \"write the prompt first\" here");
  assert.equal(retimeBlocker(once(1), null, 3), "the time it resolves to has already passed");
  assert.equal(retimeBlocker({ kind: "after", id: "" }, null, 2), "pick the item it waits for");
  assert.equal(retimeBlocker({ kind: "idle" }, null, 0), "tick the rows to move first");
  const win = { kind: "at", rule: { kind: "window", window: "weekly", edge: "before", offsetMin: -60, oneShot: true }, graceMin: 120 };
  assert.equal(retimeBlocker(win, null, 2), null, "a window rule with no reading yet is not refused");
  assert.equal(retimeWhenLabel(4, "when it's free"), "Re-time these 4 — when it's free");
  assert.equal(retimeWhenLabel(1, "now"), "Re-time it — now");
});

test("re-time says what holds it, and names the way past it for what it is", async () => {
  const { RETIME_NOW_SEG, retimeHeldWords, pastBudgetLabel, pastBudgetNote, pastBudgetConfirm, pastBudgetToast } = await import("./sendIntent.ts");
  assert.equal(RETIME_NOW_SEG, "next in line", "a queued row's now is never 'now'");
  assert.equal(retimeHeldWords(null, 5, 3), null, "nothing holding ⇒ no sentence");
  assert.equal(retimeHeldWords("paused — over the budget", null, 0), null, "the budget holds none of THESE ⇒ no sentence");
  assert.match(retimeHeldWords("paused — 96% of the weekly window used, over the 75% budget", null, 2),
    /^Held: paused — 96%.*wait for the budget like the rest of the queue\.$/);
  // The bulk release lifts the BUDGET and nothing else — it used to be
  // "run all 4 now, past the budget", which sent `intent.run` per row and put
  // four agents in one checkout at the same second.
  assert.equal(pastBudgetLabel(4), "let these 4 past the budget");
  assert.equal(pastBudgetLabel(1), "let it past the budget");
  assert.match(pastBudgetNote(4, 4), /still run one at a time/);
  assert.match(pastBudgetNote(4, 4), /wait until free/);
  assert.match(pastBudgetNote(4, 4), /until this budget window resets/, "the waiver is scoped, and says so");
  assert.doesNotMatch(pastBudgetNote(1, 1), /smart pick/, "the smart pick is gone (2026-10-16), and so is its clause");
  assert.doesNotMatch(pastBudgetNote(4, 4), /at once|this second/, "a waiver never promises now");
  assert.doesNotMatch(pastBudgetNote(1, 1), /one at a time/, "one row has no one-at-a-time to speak of");
  assert.ok(pastBudgetNote(2, 4).startsWith("2 of the 4 you ticked"), "the count is the held ones, and it says what it left out");
  assert.doesNotMatch(pastBudgetNote(3, 3), /you ticked/);
  assert.equal(pastBudgetConfirm(3), "let 3 past the budget?");
  assert.equal(pastBudgetToast(3), "let 3 past the budget — they run in turn");
  assert.equal(pastBudgetToast(1), "let it past the budget — it runs in turn");
});

test("budgetHeldIds is the one cut behind the count and the waiver", async () => {
  const { budgetHeldIds, isBudgetHeld } = await import("./sendIntent.ts");
  const NOW = 1_700_000_000_000;
  const row = (id, over = {}) => ({ id, cwd: "/r", state: "blocked", blockReason: "budget", trigger: { kind: "idle" }, ...over });
  const at = (nextAt) => ({ trigger: { kind: "at", rule: { kind: "once", at: nextAt }, graceMin: 60 }, nextAt });
  const intents = [
    row("a"),
    row("b", { blockReason: "gate" }),
    row("c", { pastBudget: { until: NOW + 60_000 } }),
    row("d", { state: "running" }),
    row("e", { blockReason: "serial" }),
    row("f", { state: "queued" }),
    row("g", { state: "done" }),
    // An EXPIRED waiver is no waiver: the budget holds it again.
    row("h", { pastBudget: { until: NOW - 1 } }),
    // Rung 2 sits above the trigger, so a row whose clock is tomorrow reads
    // `budget` too — but it would not run now, so there is nothing to waive.
    row("i", at(NOW + 86_400_000)),
    row("j", at(NOW - 60_000)),
    // A chain is due only once its predecessor settled the way it asked.
    row("k", { trigger: { kind: "after", id: "g" } }),
    row("l", { trigger: { kind: "after", id: "a" } }),
    row("m", { trigger: { kind: "files", needs: ["x"], deadlineAt: NOW + 1 } }),
  ];
  assert.deepEqual(budgetHeldIds(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "gone"], intents, NOW), ["a", "f", "h", "j", "k"]);
  assert.deepEqual(budgetHeldIds([], intents, NOW), []);
  // The header chip's count reads the same test.
  const byId = new Map(intents.map((i) => [i.id, i]));
  assert.deepEqual(intents.filter((i) => isBudgetHeld(i, NOW, byId)).map((i) => i.id), ["a", "f", "h", "j", "k"]);
});

test("every single-row skip-the-queue verb makes one promise", async () => {
  const { skipQueueNote, busyInCheckout, SKIP_QUEUE_BUSY_NOTE, QUEUES_ITEM_RUN_NOTE } = await import("./sendIntent.ts");
  assert.equal(skipQueueNote(true),
    "starts it this second in a session of its own — skips the queue: the budget, one at a time and wait until free");
  assert.match(skipQueueNote(false), /this second — skips the queue/);
  assert.doesNotMatch(skipQueueNote(false), /of its own/, "a row aimed at a session opens nothing");
  // Said, never asked: a fire is the manual override and takes ONE tap.
  assert.equal(SKIP_QUEUE_BUSY_NOTE, "another agent is working in this checkout — this starts a second one beside it");
  assert.doesNotMatch(SKIP_QUEUE_BUSY_NOTE, /\?$/, "a note, not a question a confirm would ask");
  assert.equal(QUEUES_ITEM_RUN_NOTE, "queues an item in its backlog — it runs in turn");
  const rows = [
    { id: "x", cwd: "/r", state: "running" },
    { id: "y", cwd: "/r", state: "queued" },
    { id: "z", cwd: "/r-wt", state: "starting" },
  ];
  assert.equal(busyInCheckout("/r", rows, "y"), true);
  assert.equal(busyInCheckout("/r", rows, "x"), false, "a row is not busy against itself");
  assert.equal(busyInCheckout("/r-wt", rows, "q"), true);
  assert.equal(busyInCheckout("/other", rows), false, "another worktree is another checkout");
  assert.equal(busyInCheckout(undefined, rows), false);
  // A live session mid-turn in that checkout is an agent at work too; an idle
  // or closed one is not.
  const sess = [
    { cwd: "/s", running: true, turnActive: true },
    { cwd: "/idle", running: true, turnActive: false },
    { cwd: "/gone", running: false, turnActive: true },
  ];
  assert.equal(busyInCheckout("/s", [], undefined, sess), true);
  assert.equal(busyInCheckout("/idle", [], undefined, sess), false);
  assert.equal(busyInCheckout("/gone", [], undefined, sess), false);
});

// ── a budget on the session(s) a send opens ──────────────────────────────

const CAP = { unit: "usd", max: 2, interrupt: true };
const repoIntent = (budget, when = { kind: "now" }) => ({ prompts: ["go"], target: { kind: "repo", cwd: "/r", ...(budget ? { budget } : {}) }, when, sequential: false });

test("the button restates the cap, and says nothing without one", () => {
  assert.equal(sendLabel(repoIntent(), names, null), "Start in app");
  assert.equal(sendLabel(repoIntent(CAP), names, null), "Start in app · budget ≤ $2.00");
  assert.equal(sendLabel(repoIntent(CAP, { kind: "idle" }), names, null),
    "Queue for app · a new session when this repo is free · budget ≤ $2.00");
  // A percent is worded by shared, the long way: this is its sentence, not a re-spelling.
  assert.match(sendLabel(repoIntent({ unit: "sessionPct", max: 2, interrupt: true }), names, null), /budget ≤ 2% of this 5-hour window$/);
});

test("a sweep carries the cap on its own target and the collapsed row says so", () => {
  const t = { kind: "repos", dirs: ["/a", "/b"], budget: CAP };
  assert.equal(targetWords(t, names), "2 repos, budget ≤ $2.00");
  assert.equal(sendLabel({ prompts: ["x"], target: t, when: { kind: "now" }, sequential: false }, names, null), "Fan out to 2 repos · budget ≤ $2.00");
  assert.equal(targetWords({ kind: "repo", cwd: "/r", budget: CAP }, names), "app · a new session, budget ≤ $2.00");
});

test("withBudget sets and removes the cap, leaving no undefined key, and ignores a session target", () => {
  const t = { kind: "repo", cwd: "/r", resume: true };
  assert.deepEqual(withBudget(t, CAP), { kind: "repo", cwd: "/r", resume: true, budget: CAP });
  assert.deepEqual(withBudget(withBudget(t, CAP), null), t);
  assert.equal("budget" in withBudget(withBudget(t, CAP), undefined), false);
  const s = { kind: "session", sessionId: "s", cwd: "/r" };
  assert.equal(withBudget(s, CAP), s);
  assert.equal(budgetOfTarget(s), undefined);
  assert.equal(budgetOfTarget(withBudget(t, CAP)), CAP);
});

test("a sweep's own launch survives a budget change and is dropped only by withoutLaunch", () => {
  const t = { kind: "repos", dirs: ["/a"], launch: { model: "sonnet" } };
  assert.deepEqual(withBudget(t, CAP), { ...t, budget: CAP });
  assert.deepEqual(withoutLaunch(withBudget(t, CAP)), { kind: "repos", dirs: ["/a"], budget: CAP });
  // A repo target carries one now too (the sheet's *model* row); a session does not.
  const r = { kind: "repo", cwd: "/r" };
  assert.deepEqual(withoutLaunch({ ...r, launch: { model: "opus" } }), r);
  const s = { kind: "session", sessionId: "s", cwd: "/r" };
  assert.equal(withoutLaunch(s), s);
});

// ── The *model* row: a later "new session" can name its model ─────────────────

test("the model row's words: the defaults until something is picked, the backend only when it is not claude", () => {
  assert.equal(launchWords(undefined), "new-session defaults");
  assert.equal(launchWords({}), "new-session defaults");
  assert.equal(launchWords({ permissionMode: "plan" }), "new-session defaults", "nothing the row picks was picked");
  assert.equal(launchWords({ model: "sonnet" }), "sonnet");
  assert.equal(launchWords({ model: "opus", effort: "high", backend: "claude" }), "opus · high");
  assert.equal(launchWords({ backend: "localrun", model: "qwen3-coder:30b" }), "localrun · qwen3-coder:30b");
  assert.equal(launchWords({ effort: "low" }), "the default model · low");
});

test("a repo target carries its launch like its budget, and both restate it", () => {
  const t = { kind: "repo", cwd: "/a" };
  const picked = withLaunch(t, { model: "sonnet", effort: "low" });
  assert.deepEqual(launchOfTarget(picked), { model: "sonnet", effort: "low" });
  assert.equal("launch" in withLaunch(picked, null), false, "no `launch: undefined` key is left behind");
  assert.deepEqual(withBudget(picked, CAP).launch, picked.launch, "a budget change keeps the model");
  const s = { kind: "session", sessionId: "s", cwd: "/a" };
  assert.equal(withLaunch(s, { model: "opus" }), s, "a live session is already running whatever it runs");
  assert.equal(launchOfTarget(s), undefined);
  // Untouched, the words are exactly what they always were.
  assert.equal(targetWords(t, names), "app · a new session");
  assert.equal(targetWords(picked, names), "app · a new session, sonnet · low");
  assert.equal(sendLabel(send(t, NOWISH), names, null), "Start in app");
  assert.equal(sendLabel(send(picked, NOWISH), names, null), "Start in app · sonnet · low");
  assert.match(sendLabel(send(withLaunch({ kind: "repos", dirs: ["/a", "/b"] }, { model: "haiku" }), NOWISH), names, null), / · haiku$/);
});

import { guardWords as guardWordsOf } from "./sendIntent/sendRule.ts";

test("guardWords names a guard window this build does not know", () => {
  // `guardWindow` is stored on the host's rule; a newer host's window reached
  // WINDOW_LABEL with no key and printed "undefined".
  const text = guardWordsOf({ window: "session", guardWindow: "someFutureWindow", minPctLeft: 20, edge: "before" });
  assert.doesNotMatch(text, /undefined/);
});
