/**
 * The compose bar's split button, pinned by its words.
 *
 * This control is on screen for almost every send this app makes, and the two
 * ways it goes wrong are both invisible to a type-checker: a third mode creeps
 * back in (there were five answers here once, two of which were the same
 * decision with different holders), or a toast claims a holder the send does
 * not have — "held" when the phone is the one holding it is a promise that the
 * message survives a locked screen, and it did not.
 *
 *     node --test packages/web/src/composeSend.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMenu, composeWhere, composeAimNote, sendButtonTitle, sendModeLabel, sendModeTitle,
  sendModeToast, sendWhereLabel, whereGoneToast, AIM_HERE_LABEL, PAD_EMPTY_TOAST, PAD_KEPT_TOAST,
  WHERE_LEAD, WHERE_UNPICKED_TOAST,
} from "./composeSend.ts";

test("there are exactly two modes, and they say which they are", () => {
  assert.equal(sendModeLabel("now"), "Send");
  assert.equal(sendModeLabel("idle"), "When free");
  // The retired third mode. `queue here` and `when it's free` were one decision
  // told twice; nothing may put it back without editing this line.
  assert.doesNotMatch(sendModeLabel("idle"), /queue/i);
  assert.doesNotMatch(sendModeTitle("idle"), /queue here/i);
});

test("the `when free` title names the desktop as the holder", () => {
  // The whole reason this mode moved off the phone: a locked screen held the
  // prompt and never delivered it.
  assert.match(sendModeTitle("idle"), /desktop/);
  assert.match(sendModeTitle("idle"), /turn ended, no question open, no usage-limit block/);
  assert.equal(sendModeTitle("now"), "Send to this session");
});

test("`now` says nothing — the composer emptying is the receipt", () => {
  assert.equal(sendModeToast("now", { online: true, holder: "desktop" }), null);
  assert.equal(sendModeToast("now", { online: false, holder: "phone" }), null);
});

test("`when free` names the desktop, and says what a dead link changes", () => {
  assert.equal(
    sendModeToast("idle", { online: true, holder: "desktop" }),
    "queued on the desktop — it goes in when this session is free");
  assert.match(sendModeToast("idle", { online: false, holder: "desktop" }), /link is back/);
});

test("the one send the desktop cannot hold is worded as the phone's", () => {
  // A prompt chained behind a session that does not exist yet: there is no
  // session id for a pinned item to name, so the create's own lane is the queue.
  const t = sendModeToast("idle", { online: true, holder: "phone" });
  assert.equal(t, "queued — it runs in this session when it opens");
  assert.doesNotMatch(t, /desktop/, "the desktop is not holding this one — do not claim it is");
});

test("the menu is two modes, the pad, and one errand", () => {
  const m = composeMenu();
  assert.deepEqual(m.map((e) => e.label),
    ["now", "when it's free", "keep it on the pad", "elsewhere or later…"]);
  assert.deepEqual(m.map((e) => e.mode), ["now", "idle", null, null]);
  // Still ONE errand. The pad row is not a third door into the send sheet —
  // it is the answer that sends nothing — so it is told apart by its key, and
  // a caller switching on `mode === null` alone would open the sheet for it.
  assert.deepEqual(m.filter((e) => e.mode === null).map((e) => e.key), ["pad", "elsewhere"]);
  // The two errands that went: a wall-clock time and "somewhere else entirely"
  // were two doors into one sheet, differing only in which row they expanded.
  assert.ok(!m.some((e) => /at a time…|somewhere else…/.test(e.label)));
});

/**
 * **The pad row is the one answer here that nothing fires.**
 *
 * That is the whole reason it exists: `now`, `when it's free` and every WHEN in
 * the send sheet end in something that runs itself, and an idea to reconsider
 * or a bug to check by hand once more is not work anybody has decided to do
 * yet. If this row's words ever start promising a backlog, a queue or a
 * trigger, the promise is wrong — so they are pinned NEGATIVELY as well.
 */
test("the pad row promises that nothing runs it", () => {
  const pad = composeMenu().find((e) => e.key === "pad");
  assert.equal(pad.icon, "pad", "not the send icon — this row sends nothing");
  assert.match(pad.title, /nothing runs them/);
  assert.match(pad.title, /no backlog/);
  assert.match(PAD_KEPT_TOAST, /nothing runs it/);
  // Where the words went. The pad has no strip on the compose screen, so a
  // note that lands silently is a note nobody finds again.
  assert.match(PAD_KEPT_TOAST, /open the pad/);
  for (const s of [pad.label, PAD_KEPT_TOAST]) {
    assert.doesNotMatch(s, /\bqueued\b|\bscheduled\b|\bwill run\b/i,
      "a pad note is never queued, scheduled or run — do not word it as if it were");
  }
  // An empty box is answered in words, never by a dimmed row.
  assert.match(PAD_EMPTY_TOAST, /nothing in the box/);
});

