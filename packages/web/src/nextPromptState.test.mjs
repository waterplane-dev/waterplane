/**
 * What the strip above the composer is allowed to say about the next prompt.
 *
 * Every case here is one a tap could otherwise get wrong in a way nobody would
 * see until it mattered — the strip would look right and the tap would do
 * nothing, or it would name the wrong message. The ladder is four facts that do
 * not agree in the obvious order (a wall, the link, a picture still uploading,
 * the park, a turn in flight), and the order is the whole of it: a reconnect
 * changes nothing while a dialog is open, and a turn in flight is NOT a wall,
 * because typing into a working session is what every un-parked entry does
 * anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { nextPromptView, nextWords, tieNote } = await import("./nextPromptState.ts");

const prose = (e) => e.text ?? "";
const S = "s1";
const entry = (over = {}) => ({
  ackId: "a1", sessionId: S, status: "queued", mode: "input", text: "add the tests", ...over,
});
const view = (over = {}) => nextPromptView({
  entries: [entry()], sessionId: S, busy: true, online: true, wall: null, prose, ...over,
});

test("nothing queued for this session ⇒ nothing on screen", () => {
  assert.equal(view({ entries: [] }), null);
  assert.equal(view({ entries: [entry({ sessionId: "other" })] }), null);
});

test("an idle, reachable session shows nothing — the entry is already on its way", () => {
  // A strip that appears for the half-second before the queue drains is flicker,
  // not information.
  assert.equal(view({ busy: false }), null);
  // …but a wall keeps it up even with no turn running: that is exactly when the
  // next prompt is stuck and nothing on screen said so.
  assert.ok(view({ busy: false, wall: "a dialog is open in that session — answer it first" }));
  // …and so does a dead link.
  assert.ok(view({ busy: false, online: false }));
});

test("only a QUEUED entry is decidable — pending is on the wire, failed is over", () => {
  assert.equal(view({ entries: [entry({ status: "pending" })] }), null);
  assert.equal(view({ entries: [entry({ status: "failed" })] }), null);
});

test("it names the FIRST of this session's entries and counts the rest", () => {
  const v = view({
    entries: [
      entry({ ackId: "other", sessionId: "zzz" }),
      entry({ ackId: "a1", text: "first" }),
      entry({ ackId: "a2", text: "second" }),
      entry({ ackId: "a3", text: "third" }),
    ],
  });
  assert.equal(v.id, "a1");
  assert.equal(v.holder, "phone");
  assert.equal(v.words, "first");
  assert.equal(v.behind, 2, "the one from another session is not counted");
});

test("parked and un-parked are different sentences, and different verbs", () => {
  assert.equal(view({ entries: [entry({ holdUntilIdle: true })] }).held, true);
  assert.match(view({ entries: [entry({ holdUntilIdle: true })] }).why, /waits for this turn/);
  assert.equal(view().held, false);
  assert.match(view().why, /as soon as the queue reaches it/);
});

test("a wall outranks the link, which outranks the park", () => {
  const wall = "blocked on a usage limit — it goes out at the reset";
  // All three true at once: the sentence must be the one that actually decides
  // the outcome. A reconnect changes nothing while the session is walled.
  const v = view({ entries: [entry({ holdUntilIdle: true })], online: false, wall });
  assert.equal(v.why, wall);
  assert.equal(v.wall, wall);
  const offline = view({ entries: [entry({ holdUntilIdle: true })], online: false });
  assert.match(offline.why, /waits for the link/);
});

test("send-now is refused with no link — a tap would queue what is already queued", () => {
  // The park is the only thing a tap can lift, and lifting it changes nothing
  // while there is no socket to deliver over. Refused as a SENTENCE, never as a
  // dimmed button.
  assert.match(view({ online: false }).wall, /no connection/);
  assert.equal(view().wall, null, "a live, un-walled session may be sent into");
});

test("a turn in flight is not a wall", () => {
  // The distinction the whole feature rests on: "send now" beats the park
  // precisely because typing into a working session is ordinary.
  assert.equal(view({ busy: true, wall: null }).wall, null);
});

test("words come from the entry, and an entry with none still says what it is", () => {
  assert.equal(nextWords({ mode: "upload", text: "" }, prose), "a file");
  assert.equal(nextWords({ mode: "op", text: "" }, prose), "an action");
  assert.equal(nextWords({ mode: "input", text: "  keep   going\n\nnow " }, prose), "keep going now");
  const long = nextWords({ mode: "input", text: "x".repeat(80) }, prose);
  assert.equal(long.length, 57, "clipped to one line, with the ellipsis");
  assert.ok(long.endsWith("…"));
});

test("a prompt behind its own picture says so, and is not offered a tap that cannot work", () => {
  // The lane delivers in order and `guardUploadRefs` put the upload in it on
  // purpose, so nothing can make the prompt jump the bytes. This is the state
  // you are in the instant after sending a prompt that names a photo.
  const entries = [
    entry({ ackId: "img", mode: "upload", status: "pending", text: "" }),
    entry({ ackId: "a1", text: "what do you make of this" }),
  ];
  const v = view({ entries, busy: false });
  assert.ok(v, "shown even with an idle session — it is genuinely stuck behind the bytes");
  assert.equal(v.id, "a1");
  assert.equal(v.holder, "phone");
  assert.match(v.why, /finish uploading/);
  assert.match(v.wall, /still uploading/);
});

test("an upload BEHIND the prompt blocks nothing", () => {
  const entries = [
    entry({ ackId: "a1", text: "go on then" }),
    entry({ ackId: "img", mode: "upload", status: "pending", text: "" }),
  ];
  assert.equal(view({ entries, busy: false }), null, "nothing is in this prompt's way");
  assert.match(view({ entries }).why, /as soon as the queue reaches it/);
});

test("a FAILED upload ahead is not a wait — it is over", () => {
  const entries = [
    entry({ ackId: "img", mode: "upload", status: "failed", text: "" }),
    entry({ ackId: "a1", text: "still worth asking" }),
  ];
  assert.equal(view({ entries, busy: false }), null);
});

/**
 * ── The desktop's half ───────────────────────────────────────────────────────
 *
 * *When it's free* posts a work item pinned to this session and the HOST holds
 * it, so the prompt somebody is waiting on is routinely not in this tab's queue
 * at all. Before that move the strip simply went blank for those, and the
 * composer said nothing about words that were definitely going to run.
 */

