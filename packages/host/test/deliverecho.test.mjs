/**
 * What a delivery does with the ECHO — the half of `deliver.ts` that decides
 * whether the text it typed is on the screen, and what it is allowed to do when
 * it thinks it is not.
 *
 * Sibling of `deliversubmit.test.mjs`, which pins the other end of the same
 * function. These three cases are the ones a booted host cannot be asked to
 * produce on demand, and every one of them cost something real:
 *
 *   • the composer sitting SIXTEEN rows above the bottom of the render. The old
 *     rule accepted a hit within ~11 rows of the last row of the capture, which
 *     measures the TEAR and not the box: `render.ts` replays the whole buffer
 *     into a fixed 50-row VT, so mid-turn a half-done repaint leaves a
 *     duplicated footer and rows of streaming output UNDER the newest composer
 *     frame. The echo was found and then refused. ~30% of deliveries.
 *   • the miss sweep firing into a LIVE TURN. `unconfirmed` opens with an Esc,
 *     which interrupts the turn, and then six ctrl-Us, which delete the
 *     interjection that had in fact landed — after which the sweep re-sent it
 *     minutes later.
 *   • the ambiguous `before`, which records NOTHING. Nothing was typed, so no
 *     echo of our text was ever owed; filing it as a miss would peg the signal
 *     amber on the commonest shape there is (a re-send of a prompt whose first
 *     attempt is still in the box) with nothing broken at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliverPrompt } from "../dist/deliver.js";
import { CliHealthStore, setCliHealth } from "../dist/clihealth.js";
import { noteDeliveryEnded, noteDeliveryStarted } from "../dist/opendeliveries.js";
import { samePromptText } from "../dist/echo.js";

const TEXT = "have another look at the retry test and say what you find";
/** A slash command that is NOT TUI-local — it starts a turn like any prompt,
 *  and it is what the no-box fallback's slash allowance is about. */
const SLASH_TEXT = "/review packages/host/src/deliver.ts and say what you find";
/** …and one that IS local: a view, no turn, nothing in the conversation log. */
const LOCAL_TEXT = "/context";

/** The composer's own full-width rule, as the CLI draws it. */
const RULE = "─".repeat(60);

/**
 * The shape of the live capture this whole change came from: a composer frame
 * with the text in it, a DUPLICATED footer, and rows of streaming turn output
 * below — so the hit sits far outside the window that used to accept it.
 *
 * The NBSP after the `❯` is the TUI's own padding of the cursor row;
 * `renderCapture` trims spaces and tabs and leaves that one alone.
 */
function tornScreen(inComposer) {
  return [
    "  ⎿  Read packages/host/src/deliver.ts (898 lines)",
    "",
    "✻ Sautéed for 40s (esc to interrupt · ctrl+t to show todos)",
    "",
    RULE,
    `❯\u00a0${inComposer}`,
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
    "  …/clear to save 102.6k tokens",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
    "  …/clear to save 102.6k tokens",
    "  ⏺ Update(packages/host/src/settle.ts)",
    "  ⎿  Updated packages/host/src/settle.ts with 14 additions",
    "     372    const info = sessions.get(sessionId);",
    "     373    const alive = info?.running === true;",
    "  ⏺ Bash(npm run build:shared)",
    "  ⎿  > tsc -p tsconfig.json",
    "  ⏺ Read(packages/host/src/echo.ts)",
    "  ⎿  Read 375 lines",
    "✻ Sautéing… (esc to interrupt)",
  ].join("\n");
}

/**
 * The tear the other way up: TWO composer frames, and the live one is EMPTY.
 *
 * The interjection above was submitted moments ago, so the box at the bottom of
 * the replay — the one the CLI is actually taking typing into — is empty, while
 * the frame the half-done repaint left behind still shows the words that have
 * already gone. Which of the two is live cannot be read off a rendered screen,
 * and "the newest frame holding anything" picks the wrong one here.
 */
