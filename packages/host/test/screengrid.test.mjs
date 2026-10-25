// What `screenText`/`screenCells` read in the ALTERNATE screen: the recorder's
// live VT, resized in step with the pane — never a replay of the byte ring into
// one fixed 50-row VT. The ring holds no resizes, and a phone keyboard opening
// and closing reshapes the pane all session long: replayed, the live composer
// came back with its closing rule overdrawn by the mode row
// (`──⏵⏵ auto mode on …───`), `foreignInComposer` read that as typed text, and
// every send to the session was refused while the real box was empty.
import { test } from "node:test";
import assert from "node:assert/strict";

const { SessionScreenLog } = await import("../dist/screenlog.js");
const { screenText, screenCells } = await import("../dist/sessions/drive.js");
const { renderCapture } = await import("../dist/render.js");

const RULE = "─".repeat(30);
const ESC = "\x1b";
// A composer drawn bottom-anchored at absolute rows, the way a full-screen TUI
// does: rule, `❯ ` input row, rule, mode row as the last row of the grid.
// No clear: a TUI repaints only what changed, which is exactly what leaves a
// replay at the wrong height holding the previous frame's rows.
const frame = (rows, mode) =>
  `${ESC}[${rows - 3};1H${RULE}` +
  `${ESC}[${rows - 2};1H❯ ` +
  `${ESC}[${rows - 1};1H${RULE}` +
  `${ESC}[${rows};1H  ⏵⏵ ${mode} mode on${ESC}[K`;

function sessionAt(cols, rows) {
  const log = new SessionScreenLog(cols, rows);
  const s = { cols, rows, scrollback: "", screenLog: log };
  const feed = (d) => { s.scrollback += d; log.write(d); };
  const resize = (c, r) => { s.cols = c; s.rows = r; log.resize(c, r); };
  const core = { sessions: new Map([["x", s]]) };
  return { s, feed, resize, core };
}

// xterm's write is asynchronous; an empty write's callback is not exposed by
// the recorder, so give the parser a turn before reading.
const settle = () => new Promise((r) => setTimeout(r, 50));

test("alternate screen: the grid follows a resize the ring never recorded", async () => {
  const { s, feed, resize, core } = sessionAt(30, 27);
  feed(`${ESC}[?1049h` + frame(27, "auto"));
  resize(30, 23);
  feed(frame(23, "plan"));
  await settle();
  assert.ok(s.screenLog.alternate());

  const text = (await screenText(core, "x", 40)).split("\n");
  assert.deepEqual(text.slice(-4), [RULE, "❯", RULE, "  ⏵⏵ plan mode on"]);

  const cells = await screenCells(core, "x", 60);
  assert.equal(cells.length, 23, "one row per row of the pane, no stale rows under it");
  assert.equal(cells[cells.length - 1].text.trimEnd(), "  ⏵⏵ plan mode on");

  // The replay this replaced still holds the old frame's rows under the new
  // one — the shape that read as text in the box.
  const replay = (await renderCapture(s.scrollback, s.cols)).split("\n");
  assert.equal(replay[replay.length - 1], "  ⏵⏵ auto mode on");
});

// In production the alternate check is met by the TMUX CLIENT (it emits
// `?1049h` for every session, claude or shell), not by the program in the pane;
// this pins the fallback for a recorder that is not in the alternate screen.
test("normal screen: still the replay — rows the 5-row grid no longer shows are read", async () => {
  const { feed, core } = sessionAt(30, 5);
  for (let i = 1; i <= 12; i++) feed(`line ${i}\r\n`);
  await settle();
  const text = await screenText(core, "x", 40);
  assert.match(text, /^line 1$/m, "the 50-row replay still holds rows the 5-row grid lost");
});