const pin = (id, words, why) => ({ id, words, ...(why ? { why } : {}) });

test("with nothing in this tab's queue, the desktop's head is the row", () => {
  const v = view({ entries: [], pinned: [pin("i1", "write the migration"), pin("i2", "then the test")] });
  assert.equal(v.holder, "desktop");
  assert.equal(v.id, "i1", "the buttons act on the work item, not on an ackId");
  assert.equal(v.words, "write the migration");
  assert.equal(v.behind, 1);
  assert.equal(v.held, true, "a pinned item is waiting by construction");
  assert.match(v.why, /waits for this turn to end/);
});

test("the phone's own queue goes first — it is the one a tap can still change", () => {
  // Not a ranking of importance. A parked entry is in FRONT of the pinned item
  // and nothing else knows it exists; naming the desktop's head as "next" while
  // a local one sits ahead of it would name the wrong prompt.
  const v = view({ entries: [entry({ text: "local one" })], pinned: [pin("i1", "the pinned one")] });
  assert.equal(v.holder, "phone");
  assert.equal(v.words, "local one");
});

test("a dead link does not make the desktop's item stuck, and must not say so", () => {
  const v = view({ entries: [], online: false, pinned: [pin("i1", "carry on")] });
  assert.match(v.wall, /the desktop is holding it/);
  assert.doesNotMatch(v.wall, /queue what is already queued/);
});

test("a wall in the session still outranks everything for a pinned item", () => {
  const wall = "a dialog is open in that session — answer it first";
  const v = view({ entries: [], wall, pinned: [pin("i1", "carry on")] });
  assert.equal(v.why, wall);
  assert.equal(v.wall, wall, "send now would type prose into a menu — refused as a sentence");
});