function twoFrameScreen(stale) {
  return [
    "  ⏺ Read(packages/host/src/echo.ts)",
    RULE,
    `❯ ${stale}`,
    RULE,
    "  ⏺ streaming turn output row 0",
    "  ⏺ streaming turn output row 1",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n");
}

/**
 * A screen with NO `❯` box anywhere on it — the no-box FALLBACK, which is the
 * old distance rule and the only thing left when a picker covers the composer
 * or an upstream redraw stops being recognised.
 *
 * Shaped as the one screen that rule can be talked into a wrong answer on: an
 * earlier `/review …` of these exact words sixty rows up, drawn as the CLI
 * renders a user turn it has already run, with tool output under it. Every one
 * of those output rows starts with `/` because it is a file path, which is what
 * the rule's slash-completion allowance keys on — so a fallback that can see
 * sixty rows reads a command that RAN as one sitting unsent in the box.
 */
function noBoxScreen(typed) {
  const rows = [
    "  ⏺ Read(packages/host/src/echo.ts)",
    `> ${SLASH_TEXT}`,
    "  ⎿  Read 375 lines",
  ];
  for (let i = 0; i < 60; i++) rows.push(`  /Users/me/dev/myapp/packages/host/src/file${i}.ts`);
  rows.push(typed ? `> ${typed}` : "> ");
  return rows.join("\n");
}

/**
 * A session manager with nothing in it but the screen and the keystroke log.
 *
 * `composer` is what the box is holding right now; `echoes` says whether our
 * own write lands in it (false is the screen that never shows the text, which
 * is the miss path). Every byte written is kept, because the assertions that
 * matter here are about bytes that must NOT have been sent.
 *
 * `render` is which of the screens above this session is drawing; `drifts`
 * repaints it on its own every time it is read, which is what an ordinary busy
 * TUI does (a spinner frame, a token counter) and the only evidence the
 * local-command rescue below has to work from.
 */
function fakeSessions({
  hooked = false, turnActive = false, composer = "", echoes = true,
  render = tornScreen, drifts = false, submitted = [],
} = {}) {
  const state = { hooked, turnActive, composer, writes: [], scrollback: "x".repeat(100), paints: 0, submitted, onReturn: null };
  const info = { id: "s1", running: true, get turnActive() { return state.turnActive; } };
  return {
    state,
    get: () => info,
    idleMs: () => 300,
    waitReady: async () => true,
    screenText: async () => {
      const drawn = render(state.composer);
      return drifts ? `${drawn}\n  ⏺ streaming turn output row ${state.paints++}` : drawn;
    },
    scrollback: () => state.scrollback,
    recordPrompt: () => {},
    isHooked: () => state.hooked,
    stopCount: () => 0,
    /** The grid the composer is drawn in — the audit row's, never a branch's. */
    geometry: () => ({ cols: 80, rows: 30 }),
    /**
     * The CLI's own `UserPromptSubmit`, as this double can produce it: the
     * prompts `submitted` says went in, claimed at most once each — the whole
     * point of the ledger being that two deliveries of one text cannot both
     * read one hook event as their own.
     */
    claimSubmittedPrompt: (_id, text, since) => {
      // `since` is not decoration: an event from BEFORE this delivery started
      // is somebody else's, and a double that ignored the window let a second
      // send of identical words claim the first send's hook — which is the
      // exact failure the real ledger is spending a claim to prevent.
      const i = state.submitted.findIndex((e) => !e.claimed && e.prompt === text && (e.at ?? 0) >= since);
      if (i < 0) return false;
      state.submitted[i].claimed = true;
      return true;
    },
    lastSubmittedPrompt: (_id, since) => state.submitted.filter((e) => (e.at ?? 0) >= since).at(-1)?.prompt ?? null,

    // This double has no screen-inferred turn state to tell apart from a
    // hook-announced one — `turnActive` IS the hook's fact here.
    turnFromHook: () => state.turnActive,
    // Settling asks this BEFORE it reads a transcript: a backend whose record is
    // not claude's jsonl can never produce the evidence those verdicts are
    // about, and reading one to find that out costs a full store read per
    // settle. This double is a claude session, like everything else here.
    keepsClaudeLog: () => true,
    getTranscript: () => null,
    noteHookFallback: () => {},
    // This double stands in for a CLAUDE session, which is what every assertion
    // in this file is about: `deliver.ts` asks the manager whether the session's
    // backend is inside the health record's scope before filing anything, and
    // for claude the answer has always been yes.
    healthScope: () => true,
    write: (_id, data) => {
      state.writes.push(data);
      // A Return submits what the BOX is holding, so it starts a turn only when
      // the box holds something. That distinction had no consequence while
      // nothing pressed Return on the miss path; it decides two cases now — a
      // Return at a composer that never showed our text (`echoes: false`) must
      // leave the session exactly as quiet as it found it, which is what makes
      // the sweep below still fire.
      if (data === "\r") { if (state.composer) state.turnActive = true; state.onReturn?.(); return; }
      if (data === "\x15") { state.composer = ""; return; }
      if (data === "\x1b") return;
      if (echoes) state.composer = data;
    },
  };
}

/** A store with nothing else installed, plus a reader for the echo signal. */
function store() {
  const s = new CliHealthStore(mkdtempSync(join(tmpdir(), "waterplane-echo-")), () => {}, () => {});
  setCliHealth(s);
  return { store: s, echo: () => s.get().signals["deliver.echo"] ?? null };
}

test("a composer sixteen rows above the bottom of the render is still the composer", async () => {
  // The regression, at the level the fix was made: the echo is found, the
  // delivery is confirmed, and the signal records the primary rule ANSWERING.
  // Under the old distance rule this same screen came back `unconfirmed`.
  const h = store();
  const sessions = fakeSessions({ hooked: true });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  const sig = h.echo();
  assert.ok(sig, "one observation per delivery, and this delivery made one");
  assert.equal(sig.window.at(-1).ok, true);
  assert.equal(sig.window.at(-1).fallback ?? false, false, "the primary rule answered — no rescue was needed");
  assert.equal(sessions.state.writes.filter((w) => w === TEXT).length, 1, "typed once, as always");
  assert.ok(!sessions.state.writes.includes("\x1b"), "and nothing swept a composer that was plainly fine");
});

test("our words drawn DIM in an empty box are the CLI's proposal, not a copy already typed", async () => {
  // The first live tap of the phone's "Claude proposes" button: claude draws
  // its proposal for the next prompt dim in the EMPTY composer, the phone sends
  // exactly those words, and the plain render read them as `exact` — so the
  // delivery typed nothing and pressed Return into an empty box. The prompt
  // never ran. The dim-blanked read says the box is empty: type.
  const h = store();
  const sessions = fakeSessions({ hooked: true });
  let hint = TEXT; // drawn until the first keystroke, as the CLI does
  const shown = () => sessions.state.composer || hint;
  sessions.screenText = async () => tornScreen(shown());
  sessions.screenCells = async () => {
    const plain = tornScreen(shown()).split("\n");
    const lit = tornScreen(sessions.state.composer).split("\n");
    return plain.map((text, i) => ({ text, spans: [], undimmed: lit[i] }));
  };
  const write = sessions.write;
  sessions.write = (id, data) => { if (data !== "\r") hint = ""; write(id, data); };
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(sessions.state.writes.filter((w) => w === TEXT).length, 1, "the words were TYPED, not assumed");
  assert.ok(h.echo(), "and the echo of what was typed was seen");
});

test("a composer that already holds text we cannot tell from ours records NOTHING", async (t) => {
  // A rival delivery into the same session whose text shares our fourteen-
  // character head — which is what a re-send looks like. The verdict is
  // `retry` (provably nothing typed, so running it again is free) and the
  // health record must stay silent: the rule was not asked to find our echo and
  // did not fail to. Filing a miss here is the "was this the right rule"
  // mistake, and it fires on the commonest shape there is.
  const rival = TEXT.slice(0, 20) + " — but a completely different instruction";
  noteDeliveryStarted("rival", "s1", rival);
  t.after(() => noteDeliveryEnded("rival"));
  const h = store();
  const sessions = fakeSessions({ hooked: true, composer: rival });
  let detail = "";
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", {
    watch: false, onDetail: (d) => { detail = d; },
  });
  assert.equal(result, "retry", "nothing typed, nothing submitted — safe to run again once the box is clear");
  assert.match(detail, /cannot tell apart/, "…and the audit row says which kind of retry this was");
  assert.equal(h.echo(), null, "no echo was owed, so none is recorded — not a miss and not a good");
  assert.deepEqual(sessions.state.writes, [], "the composer is somebody else's; we neither typed nor pressed Return");
});

