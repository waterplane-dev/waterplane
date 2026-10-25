/**
 * What became of a delivery — decided from evidence, with a fake session in
 * place of a PTY.
 *
 * `settle.ts` is read-only by construction: it reads the CLI's conversation log
 * and the rendered screen and writes nothing anywhere. That makes it exactly
 * the kind of decision core this project pins with a fixture rather than only
 * through a booted host — the e2e scripts prove the wiring, and these prove the
 * rule, in one line per awkward case.
 *
 * The awkward cases are all one family, found live on 2026-09-05: every
 * comparison here ran on a fourteen-character head, so two prompts that started
 * the same way were one prompt. The verdicts it produced were not "I could not
 * tell" — they were confident and wrong, which is the one thing the heuristics
 * in this repo are not allowed to be.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetSpentTurns, logMatch, logVerdict, settleDelivery } from "../dist/settle.js";
import { setLiveSourceLookup } from "../dist/livesources.js";
import { cliHeldTable, parseTranscript, cliHeldOf } from "../dist/transcript.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Two prompts sharing a fourteen-character head — i.e. what a re-send looks
 *  like to the old probe, and what two neighbouring instructions look like too. */
const A = "please rewrite the flaky retry test and explain the fix";
const B = "please rewrite the docs index so it links the new notes";

/**
 * A SessionManager with nothing in it but the three things settling reads: does
 * this session's backend keep a claude log at all, the log itself, and the last
 * 40 rows of a screen.
 *
 * `claudeLog` defaults to true because every case below is a claude session;
 * the one that is not sets it, and asserts that the transcript is then never
 * even asked for.
 */
function fakeSessions({ turns, held = [], screen = "", running = true, claudeLog = true, onTranscript = () => {} }) {
  return {
    get: () => ({ running }),
    keepsClaudeLog: () => claudeLog,
    screenText: async () => screen,
    getTranscript: () => {
      onTranscript();
      if (turns == null) return null;
      const doc = { source: "jsonl", turns };
      if (held.length) cliHeldTable.set(doc, held);
      return doc;
    },
  };
}

const turn = (id, prompt, at = Date.now()) => ({ id, prompt, sentAt: at });

test("one prompt's log turn is not proof that another one ran", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  const sessions = fakeSessions({ turns: [turn("u1", A)] });
  const now = Date.now();
  assert.equal(logVerdict(sessions, "s1", A, now), "landed");
  // The bug: B shares A's head, so the old prefix rule read A's turn as proof
  // that B had run. The row retires, the queue drops the words, and nothing
  // revisits an answered question.
  assert.equal(logVerdict(sessions, "s1", B, now), "absent",
    "a readable log without B's words says B never ran — and says nothing about A's turn");
});

test("a log turn is evidence for exactly ONE delivery", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // The case a whole-text comparison cannot fix by itself: two deliveries of
  // the SAME words, which is what a re-send is. Without a claim both read the
  // one turn and both settle `landed`; the second never ran and its row retires
  // saying it did.
  const sessions = fakeSessions({ turns: [turn("u1", A)] });
  const now = Date.now();
  const first = logMatch(sessions, "s1", A, now, { claimer: "ack-1" });
  assert.equal(first.verdict, "landed");
  assert.equal(first.turnId, "u1", "the row can write down which turn proved it");
  // Asking again with the same name is the same delivery re-asking, and it
  // keeps its own proof — a row is re-asked on every sweep.
  assert.equal(logMatch(sessions, "s1", A, now, { claimer: "ack-1" }).verdict, "landed");
  // A DIFFERENT delivery of the same words gets `unknown`, and emphatically not
  // `absent`: "somebody already claimed this turn" is not a readable log that
  // lacks the words, and `absent` would authorise a re-send that runs the same
  // instruction twice — worse than the false `landed` it replaces.
  assert.equal(logMatch(sessions, "s1", A, now, { claimer: "ack-2" }).verdict, "unknown");
});

test("a screen match that a rival could have produced is not a `composer` verdict", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // B's echo is in the composer; we are asking about A. There is no log at all,
  // so the screen is the only witness — and it is not a witness about A.
  const sessions = fakeSessions({ turns: null, screen: `> ${B}` });
  const now = Date.now();
  const blind = await settleDelivery(sessions, "s1", A, now, { others: [B] });
  assert.equal(blind.verdict, "unknown",
    "`composer` means 'press Return there, never retype it' — it must not point at somebody else's prompt");
  // With no rival known, the prefix hit is as good as an identification and the
  // behaviour is unchanged: an incomplete rival list only ever degrades a
  // confident answer, never invents one.
  const alone = await settleDelivery(sessions, "s1", A, now);
  assert.equal(alone.verdict, "composer");
});

