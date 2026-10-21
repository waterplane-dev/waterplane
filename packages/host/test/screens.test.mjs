/**
 * Real screens off claude 2.1.301, each run through the reader it feeds.
 *
 * Every file in `fixtures/screens/` is a `tmux capture-pane -p` of the
 * installed binary (2.1.301, model haiku, 100x30 unless the name says
 * otherwise), driven in a private-socket tmux session in a scratch dir. The one
 * edit is the banner's working-directory row, cut to `/tmp/wp301` so no local
 * path enters the repo; no row a reader looks at was touched. Which signal each
 * file feeds is declared in `fixtures/signals.json` (`tools/screenfixtures.mjs`).
 *
 *   checkbox-*.txt         an AskUserQuestion with multiSelect: true — fresh,
 *                          one row ticked with its digit, the cursor walked
 *                          down to Submit, and the same at 46 columns.
 *   context-view.txt       what `/context` printed (the gauge row).
 *   slash-*-typed/open     a TUI-local command in the composer (its menu up)
 *                          and the screen after Return — the "screen moved"
 *                          proof `deliverreturn.ts` files `slash.local` on.
 *   paste-*.txt            a long multi-line paste in the composer (80x30),
 *                          its prompt beside it as `paste-*.prompt`.
 *
 * Measured here first: a TICKED row is drawn `[✔]` (U+2714), which the label
 * strip did not know, so ticking Banana published the label "[✔] Banana".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPrompt, navToSubmit, dialogEvidence, mergeBox, sameBox, samePrompt } from "../dist/prompt.js";
import { detectContext } from "../dist/context.js";
import { detectLimitText } from "../dist/limit.js";
import { startsNoTurn, isLocalCommand } from "../dist/slash.js";
import { pastedNewlines } from "../dist/echo.js";
import { composerEcho, composerSpans, composerText } from "../dist/composer.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "screens");
const screen = (name) => readFileSync(join(DIR, `${name}.txt`), "utf8");
const LABELS = ["Apple", "Banana", "Cherry", "Type something", "Chat about this"];

test("2.1.301 checkbox box: read as one multi-select box with the question the CLI drew", () => {
  for (const name of ["checkbox-submit", "checkbox-toggled", "checkbox-on-submit", "checkbox-46col"]) {
    const p = detectPrompt(screen(name));
    assert.ok(p, `${name}: the box must be detected`);
    assert.equal(p.multi, true, `${name}: a checkbox box`);
    assert.equal(p.question, "Which fruits should go in the salad?", name);
    assert.deepEqual(p.options.map((o) => o.label), LABELS, `${name}: labels carry no checkbox mark`);
  }
  for (const name of ["checkbox-submit", "checkbox-toggled"]) assert.equal(dialogEvidence(screen(name)).box, true, name);
});

test("2.1.301 checkbox box: the footer is still read as a footer once the cursor is on Submit", { todo:
  "with the cursor on Submit the CLI adds 'ctrl+g to edit in Vim' to the footer — a three-word verb " +
  "tail, which KEY_HINT_RE caps at two on purpose (prose guard) — and at 46 columns the footer wraps " +
  "over two rows. The parse and dialogStillUp still see the box; only dialogEvidence (the health " +
  "record's 'was a box up?') does not, so a strict-parse miss on such a screen would go unrecorded.",
}, () => {
  for (const name of ["checkbox-on-submit", "checkbox-46col"]) assert.equal(dialogEvidence(screen(name)).box, true, name);
});

test("2.1.301 checkbox box: ticking a row is the SAME box (labels are the fingerprint)", () => {
  const fresh = detectPrompt(screen("checkbox-submit")), ticked = detectPrompt(screen("checkbox-toggled"));
  assert.ok(sameBox(fresh, ticked));
  assert.ok(samePrompt(fresh, ticked, "ignore"), "same apart from the tick: no new push");
  assert.equal(samePrompt(fresh, ticked), false, "the tick itself is a change the phone must redraw");
});

test("2.1.301 checkbox box: each row's tick is published, the free rows carry none", () => {
  const ticks = (name) => detectPrompt(screen(name)).options.map((o) => o.checked);
  assert.deepEqual(ticks("checkbox-submit"), [false, false, false, false, undefined]);
  for (const name of ["checkbox-toggled", "checkbox-on-submit", "checkbox-46col"])
    assert.deepEqual(ticks(name), [false, true, false, false, undefined], name);
  // The merge keeps the published labels but takes the FRESHEST tick, both ways.
  const fresh = detectPrompt(screen("checkbox-submit")), ticked = detectPrompt(screen("checkbox-toggled"));
  assert.equal(mergeBox(fresh, ticked).options[1].checked, true);
  assert.equal(mergeBox(ticked, fresh).options[1].checked, false);
});

test("2.1.301 checkbox box: the walk to Submit is measured in selectable rows", () => {
  // Cursor on Apple: Banana, Cherry, Type something, then Submit.
  assert.deepEqual(navToSubmit(screen("checkbox-submit")), { steps: 4, label: "Submit" });
  // A digit toggles without moving the cursor.
  assert.deepEqual(navToSubmit(screen("checkbox-toggled")), { steps: 4, label: "Submit" });
  assert.deepEqual(navToSubmit(screen("checkbox-on-submit")), { steps: 0, label: "Submit" });
  // Narrow: every description wraps, and the wrap is not a row the arrows land on.
  assert.deepEqual(navToSubmit(screen("checkbox-46col")), { steps: 0, label: "Submit" });
});

test("2.1.301 /context: the gauge row reads as used/total", () => {
  assert.deepEqual(detectContext(screen("context-view")), { leftPct: 95, usedTok: 50300, totalTok: 1_000_000 });
});

test("2.1.301 local commands: no turn, no box, and the screen moves on Return", () => {
  for (const [cmd, typed, open] of [["/context", "slash-context-typed", "context-view"], ["/usage", "slash-usage-typed", "slash-usage-open"]]) {
    assert.ok(isLocalCommand(cmd) && startsNoTurn(cmd), cmd);
    assert.match(screen(typed), new RegExp(`^❯\\s${cmd}\\s*$`, "m"), `${typed}: the command sits in the composer (after a NBSP)`);
    assert.notEqual(screen(typed), screen(open), `${cmd}: Return changed the screen`);
    for (const s of [typed, open]) {
      assert.equal(detectPrompt(screen(s)), null, `${s}: a slash menu or a view is not a question box`);
      assert.equal(dialogEvidence(screen(s)).box, false, s);
    }
  }
});

test("2.1.301 screens that only mention resets and limits are not a block", () => {
  // The /usage view prints a reset clock per window; the slash menu carries a
  // command description about limits. Neither is the block notice.
  for (const s of ["slash-usage-open", "slash-usage-typed", "context-view", "checkbox-submit"]) {
    const d = detectLimitText(screen(s), Date.UTC(2026, 9, 16, 10, 0, 0));
    assert.equal(d.blocked, false, s);
    assert.equal(d.resetAt, null, s);
  }
});

/**
 * The composer of a LONG paste, as 2.1.301 draws it at 80x30 — a fresh session,
 * one write of the prompt beside each grid (`paste-*.prompt`, synthetic
 * words in the shapes of the 2026-10-15 backlog failures), the host's exact
 * shape. The CLI reads the burst in ~1 KB pieces and collapses each one:
 *
 *   paste-chain     five chits back to back, nothing else in the box — the
 *                   first says `+2 lines` of 11, and no tail is drawn.
 *   paste-blankrow  four chits, then the uncollapsed last piece, which holds a
 *                   blank line — drawn as a blank row INSIDE the box.
 *
 * Both read `none` before 2026-10-16 and every such delivery came back
 * `unconfirmed`; the hook proved 12 of 12 had run.
 */
