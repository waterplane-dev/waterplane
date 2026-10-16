/**
 * The tmux client's terminal queries: answered from the host, stripped from
 * what every consumer reads, and nothing else touched (`termqueries.ts`).
 *
 * The bytes below are the client's own, as measured at start-up (tmux 3.6b
 * with the generated tmux.conf). A false match would delete a byte the phone
 * should have drawn; a miss leaves the session waiting 5 s on a phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TermQueryResponder, answerTermQueries, x11Rgb, CELL_PX, HOLD_MS, STARTUP_REPLY_MS } from "../dist/termqueries.js";

const facts = { cols: () => 80, rows: () => 24 };
const E = "\x1b";

// The first chunk a fresh tmux client writes, verbatim (trimmed only of nothing).
const START = `${E}[?1049h${E}[22;0;0t${E}[?1h${E}=${E}[H${E}[2J${E}[?12l${E}[?25h${E}[?1000l${E}[?1002l${E}[?1003l${E}[?1006l${E}[?1005l${E}[?2004h${E}[?2031h${E}[?996n${E}(B${E}[m${E}[?12l${E}[?25h${E}[?1006l${E}[?1000l${E}[?1002l${E}[?1003l${E}[1;1H${E}[1;24r${E}[c${E}[>c${E}[>q${E}]10;?${E}\\${E}]11;?${E}\\${E}[1;1H`;
const START_CLEAN = `${E}[?1049h${E}[22;0;0t${E}[?1h${E}=${E}[H${E}[2J${E}[?12l${E}[?25h${E}[?1000l${E}[?1002l${E}[?1003l${E}[?1006l${E}[?1005l${E}[?2004h${E}[?2031h${E}(B${E}[m${E}[?12l${E}[?25h${E}[?1006l${E}[?1000l${E}[?1002l${E}[?1003l${E}[1;1H${E}[1;24r${E}[1;1H`;
const START_REPLIES = `${E}[?997;1n${E}[?1;2c${E}[>0;276;0c${E}P>|xterm.js(6.0.0)${E}\\${E}]10;rgb:d6d6/dcdc/e5e5${E}\\${E}]11;rgb:0b0b/0d0d/1010${E}\\`;

test("the start-up chunk: every query answered in the order asked, every other byte kept", () => {
  const r = new TermQueryResponder(facts);
  const { out, replies } = r.feed(START);
  assert.equal(out, START_CLEAN);
  assert.equal(replies, START_REPLIES);
  assert.equal(r.holding(), false);
});

test("the size queries answer the PTY's geometry at the moment of asking, cells first as asked", () => {
  let cols = 80, rows = 24;
  const r = new TermQueryResponder({ cols: () => cols, rows: () => rows });
  assert.equal(r.feed(`${E}[H${E}[18t${E}[14t${E}(B`).replies, `${E}[8;24;80t${E}[4;${24 * CELL_PX.h};${80 * CELL_PX.w}t`);
  cols = 100; rows = 30;
  const again = r.feed(`${E}[18t${E}[14t`);
  assert.equal(again.out, "");
  assert.equal(again.replies, `${E}[8;30;100t${E}[4;${30 * CELL_PX.h};${100 * CELL_PX.w}t`);
});

test("a query split across chunks is held, then answered once — at every cut point", () => {
  for (let cut = 1; cut < START.length; cut++) {
    const r = new TermQueryResponder(facts);
    const a = r.feed(START.slice(0, cut));
    const b = r.feed(START.slice(cut));
    assert.equal(a.out + b.out, START_CLEAN, `cut at ${cut}`);
    assert.equal(a.replies + b.replies, START_REPLIES, `cut at ${cut}`);
    assert.equal(r.holding(), false);
  }
});

test("one byte at a time still answers everything once", () => {
  const r = new TermQueryResponder(facts);
  let out = "", replies = "";
  for (const ch of START) { const f = r.feed(ch); out += f.out; replies += f.replies; }
  assert.equal(out, START_CLEAN);
  assert.equal(replies, START_REPLIES);
});

test("a held prefix that never becomes a query comes back untouched", () => {
  const r = new TermQueryResponder(facts);
  const a = r.feed(`hello${E}[1`);
  assert.equal(a.out, "hello");
  assert.equal(r.holding(), true);
  // …completed by something else:
  assert.deepEqual(r.feed(`;1Hworld`), { out: `${E}[1;1Hworld`, replies: "", late: 0 });
  // …or by nothing at all: flush releases it.
  r.feed(`${E}]1`);
  assert.equal(r.flush(), `${E}]1`);
  assert.equal(r.holding(), false);
});

test("BEL-terminated colour queries are answered with BEL", () => {
  const r = new TermQueryResponder(facts);
  assert.equal(r.feed(`${E}]11;?\x07`).replies, `${E}]11;rgb:0b0b/0d0d/1010\x07`);
});

test("normal output is never mistaken for a query", () => {
  const r = new TermQueryResponder(facts);
  const screen = [
    `${E}[38;2;215;119;87m✻ Crafting… (9m 35s)${E}[39m`,
    `${E}[2C${E}[1A${E}[14;1H${E}[18;3H${E}[?25l${E}[?2026h${E}[?2026l`,
    `${E}]0;claude${E}\\${E}]8;;https://x.example/${E}\\link${E}]8;;${E}\\`,
    `${E}[?1004h${E}[?7727h${E}[1c${E}[>1c${E}[>1q${E}[2q`,
    `${E}[4;5H${E}[8;1H${E}[11;1H${E}[10;20r${E}[>4;1m${E}[>1u${E}[18;1t${E}[144t`,
    `${E}]10;#fff${E}\\${E}]11;rgb:0000/0000/0000${E}\\${E}[?996h${E}[?9961n`,
    "❯ type ESC[c as text, 18t, 14t, ]11;? — all printable",
  ].join("\r\n");
  const { out, replies } = r.feed(screen);
  assert.equal(out, screen);
  assert.equal(replies, "");
  assert.equal(r.holding(), false);
});

test("x11Rgb doubles each channel byte", () => {
  assert.equal(x11Rgb("#0b0d10"), "rgb:0b0b/0d0d/1010");
  assert.equal(x11Rgb("#FCFCFD"), "rgb:fcfc/fcfc/fdfd");
});

test("the light palette answers light, and says so in the scheme report", async () => {
  const { TERM_COLORS } = await import("../../shared/dist/index.js");
  const r = new TermQueryResponder({ ...facts, colors: () => TERM_COLORS.light });
  assert.equal(r.feed(`${E}[?996n${E}]11;?${E}\\`).replies, `${E}[?997;2n${E}]11;rgb:fcfc/fcfc/fdfd${E}\\`);
});

test("answerTermQueries sits in front of the handler: replies to the PTY, stripped bytes to the consumer, a held tail flushed", async () => {
  let handler = null;
  const written = [];
  const pty = { cols: 80, rows: 24, onData: (cb) => { handler = cb; }, write: (s) => written.push(s) };
  const seen = [];
  const q = answerTermQueries(pty, (c) => seen.push(c));
  handler(`a${E}[c`);
  handler(`b${E}[1`); // could be ESC[14t — held
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(written, [`${E}[?1;2c`]);
  await new Promise((r) => setTimeout(r, HOLD_MS * 4));
  assert.deepEqual(seen, ["a", "b", `${E}[1`]);
  q.dispose();
});

// tmux reads DA1/DA2/XTVERSION replies only inside its ~5 s start-up window; one
// arriving later is typed into the pane (measured, tmux 3.4 and 3.6b). The colour,
// scheme and size replies are read at any time.
test("past the start-up window the three start-up-only queries are stripped UNANSWERED, the rest still answered", () => {
  let age = STARTUP_REPLY_MS + 1;
  const r = new TermQueryResponder({ ...facts, ageMs: () => age });
  const late = r.feed(START);
  assert.equal(late.out, START_CLEAN);
  assert.equal(late.late, 3);
  assert.equal(late.replies, `${E}[?997;1n${E}]10;rgb:d6d6/dcdc/e5e5${E}\\${E}]11;rgb:0b0b/0d0d/1010${E}\\`);
  age = STARTUP_REPLY_MS;
  const inTime = r.feed(START);
  assert.equal(inTime.replies, START_REPLIES);
  assert.equal(inTime.late, 0);
  // No age fact (a caller that does not know): everything answered, as before.
  assert.equal(new TermQueryResponder(facts).feed(START).replies, START_REPLIES);
});

test("answerTermQueries counts the client's age from its own call and reports what it left unanswered", async () => {
  let handler = null;
  const written = [];
  const pty = { cols: 80, rows: 24, onData: (cb) => { handler = cb; }, write: (s) => written.push(s) };
  const lates = [];
  const realNow = Date.now;
  const t0 = realNow();
  try {
    const q = answerTermQueries(pty, () => {}, undefined, (n, ageMs) => lates.push([n, ageMs]));
    Date.now = () => t0 + STARTUP_REPLY_MS + 500;
    handler(`${E}[c${E}[>c${E}[>q${E}]11;?${E}\\`);
    assert.deepEqual(written, [`${E}]11;rgb:0b0b/0d0d/1010${E}\\`]);
    assert.equal(lates.length, 1);
    assert.equal(lates[0][0], 3);
    assert.ok(lates[0][1] > STARTUP_REPLY_MS);
    q.dispose();
  } finally { Date.now = realNow; }
});

// XTVERSION names the xterm.js the phone actually runs. The string is a
// literal in termqueries.ts; this pin fails the day the web package moves to
// another major/minor, so the answer is updated with it, not left behind.
test("XTVERSION names the installed xterm.js version", async () => {
  const { readFileSync } = await import("node:fs");
  const v = JSON.parse(readFileSync(new URL("../../../node_modules/@xterm/xterm/package.json", import.meta.url), "utf8")).version;
  assert.ok(START_REPLIES.includes(`xterm.js(${v})`), `termqueries.ts answers XTVERSION with a version other than the installed @xterm/xterm ${v}`);
});