test("the miss sweep sends no Esc and no ctrl-U while a turn is provably running", async () => {
  // The expensive half of the old bug. A miss that is a MISPLACED echo rather
  // than a missing one arrives here with the turn very much alive: the Esc
  // interrupts it, and the six ctrl-Us delete the interjection that had landed.
  const h = store();
  const sessions = fakeSessions({ hooked: true, turnActive: true, echoes: false });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "unconfirmed", "the verdict is unchanged — it is the keystrokes that were wrong");
  assert.equal(h.echo().window.at(-1).ok, false, "the echo genuinely missed, and says so");
  assert.ok(!sessions.state.writes.includes("\x1b"), "no Esc into a running turn");
  assert.ok(!sessions.state.writes.includes("\x15"), "and no ctrl-U over text that may have landed");
  assert.deepEqual(sessions.state.writes, [TEXT, "\r"], "the text, then ONE Return — which cannot stack a copy, and which the CLI is asked about by name");
});

test("…and on a quiet session the sweep still fires, because nothing is at risk there", async () => {
  // The guard is about a LIVE TURN, not a blanket disable: text left in an idle
  // composer would otherwise sit under the next attempt.
  store();
  const sessions = fakeSessions({ hooked: true, turnActive: false, echoes: false });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "unconfirmed");
  assert.ok(sessions.state.writes.includes("\x1b"), "an idle session gets its Esc");
  assert.ok(sessions.state.writes.includes("\x15"), "…and its ctrl-U sweep");
});