/**
 * The OTHER send the desktop cannot hold.
 *
 * `/usage`, `/model` and `/help` open a VIEW and start no turn. A pinned work
 * item is delivered with `watch: "turn"` and settles when a turn ends, so
 * handing one of these to the desktop hands it a row whose finish condition
 * never happens — it sits `running` in Activity for ever while the CLI has long
 * since drawn and dismissed a modal. The phone keeps that one, and the toast
 * has to say so: "leave the app open" is the fact that decides whether locking
 * the screen loses the command.
 */
test("a command that opens a view is worded as the phone's, and says to stay", () => {
  const t = sendModeToast("idle", { online: true, holder: "phone", phoneHold: "opens-a-view" });
  assert.match(t, /held on this phone/);
  assert.match(t, /opens a view rather than starting a turn/);
  assert.match(t, /Leave the app open/);
  assert.doesNotMatch(t, /desktop/, "the desktop is not holding this one — do not claim it is");
  assert.match(sendModeToast("idle", { online: false, holder: "phone", phoneHold: "opens-a-view" }),
    /link is back/);
  // The two phone-held cases are two different promises and must not collapse.
  assert.notEqual(
    sendModeToast("idle", { online: true, holder: "phone", phoneHold: "opens-a-view" }),
    sendModeToast("idle", { online: true, holder: "phone", phoneHold: "session-not-open" }));
});

test("every menu row carries a title that says something its label does not", () => {
  // Not `title.length > label.length`, which any longer string passes and which
  // therefore pins nothing. Each title carries the one fact its row's label
  // cannot: where the words go, and who ends up holding them.
  const by = Object.fromEntries(composeMenu().map((e) => [e.key, e]));
  assert.match(by.now.title, /this session/);
  assert.match(by.idle.title, /desktop/, "the holder is the whole difference between the two modes");
  assert.match(by.elsewhere.title, /at a time/, "the errand names the WHEN the two modes cannot reach");
  assert.match(by.pad.title, /decide later/, "the pad row's fact is that the decision is postponed, not made");
  for (const e of composeMenu()) {
    assert.notEqual(e.title.trim().toLowerCase(), e.label.trim().toLowerCase(),
      `${e.key}: a title repeating its own label has told nobody anything`);
  }
});

// ── WHERE: the fourth answer, and the line that keeps it visible ────────────

test("there are exactly three aims, and `this session` is the first of them", () => {
  const keys = composeWhere().map((e) => e.key);
  assert.deepEqual(keys, ["this", "new", "other"]);
  // The default is the session on screen, and it leads the toggle: a person
  // who never touches this control must never be able to end up on another one.
  assert.equal(keys[0], "this");
  // The sweep is the send sheet's, not this strip's: one line cannot be honest
  // about N repos, and `dispatchIntent` reads only `steps[0]` for one.
  assert.ok(!keys.includes("repos"));
});

test("each aim's title says the one fact its label cannot", () => {
  const by = Object.fromEntries(composeWhere().map((e) => [e.key, e]));
  assert.match(by.this.title, /on screen/);
  assert.match(by.new.title, /fresh session/, "the point of a new session is that it inherits nothing");
  assert.match(by.other.title, /pick/, "this one is not complete until a session is chosen");
  for (const e of composeWhere()) {
    assert.notEqual(e.title.trim().toLowerCase(), e.label.trim().toLowerCase(),
      `${e.key}: a title repeating its own label has told nobody anything`);
  }
  assert.equal(sendWhereLabel("new"), by.new.label, "one wording, on the toggle and off it");
});

test("the aim line says nothing about the session you are looking at", () => {
  // `this` is what the screen already says. A banner restating it is furniture
  // that teaches people to stop reading this line, which is the one line
  // standing between a remembered aim and a prompt landing somewhere nobody saw.
  assert.equal(composeAimNote("this", { repoName: "myapp" }), null);
});

test("the aim line states the NEGATIVE, which is the fact that matters", () => {
  const fresh = composeAimNote("new", { repoName: "myapp" });
  assert.match(fresh, /myapp/, "it names the repo the new session opens in");
  assert.match(fresh, /not the conversation on screen/);
  const other = composeAimNote("other", { repoName: "myapp", sessionName: "myapp · fix the sheet" });
  assert.match(other, /myapp · fix the sheet/);
  assert.match(other, /not the conversation on screen/);
});