/**
 * A pinned item is DRAWN on an idle session — the opposite of the phone's lane.
 *
 * "The host fires it within a tick" is a fact this tab owns about its own
 * queue, and a guess about the desktop's. A pinned row can be held on the
 * budget gate, the global auto switch, a usage limit or an answer the agent is
 * waiting for, and none of those is visible from here. Hidden, the session
 * screen said nothing at all about words that were definitely going to run:
 * the strip was blank, the queue bar was blank (the row is not in this tab's
 * outbox), and the only sign they existed was a badge.
 */
test("an idle, reachable session still shows a pinned item — the desktop's reasons are not visible here", () => {
  const v = view({ entries: [], busy: false, pinned: [pin("i1", "soon")] });
  assert.ok(v, "the phone cannot see why the desktop has not fired it");
  assert.equal(v.holder, "desktop");
  // …and with no turn in flight it must not claim there is one to wait for.
  assert.equal(v.why, "the desktop runs it when this session is free");
  // The phone's own lane keeps the flicker guard: that one IS about to go.
  assert.equal(view({ busy: false }), null);
});

test("the host's own sentence wins over anything this side would guess", () => {
  const why = "the account is at its usage limit — it resumes at 14:00";
  assert.equal(view({ entries: [], busy: true, pinned: [pin("i1", "soon", why)] }).why, why);
  assert.equal(view({ entries: [], busy: false, pinned: [pin("i1", "soon", why)] }).why, why);
});

/**
 * Offline, `pinned` is the last synced snapshot — it may be hours old and the
 * row may already have run. "The desktop is holding it" asserted from a copy,
 * with no age on it, is a claim about right now made from something nobody has
 * checked. The Backlog sheet ages the same snapshot; this strip did not.
 */
test("offline, the desktop's line says how old the copy it is reading is", () => {
  const v = view({ entries: [], online: false, asOf: "3h ago", pinned: [pin("i1", "carry on")] });
  assert.match(v.why, /as of 3h ago$/);
  // Online there is nothing to date — the list arrived with this frame.
  assert.doesNotMatch(view({ entries: [], asOf: "3h ago", pinned: [pin("i1", "carry on")] }).why, /as of/);
});

test("a pinned item's words are clipped the same as a queued entry's", () => {
  const v = view({ entries: [], pinned: [pin("i1", "y".repeat(80))] });
  assert.equal(v.words.length, 57);
  assert.ok(v.words.endsWith("…"));
});

// A timed row aimed at this session sits on the strip for days, and "may I
// close this session?" is the question a person has about it. The strip
// answers it, truthfully for each of the two shapes the host can hold.
test("a timed pinned row says when, and what closing this session does to it", () => {
  const reopens = tieNote("Thu 17:59", true);
  assert.match(reopens, /^timed · Thu 17:59 · tied to this conversation/);
  assert.match(reopens, /close it before then and the desktop reopens this conversation and sends it there/);
  const bound = tieNote("Thu 17:59", false);
  assert.match(bound, /tied to this session — keep it open until then/);
  const v = view({ entries: [], pinned: [{ ...pin("i1", "implement it"), tie: reopens }] });
  assert.equal(v.tie, reopens);
  assert.equal(view({ entries: [], pinned: [pin("i1", "untimed")] }).tie, null);
});

test("a pinned row the budget holds offers *past the budget* — only live, only on the desktop's row", () => {
  const held = { ...pin("i1", "write the migration"), budgetHeld: true };
  assert.equal(view({ entries: [], pinned: [held] }).budgetHeld, true);
  // Offline the verdict is a copy and the waiver could not land.
  assert.equal(view({ entries: [], pinned: [held], online: false }).budgetHeld, false);
  assert.equal(view({ entries: [], pinned: [pin("i1", "x")] }).budgetHeld, false);
  // The phone's own lane is never budget-held: the budget gates desktop work.
  assert.equal(view({ entries: [entry({ text: "local", holdUntilIdle: true })], pinned: [held], busy: true }).budgetHeld, false);
});