test("a local command rescued by the screen moving records ONE observation, and it is the fallback", async () => {
  // **One observation per delivery**, and only for what was actually seen.
  //
  // The rescue exists because the conversation log is silent about a slash
  // command by construction, so a `/context` whose echo does not arrive inside
  // the echo window has no second witness but the screen redrawing. Taking it
  // is a `fallback`, which `shared/clihealth.ts` counts as a MISS: the primary
  // rule did not answer. Control then left the failed-echo block and fell
  // through to the unconditional `good` at the end of it, so one delivery whose
  // echo was never seen wrote a miss AND a success into the same twenty-slot
  // window — a rate describing no event at all, and a `good` claiming an echo
  // nobody ever saw. The count is the assertion here, not the last value: the
  // pair reads correct from either end on its own.
  const h = store();
  const sessions = fakeSessions({ hooked: true, echoes: false, drifts: true });
  const result = await deliverPrompt(sessions, "s1", LOCAL_TEXT, "prompt", { watch: false });
  assert.equal(result, "ok", "the view opened — the screen moved, which is all a local command can prove");
  const sig = h.echo();
  assert.ok(sig, "the delivery is still an observation — it just is not a good one");
  assert.equal(sig.window.length, 1, "ONE delivery, ONE observation");
  assert.equal(sig.window[0].ok, false, "the echo never appeared, so nothing here may read as a success");
  assert.equal(sig.window[0].fallback, true, "…it is the rescue being taken, and that is what the record says");
});

test("the no-box fallback may not reach sixty rows up to find a command that already ran", async () => {
  // The fallback is the OLD distance rule, and it has to stay old.
  //
  // Its slash-completion allowance accepts a hit at any height as long as two
  // squashed rows below it start with `/` — which was bounded by nothing except
  // the 40 rows the old code could physically see, because rows starting with
  // `/` are file paths and tool output is made of them. Handed the wider window
  // the ANCHORED rule needs, it reads a `/review …` that ran sixty rows ago as
  // one sitting unsent in the box: "already typed, provably ours", nothing
  // typed, and a Return pressed into an empty composer. This screen is exactly
  // that, and the assertion is on the KEYSTROKES — the verdict is `ok` either
  // way, which is the whole danger.
  store();
  const sessions = fakeSessions({ hooked: true, render: noBoxScreen });
  const result = await deliverPrompt(sessions, "s1", SLASH_TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.deepEqual(
    sessions.state.writes,
    [SLASH_TEXT, "\r"],
    "the text was TYPED and then submitted — never a bare Return at a box the app only thought was full",
  );
});

test("two composers that do not agree are not a composer this app may act on", async () => {
  // The other way the tear falls. `newestOnly` answers "does the box already
  // hold my text" off the bottom-most frame that is holding anything, which is
  // right when the stale frame is the empty one — and wrong here: an
  // interjection was just SUBMITTED, so the live box at the bottom is empty and
  // the stale frame above it still shows the words that have already gone.
  // Believing the stale one means typing nothing and pressing Return at
  // nothing: `unsubmitted` for a prompt that never ran, off a screen that said
  // "provably ours".
  //
  // Neither frame can be shown to be the live one, so the answer is neither of
  // them. `retry` has provably no side effect — nothing typed, nothing
  // submitted — and the health record stays silent for the same reason it does
  // on the rival branch: no echo of our text was ever owed.
  const h = store();
  const sessions = fakeSessions({ hooked: true, render: twoFrameScreen, composer: TEXT });
  let detail = "";
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", {
    watch: false, onDetail: (d) => { detail = d; },
  });
  assert.equal(result, "retry", "safe to run again: this delivery touched nothing");
  assert.match(detail, /cannot tell which one is live/, "…and the audit row says which kind of retry this was");
  assert.deepEqual(sessions.state.writes, [], "no text, and above all no Return at an empty box");
  assert.equal(h.echo(), null, "nothing was typed, so no echo was owed and none is recorded");
});