test("an `other` aim with nothing picked says so instead of naming a session", () => {
  const note = composeAimNote("other", { repoName: "myapp", sessionName: null });
  assert.match(note, /none is picked/);
  // And the send refuses on the same fact rather than falling back to the
  // session on screen, which would be a different answer to the question asked.
  assert.match(WHERE_UNPICKED_TOAST, /no session picked/);
  assert.match(WHERE_UNPICKED_TOAST, /aim it back/);
});

test("a session that closed while it was armed sends NOTHING and says so", () => {
  const said = whereGoneToast("myapp · fix the sheet");
  assert.match(said, /myapp · fix the sheet/);
  assert.match(said, /nothing was sent/, "the words are still in the box");
  assert.match(said, /back on this session/, "and the aim is somewhere a person can see");
  // Unnamed is a real case — the session may be gone from the list entirely.
  assert.match(whereGoneToast(null), /that session/);
  assert.doesNotMatch(whereGoneToast(null), /undefined|null/);
});

test("the button's title restates BOTH answers, and the fresh-session wait has one clause", () => {
  // Unaimed, it is exactly the mode's own title — nothing new to say.
  assert.equal(sendButtonTitle("now", "this"), sendModeTitle("now"));
  assert.equal(sendButtonTitle("idle", "this"), sendModeTitle("idle"));
  // ONE clause for the fresh-session wait, the same one the send sheet uses:
  // a session is free when its turn ends and a repo is free when nothing is
  // running in it, and calling them the same thing is a promise that breaks.
  assert.match(sendButtonTitle("idle", "new"), /when this repo is free/);
  assert.doesNotMatch(sendButtonTitle("idle", "new"), /when this session is free/);
  assert.match(sendButtonTitle("now", "new"), /not the conversation on screen/);
  assert.match(sendButtonTitle("now", "other", "myapp · fix the sheet"), /myapp · fix the sheet/);
  // A nameless `other` still reads as a sentence, never as an empty gap.
  assert.match(sendButtonTitle("now", "other", null), /another open session/);
});

test("the strip's lead and the way back are worded once", () => {
  assert.equal(WHERE_LEAD, "Runs in");
  assert.match(AIM_HERE_LABEL, /aim it here/);
});

test("Send on a working session asks — only for the plain button, aimed here", async () => {
  const { busySendRoute, BUSY_SEND_ASK, busySendRememberedToast } = await import("./composeSend.ts");
  const base = { how: "now", explicit: false, aimedHere: true, turnActive: true, pending: false, localCmd: false, pref: "" };
  assert.equal(busySendRoute(base), "ask");
  // Remembered answers are used without asking.
  assert.equal(busySendRoute({ ...base, pref: "idle" }), "idle");
  assert.equal(busySendRoute({ ...base, pref: "now" }), "now");
  // Everything else is the mode it already was.
  assert.equal(busySendRoute({ ...base, turnActive: false }), "now");
  assert.equal(busySendRoute({ ...base, explicit: true }), "now");
  assert.equal(busySendRoute({ ...base, aimedHere: false }), "now");
  assert.equal(busySendRoute({ ...base, pending: true }), "now");
  assert.equal(busySendRoute({ ...base, localCmd: true }), "now");
  assert.equal(busySendRoute({ ...base, how: "idle" }), "idle");
  assert.equal(BUSY_SEND_ASK.confirmLabel, "Send now");
  assert.equal(BUSY_SEND_ASK.cancelLabel, "When it's free");
  assert.match(busySendRememberedToast("idle"), /Settings/);
  assert.match(busySendRememberedToast("now"), /Settings/);
});

test("the busy ask offers *past the budget* only while the budget holds work", async () => {
  const { busySendAsk, BUSY_SEND_ASK, BUSY_PAST_BUDGET_LABEL, busyPastBudgetToast } = await import("./composeSend.ts");
  // Not held: the two answers it always had, nothing to lift.
  const plain = busySendAsk(null);
  assert.equal(plain.altLabel, undefined);
  assert.deepEqual(plain.lines, [...BUSY_SEND_ASK.lines]);
  // Held: a third answer, and the budget's own sentence says why it matters.
  const held = busySendAsk("paused — 91% of the weekly window used, over the 75% budget");
  assert.equal(held.altLabel, BUSY_PAST_BUDGET_LABEL);
  assert.equal(held.confirmLabel, "Send now");
  assert.equal(held.cancelLabel, "When it's free");
  assert.ok(held.lines.some((l) => l.includes("over the 75% budget")));
  assert.ok(held.lines.some((l) => l.startsWith("When it's free, past the budget:")));
  // The receipt never claims it runs NOW — it still waits for the turn.
  assert.match(busyPastBudgetToast(true), /once this turn ends/);
  assert.match(busyPastBudgetToast(false), /link is back/);
});