test("our own text on screen is `composer` however many rivals share its head", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  const sessions = fakeSessions({ turns: null, screen: `> ${A}` });
  const r = await settleDelivery(sessions, "s1", A, Date.now(), { others: [B] });
  assert.equal(r.verdict, "composer", "the WHOLE text is on screen — that is an identification, not a prefix");
});

test("a rival's echo never turns into `absent`", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // The dangerous direction. The log is readable and does not have A, so the
  // log half says `absent` — but the screen holds text that might be A sitting
  // unsent. `absent` is the verdict that authorises sending it again, and doing
  // that on top of a composer that already holds it is the stacking this whole
  // subsystem exists to prevent. "I cannot tell" is the only honest answer.
  const sessions = fakeSessions({ turns: [turn("u1", "an unrelated earlier prompt")], screen: `> ${B}` });
  const r = await settleDelivery(sessions, "s1", A, Date.now(), { others: [B] });
  assert.equal(r.verdict, "unknown");
});

// ── Where the text is, not how far up the render it is ───────────────────────
//
// The screen half used to narrow to a bottom-`depth` slice, the same rule
// `deliver.ts` used, and both were measuring the same wrong thing. `render.ts`
// replays the whole buffer into a fixed 50-row VT, so a repaint caught
// half-done leaves a duplicated footer and rows of streaming turn output UNDER
// the newest composer frame — and the delivery that arrives here is precisely
// the one that tore, an interjection the echo window could not confirm. It
// settled `unknown` with the words visible in the box.

/** The live capture's shape: the box, then the tear underneath it. */
const torn = (inComposer) => [
  "  ⎿  Read packages/host/src/deliver.ts (898 lines)",
  "",
  "✻ Sautéed for 40s (esc to interrupt · ctrl+t to show todos)",
  "",
  "─".repeat(60),
  `❯\u00a0${inComposer}`,
  "─".repeat(60),
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "  …/clear to save 102.6k tokens",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "  …/clear to save 102.6k tokens",
  "  ⏺ Update(packages/host/src/settle.ts)",
  "  ⎿  Updated packages/host/src/settle.ts with 14 additions",
  "  ⏺ Bash(npm run build:shared)",
  "  ⎿  > tsc -p tsconfig.json",
  "  ⏺ Read(packages/host/src/echo.ts)",
  "  ⎿  Read 375 lines",
  "✻ Sautéing… (esc to interrupt)",
].join("\n");

test("text in the box is `composer` however much has streamed in below it", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  const sessions = fakeSessions({ turns: null, screen: torn(A) });
  const r = await settleDelivery(sessions, "s1", A, Date.now());
  assert.equal(r.verdict, "composer",
    "it is inside the box the CLI draws to take typing — which is the question, and the only one");
});

test("…and an EMPTY box below a past turn is still not somewhere to press Return", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // The dangerous inverse, and the reason the narrowing exists at all: this CLI
  // scrolls rather than repainting, so a prompt that already RAN is sitting in
  // the visible tail verbatim. `composer` means "press Return there, never
  // retype it", and the box it would point at here is empty.
  const scrolled = torn("").replace("✻ Sautéed for 40s", `> ${A}`);
  const sessions = fakeSessions({ turns: null, screen: scrolled });
  const r = await settleDelivery(sessions, "s1", A, Date.now());
  assert.equal(r.verdict, "unknown", "seen on screen, not in the box — and no log to say it ran");
});

test("a box the tear pushed far up the replay is still the box", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // The window asymmetry, which is its own failure and not a detail of the one
  // above. `deliver.ts` reads a wider screen than the rest of this path
  // precisely because the anchor is structural, and this reader used to take 40
  // rows — so a tear that stranded the composer fifty rows up was confirmable
  // there and invisible here: the anchored rule saw no box, the fallback slice
  // saw no text, and the delivery settled `unknown` (or, with a log that could
  // not find it, `absent` — which authorises sending it again) while the words
  // sat in the composer. Both sides share `composer.ts`'s `ROW_WINDOW` now.
  //
  // The fake honours `lines` the way the real `screenText` does, because that
  // is the entire subject of this test.
  const rows = [
    "  ⏺ Read(packages/host/src/echo.ts)",
    "─".repeat(60),
    `❯ ${A}`,
    "─".repeat(60),
  ];
  for (let i = 0; i < 55; i++) rows.push(`  ⏺ streaming turn output row ${i} lorem ipsum`);
  const sessions = {
    get: () => ({ running: true }),
    keepsClaudeLog: () => true,
    screenText: async (_id, lines) => rows.slice(-lines).join("\n"),
    getTranscript: () => null,
  };
  const r = await settleDelivery(sessions, "s1", A, Date.now());
  assert.equal(r.verdict, "composer",
    "fifty rows of streamed output below the box does not move the box");
});