/**
 * **The rescue the composer's own geometry made necessary.**
 *
 * The composer is a VIEWPORT (`echo.ts`'s `scrolled`): it is sized off the
 * terminal's height and the text scrolls inside it, so a long single-line
 * prompt — which is what a phone produces — draws only its TAIL, and the head
 * the probe is cut from is off the top of the box. Measured on the live host
 * over a fortnight: 46% of deliveries between 300 and 800 characters came back
 * unconfirmable against 19% of the shorter ones, and the health record's own
 * sample for the signal reads `1 lines, 632 chars`. Those prompts were typed
 * and one keystroke from running.
 *
 * `UserPromptSubmit` carries the submitted text, so the CLI can simply be ASKED
 * — and its answer is about this delivery rather than about the session being
 * busy, which is what every other proof in this file is.
 */
test("a prompt the screen never showed is rescued by the CLI naming it back", async () => {
  const h = store();
  // `echoes: false` is the whole case: the text goes in and the screen never
  // shows it. The hook then reports the prompt the Return submitted.
  const sessions = fakeSessions({ hooked: true, echoes: false });
  sessions.state.onReturn = () => sessions.state.submitted.push({ prompt: TEXT, claimed: false, at: Date.now() });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok", "the CLI said it took these very words — that is not an ambiguous delivery");
  const sig = h.echo();
  assert.equal(sig.window.at(-1).ok, false, "and the echo rule still did NOT answer: this is a fallback, not a good");
  assert.ok(!sessions.state.writes.includes("\x1b"), "nothing sweeps a composer whose contents provably ran");
  assert.ok(!sessions.state.writes.includes("\x15"), "…and nothing ctrl-Us the prompt that is now running");
  assert.equal(sessions.state.writes.filter((w) => w === "\r").length, 1, "one Return, not a loop of them");
});

test("a hook naming somebody ELSE's prompt rescues nothing", async () => {
  // The failure this could have introduced, pinned: a Return into a box whose
  // contents we could not read may submit words that are not ours. The hook is
  // what makes that visible instead of silent, so the verdict stays
  // `unconfirmed` — and the row says what happened rather than reporting a
  // clean miss.
  store();
  const sessions = fakeSessions({ hooked: true, echoes: false });
  sessions.state.onReturn = () => sessions.state.submitted.push({ prompt: "a completely different instruction", claimed: false, at: Date.now() });
  let detail = "";
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false, onDetail: (d) => { detail = d; } });
  assert.equal(result, "unconfirmed", "another prompt's submission is not evidence about ours");
  assert.match(detail, /submitted something other than your text/, "…and the audit row says so, which no screen rule could");
});

test("an unhooked session is left exactly as it was", async () => {
  // The proof does not exist without a pipe (and cannot for a backend that has
  // no hooks at all), so nothing is pressed and the old path runs unchanged: no
  // Return at a box we cannot read, and the sweep still clears it.
  store();
  const sessions = fakeSessions({ hooked: false, echoes: false });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "unconfirmed");
  assert.ok(!sessions.state.writes.includes("\r"), "no pipe to ask, so no Return is pressed on a guess");
  assert.ok(sessions.state.writes.includes("\x15"), "and the composer is swept, as it always was");
});

/**
 * The matcher itself, which is the only thing standing between "the CLI took
 * our words" and "the CLI took somebody's words". STRICT on purpose: the
 * verdict it upgrades (`unconfirmed` → `ok`) is the one nothing revisits, so a
 * wrong yes loses a prompt silently, while a wrong no costs a settle pass that
 * was going to run anyway.
 */
