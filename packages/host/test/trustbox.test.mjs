/**
 * claude 2.1.293's first-launch trust box: UNNUMBERED rows, the cursor on
 * "No, exit" — the first thing every new user's first session shows, and a box
 * `detectPrompt` used to read as nothing (no buttons, only the key bar).
 *
 * The fixture is a real `tmux capture-pane -p` off the binary
 * (`fixtures/permmode/trust-box.txt`). Detection is by SHAPE — the footer as
 * the screen's last row, a one-column run of rows with exactly one "❯" — so the
 * false-positive half matters as much as the hit: prose, an answered box, a
 * numbered box, the CLI's own pickers.
 *
 * The answer half: a tap is a WALK (Up/Down, re-read, Return only on arrival),
 * never a digit, and it refuses in words when the screen does not agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { detectPrompt, dialogEvidence, dialogStillUp, readNavBox, samePrompt } from "../dist/prompt.js";

const boxes = await import("../dist/sessions/boxes.js");

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "permmode");
const TRUST = readFileSync(join(DIR, "trust-box.txt"), "utf8");
/** The same grid with the cursor moved to row `n` (1-based), as an arrow key repaints it. */
function trustAt(n) {
  const labels = ["No, exit", "Yes, I trust this folder"];
  let out = TRUST;
  labels.forEach((l, i) => { out = out.replace(new RegExp(`^ (?:❯ |  )${l.replace(/[,]/g, "\\$&")}$`, "m"), i + 1 === n ? ` ❯ ${l}` : `   ${l}`); });
  return out;
}

test("the 2.1.293 trust box parses: options in order, a trust box, answered by walking", () => {
  const p = detectPrompt(TRUST);
  assert.ok(p, "the trust box must be detected");
  assert.equal(p.kind, "trust", "the answer gate refuses trust boxes for plugins — keep the kind");
  assert.equal(p.nav, true, "no numbers: the phone sends promptChoice, never a digit");
  assert.deepEqual(p.options, [{ index: 1, label: "No, exit" }, { index: 2, label: "Yes, I trust this folder" }]);
  assert.match(p.question, /^Quick safety check: Is this a project you created or one you trust\?/);
  assert.equal(readNavBox(TRUST)?.cursor, 1, "the cursor starts on No, exit");
});

test("the cursor moves; the published box does not", () => {
  const moved = trustAt(2);
  assert.notEqual(moved, TRUST);
  assert.equal(readNavBox(moved)?.cursor, 2);
  // The cursor is not identity: a box re-published per arrow re-keys its fingerprint.
  assert.ok(samePrompt(detectPrompt(moved), detectPrompt(TRUST)));
});

test("the strict pass reads it; the lenient gate is unchanged (the footer buys the render)", () => {
  assert.equal(detectPrompt(TRUST, { lenient: true }), null);
  assert.ok(dialogStillUp(TRUST));
  assert.ok(dialogEvidence(TRUST).box, "a box the detector used to miss is a box the health board saw");
});

test("an answered trust box — a composer drawn under it — is gone", () => {
  const answered = TRUST + "\n\n" + "─".repeat(60) + "\n❯ \n" + "─".repeat(60) + "\n  ? for shortcuts\n";
  assert.equal(detectPrompt(answered), null);
  assert.equal(readNavBox(answered), null);
  assert.equal(readNavBox(TRUST + "\n> \n"), null, "a shell stub's prompt is a composer too");
});

test("no other real grid reads as an unnumbered box", () => {
  for (const f of readdirSync(DIR)) {
    if (f === "trust-box.txt") continue;
    const screen = readFileSync(join(DIR, f), "utf8");
    assert.equal(readNavBox(screen), null, f);
    assert.notEqual(detectPrompt(screen)?.nav, true, f);
  }
});

test("a numbered box still reads as numbered — the walk is only for rows with no numbers", () => {
  const box = ["Do you want to proceed?", "", "❯ 1. Yes", "  2. No", "", "Enter to confirm · Esc to cancel"].join("\n");
  assert.equal(readNavBox(box), null);
  const p = detectPrompt(box);
  assert.equal(p.nav, undefined);
  assert.deepEqual(p.options.map((o) => o.index), [1, 2]);
});