const pasted = (name) => ({ grid: screen(name).split("\n"), text: readFileSync(join(DIR, `${name}.prompt`), "utf8") });

test("2.1.301 a paste in several pieces: the run of chits is counted whole", () => {
  const { grid, text } = pasted("paste-chain");
  const [span] = composerSpans(grid);
  assert.equal(pastedNewlines(composerText(span)), text.split("\n").length - 1, "2+2+2+2+2 = every newline typed");
  assert.equal(composerEcho(grid, text), "paste");
  const fewer = text.split("\n").slice(0, 7).join("\n");
  assert.equal(composerEcho(grid, fewer), "none", "the same chits do not account for a prompt with four fewer lines");
});

test("2.1.301 a blank line in the prompt is a blank row inside the box, and the tail after it is held", () => {
  const { grid, text } = pasted("paste-blankrow");
  const [span] = composerSpans(grid);
  assert.ok(span.rows.includes(""), "the blank row stays inside the span");
  assert.match(span.rows.at(-1), /STEP LAST/, "…so the span runs down to the tail");
  assert.equal(composerEcho(grid, text), "paste", "tied to this text by its tail");

  // Guards, derived from the same grid (the rows a reader looks at, untouched):
  const close = grid.findIndex((r, i) => i > grid.findIndex((x) => x.startsWith("❯")) && /^─{20,}$/.test(r.trim()));
  const torn = grid.filter((_, i) => i !== close);
  const [open] = composerSpans(torn);
  assert.ok(!open.rows.includes(""), "no rule below: a blank row ends the box as before");
  assert.ok(!open.rows.some((r) => /paste again|CAVEMAN/.test(r)), "…and the footer never joins it");
  const blank = grid.indexOf("", grid.findIndex((x) => x.startsWith("❯")));
  const nextFrame = [...grid.slice(0, blank + 1), grid[close], "❯ another frame", grid[close]];
  const [first] = composerSpans(nextFrame);
  assert.ok(!first.rows.includes("") && !first.rows.some((r) => /another frame/.test(r)), "a rule that opens another frame does not close this one");
});

test("the newest run of chits is the count — not a placeholder elsewhere on the screen", () => {
  assert.equal(pastedNewlines("[pastedtext#1+9lines]hello[pastedtext#2+2lines][pastedtext#3]"), 2);
  assert.equal(pastedNewlines("[pastedtext#4]"), 0, "a bare chit hides no newline");
  assert.equal(pastedNewlines("no chit here"), null);
});