test("a session whose backend keeps no claude log is never asked for a transcript", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // The verdict was always right — `loggedPrompts` counts only `source:
  // "jsonl"`, so an opencode document was already no evidence — and it was right
  // one line too late. `getTranscript` had by then opened opencode's SQLite
  // store, read every message and part of the conversation and folded a
  // multi-megabyte document, synchronously, on the loop that pumps every PTY,
  // for an answer that is a constant. This counts the calls, because "we did not
  // do the work" is the whole of the fix and the verdict alone cannot show it.
  let asked = 0;
  const sessions = fakeSessions({
    turns: [turn("u1", A)], claudeLog: false, onTranscript: () => { asked += 1; },
  });
  const r = logMatch(sessions, "s-oc", A, Date.now());
  assert.equal(asked, 0, "the transcript is not read for a backend whose record this cannot be");
  assert.equal(r.verdict, "unknown",
    "no log to read is `unknown` — never `absent`, which authorises sending the prompt again");

  // The control, so the zero above is a fact about the gate and not about a fake
  // that answers nothing: the identical call on a claude session DOES read.
  const claude = fakeSessions({ turns: [turn("u2", A)], onTranscript: () => { asked += 1; } });
  assert.equal(logMatch(claude, "s-claude", A, Date.now()).verdict, "landed");
  assert.equal(asked, 1, "the claude path is unchanged");
});

// ── A backend's own user turns as the evidence (`sources.delivery.userTurns`) ─
//
// Where `keepsClaudeLog` is false, the side channel's record of user messages
// is what settling reads — under `logMatch`'s rules exactly: the WHOLE text,
// the recency floor, and the spent-turn ledger keyed on the SOURCE's turn id.
// `absent` still needs a list the source actually returned.

/** A non-claude session (no screen to speak of) plus a fake delivery source. */
function sourced(userTurns, { screen = "" } = {}) {
  const calls = [];
  setLiveSourceLookup((id) => ({
    session: { id, cwd: "/tmp/x", spawnedAt: 0 },
    sources: {
      delivery: {
        landed: async () => false,
        userTurns: async (_s, sinceMs) => { calls.push(sinceMs); return typeof userTurns === "function" ? userTurns() : userTurns; },
      },
      attach: async () => ({ close: async () => {}, health: () => ({ state: "up", since: 0 }) }),
    },
    health: () => ({ state: "up", since: 0 }),
  }));
  const sessions = {
    get: () => ({ running: true }),
    keepsClaudeLog: () => false,
    screenText: async () => screen,
    getTranscript: () => { throw new Error("a sourced non-claude session must not read a transcript"); },
  };
  return { sessions, calls };
}

test("a source's user turn settles a delivery `landed`, and is spent on it", async (t) => {
  forgetSpentTurns();
  t.after(() => { forgetSpentTurns(); setLiveSourceLookup(null); });
  const now = Date.now();
  const { sessions, calls } = sourced([{ id: "msg_1", text: A, at: now + 10 }]);
  const r = await settleDelivery(sessions, "s-oc", A, now, { claimer: "ack-1" });
  assert.equal(r.verdict, "landed");
  assert.equal(r.turnId, "msg_1", "the source's own id is the proof's name");
  assert.ok(calls[0] <= now, "asked from the recency floor, slack included");
  // The same words, a second delivery: the one message is already somebody's.
  const again = await settleDelivery(sessions, "s-oc", A, now, { claimer: "ack-2" });
  assert.equal(again.verdict, "unknown", "one user message proves one delivery — never `absent`");
  // …while the first claimer keeps its own evidence on a re-ask.
  assert.equal((await settleDelivery(sessions, "s-oc", A, now, { claimer: "ack-1" })).verdict, "landed");
});

