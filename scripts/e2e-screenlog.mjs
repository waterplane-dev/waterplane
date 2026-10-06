// Reconstructed alt-screen scrollback: can the phone look BACK with no host?
//
// Scrolling the claude TUI is a remote operation — the pan is translated into
// mouse-wheel bytes the TUI itself consumes — so with the tunnel down the
// gesture did nothing at all. The fix keeps a local archive of the lines that
// scrolled off the grid, rebuilt from what this device rendered.
//
// Both failure directions are silent, which is why this is pinned:
//  - too eager (archiving a grid that only repainted its spinner) and the
//    history fills with hundreds of near-identical screens, pushing the real
//    output out of the cap. The scrollback is then technically present and
//    useless.
//  - too shy (missing a real scroll) and lines vanish for ever: nothing else on
//    the device has them, the wire never carries the TUI's own buffer.
// The load-bearing test is the round trip: replay a document through a scrolling
// 10-row window and the reconstruction must equal the document.
import { readFileSync } from "node:fs";
import { absorbScreen, newScreenLog, screenLogLines, scrollOffCount, SCREENLOG_MAX_LINES } from "../packages/shared/dist/screenlog.js";

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), `${label}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` — got ${JSON.stringify(a)}`}`);

// ── What counts as "scrolled off" ───────────────────────────────────
const screen = (...l) => l;

eq(scrollOffCount(screen("a", "b", "c", "d"), screen("c", "d", "e", "f")), 2,
  "two lines off the top is a scroll of two");
eq(scrollOffCount(screen("a", "b", "c", "d"), screen("a", "b", "c", "X")), 0,
  "the bottom row changing (a spinner, a token count) is not a scroll");
eq(scrollOffCount(screen("a", "b", "c", "d"), screen("q", "r", "s", "t")), 4,
  "a grid with nothing in common is a full repaint — the whole outgoing screen left");

// The claude composer draws blank rows above itself and their COUNT moves
// between repaints, so anchoring on the raw first row would report a scroll on
// every frame.
eq(scrollOffCount(screen("a", "b", "c", "d"), screen("", "", "b", "c", "d")), 1,
  "leading blank rows are not content — the anchor is the first real line");
eq(scrollOffCount(screen("a", "b", "c"), screen("", "", "")), 0,
  "an all-blank grid is a repaint in progress, never a scroll of everything");

// ── The round trip ──────────────────────────────────────────────────
// A 10-row window walked down a 60-line document, one line at a time, sampled at
// every step: archive + live screen must be the document, in order, once.
const doc = Array.from({ length: 60 }, (_, i) => `line ${i}`);
let log = newScreenLog();
for (let top = 0; top + 10 <= doc.length; top++) log = absorbScreen(log, doc.slice(top, top + 10));
eq(screenLogLines(log), doc, "a document scrolled through the window comes back whole and in order");

// Same walk, but the bottom two rows are a live composer that changes every
// frame — the shape every real repaint has.
log = newScreenLog();
for (let top = 0; top + 8 <= doc.length; top++) {
  log = absorbScreen(log, [...doc.slice(top, top + 8), `> typing ${top}`, `  ${top} tokens`]);
}
const withComposer = screenLogLines(log);
check(doc.every((l, i) => withComposer[i] === l),
  "a churning composer at the bottom doesn't corrupt the history above it");
check(withComposer.length < doc.length + 8,
  `a redrawn composer is not archived once per frame (${withComposer.length} lines from a 60-line document)`);

// ── Repaints that are not scrolls ───────────────────────────────────
log = newScreenLog();
log = absorbScreen(log, screen("hello", "world"));
const same = absorbScreen(log, screen("hello", "world"));
check(same === log, "an identical repaint returns the SAME state — nothing to store, nothing to re-render");
eq(absorbScreen(log, screen("hello", "world", "")).archived, [],
  "trailing blank rows are trimmed, so a grid that only grew whitespace archives nothing");

