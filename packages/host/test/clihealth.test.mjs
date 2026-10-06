/**
 * The host half of the CLI-health record: the file, the transitions, and the
 * version re-arm.
 *
 * `shared/clihealth.ts` owns the rules and `npm run test:unit` pins them. What
 * lives here is everything the rules deliberately have no opinion about — a
 * JSON file that may be corrupt, an alert that must fire once per transition
 * rather than once per miss, and a version reading that may simply be missing.
 * All three are the kind of thing that fails quietly in the direction of
 * "nothing was said", which is the failure this whole feature exists to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliHealthStore, noteHealth, setCliHealth } from "../dist/clihealth.js";
import { detectPrompt, dialogEvidence, hasDialogFooter, isDialogFooterRow } from "../dist/prompt.js";

const root = () => mkdtempSync(join(tmpdir(), "waterplane-health-"));

/** A store plus the alerts it fired. */
function make(dir) {
  const alerts = [];
  const changes = [];
  const store = new CliHealthStore(dir, (h, r) => changes.push(r), (kind, p) => alerts.push({ kind, ...p }));
  return { store, alerts, changes };
}

test("an unset singleton makes noteHealth a silent no-op", () => {
  setCliHealth(null);
  // The whole point of the free function: a unit import, a test, or a host
  // built without the store must never be the reason a delivery throws.
  assert.doesNotThrow(() => noteHealth("deliver.echo", "miss", { raw: "x" }));
});

test("a signal alerts on the transition into degraded, not on every miss", () => {
  const { store, alerts } = make(root());
  store.observe("prompt.box", "miss", { raw: "Enter to confirm · Esc to cancel" });
  assert.equal(alerts.length, 0, "one miss is a moment, not a pattern");
  store.observe("prompt.box", "miss", { raw: "Enter to confirm · Esc to cancel" });
  assert.equal(alerts.length, 1, "two in a row is degraded, and worth one word");
  assert.equal(alerts[0].kind, "cli");
  assert.equal(alerts[0].tag, "clihealth-prompt.box");
  store.observe("prompt.box", "miss", { raw: "Enter to confirm · Esc to cancel" });
  assert.equal(alerts.length, 1, "still degraded ⇒ still one alert: a state is not an event");
});

test("recovering is broadcast but never buzzed — nobody needs waking to be told a thing works", () => {
  const { store, alerts } = make(root());
  store.observe("prompt.box", "miss");
  store.observe("prompt.box", "miss");
  assert.equal(alerts.length, 1);
  store.observe("prompt.box", "good");
  assert.equal(alerts.length, 1, "healthy again is not an alert");
});

test("a degraded signal that gets worse says so once more", () => {
  const { store, alerts } = make(root());
  for (let i = 0; i < 5; i++) store.observe("prompt.box", "miss");
  // Two → degraded, five → broken. Two transitions, two alerts; the three
  // misses in between add nothing a reader did not already have.
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].body, /broken/);
});

test("the record survives a restart, and a restart re-announces nothing", () => {
  const dir = root();
  const a = make(dir);
  a.store.observe("deliver.echo", "miss", { raw: "some prompt text" });
  for (let i = 0; i < 5; i++) a.store.observe("deliver.echo", "miss");
  a.store.flush();
  assert.ok(a.alerts.length >= 1, "it said something the first time");

  const b = make(dir);
  assert.equal(b.store.get().signals["deliver.echo"].misses, 6, "the streak came back off disk");
  assert.equal(b.alerts.length, 0, "and the boot said nothing — the user was already told");
  b.store.observe("deliver.echo", "miss");
  assert.equal(b.alerts.length, 0, "a further miss in a state already reported is still not news");
});

test("a corrupt record starts empty rather than throwing into boot", () => {
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  writeFileSync(join(dir, ".waterplane", "clihealth.json"), "{ this is not json");
  const { store } = make(dir);
  assert.deepEqual(store.get().signals, {}, "unreadable ⇒ unknown everywhere, which is honest");
  assert.equal(store.rollup().verdict, "unknown");
});