test("the submitted-prompt match normalises a terminal round trip and nothing else", () => {
  assert.equal(samePromptText(TEXT, TEXT), true);
  assert.equal(samePromptText(`${TEXT}\r\n`, TEXT), true, "the PTY writes \\r and the CLI reports \\n");
  assert.equal(samePromptText(`${TEXT}   `, TEXT), true, "a trailing space before Return is not a different prompt");
  assert.equal(samePromptText(TEXT, TEXT.slice(0, 40)), false, "a PREFIX is not a match — a re-send of a shorter prompt would claim it");
  assert.equal(samePromptText(`${TEXT} and one more thing`, TEXT), false, "…and neither is a superset");
  assert.equal(samePromptText("", ""), false, "an empty payload proves nothing");
});

/**
 * **A pasted prompt is named back in the CLI's envelope** — the hook payload
 * measured on 2.1.301 (one 1745-char write, read in two pieces: the first
 * wrapped, the rest plain) and the log's shape on 2.1.300 (a 5045-char write,
 * five wrapped chunks, each seam cutting mid-word). Both are the very words
 * typed; before this rule both read as "something other than your text", and
 * every such delivery whose echo the screen missed came back `unconfirmed`
 * though it ran.
 */
test("the submitted-prompt match reads the CLI's paste envelope, and only as the whole text", () => {
  const LONG = "Implement the plan in docs/plan.md — all of it.\n\nRun one subagent per package (WP1 first).\n- Commit after each package.\n- At the end: npm test, then write the report.";
  const at = 40; // a seam cutting mid-word, as the CLI's ~1 KB reads do
  const hookShape = `\n\n<pasted_content id="7ed2">\n${LONG.slice(0, at)}\n</pasted_content id="7ed2">\n\n${LONG.slice(at)}`;
  const logShape = `\n\n<pasted_content id="550a">\n${LONG.slice(0, at)}\n</pasted_content id="550a">\n\n\n<pasted_content id="550a">\n${LONG.slice(at)}\n</pasted_content id="550a">\n`;
  assert.equal(samePromptText(hookShape, LONG), true, "the hook's shape: one chunk wrapped, the rest plain");
  assert.equal(samePromptText(logShape, LONG), true, "the log's shape: every chunk wrapped");
  assert.equal(samePromptText(`\n\n<pasted_content id="1">\n${LONG.slice(0, 60)}\n</pasted_content id="1">\n`, LONG), false, "a PREFIX in an envelope is still a prefix");
  assert.equal(samePromptText(logShape, LONG.slice(0, 60)), false, "…and a superset still a superset");
  assert.equal(samePromptText(logShape.replace("WP1", "WP2"), LONG), false, "another prompt in the same envelope is another prompt");
  assert.equal(samePromptText(logShape, LONG.toLowerCase()), false, "case is not whitespace");
  assert.equal(samePromptText(LONG.replace(/\n+/g, " "), LONG), false, "no envelope, no whitespace blindness: the strict rule stands");
  assert.equal(samePromptText('<pasted_content id="1"></pasted_content id="1">', ""), false, "an empty envelope proves nothing");
});

/**
 * **The 2026-10-15 backlog failure, at the level a person saw it.** A real
 * 2.1.301 grid of a long prompt collapsed into five chits with nothing else in
 * the box (`fixtures/screens/paste-chain.txt`). The echo used to read `none`,
 * the delivery fell to the hook as its last proof, and with no hook it came
 * back `unconfirmed` though the words were one Return from running.
 */
test("a long paste the CLI drew as a run of chits is an echo, confirmed by the screen", async () => {
  const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "screens");
  const grid = readFileSync(join(FX, "paste-chain.txt"), "utf8");
  const text = readFileSync(join(FX, "paste-chain.prompt"), "utf8");
  const rows = grid.split("\n");
  const at = rows.findIndex((r) => r.startsWith("❯"));
  const close = rows.findIndex((r, i) => i > at && /^─{20,}$/.test(r.trim()));
  const empty = [...rows.slice(0, at), "❯ ", ...rows.slice(close)].join("\n");
  const h = store();
  const sessions = fakeSessions({ hooked: true, render: (c) => (c ? grid : empty) });
  const result = await deliverPrompt(sessions, "s1", text, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(h.echo().window.at(-1).ok, true, "the echo rule ANSWERED — no fallback, no hook needed");
  assert.equal(sessions.state.writes.filter((w) => w === "\r").length, 1, "one Return");
});