// A view switch (/usage, /resume) repaints the whole grid. The outgoing screen
// is history and has to be kept: it is the conversation the user was reading.
log = newScreenLog();
log = absorbScreen(log, screen("conversation", "in", "progress"));
log = absorbScreen(log, screen("Current week", "0% used", "Esc to cancel"));
eq(log.archived, ["conversation", "in", "progress"], "opening a full-screen view archives the screen it replaced");
eq(screenLogLines(log), ["conversation", "in", "progress", "Current week", "0% used", "Esc to cancel"],
  "…and the view itself is readable underneath it");

// ── The cap drops the OLDEST ────────────────────────────────────────
log = newScreenLog();
for (let i = 0; i < SCREENLOG_MAX_LINES + 500; i++) log = absorbScreen(log, [`row ${i}`, `row ${i + 1}`, `row ${i + 2}`]);
check(log.archived.length <= SCREENLOG_MAX_LINES, `the archive stays capped (${log.archived.length})`);
check(screenLogLines(log).at(-1) === `row ${SCREENLOG_MAX_LINES + 501}`,
  "the cap trims the front — the newest output is the one thing that must never be dropped");

// ── The client half has to work with the socket down ────────────────
const term = readFileSync("packages/web/src/Terminal.tsx", "utf8");
check(/liveRef\.current\.linkUp/.test(term) && /onReachBack/.test(term),
  "the terminal routes an upward pan somewhere else when the link is down (instead of dropping wheel bytes on the floor)");
check(/\.repeat\(Math\.abs\(lines\)\)/.test(term),
  "a flick is ONE write, not one frame per line — a bad link is what makes scrolling feel broken");
// What "the screen moved" MEANS is the whole assertion. Disarming the stall
// timer on any incoming write made the escape hatch unreachable on a busy
// session — a spinner repaints several times a second — so the discriminator is
// the TOP VISIBLE ROW: a repaint in place does not change it, a scroll does.
// (This used to grep for a comment, which an edit to the line above it silently
// broke; the rule is `topRow()`, so that is what is pinned.)
check(/SCROLL_STALL_MS/.test(term) && /topRow\(\) !== before/.test(term),
  "a scroll that WAS sent and moved nothing says where the local copy is — the poor-link half, not the dead-link half");

// The sheet used to talk to no host AT ALL, and that was the wrong rule. This
// device's archive is a RECONSTRUCTION — a view switch repaints the whole grid,
// which cannot be told from an enormous scroll, so the outgoing screen is
// archived whole and turns up again on the way back, and anything painted while
// the app was closed was never captured. Duplicated blocks and missing ones, as
// reported. The desktop has the real PTY bytes and one real VT, so with a link
// there is a better answer and the sheet asks for it.
//
// What has to stay true is the reason the sheet exists: with no link it renders
// the local archive and never a spinner or a blank. So the pin is the FALLBACK,
// not the absence of a fetch — the host read may only ever REPLACE what is
// already drawable, never gate it.
const sheet = readFileSync("packages/web/src/ScrollbackSheet.tsx", "utf8");
check(/api\.scrollback\(/.test(sheet),
  "the sheet asks the DESKTOP first — its own copy is a reconstruction, the host's is the bytes");
check(/screenLogFor\(/.test(sheet) && /\.catch\(/.test(sheet),
  "…and a host that cannot be reached falls back to this device's archive, silently");
check(/const lines = host \? host\.lines : local;/.test(sheet),
  "the local copy is the DEFAULT and the host read replaces it — never a gate in front of it");
check(!/\bsend\(/.test(sheet),
  "still no socket here: a pan with the tunnel down must not need one");

const idb = readFileSync("packages/web/src/idb.ts", "utf8");
check(/createObjectStore\("screenlog"\)/.test(idb),
  "the archive survives a reload — a cold start with the tunnel down is exactly when it is wanted");

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