test("a sample is redacted on the way in, by the signal's own rule", () => {
  const { store } = make(root());
  store.observe("prompt.box", "miss", { raw: "❯ 1) Yes  /Users/somebody/dev/x  token=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
  const s = store.get().signals["prompt.box"].sample;
  assert.match(s, /1\) Yes/, "the line the matcher refused is the point of a sample");
  assert.ok(!s.includes("/Users/somebody"), "the account name is not");
  assert.ok(!s.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "nor is anything credential-shaped");
});

test("a version we could not read is not a version change", () => {
  const { store, alerts } = make(root());
  store.noteVersion("2.1.4");
  store.observe("prompt.box", "good");
  // `UpdateInfo.current` is absent until the first probe answers and can go
  // absent again on a failed one. Treating that gap as a change would re-arm
  // every heuristic — wiping the history this file exists to keep — because a
  // subprocess did not reply.
  store.noteVersion(null);
  store.noteVersion(undefined);
  store.noteVersion("");
  assert.equal(store.get().version, "2.1.4");
  assert.equal(store.get().signals["prompt.box"].lastGoodAt != null, true, "the history is intact");
  assert.equal(alerts.length, 0);
});

test("a real version change re-arms every signal and says so once", () => {
  const { store, alerts } = make(root());
  store.noteVersion("2.1.4");
  for (let i = 0; i < 5; i++) store.observe("prompt.box", "miss");
  alerts.length = 0;
  store.noteVersion("2.2.0");
  assert.equal(store.rollup().verdict, "unknown", "yesterday's verdict was about another binary");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "info");
  assert.match(alerts[0].body, /2\.2\.0/);
  // The breadcrumb that names a cause: "this went red at the upgrade from …".
  assert.equal(store.get().signals["prompt.box"].priorVersion, "2.1.4");
  assert.equal(store.get().signals["prompt.box"].priorVerdict, "broken");
});

test("a first sighting on a fresh record is not an upgrade anybody needs told about", () => {
  const { store, alerts } = make(root());
  store.noteVersion("2.1.4");
  assert.equal(alerts.length, 0, "there was no history to have invalidated");
});

test("flush writes the file, and the file is the record", () => {
  const dir = root();
  const { store } = make(dir);
  store.observe("hook.pipe", "fallback", { via: "silence heuristics" });
  store.flush();
  const raw = JSON.parse(readFileSync(join(dir, ".waterplane", "clihealth.json"), "utf8"));
  assert.equal(raw.signals["hook.pipe"].via, "silence heuristics");
  assert.equal(raw.signals["hook.pipe"].totalMiss, 1, "a fallback counts as a miss — the primary did not answer");
});

// ── What may be counted as a miss at all ─────────────────────────────────
//
// The rule these pin is the one the live host got wrong: **an observation is
// only a miss if the primary rule was the right rule and failed.** The
// choice-box detector reported 44% failure on a machine where it was working
// perfectly, because a claude session displaying prose ABOUT the detector put
// the footer's words on screen, the cheap gate fired as designed, the strict
// pass correctly refused to read a paragraph as a box — and that refusal was
// filed as a miss. `dialogEvidence` is the thing that separates the two, so it
// is where the counting is pinned.

/**
 * The screen `scripts/claude-stub-tui.mjs`'s `prose` mode draws, so the unit
 * fixture and the end-to-end one are the same screen and cannot drift into
 * disagreeing about what the rule is.
 */
const PROSE_SCREEN = [
  "  transcript line 0 lorem ipsum",
  "I read packages/host/src/prompt.ts and here is what the stages do.",
  "The cheap gate is a substring test over a byte window, so the login",
  "screen's Esc to cancel footer already trips it before anything is",
  "rendered, and the strict pass over the screen is what publishes.",
  "",
  "1. the lenient scan keeps the index-1 anchor as its one defence",
  "3. the strict pass may drop that anchor because it has proof",
  "> ",
].join("\n");

/** The stub's `unreadable` mode: a box that is really up and really cannot be
 *  read — option rows numbered `1)`, which is the shape of an upstream change. */