test("a source's list without our words is `absent`; a source that cannot say is `unknown`", async (t) => {
  forgetSpentTurns();
  t.after(() => { forgetSpentTurns(); setLiveSourceLookup(null); });
  const now = Date.now();
  // B shares A's fourteen-character head: the whole-text rule, not the probe.
  const listed = sourced([{ id: "msg_2", text: B, at: now + 10 }], { screen: "an idle screen with nothing typed in it" });
  assert.equal((await settleDelivery(listed.sessions, "s-oc", A, now)).verdict, "absent",
    "a readable list lacking the words is the evidence `absent` requires");
  const blind = sourced(null, { screen: "an idle screen with nothing typed in it" });
  assert.equal((await settleDelivery(blind.sessions, "s-oc", A, now)).verdict, "unknown",
    "null is the source saying it cannot tell — never authority for a re-send");
  const throws = sourced(() => { throw new Error("channel gone"); }, { screen: "an idle screen" });
  assert.equal((await settleDelivery(throws.sessions, "s-oc", A, now)).verdict, "unknown");
});

test("a claude session never asks the source, even when one is installed", async (t) => {
  forgetSpentTurns();
  t.after(() => { forgetSpentTurns(); setLiveSourceLookup(null); });
  const { calls } = sourced([{ id: "msg_3", text: A, at: Date.now() }]);
  const claude = fakeSessions({ turns: [] });
  const r = await settleDelivery(claude, "s-claude", A, Date.now());
  assert.equal(calls.length, 0, "claude's log is the evidence there, as it always was");
  assert.notEqual(r.verdict, "landed");
});

// ── The CLI's own queue (2.1.310) ────────────────────────────────────────────
//
// A prompt submitted into a busy session leaves the composer at once and is in
// the log only as a `queue-operation` enqueue until the CLI takes it — measured:
// 2 min 49 s for one prompt. Log without a turn + an empty composer used to read
// `absent`, the verdict that types it a second time.

test("a prompt the CLI holds in its own queue is never `absent`", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  const now = Date.now();
  const sessions = fakeSessions({ turns: [turn("u1", "an unrelated earlier prompt", now - 60_000)], held: [{ at: now + 500, text: A }] });
  const r = await settleDelivery(sessions, "s1", A, now);
  assert.equal(r.verdict, "unknown");
  assert.equal(r.held, true, "the caller is told WHY it cannot say, so it keeps asking instead of giving up");
  assert.equal(logVerdict(sessions, "s1", A, now), "unknown", "the intents' re-fire check reads the same rule");
  // Somebody else's held words are not ours.
  assert.equal(logVerdict(sessions, "s1", B, now), "absent");
});

test("an enqueue older than the delivery is somebody else's", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  const now = Date.now();
  const sessions = fakeSessions({ turns: [], held: [{ at: now - 10 * 60_000, text: A }] });
  assert.equal(logVerdict(sessions, "s1", A, now), "absent");
});

test("our own spliced rows in the jsonl document are not the log", async (t) => {
  forgetSpentTurns();
  t.after(forgetSpentTurns);
  // `getTranscript` merges what WE typed and the log has not caught up with
  // (`queued: true`) — recorded the moment the echo is seen, Return or not.
  const now = Date.now();
  const sessions = fakeSessions({ turns: [{ ...turn("queued:h1", A, now + 100), queued: true }] });
  assert.equal(logVerdict(sessions, "s1", A, now), "absent", "our history is not the CLI saying it ran");
});

test("parseTranscript reads the queue rows: enqueue held, a reasonless remove handed back", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-held-"));
  try {
    const path = join(dir, "c.jsonl");
    const op = (operation, content, ts, reason) => JSON.stringify({ type: "queue-operation", operation, timestamp: ts, sessionId: "x", content, ...(reason ? { reason } : {}) });
    writeFileSync(path, [
      op("enqueue", A, "2026-10-24T09:29:23.344Z"),
      op("enqueue", B, "2026-10-24T09:29:30.000Z"),
      op("remove", B, "2026-10-24T09:29:40.000Z"),
      op("enqueue", "taken mid-turn", "2026-10-24T09:29:50.000Z"),
      op("remove", "taken mid-turn", "2026-10-24T09:32:12.358Z", "absorbed_mid_turn"),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-10-24T09:33:00.000Z", sessionId: "x" }),
    ].join("\n") + "\n");
    const doc = parseTranscript(path, dir, "lite");
    assert.deepEqual(cliHeldOf(doc).map((h) => h.text), [A, "taken mid-turn"],
      "B was handed back; an absorbed prompt was taken, so it stays held (never `absent`)");
    assert.equal(cliHeldOf(doc)[0].at, Date.parse("2026-10-24T09:29:23.344Z"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