test("shapes that are not the box are null — never a phantom", () => {
  const foot = "Enter to confirm · Esc to cancel";
  const cases = {
    // The footer's words inside a SENTENCE are not a footer row.
    prose: ["❯ No, exit", "  Yes, I trust this folder", "", "The box says Enter to confirm · Esc to cancel when it is open."],
    // No cursor at all: a two-line indented paragraph above a footer.
    "no cursor": ["  first line", "  second line", "", foot],
    // Two cursors: two rows of the composer's history, not one selection.
    "two cursors": ["❯ hello", "❯ world", "", foot],
    // One row is not a choice.
    "one row": ["❯ Only option", "", foot],
    // A row indented deeper than the labels — a wrapped label, a shape not measured.
    "deeper row": ["❯ Yes", "  No, and tell Claude", "     what to do", "", foot],
    // Rows of mismatched columns.
    "ragged": [" ❯ Yes", "     No", "", foot],
    // The footer is not the last row: something was drawn after the box.
    "footer not last": ["❯ Yes", "  No", "", foot, "", "⏺ working on it"],
    // A checkbox run is the numbered rules' business.
    checkbox: ["❯ [ ] one", "  [ ] two", "", foot],
    // Too far from the footer.
    "gap": ["❯ Yes", "  No", "", "", "", "", foot],
  };
  for (const [name, rows] of Object.entries(cases)) {
    const screen = rows.join("\n");
    assert.equal(readNavBox(screen), null, name);
    assert.notEqual(detectPrompt(screen)?.nav, true, name);
  }
});

// ── The answer walk ──────────────────────────────────────────────────────────

/** A fake session core over a screen that answers arrows the way the TUI does. */
function harness({ deaf = false, screenFor = trustAt } = {}) {
  let cursor = 1;
  const typed = [];
  const sessions = new Map();
  const base = {
    sessions,
    input: (id, data) => {
      typed.push(data);
      if (!deaf && data === "\x1b[B") cursor = Math.min(2, cursor + 1);
      if (!deaf && data === "\x1b[A") cursor = Math.max(1, cursor - 1);
      return true;
    },
    screenText: async () => screenFor(cursor),
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  sessions.set("s1", {
    info: { id: "s1", cwd: tmpdir(), running: true, title: "t", prompt: detectPrompt(TRUST) },
    backend: { id: "claude", caps: { promptBoxes: "claude-numbered", transcript: "none", asking: false, hooks: "none" } },
    scrollback: "", seq: 0, spawnedAt: Date.now(),
  });
  return { core, typed };
}

test("tapping Yes walks the cursor DOWN, re-reads, then presses Return — no digit", async () => {
  const h = harness();
  const r = await boxes.answerBox(h.core, "s1", 2, { walk: true, byPerson: true });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(h.typed, ["\x1b[B", "\r"]);
});

test("a nav box answers by walking even when the caller sent the digit's path", async () => {
  const h = harness();
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 1), { ok: true });
  assert.deepEqual(h.typed, ["\r"], "the cursor is already on No: Return only");
});

test("a cursor that never arrives presses no Return", async () => {
  const h = harness({ deaf: true });
  const r = await boxes.answerBox(h.core, "s1", 2, { walk: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not place the selection/);
  assert.ok(!h.typed.includes("\r"), "never a Return on the wrong row");
});

test("a different box under the same index is refused in words", async () => {
  const h = harness({ screenFor: (n) => trustAt(n).replace("Yes, I trust this folder", "Yes, delete it") });
  const r = await boxes.answerBox(h.core, "s1", 2, { walk: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the one that was answered/);
  assert.deepEqual(h.typed, []);
});

test("a box gone from the screen is refused, nothing typed", async () => {
  const h = harness({ screenFor: () => "─".repeat(40) + "\n❯ \n" + "─".repeat(40) });
  const r = await boxes.answerBox(h.core, "s1", 2, { walk: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer readable/);
  assert.deepEqual(h.typed, []);
});

// The usage probe's own `claude` meets the same box in a folder never trusted. It typed `1⏎`,
// which on this box is a no-op digit and a Return on "No, exit": the probe quit, the gauge read ?.
test("the usage probe answers the unnumbered trust box with Yes, by walking", async () => {
  const { trustKeys } = await import("../dist/usage.js");
  assert.equal(trustKeys(readNavBox(TRUST)), "\x1b[B\r", "cursor on No, exit: one Down, then Return");
  assert.equal(trustKeys(readNavBox(trustAt(2))), "\r", "already on Yes: Return only");
  assert.equal(trustKeys(null), "1\r", "the numbered box (before 2.1.293) keeps its digit");
  const noYes = { prompt: { options: [{ index: 1, label: "No, exit" }, { index: 2, label: "Maybe" }] }, cursor: 1 };
  assert.equal(trustKeys(noYes), "", "no option says yes: nothing is pressed");
});