const UNREADABLE_SCREEN = [
  "  transcript line 0 lorem ipsum",
  "Do you want to proceed with /Users/somebody/dev/octopus?",
  "❯ 1) Yes",
  "  2) No, and tell Claude what to do differently",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

test("prose containing a footer's words is not a footer row", () => {
  assert.equal(isDialogFooterRow("screen's Esc to cancel footer already trips it before anything is"), false,
    "the phrase is a clause inside a sentence, which is what an anchored match is for");
  assert.equal(isDialogFooterRow("Enter to confirm is the other half of that footer, quoted here."), false);
  assert.equal(isDialogFooterRow("const DIALOG_FOOTER_RE = /enter to (confirm|select)|esc to cancel/i;"), false,
    "our own source, printed on a screen, is the commonest form of this");
  assert.equal(isDialogFooterRow("Press Esc to cancel."), false, "a sentence is not a hint row");
});

test("the footer as the CLI actually draws it IS a footer row", () => {
  assert.equal(isDialogFooterRow("Enter to confirm · Esc to cancel"), true);
  assert.equal(isDialogFooterRow("  Esc to cancel"), true);
  assert.equal(isDialogFooterRow("│ Enter to select · Tab/Arrow keys to navigate · Esc to cancel │"), true,
    "inside a bordered panel, and with a hint whose key is two words");
  assert.equal(isDialogFooterRow("↑↓ to navigate · Enter to confirm · Esc to cancel"), true);
});

test("prose that trips the cheap gate is a CORRECT REFUSAL, and records nothing", () => {
  // Both halves matter. The gate must still fire — it is the safety interlock,
  // and its rule ("is anything possibly asking you something?") is deliberately
  // loose because a false wait costs a queue seconds and typing into a live
  // question box costs a turn's work.
  assert.equal(hasDialogFooter(PROSE_SCREEN), true, "the interlock still fires, as it should");
  assert.equal(detectPrompt(PROSE_SCREEN), null, "and the strict pass correctly publishes nothing");
  // …and the health record must NOT count that. No box, no claim about the
  // box detector.
  const ev = dialogEvidence(PROSE_SCREEN);
  assert.equal(ev.footerRow, false, "no row on that screen is a footer");
  assert.equal(ev.box, false, "so there is no evidence a box was up, so there is no miss to record");
});

test("a box that is really up and really unreadable IS a miss", () => {
  assert.equal(detectPrompt(UNREADABLE_SCREEN), null, "`1)` is one character, and the box becomes invisible");
  const ev = dialogEvidence(UNREADABLE_SCREEN);
  assert.equal(ev.footerRow, true, "the CLI drew its footer as a row");
  assert.equal(ev.cursor, true, "…with a selection cursor above it, which prose does not have");
  assert.equal(ev.box, true, "which is what makes the refusal a failure rather than a judgement");
});

test("option rows alone are evidence too — a cursor can be repainted away", () => {
  const half = ["Do you want to proceed?", "  1. Yes", "  2. No", "", "Enter to confirm · Esc to cancel"].join("\n");
  const ev = dialogEvidence(half);
  assert.equal(ev.cursor, false);
  assert.equal(ev.options, 2);
  assert.equal(ev.box, true);
});

/**
 * The regression case itself: the sample the LIVE record was holding on
 * 2026-09-05 when `prompt.box` read "4 of the last 9 failed".
 *
 * Copied verbatim off `~/dev/.waterplane/clihealth.json` rather than written by hand,
 * because a fixture an author composes is a fixture that agrees with the author.
 * It is a claude session running our own `login.ts` work — the redaction marker
 * is the store's, and the glued-together words are what the TUI's repaint does
 * to a row it rewrites in place (it erases a cell and steps over it instead of
 * writing the space back). Nothing on it is a footer; the phrase is a clause on
 * the third row, which is exactly why an anchored match is the rule and a
 * substring test is not.
 */
const LIVE_SAMPLE = [
  "glued,on). Width <redacted:25>,dnothcols — the CLI also wraps inside its own box.",
  "test/login.test.mjs (7 pass) detectLogin reads the rendered screen, publishes",
  "onscheckPrompt'snstrictlpassa—ttheCloginascreen'ss Esc to cancel footer already…",
].join("\n");

test("the sample the live record actually held is a correct refusal, not a miss", () => {
  assert.equal(hasDialogFooter(LIVE_SAMPLE), true,
    "the cheap gate fired on it — which is why there was ever an observation to get wrong");
  assert.equal(detectPrompt(LIVE_SAMPLE), null, "and the strict pass was right to publish nothing");
  for (const row of LIVE_SAMPLE.split("\n")) {
    assert.equal(isDialogFooterRow(row), false, `not a footer row: ${row}`);
  }
  const ev = dialogEvidence(LIVE_SAMPLE);
  assert.equal(ev.footerRow, false);
  assert.equal(ev.box, false, "so the four-of-nine reading was four statements about nothing");
});

/**
 * The SECOND live false alarm, 2026-09-07, and the reason `composer` exists.
 *
 * Reconstructed from the sample the record was holding (`~/dev/.waterplane/
 * clihealth.json`, `prompt.box`, seven misses all-time and a permanently amber
 * board). The CLI's own `/effort` picker draws a real footer row — every
 * segment a key hint, the dialog phrase whole inside one — with a "\u276f" on the
 * highlighted row and NO numbered options, because it has none. Footer plus
 * cursor was the evidence rule, so every trip to that menu filed a miss against
 * a detector that had nothing of its shape to parse.
 *
 * What separates it from a question box is the composer's STATUS LINE, drawn
 * under the picker: the CLI is still taking typing, so what is up is its own
 * inline menu. A modal box never draws it, being the last thing on screen.
 */
const EFFORT_PICKER = [
  "  transcript line 0 lorem ipsum",
  "\u276f high",
  "  medium",
  "  low",
  "\u2500".repeat(54),
  "[CAVEMAN] auto mode on (shift+tab to cycle) \u00b7 2 agents \u25cf high \u00b7 /effort",
  "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel",
].join("\n");

test("the CLI's own slash picker is not a question box, and records nothing", () => {
  // The footer and the cursor are both real — this is not prose, and the
  // anchored matcher is right to see them.
  assert.equal(isDialogFooterRow("Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel"), true);
  const ev = dialogEvidence(EFFORT_PICKER);
  assert.equal(ev.footerRow, true, "the picker draws a real footer row");
  assert.equal(ev.cursor, true, "with the selection cursor on the highlighted effort");
  assert.equal(ev.options, 0, "and no numbered options at all, because it has none");
  assert.equal(ev.composer, true, "but the composer's status line is under it: the CLI still takes typing");
  assert.equal(ev.box, false, "so there was no question to read, and no claim to make about the reader");
  assert.equal(detectPrompt(EFFORT_PICKER), null, "the strict pass publishes nothing, correctly");
  // The interlock is deliberately NOT narrowed by this: a menu taking
  // keystrokes is still a session that must not be typed a prompt into.
  assert.equal(hasDialogFooter(EFFORT_PICKER), true, "the safety interlock still holds it");
});

test("a real box is not silenced by a status line that scrolled far above it", () => {
  // The mirror risk of the rule above. `BOX_ROWS` is 40, and a composer line
  // from an earlier screen must not reach forward into a box drawn later — so
  // the test that matters is the one where the status line is ABOVE the box
  // rather than under it. Only what sits between the box and its footer counts.
  const box = ["  1. Yes", "  2. No", "", "Enter to confirm \u00b7 Esc to cancel"].join("\n");
  const ev = dialogEvidence(["shift+tab to cycle", ...Array(41).fill("  transcript line"), box].join("\n"));
  assert.equal(ev.composer, false, "that status line is out of the box's span");
  assert.equal(ev.box, true);
});

test("a half-drawn repaint of a real box is still a miss — the box is up, we just cannot read it", () => {
  // The case the under-report must not swallow. A capture taken mid-repaint has
  // the footer and the cursor row but not the option text, and that IS the
  // failure this signal exists for: a live question is on screen and the phone
  // gets no buttons. Distinguishing it from prose is the whole job — prose has
  // neither of the two things below.
  const midRepaint = [
    "Do you want to make this edit to api.ts?",
    "❯ 1",
    "  2",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  assert.equal(detectPrompt(midRepaint), null, "the labels are not on the screen yet, so nothing parses");
  const ev = dialogEvidence(midRepaint);
  assert.equal(ev.footerRow, true, "the CLI drew its footer as a row");
  assert.equal(ev.cursor, true, "and the selection cursor is sitting on something");
  assert.equal(ev.box, true, "a box is up and unreadable — the one thing that must always count");
});

test("a footer row with nothing above it stays silent rather than guessing", () => {
  // The deliberate under-report. A detector that has gone blind in every way at
  // once records no miss here — and no `good` anywhere else either, so the
  // signal ages back to `unknown`, which this board keeps distinct from
  // `healthy` for exactly this reason. Under-reporting degrades to "I cannot
  // say"; over-reporting degrades to a chip nobody taps.
  const ev = dialogEvidence(["some prose", "", "Enter to confirm · Esc to cancel"].join("\n"));
  assert.equal(ev.footerRow, true);
  assert.equal(ev.box, false);
});

test("the sample is anchored on the footer ROW, so it holds the box and not the composer", () => {
  const { store } = make(root());
  // What `sessions.ts` passes: the rows ending at the matched footer row.
  const rows = UNREADABLE_SCREEN.split("\n");
  const hit = rows.findIndex((l) => isDialogFooterRow(l));
  store.observe("prompt.box", "fallback", { raw: rows.slice(Math.max(0, hit - 5), hit + 1).join("\n") });
  const s = store.get().signals["prompt.box"].sample;
  assert.match(s, /Enter to confirm/, "the line that stopped matching");
  assert.match(s, /1\) Yes/, "and the rows it refused");
  assert.ok(!s.includes("/Users/somebody"), "with the account name redacted out of it");
});
