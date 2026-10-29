#!/usr/bin/env node
// Fake claude TUI for the backlog-delivery e2e (e2e-backlog-echo.mjs).
//
// Reproduces the two screen shapes that broke instruction delivery:
//
// STUB_USAGE=<sessionPct>,<weeklyPct> makes `/usage` render a usage screen the
// host's scraper can parse — the only way to drive the usage BUDGET end to end.
//
//   STUB_MODE=repaint (default) — the composer IS on screen, but each keystroke
//     triggers a full repaint followed by kilobytes of spinner/status updates.
//     The echoed text therefore sits far from the END of the raw PTY bytes,
//     which is exactly what defeated the old "ANSI-strip the last N bytes" echo
//     check and made the backlog retype the instruction on top of itself.
//
//   STUB_MODE=blind — input is accepted but never displayed (a full-screen view
//     swallowing keystrokes). Delivery is genuinely unconfirmable; the point is
//     that the text must still be written AT MOST ONCE.
//
//   STUB_MODE=menu — a slash command opens the completion menu UNDER the input
//     box (one row per command plus a wrapped description), and Return runs the
//     highlighted one, which opens a full-screen VIEW. A second Return — or an
//     Esc — dismisses that view. This is `/cost`: the echo sits ~17 rows above
//     the bottom (so a bottom-N-rows composer check never sees it), and the
//     command never starts a turn (so a Return pressed until the turn-start
//     proof arrives is pressed forever, into the view it just opened).
//
//   STUB_MODE=paste — a long write arrives as one chunk, which is a PASTE as far
//     as the TUI is concerned, so the composer COLLAPSES it: the screen shows
//     `[Pasted text #1 +N lines]` and then whatever tail still fits, and the
//     HEAD of the text is nowhere on it. That is the real claude TUI (v2.1),
//     and it made every long multi-line prompt — the Build sheet's "set up"
//     prompt above all — read as never echoed: `unconfirmed`, left sitting in
//     the composer, never submitted, never auto-retried. Return works fine here;
//     the whole failure was in the reading.
//     The collapse has TWO triggers, and this mode draws both: newlines, and
//     LENGTH (>800 chars) on its own. The length one is the shape a message
//     typed on a phone has — one long line — and the placeholder it draws is
//     bare, `[Pasted text #1]`, with no `+N lines` clause, because the clause
//     counts newlines and there are none. A reader that required the clause
//     matched nothing at all there.
//
//   STUB_MODE=scroll — the composer as a VIEWPORT. A real `\u276f` box with rules
//     above and below, but only the last few wrapped rows of the buffer are
//     drawn: the composer is sized off the terminal and scrolls, so a prompt
//     longer than it shows its TAIL and nothing else. Measured on 2.1.267 at 56
//     columns — a 632-character prompt draws 3 rows at a terminal height of 12
//     and 5 at 20. Nothing is collapsed and no placeholder appears (the CLI's
//     own trigger is 800 characters), so the head the echo probe is cut from is
//     simply not on screen and no other rule can stand in for it.
//
//   STUB_MODE=stream — the composer as the real TUI draws it (a `❯` input row
//     between two full-width rules) and then the TEAR that used to defeat the
//     echo check: the footer drawn TWICE and a dozen rows of streaming turn
//     output BELOW the box. `render.ts` replays the whole buffer into a fixed
//     50-row VT, so mid-turn a half-done repaint really does leave stale rows
//     under the newest composer frame — and the old rule, "the echo must sit
//     within ~11 rows of the bottom of the render", therefore measured the tear
//     rather than the composer. It FOUND the text and refused to place it:
//     `unconfirmed` for a prompt in plain sight, and then an Esc into the
//     running turn. Every other mode here still draws the plain `> ` composer
//     with no rules around it, which is the no-box fallback — this one is the
//     only place the structural rule is exercised end to end.
//
//   STUB_MODE=checkbox — a multi-select AskUserQuestion box: four checkbox rows
//     with a description each, an unnumbered "Submit" row, and a trailing
//     "5. Chat about this". Arrows move the selection cursor, a DIGIT toggles a
//     row WITHOUT moving the cursor, and Return does what the real TUI does:
//     it submits only on the Submit row and merely toggles anywhere else. That
//     asymmetry is the bug — the phone's Submit button sent a bare Return, so
//     it un-ticked option 1 (where the cursor starts) and left the box open.
//
//   STUB_MODE=demo — the SHOWCASE script the demo scenarios are recorded from
//     (docs/analysis/demo-mode-plan.md §3). A fictional todo-app repo: the first
//     submitted prompt prints some work (reading files, a patch, a test run),
//     then raises a numbered choice box; the answer (a digit, or Return on the
//     cursor row) prints a result and gives the composer back. Fully scripted
//     and clock-free, so two recordings of it differ only in ids and times.
//     Nothing in it names a real path, user or machine.
//
//   STUB_MODE=unreadable — a dialog the detector cannot read. The footer is the
//     one the CLI really draws ("Enter to confirm · Esc to cancel"), so the app
//     knows perfectly well that something is asking a question; the option rows
//     are numbered `1)` instead of `1.`, which is exactly the shape of an
//     upstream change, and `prompt.ts` therefore parses no options at all and
//     publishes nothing. There is no error and no empty state — the phone simply
//     never gets the one-tap buttons and the session sits blocked in silence.
//     That silence is the whole point of the CLI-health record, so this mode is
//     what `e2e-clihealth.mjs` drives: the box is drawn, cleared and redrawn on a
//     cycle, and each appearance is one `prompt.box` miss. The rows above the
//     footer carry a home path and a token-shaped string on purpose — a captured
//     sample must be redacted before it is written anywhere.
//
//   STUB_MODE=prose — the other half of `unreadable`, and the one that matters
//     more: a session that is not asking anything at all, and merely SAYS the
//     words. An agent working on `prompt.ts` prints its own reasoning about the
//     dialog footer, so "Esc to cancel" is on the screen inside a sentence with
//     no box anywhere near it. The cheap gate fires (it is a substring test, and
//     it is meant to), the strict pass correctly refuses to read a paragraph as
//     a choice box — and the host used to file that CORRECT REFUSAL as a
//     `prompt.box` miss. Four of nine on the real host: a detector that was
//     working perfectly, reported as failing 44% of the time. This is the direct
//     regression test for that false alarm, so the prose is deliberately nasty:
//     the footer words mid-clause, a numbered list that is prose and not
//     options, and a repaint cycle so a naive counter would rack up a streak.
//
//   STUB_MODE=login — the `/login` screen: a 300-character OAuth URL, hard-
//     wrapped across six rows the way a terminal GRID wraps one (no soft wrap,
//     no marker joining them), then the paste-the-code input and NO dialog
//     footer — claude 2.1.293 draws none there, and a stub that still did hid
//     a render gate that only opened on one. This is the shape that made signing in from a phone impossible:
//     every consumer that reads the screen as text sees six fragments, none of
//     which is a link. Typing a code and pressing Return signs in and clears
//     the screen, so the test can also assert that the published link RETIRES.
//
//   STUB_MODE=ext — a mode from OUTSIDE this file: `STUB_MODE_MODULE=<path>` names an ES module
//     exporting `paint({ buf, blind })` → the frame (a string) and, optionally, `submit(prompt)`,
//     called after the turn hooks. A backend extension's stub draws ITS CLI's geometry this way
//     against this file's input handling; `STUB_VARIANT=blind|deaf` re-uses the two failure shapes
//     above against that geometry (`blind` accepts input and never draws it, `deaf` echoes it and
//     swallows the Return).
//
//   STUB_MODE=deaf — the text echoes fine, but Return is SWALLOWED: nothing is
//     ever submitted, while the repaint churn keeps the raw capture growing.
//     This is the real-CLI failure a 12-repo fan-out hit — every session held an
//     un-run prompt while the host reported "running", because output growth was
//     taken as proof of submission. Paired with STUB_HOOKS=1 so the host has the
//     exact signal (a turn that never starts) to notice.
//
//   STUB_MODE=goal — a Stop hook that says NO. The real shape of every
//     keep-going loop (a /goal hook, a checklist driver): the CLI asks to end
//     the turn, a hook answers `decision: block`, and the CLI carries straight
//     on with NO UserPromptSubmit — no prompt was submitted, so none fires. The
//     stub therefore posts UserPromptSubmit, then a Stop while it KEEPS PAINTING
//     its working line ("✻ Crafting… (3s · ↓ 34.5k tokens)"), and only posts the
//     second Stop when the spinner finally stops. STUB_GOAL_MS is how long the
//     turn carries on past the first Stop.
//     The same mode answers `/compact` the way the real CLI does: minutes of
//     "Compacting conversation… (35s)" and NO hook at all — not a Stop, not a
//     UserPromptSubmit — which is the same lie from the other side.
//
//   STUB_MODE=logo — the turn filmed in docs/media/apk-install.gif (scripts/media/apk-install.mjs).
//     Opens on Claude Code's welcome header. A submitted prompt carrying a marked image
//     (`… (marked: circle (x 5%-31%, y 8%-19%) …)`, annNote.ts's wording) is read for
//     WHERE the mark is, and the turn really edits the sample app in the cwd: a logo drawable, the
//     logo placed at those percentages, the version bumped (scripts/media/tide-tables.mjs). The tool
//     lines come out one by one on a fixed pace (STUB_LOGO_STEP_MS), so it reads as work; no model,
//     no tokens. A prompt with no mark gets an answer saying so and changes nothing.
//
//   STUB_MODE=welcome — the session filmed at the end of docs/media/first-app.gif (scripts/ui
//     journey `first-app`): Claude Code's welcome header (the same one `logo` draws, folder said
//     `~/dev/<cwd's name>`) and an idle composer, so a docs gif never shows a bare shell where
//     Claude Code should be (R-demo-016). A submitted prompt gets a short scripted turn on
//     `logo`'s pace: the suggested first-app prompt (confetti) is answered as that work, anything
//     else is acknowledged and nothing changes. No model, no tokens, no file is touched.
//     The setup film (journey `setup`) sends the dark-mode prompt (`SETUP_PROMPT_RE`), answered as
//     that work. `STUB_TRUST=1` opens on the CLI's first-launch workspace-trust box instead
//     (packages/host/test/fixtures/permmode/trust-box.txt's wording, re-captured off claude 2.1.293
//     on 2026-10-08: unnumbered rows, the cursor on "No, exit"; the folder said from `~`): arrows
//     move the cursor, Return answers it — "Yes" draws the welcome header, "No" exits.
//     `STUB_CLAUDE_VERSION` is the version the welcome header says (default 2.1.140).
//
//   STUB_MODE=permmode — the permission-mode footer of claude 2.1.293 under a real `❯`-plus-rules
//     composer, and shift+tab (`\x1b[Z`) cycling it: auto → manual → accept edits → plan → auto,
//     the labels and glyphs as measured (packages/host/test/fixtures/permmode/). `STUB_PERMMODE_DEAF=1`
//     ignores shift+tab (the footer never moves). For e2e-permmode.mjs.
//
//   STUB_MODE=answer — a turn that ANSWERS, for the peer-job e2e (e2e-peer.mjs). The default
//     composer, but a submit also writes the conversation log the host reads a report from
//     (`<claude home>/.claude/projects/<cwd slug>/<session id>.jsonl`, session id off
//     `--session-id`/`--resume`) before the hooks fire. Directives, one per line, in the
//     submitted prompt: `STUB_WRITE <relpath>` writes a file under the cwd, `STUB_RUN <cmd>`
//     runs a shell command in the cwd (its exit code and output go into the answer),
//     `STUB_SAY <text>` is the answer's text, `STUB_NETFAIL <n>` makes this turn and the
//     next n-1 end on the CLI's transient give-up row (`isApiErrorMessage`, `server_error`,
//     ENOTFOUND — e2e-netretry.mjs) instead. No directive => the answer is "ok". Needs
//     `STUB_HOOKS=1` for the turn to end. A multi-line write is ONE prompt (only \r submits).
//
// STUB_HOOKS=1 makes the stub POST a SessionStart hook to the host, so the
// session counts as `hooked` — the tests that want the silence fallback leave it
// off. It never sends UserPromptSubmit/Stop: those come from real turns.
//
// Every byte received is appended to $STUB_LOG so the test can count copies.
//
// Only the INTERACTIVE session's bytes, though. `<ENV>_CLAUDE_BIN` is also what
// the host's unattended `claude -p` calls spawn (`summarize()`, `nameTab()`),
// so this stub is launched headless too, with the prompt on its stdin — and
// `nameTab`'s prompt embeds the previous summary, which is this stub's own raw
// screen, `\x1b[H\x1b[2J` included. Logged, that read as "an Esc reached the
// session" and "the instruction was typed twice" when no keystroke was sent.
// The log is the keystrokes typed INTO the session; a headless run is not one.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { E } from "./lib-brand.mjs";

const HEADLESS = process.argv.includes("-p") || process.argv.includes("--print");
const LOG = HEADLESS ? undefined : process.env.STUB_LOG;
const MODE = process.env.STUB_MODE || "repaint";
/** `ext` mode's module (`STUB_MODE_MODULE`), or null. */
const EXT = MODE === "ext" && process.env.STUB_MODE_MODULE ? await import(pathToFileURL(process.env.STUB_MODE_MODULE).href) : null;
/** `ext` mode's failure shape, re-using the two above: "" | "blind" | "deaf". */
const VARIANT = process.env.STUB_VARIANT || "";
/** Input accepted and never displayed. */
const BLIND = MODE === "blind" || (!!EXT && VARIANT === "blind");
/** Text echoes; the Return is eaten and no turn ever starts. */
const DEAF = MODE === "deaf" || (!!EXT && VARIANT === "deaf");
const out = (s) => process.stdout.write(s);

// `claude auth status`, asked by the host on request paths (the onboarding plan, a peer's hello):
// answered like the CLI in every mode, as scripts/claude-stub.sh does. As a TUI it would paint and
// wait for keys until the host's timeout.
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  out(JSON.stringify({ loggedIn: true, authMethod: "stub" }) + "\n");
  process.exit(0);
}

// logo mode, headless: the host's one naming call for the tab (`nameTab`). Answered with the real
// `--output-format json` envelope and a plain name — the gif shows the tab, and a painted screen read
// back as a title is escape codes in it.
/** welcome mode: the first prompt the setup film sends (scripts/ui/journey-setup.mjs). */
const SETUP_PROMPT_RE = /dark mode/i;
if (HEADLESS && (MODE === "logo" || MODE === "welcome")) {
  // The tab is named off the first prompt, which reaches a headless run on stdin.
  let stdin = "";
  if (MODE === "welcome" && !process.stdin.isTTY) {
    const t = setTimeout(() => process.stdin.destroy(), 1500);
    try { for await (const c of process.stdin) stdin += c; } catch { /* closed: name it off what arrived */ }
    clearTimeout(t);
  }
  const result = MODE === "logo" ? "Tide Tables logo" : SETUP_PROMPT_RE.test(stdin) ? "Dark mode toggle" : "Confetti every tenth tap";
  out(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }) + "\n");
  process.exit(0);
}

// Announce the hook pipe as live (SessionStart only). Best-effort, exactly like
// the real curl hooks: a failure just means the session stays unhooked.
//
// STUB_HOOK_URL redirects every post (a PLUGIN backend's sink,
// `/api/plugin/<id>/hook` — scripts/fixtures/plugin-backend-stub), and
// STUB_SESSION_ID rides on each payload as `session_id` so that plugin can tell
// its sessions apart. Both absent ⇒ the core's `/api/hook`, exactly as before.
const HOOK_URL = process.env.STUB_HOOK_URL || `http://127.0.0.1:${process.env[E.PORT] || "8770"}/api/hook`;
const HOOK_SID = process.env.STUB_SESSION_ID ? { session_id: process.env.STUB_SESSION_ID } : {};
if (process.env.STUB_HOOKS === "1") {
  fetch(HOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", cwd: process.cwd(), ...HOOK_SID }),
  }).catch(() => {});
}

let buf = "";
let spinner = null;
let view = false;   // menu mode: a full-screen command view is up

/** menu mode: the commands that open a view instead of starting a turn. */
const LOCAL = new Set(["/cost", "/usage", "/context", "/config"]);

/**
 * menu mode: the commands that SUBMIT and still start no turn.
 *
 * `/btw` files a note and clears the composer — no view opens, and no
 * `UserPromptSubmit` is ever fired, so `hookTurn()` is deliberately not called.
 * That combination is the one the host had no proof for.
 */
const NOTE = new Set(["/btw"]);

/** One lifecycle event, best-effort, exactly like the real curl hooks. */
function hook(hook_event_name, extra = {}) {
  if (process.env.STUB_HOOKS !== "1") return;
  fetch(HOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name, cwd: process.cwd(), ...HOOK_SID, ...extra }),
  }).catch(() => {});
}

/**
 * Fire a hook the way a real turn would. Only a REAL prompt does this.
 *
 * **`UserPromptSubmit` carries the submitted text**, because the real one does
 * — verified against 2.1.267, whose payload is
 * `{session_id, transcript_path, cwd, prompt_id, permission_mode,
 * hook_event_name, prompt}` — and because that field is now a PROOF: it is the
 * only thing either end has that is about a particular delivery rather than
 * about the session being busy (`sessions.ts`'s `claimSubmittedPrompt`). A stub
 * that posted the event without the words would pass every test while the one
 * rule they exist to cover was never exercised.
 */
function hookTurn(prompt) {
  hook("UserPromptSubmit", typeof prompt === "string" && prompt ? { prompt } : {});
  hook("Stop");
  if (typeof prompt === "string" && prompt) EXT?.submit?.(prompt);
}


/** answer mode: turns still owed a transient give-up row (`STUB_NETFAIL`). */
let netFails = 0;

/** answer mode: write the conversation log with this prompt and its answer, then the turn hooks. */
function answerTurn(prompt) {
  const lines = String(prompt).split("\n");
  const arg = (k) => lines.map((l) => l.trim()).find((l) => l.startsWith(k + " "))?.slice(k.length + 1).trim();
  const nf = Number(arg("STUB_NETFAIL"));
  if (nf > 0) netFails = nf;
  const giveUp = netFails > 0;
  if (giveUp) netFails--;
  let say = arg("STUB_SAY") ?? "ok";
  const wr = arg("STUB_WRITE");
  if (wr) { try { mkdirSync(dirname(join(process.cwd(), wr)), { recursive: true }); writeFileSync(join(process.cwd(), wr), `written by the stub for ${wr}\n`); } catch { /* the answer says nothing */ } }
  const run = arg("STUB_RUN");
  if (run) {
    let code = 0, text = "";
    try { text = execSync(run, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { code = e.status ?? 1; text = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    say += `\n\n\`${run}\` exited ${code}: ${text.trim()}`;
  }
  const a = process.argv, i = Math.max(a.indexOf("--session-id"), a.indexOf("--resume"));
  const sid = i >= 0 ? a[i + 1] : "";
  if (sid) {
    try {
      const home = process.env[E.CLAUDE_HOME] || homedir();
      const dir = join(home, ".claude", "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const reply = giveUp
        ? { type: "assistant", timestamp: at, isApiErrorMessage: true, error: "server_error", apiErrorStatus: null,
            message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API " + "Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" }] } }
        : { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: say }] } };
      appendFileSync(join(dir, sid + ".jsonl"),
        JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: prompt } }) + "\n" +
        JSON.stringify(reply) + "\n");
    } catch { /* no log: the answer is simply unreadable */ }
  }
  hookTurn(prompt);
}

/** goal mode's quiet screen: transcript, composer, nothing moving. */
function paintGoal() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 8; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  frame += `❯ ${buf}\r\n`;
  out(frame);
}

/** How long a `goal` turn carries on after the Stop that was refused. */
const GOAL_KEEP_MS = Number(process.env.STUB_GOAL_MS || 3000);
/** How long a compaction runs before the CLI starts printing an elapsed. The
 *  real one waits; a delivery is decided long before that. */
const COMPACT_ELAPSED_AT_S = Number(process.env.STUB_COMPACT_ELAPSED_S || 30);
/**
 * goal mode's turn: the Stop arrives in the middle of the work, not at the end
 * of it. Between the two Stops the screen is the one thing that can contradict
 * the hook, so it carries the CLI's own working line — gerund, ellipsis, and a
 * parenthetical with a duration and a token count.
 */
/**
 * goal mode's `/compact`: work with no hook whatsoever.
 *
 * Nothing is posted — that IS the case under test. The only thing on the wire
 * saying this session is busy is the line it paints.
 */
function compactRun() {
  const t0 = Date.now();
  clearInterval(spinner);
  spinner = setInterval(() => {
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    // **The first half-minute carries NO parenthetical** — verbatim from this
    // desktop's turn captures, and the shape the stub used to skip. A delivery
    // is proved (or not) inside exactly this window, so painting the LATE shape
    // from the first frame is what let `e2e-submit.mjs` pass while the live
    // host filed a running compaction as "Return was swallowed". The bar and
    // the percentage are the measurement until the elapsed shows up.
    const pct = Math.min(99, 2 + secs * 3);
    const bar = "▰".repeat(Math.round(pct / 5)).padEnd(20, "▱");
    const head = secs < COMPACT_ELAPSED_AT_S ? "Compacting conversation…" : `Compacting conversation… (${secs}s)`;
    // **Painted the way a real TUI paints it: never contiguously.** Measured on
    // claude 2.1.267, the compaction line reaches the PTY as
    // `C\x1b(Bo\x1b(Bm\x1b(Bp…` — each character followed by a charset
    // escape, spliced through the previous frame's leftovers. The bytes
    // therefore contain no readable phrase and the GRID contains exactly one;
    // a stub that wrote the line in one clean chunk let the byte-window reader
    // pass here while the live host published `idle` over a running compaction
    // for two minutes. The escape is a no-op for the terminal, so what a person
    // sees is unchanged.
    const scatter = (t) => [...t].join("\x1b(B");
    out(`\x1b[H\x1b[2J✳ ${scatter(head)}\r\n  ${scatter(`${bar} ${pct}%`)}\r\n`);
    if (Date.now() - t0 < GOAL_KEEP_MS) return;
    clearInterval(spinner);
    spinner = null;
    out("\r\nCOMPACTED\r\n❯ \r\n");
  }, 150);
}

function goalTurn(prompt) {
  hook("UserPromptSubmit", typeof prompt === "string" && prompt ? { prompt } : {});
  const t0 = Date.now();
  clearInterval(spinner);
  setTimeout(() => hook("Stop"), 150);   // …and the hook answers "keep going"
  spinner = setInterval(() => {
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    out(`\x1b[H\x1b[2J✻ Crafting… (${secs}s · ↓ 34.5k tokens)\r\n`);
    if (Date.now() - t0 < GOAL_KEEP_MS) return;
    clearInterval(spinner);
    spinner = null;
    out("\r\nDONE\r\n❯ \r\n");   // the composer is back: the turn is really over
    hook("Stop");
  }, 150);
}

/**
 * paste mode. The composer renders a multi-line buffer the way the real TUI
 * does: a placeholder standing for the hidden HEAD lines, then the tail.
 * `TAIL_ROWS` is how many lines survive on screen — the rest are counted, not
 * drawn, exactly like `[Pasted text #1 +11 lines]`.
 */
const TAIL_ROWS = 4;
/**
 * How long a write collapses on LENGTH alone — the real composer's own number
 * (`text.length > 800 || newlines > 2`). A long ONE-LINE write is collapsed
 * too, and the placeholder it draws carries no `+N lines` clause at all,
 * because the clause reports NEWLINES and there are none. That is the shape a
 * message typed on a phone has, and the shape that read as never typed.
 */
const PASTE_MIN_CHARS = 800;
function paintPaste() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 20; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  const lines = buf.split("\n");
  if (lines.length === 1 && buf.length > PASTE_MIN_CHARS) {
    // Nothing but the chit: no count, no tail, no head. Everything a reader
    // could tie to this text is gone except "a paste with no newlines".
    frame += `> [Pasted text #1]\r\n`;
  } else if (lines.length > TAIL_ROWS) {
    const tail = lines.slice(-TAIL_ROWS);
    frame += `> [Pasted text #1 +${lines.length - TAIL_ROWS} lines]${tail[0]}\r\n`;
    for (const l of tail.slice(1)) frame += `  ${l}\r\n`;
  } else {
    frame += `> ${lines[0] ?? ""}\r\n`;
    for (const l of lines.slice(1)) frame += `  ${l}\r\n`;
  }
  out(frame);
}

/**
 * scroll mode. The composer as the real one behaves: a viewport, not a field.
 *
 * The buffer is wrapped at `SCROLL_COLS` and only the last `SCROLL_ROWS` of
 * those rows are drawn, inside a box `composer.ts` recognises. That is what the
 * live CLI does at a phone's terminal height, and it is the only thing wrong
 * with the screen: the text is accepted, echoed and submittable, and the head
 * of it is off the top of the box.
 */
const SCROLL_RULE = "\u2500".repeat(56);
const SCROLL_COLS = 52;
const SCROLL_ROWS = 3;
function paintScroll() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 10; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  const wrapped = [];
  for (const line of buf.split("\n")) {
    if (!line) { wrapped.push(""); continue; }
    for (let i = 0; i < line.length; i += SCROLL_COLS) wrapped.push(line.slice(i, i + SCROLL_COLS));
  }
  const shown = wrapped.slice(-SCROLL_ROWS);
  frame += `${SCROLL_RULE}\r\n`;
  frame += `\u276f\u00a0${shown[0] ?? ""}\r\n`;
  for (const row of shown.slice(1)) frame += `  ${row}\r\n`;
  frame += `${SCROLL_RULE}\r\n`;
  frame += "  \u23f5\u23f5 auto mode on (shift+tab to cycle)\r\n";
  out(frame);
}

/**
 * stream mode. The composer inside its own box, with the render torn under it.
 *
 * The rules are the characters `composer.ts` anchors on (U+2500, 20 or more of
 * them) and the input row is `❯` plus the NBSP the real TUI pads the cursor row
 * with. Everything below the closing rule is what the tear leaves behind: the
 * footer twice over, then turn output. `STREAM_BELOW` is chosen so the echo
 * sits well past the eleven rows the old positional rule allowed.
 */
const STREAM_RULE = "─".repeat(56);
const STREAM_BELOW = 12;
function paintStream() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 6; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  frame += `${STREAM_RULE}\r\n`;
  frame += `❯ ${buf}\r\n`;
  frame += `${STREAM_RULE}\r\n`;
  // The footer, drawn twice — the signature of a repaint caught half-done.
  for (let i = 0; i < 2; i++) {
    frame += "  ⏵⏵ auto mode on (shift+tab to cycle)\r\n";
    frame += "  …/clear to save 102.6k tokens\r\n";
  }
  for (let i = 0; i < STREAM_BELOW; i++) frame += `  ⏺ streaming turn output row ${i} lorem ipsum\r\n`;
  out(frame);
  // The same trailing churn `repaint` uses: the composer stays visible while
  // kilobytes pile up behind it in the raw byte stream.
  clearInterval(spinner);
  let n = 0;
  spinner = setInterval(() => {
    if (n++ > 60) { clearInterval(spinner); return; }
    out(`\x1b[2K\x1b[38;5;213m  * Working... (${n}s - ${n * 137} tokens - esc to interrupt)\x1b[0m\r`);
  }, 6);
}

/**
 * checkbox mode. The box as `AskUserQuestion` draws a multi-select one: the
 * ticked state and the CURSOR are two different things, and only the Submit row
 * turns Return into an answer.
 */
const CB_OPTS = ["Host notification + push", "Launcher badge", "Standing banner", "Type something"];
/** Navigable rows, in screen order: the options, Submit, then the trailing action. */
const CB_ROWS = [...CB_OPTS.map((_, i) => ({ kind: "opt", i })), { kind: "submit" }, { kind: "chat" }];
const cbTicked = new Set();
let cbCursor = 0;
let cbOpen = true;
/** The SUBMITTED line, repainted with the closed box (see `loginVerdict`). */
let cbVerdict = "";

function paintCheckbox() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 12; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  if (!cbOpen) { frame += `${cbVerdict}\r\n> ${buf}\r\n`; out(frame); return; }
  frame += "How should a give-up announce itself proactively?\r\n\r\n";
  CB_ROWS.forEach((r, n) => {
    const mark = n === cbCursor ? "\u276f " : "  ";
    if (r.kind === "opt") {
      frame += `${mark}${r.i + 1}. [${cbTicked.has(r.i) ? "\u2713" : " "}] ${CB_OPTS[r.i]}\r\n`;
      frame += `    what option ${r.i + 1} would mean, at the length the real box wraps to\r\n`;
    } else if (r.kind === "submit") {
      frame += `${mark}Submit\r\n`;
      frame += "  " + "\u2500".repeat(40) + "\r\n";
    } else {
      frame += `${mark}${CB_OPTS.length + 1}. Chat about this\r\n`;
    }
  });
  frame += "\r\nEnter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel\r\n";
  out(frame);
}

/** Every keystroke the box understands. Escape sequences arrive whole. */
function feedCheckbox(d) {
  for (let i = 0; i < d.length; i++) {
    const rest = d.slice(i);
    if (rest.startsWith("\x1b[B")) { cbCursor = Math.min(CB_ROWS.length - 1, cbCursor + 1); i += 2; continue; }
    if (rest.startsWith("\x1b[A")) { cbCursor = Math.max(0, cbCursor - 1); i += 2; continue; }
    const ch = d[i];
    if (ch === "\r" || ch === "\n") {
      const row = CB_ROWS[cbCursor];
      // The whole point: Return is a TOGGLE unless the cursor is on Submit.
      if (row.kind === "submit") {
        cbOpen = false;
        cbVerdict = `SUBMITTED: ${[...cbTicked].sort().map((n) => n + 1).join(",")}`;
        out(`\r\n${cbVerdict}\r\n`);
        hookTurn();
      } else if (row.kind === "opt") {
        cbTicked.has(row.i) ? cbTicked.delete(row.i) : cbTicked.add(row.i);
      }
      continue;
    }
    if (/[1-9]/.test(ch)) {
      // A digit ticks its row and leaves the cursor where it was — which is how
      // the cursor is still on option 1 when the phone presses Submit.
      const n = Number(ch) - 1;
      if (n < CB_OPTS.length) (cbTicked.has(n) ? cbTicked.delete(n) : cbTicked.add(n));
      continue;
    }
    if (ch === "\x1b") { cbOpen = false; out("\r\nCANCELLED\r\n"); continue; }
  }
  paintCheckbox();
}

/**
 * unreadable mode. A dialog whose footer is unmistakable and whose option rows
 * this app's parser refuses.
 *
 * The six rows ending at the footer are exactly what the host captures as the
 * failing sample, so two of them are deliberately dirty: a home directory (which
 * carries the account name) and a `token=` assignment. Neither may survive into
 * the record — the sample exists so a human can see the line that stopped
 * matching, not to copy a terminal into a JSON file.
 */
function paintUnreadable(box) {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 14; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  if (!box) { frame += `> ${buf}\r\n`; out(frame); return; }
  frame += "Do you want to proceed with /Users/somebody/dev/octopus?\r\n";
  frame += "token=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n";
  // `1)` rather than `1.` — one character, and the box becomes invisible.
  frame += "❯ 1) Yes\r\n";
  frame += "  2) No, and tell Claude what to do differently\r\n";
  frame += "\r\n";
  frame += "Enter to confirm · Esc to cancel\r\n";
  out(frame);
}
let unreadableBox = true;
if (MODE === "unreadable") {
  // The box goes away and comes back, because ONE unreadable box is one miss and
  // the verdict this test is about needs a streak. A real session produces the
  // same shape: every question the agent asks is a fresh appearance.
  setInterval(() => { unreadableBox = !unreadableBox; paintUnreadable(unreadableBox); }, 2000);
}

/**
 * prose mode. An agent talking ABOUT the dialog footer, with no dialog anywhere.
 *
 * Every line here is a sentence. The footer words appear mid-clause on the row
 * the real host captured as its sample; numbered rows appear too, because prose
 * is numbered all the time and a `1.` is not evidence of a box on its own (the
 * two here quote stages 1 and 3, so they do not even form a run). What is
 * deliberately absent is the two things that ARE evidence: a row made of key
 * hints and nothing else, and a "❯" selection cursor.
 */
function paintProse(second) {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 8; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  frame += "I read packages/host/src/prompt.ts and here is what the stages do.\r\n";
  frame += "The cheap gate is a substring test over a byte window, so the login\r\n";
  frame += "screen's Esc to cancel footer already trips it before anything is\r\n";
  frame += "rendered, and the strict pass over the screen is what publishes.\r\n";
  frame += "\r\n";
  frame += "1. the lenient scan keeps the index-1 anchor as its one defence\r\n";
  frame += "3. the strict pass may drop that anchor because it has proof\r\n";
  if (second) frame += "Enter to confirm is the other half of that footer, quoted here.\r\n";
  frame += `> ${buf}\r\n`;
  out(frame);
}
let proseSecond = false;
if (MODE === "prose") {
  // Redrawn on the same cycle as `unreadable`, so a counter that mistakes a
  // refusal for a miss racks up the identical streak and the two tests differ in
  // nothing but whether a box is really there.
  setInterval(() => { proseSecond = !proseSecond; paintProse(proseSecond); }, 2000);
}

/**
 * login mode. The CLI's sign-in screen, wrapped by the grid.
 *
 * The URL is emitted as fixed-width ROWS rather than one long line on purpose:
 * that is what the terminal does to it, and the whole detector exists to undo
 * it. Wrapped at 50 so the rows are the same width whatever the test's terminal
 * is, which is the geometry `findUrls` reads as a wrap.
 */
const LOGIN_URL =
  "https://claude.example/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.example%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&state=cQb7hRqDdxKqM6fnqs6N6jdsYfHWu9J0ZWwDdOxnhpw";
const LOGIN_WRAP = 50;
let loggedIn = false;
/** The verdict line, kept so the repaint after it still shows it: under tmux the
 *  client's bytes are a redraw of the FINAL screen, and a line printed and then
 *  cleared in the same tick never reaches it. */
let loginVerdict = "";
function paintLogin() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 6; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  if (loggedIn) { frame += `  Login successful\r\n${loginVerdict}\r\n> ${buf}\r\n`; out(frame); return; }
  frame += "Login\r\n\r\n";
  frame += "Browser didn't open? Use the url below to sign in\r\n\r\n";
  for (let i = 0; i < LOGIN_URL.length; i += LOGIN_WRAP) frame += LOGIN_URL.slice(i, i + LOGIN_WRAP) + "\r\n";
  frame += "\r\nPaste code here if prompted >\r\n";
  out(frame);
}


/**
 * demo mode. `demoLog` is the transcript so far; `demoBox` is the open choice
 * box (null when none). Everything printed is fictional: a todo app, `src/…`
 * paths relative to the repo, no usernames.
 */
const DEMO_WORK = [
  "\u25cf I'll look at how the task list is rendered first.",
  "\u25cf Read(src/components/TaskList.tsx)",
  "  \u23bf  Read 84 lines",
  "\u25cf Read(src/store/tasks.ts)",
  "  \u23bf  Read 61 lines",
  "\u25cf Update(src/store/tasks.ts)",
  "  \u23bf  Added 12 lines, removed 2 lines",
  "\u25cf Bash(npm test -- tasks)",
  "  \u23bf  PASS src/store/tasks.test.ts (7 tests)",
];
const DEMO_OPTS = ["Yes, sort by due date", "No, keep creation order"];
let demoLog = ["stub tui ready"];
let demoBox = null;
let demoCursor = 0;

function paintDemo() {
  let frame = "\x1b[H\x1b[2J";
  for (const l of demoLog) frame += `${l}\r\n`;
  if (demoBox) {
    frame += "\r\nShould the task list be sorted by due date?\r\n\r\n";
    DEMO_OPTS.forEach((o, i) => { frame += `${i === demoCursor ? "\u276f " : "  "}${i + 1}. ${o}\r\n`; });
    frame += "\r\nEnter to select \u00b7 Esc to cancel\r\n";
  } else {
    frame += `> ${buf}\r\n`;
  }
  out(frame);
}

function answerDemo(n) {
  demoBox = null;
  demoLog.push(`\u276f ${n + 1}. ${DEMO_OPTS[n]}`);
  demoLog.push(n === 0 ? "\u25cf Done. Tasks now sort by due date; overdue ones sit on top (src/store/tasks.ts)." : "\u25cf Understood, the order stays as created. No further changes.");
  hookTurn();
}

function feedDemo(d) {
  for (let i = 0; i < d.length; i++) {
    const rest = d.slice(i);
    if (demoBox) {
      if (rest.startsWith("\x1b[B")) { demoCursor = Math.min(DEMO_OPTS.length - 1, demoCursor + 1); i += 2; continue; }
      if (rest.startsWith("\x1b[A")) { demoCursor = Math.max(0, demoCursor - 1); i += 2; continue; }
      const ch = d[i];
      if (/[1-9]/.test(ch) && Number(ch) <= DEMO_OPTS.length) answerDemo(Number(ch) - 1);
      else if (ch === "\r" || ch === "\n") answerDemo(demoCursor);
      else if (ch === "\x1b") { demoBox = null; demoLog.push("(cancelled)"); }
      continue;
    }
    const ch = d[i];
    if (ch === "\r" || ch === "\n") {
      if (!buf.trim()) continue;
      const p = buf; buf = "";
      demoLog.push(`> ${p}`, ...DEMO_WORK);
      demoBox = {}; demoCursor = 0;
      hookTurn(p);
    } else if (ch === "\x15") buf = "";
    else if (ch === "\x1b") { /* Esc: nothing to close */ }
    else buf += ch;
  }
  paintDemo();
}


/**
 * logo mode. The welcome header, the turn so far, a working line while it runs, the composer.
 * The edit itself is `addLogo` (scripts/media/tide-tables.mjs), imported on first use so every other
 * mode loads nothing new.
 */
const LOGO_C = "\x1b[38;2;215;119;87m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";
const LOGO_BANNER = "\r\n\r\n\r\n\r\n\r\n" + `${LOGO_C} \u2590\u259b\u2588\u2588\u2588\u259c\u258c${RST}   ${BOLD}Claude Code${RST} ${DIM}v${process.env.STUB_CLAUDE_VERSION || "2.1.140"}${RST}\r\n` +
  `${LOGO_C}\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u259b\u2598${RST}  ${DIM}Sonnet 5 \u00b7 Claude Max${RST}\r\n` +
  `${LOGO_C}  \u2598\u2598 \u259d\u259d${RST}    ${DIM}~/dev/${process.cwd().split("/").pop()}${RST}\r\n\r\n`;
const LOGO_STEP_MS = Number(process.env.STUB_LOGO_STEP_MS || 900);
let logoLog = [];
let logoWorking = null; // { verb, t0 } while a turn runs
let logoBusy = false;
/** welcome mode under STUB_TRUST=1: the first-launch trust box is up until it is answered. */
let trustOpen = MODE === "welcome" && process.env.STUB_TRUST === "1";
let trustCursor = 0;
const TRUST_OPTS = ["No, exit", "Yes, I trust this folder"];
function paintTrust() {
  const cols = Math.max(40, process.stdout.columns || 80);
  const home = homedir();
  const dir = process.cwd().startsWith(home + "/") ? "~" + process.cwd().slice(home.length) : process.cwd();
  // Word-wrapped to the grid the way the CLI wraps it (a capture at 100 columns breaks after "a").
  const wrap = (text) => {
    const rows = [];
    let row = "";
    for (const w of text.split(" ")) {
      if (row && row.length + 1 + w.length > cols - 2) { rows.push(row); row = w; } else row = row ? `${row} ${w}` : w;
    }
    return rows.concat(row).map((r) => ` ${r}\r\n`).join("");
  };
  let frame = "\x1b[H\x1b[2J" + `${LOGO_C}${"\u2500".repeat(cols)}${RST}\r\n` +
    ` ${BOLD}Accessing workspace:${RST}\r\n\r\n ${dir}\r\n\r\n` +
    wrap("Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.") +
    "\r\n" + wrap("Claude Code'll be able to read, edit, and execute files here.") + "\r\n" +
    ` ${DIM}Security guide${RST}\r\n\r\n`;
  TRUST_OPTS.forEach((o, i) => { frame += i === trustCursor ? ` ${LOGO_C}\u276f ${o}${RST}\r\n` : `   ${o}\r\n`; });
  frame += `\r\n ${DIM}Enter to confirm \u00b7 Esc to cancel${RST}\r\n`;
  out(frame);
}
// The phone sizes the grid after the spawn: the box is re-wrapped to it, as the CLI re-wraps.
if (trustOpen) process.stdout.on("resize", () => { if (trustOpen) paintTrust(); });
function answerTrust(i) {
  if (i === 0) { out("\x1b[H\x1b[2J"); process.exit(0); }
  trustOpen = false;
  paintLogo();
}
function paintLogo() {
  if (trustOpen) return paintTrust();
  let frame = "\x1b[H\x1b[2J" + LOGO_BANNER;
  for (const l of logoLog) frame += `${l}\r\n`;
  if (logoWorking) frame += `\r\n${LOGO_C}\u273b${RST} ${logoWorking.verb}\u2026 ${DIM}(${Math.max(1, Math.round((Date.now() - logoWorking.t0) / 1000))}s \u00b7 esc to interrupt)${RST}\r\n`;
  frame += `\r\n> ${buf}\r\n`;
  // The status line the CLI draws under its composer once it takes typing — what a delivery
  // waits for after accepting the trust box (`deliverrun.ts`). Only under STUB_TRUST: the docs' frames stay as filmed.
  if (process.env.STUB_TRUST === "1") frame += `  ${DIM}? for shortcuts${RST}\r\n`;
  out(frame);
}
async function logoTurn(prompt) {
  logoBusy = true;
  hook("UserPromptSubmit", { prompt });
  const short = prompt.length > 160 ? prompt.slice(0, 157) + "\u2026" : prompt;
  logoLog.push(`${DIM}>${RST} ${short}`, "");
  const steps = [];
  const say = (...lines) => steps.push(() => logoLog.push(...lines));
  const { parseMark, addLogo } = await import("./media/tide-tables.mjs");
  const img = /\S*\.claude\/inbox\/\S+\.(?:png|jpe?g|webp)/i.exec(prompt)?.[0];
  const mark = parseMark(prompt);
  if (img) say(`\u25cf Read(${img})`, `  \u23bf  Read image`);
  if (!mark) {
    say("\u25cf I can't see a mark on that picture, so I haven't changed anything. Circle the spot and send it again.", "");
  } else {
    const pc = (v) => `${Math.round(v * 100)}%`;
    say(`\u25cf The ${mark.kind === "point" ? "label" : mark.kind} is at x ${pc(mark.x0)}-${pc(mark.x1)}, y ${pc(mark.y0)}-${pc(mark.y1)}: the empty space left of the title. The logo goes there.`);
    say("\u25cf Read(src/MainActivity.java)", "  \u23bf  Read 58 lines");
    let r = null;
    steps.push(() => {
      try { r = addLogo(process.cwd(), mark); logoLog.push("\u25cf Write(res/drawable/logo.xml)", `  \u23bf  Wrote ${r.logoLines} lines: a tide mark, sun over two waves`); }
      catch (e) { logoLog.push(`\u25cf Error: ${e.message}`); }
    });
    steps.push(() => { if (r) logoLog.push("\u25cf Update(src/MainActivity.java)", `  \u23bf  Added ${r.javaLines} lines: the logo, centred on the marked spot`); });
    steps.push(() => { if (r) logoLog.push("\u25cf Update(version.txt)", `  \u23bf  ${r.was} \u2192 ${r.now}`); });
    steps.push(() => { if (r) logoLog.push("", `\u25cf Done. The logo sits where you circled it, and the version is ${r.now}. Run the debug apk build to ship it.`, ""); });
  }
  logoWorking = { verb: "Drawing", t0: Date.now() };
  const tick = setInterval(paintLogo, 500);
  for (const s of steps) { await new Promise((res) => setTimeout(res, LOGO_STEP_MS)); s(); paintLogo(); }
  clearInterval(tick);
  logoWorking = null;
  logoBusy = false;
  paintLogo();
  hook("Stop");
}
function feedLogo(d) {
  if (trustOpen) {
    for (let i = 0; i < d.length && trustOpen; i++) {
      const rest = d.slice(i);
      if (rest.startsWith("\x1b[B")) { trustCursor = Math.min(TRUST_OPTS.length - 1, trustCursor + 1); i += 2; continue; }
      if (rest.startsWith("\x1b[A")) { trustCursor = Math.max(0, trustCursor - 1); i += 2; continue; }
      const ch = d[i];
      if (ch === "1" || ch === "2") answerTrust(Number(ch) - 1);
      else if (ch === "\r" || ch === "\n") answerTrust(trustCursor);
    }
    if (trustOpen) paintTrust();
    return;
  }
  for (const ch of d) {
    if (ch === "\r" || ch === "\n") {
      if (logoBusy || !buf.trim()) continue;
      const p = buf; buf = "";
      void (MODE === "welcome" ? welcomeTurn(p) : logoTurn(p));
    } else if (ch === "\x15") buf = "";
    else if (ch === "\x1b") { /* Esc: nothing to close */ }
    else if (!logoBusy) buf += ch;
  }
  paintLogo();
}

/** welcome mode's turn: scripted lines on `logo`'s pace, between the two turn hooks. */
async function welcomeTurn(prompt) {
  logoBusy = true;
  hook("UserPromptSubmit", { prompt });
  const short = prompt.length > 160 ? prompt.slice(0, 157) + "\u2026" : prompt;
  logoLog.push(`${DIM}>${RST} ${short}`, "");
  const lines = SETUP_PROMPT_RE.test(prompt) ? [
    ["\u25cf Read(src/App.tsx)", "  \u23bf  Read 112 lines"],
    ["\u25cf Read(src/styles.css)", "  \u23bf  Read 87 lines"],
    ["\u25cf Update(src/styles.css)", "  \u23bf  Added 24 lines: a dark palette under [data-theme=dark]"],
    ["\u25cf Update(src/App.tsx)", "  \u23bf  Added 18 lines: a moon/sun toggle in the header, remembered per browser"],
    ["\u25cf Bash(npm test)", "  \u23bf  14 passed (2 new: the toggle flips the theme, and it survives a reload)"],
    ["", "\u25cf Done. The header has a dark mode toggle; it follows the system setting until you tap it, then remembers your choice.", ""],
  ] : /confetti/i.test(prompt) ? [
    ["\u25cf Read(index.html)", "  \u23bf  Read 64 lines"],
    ["\u25cf Update(index.html)", "  \u23bf  Added 31 lines: a confetti burst on every tenth tap, and the best streak under the count"],
    ["", "\u25cf Done. Every tenth tap now bursts confetti, and the best streak of this visit shows under the count. Rebuild the page to see it.", ""],
  ] : [["\u25cf Noted. Nothing to change for that yet.", ""]];
  logoWorking = { verb: "Thinking", t0: Date.now() };
  const tick = setInterval(paintLogo, 500);
  for (const l of lines) { await new Promise((res) => setTimeout(res, LOGO_STEP_MS)); logoLog.push(...l); paintLogo(); }
  clearInterval(tick);
  logoWorking = null;
  logoBusy = false;
  paintLogo();
  hook("Stop");
}

/** A full-screen repaint: filler transcript, the composer, then a status line. */
function paint() {
  // goal mode draws NO trailing churn: the point of the test is which windows
  // carry the CLI's working line, so the only one that does must be the turn
  // that is really still running.
  if (MODE === "goal") return paintGoal();
  if (EXT) return out(EXT.paint({ buf, blind: BLIND }));
  if (MODE === "unreadable") return paintUnreadable(unreadableBox);
  if (MODE === "prose") return paintProse(proseSecond);
  if (MODE === "checkbox") return paintCheckbox();
  if (MODE === "demo") return paintDemo();
  if (MODE === "logo" || MODE === "welcome") return paintLogo();
  if (MODE === "login") return paintLogin();
  if (MODE === "scroll") return paintScroll();
  if (MODE === "stream") return paintStream();
  if (MODE === "menu") return paintMenu();
  if (MODE === "paste") return paintPaste();
  if (MODE === "permmode") return paintPermMode();
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 40; i++) frame += `\x1b[38;5;${i % 255}m  transcript line ${i} ${"lorem ipsum ".repeat(3)}\x1b[0m\r\n`;
  if (!BLIND) frame += `> ${buf}\r\n`;
  out(frame);
  // Trailing churn: the spinner keeps rewriting the LAST line (\r, no newline),
  // so the composer stays visible while several KB pile up behind it.
  clearInterval(spinner);
  let n = 0;
  spinner = setInterval(() => {
    if (n++ > 60) { clearInterval(spinner); return; }
    out(`\x1b[2K\x1b[38;5;213m  * Working... (${n}s - ${n * 137} tokens - esc to interrupt)\x1b[0m\r`);
  }, 6);
}

/**
 * menu mode. Either the view fills the screen, or: transcript, the composer,
 * and — when the composer holds a slash command — the completion menu below it.
 */
function paintMenu() {
  let frame = "\x1b[H\x1b[2J";
  if (view) {
    frame += "Usage view\r\n";
    for (let i = 0; i < 12; i++) frame += `  metric ${i}   ${i * 7}%\r\n`;
    out(frame);
    return;
  }
  for (let i = 0; i < 20; i++) frame += `  transcript line ${i} ${"lorem ipsum ".repeat(2)}\r\n`;
  frame += `> ${buf}\r\n`;
  if (buf.startsWith("/")) {
    for (let i = 0; i < 8; i++) {
      frame += `/candidate-${i}          Do the ${i}th thing, at some\r\n`;
      frame += `                         length that wraps a line\r\n`;
    }
  }
  out(frame);
}

/**
 * permmode mode. The footer row the host reads the mode off (`permmode.ts`),
 * under a composer `composer.ts` and `permmode.ts` both recognise, with a status
 * line between them like a user's own `statusLine` draws.
 */
const PM_CYCLE = [
  ["\u23f5\u23f5", "auto mode on (shift+tab to cycle)"],
  ["\u23f8", "manual mode on"],
  ["\u23f5\u23f5", "accept edits on (shift+tab to cycle)"],
  ["\u23f8", "plan mode on (shift+tab to cycle)"],
];
let pmIdx = 0;
const PM_RULE = "\u2500".repeat(60);
function paintPermMode() {
  let frame = "\x1b[H\x1b[2J";
  for (let i = 0; i < 8; i++) frame += `  transcript line ${i} lorem ipsum\r\n`;
  const [glyph, words] = PM_CYCLE[pmIdx];
  frame += `${PM_RULE}\r\n\u276f\u00a0${buf}\r\n${PM_RULE}\r\n  [STATUS]\r\n  ${glyph} ${words} \u00b7 \u2190 1 agent\r\n`;
  out(frame);
}

/**
 * The `/usage` screen, when the test asked for one (`STUB_USAGE=<session>,<weekly>`).
 *
 * `host/usage.ts` scrapes this out of a short-lived PTY and `shared/budget.ts`
 * gates automatic work on the result, so the only way to exercise that path
 * end-to-end is for the stub to be able to say "you are at 95%". The layout is
 * the one the parser reads: each figure under the heading that NAMES it, the
 * weekly one qualified `(all models)` (a per-model row must never stand in for
 * the account), and a reset line under each.
 *
 * Rendered on ANY input containing `/usage`, in every mode: the probe types the
 * command and reads the screen, and it has no composer to drive.
 */
const USAGE = process.env.STUB_USAGE;
function paintUsage() {
  const [sess = "0", week = "0"] = USAGE.split(",");
  // Far enough out that a test never races the "past the reset" branch, and
  // named with a weekday+date because the weekly parse insists on one.
  const reset = new Date(Date.now() + 3 * 3600_000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][reset.getDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][reset.getMonth()];
  const hh = `${((reset.getHours() + 11) % 12) + 1}${reset.getHours() < 12 ? "am" : "pm"}`;
  out("\x1b[H\x1b[2J");
  out("Current session\r\n");
  out(`  ${sess}% used\r\n`);
  out(`  Resets ${day} ${mon} ${reset.getDate()} at ${hh}\r\n\r\n`);
  out("Current week (all models)\r\n");
  out(`  ${week}% used\r\n`);
  out(`  Resets ${day} ${mon} ${reset.getDate() + 2} at ${hh}\r\n`);
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
/** Set when the input handler printed a verdict line (`verdict`), so its repaint waits. */
let saidVerdict = false;
const VERDICT_HOLD_MS = 60;
function verdict(line) { out(line); saidVerdict = true; }
process.stdin.on("data", (d) => {
  if (LOG) { try { appendFileSync(LOG, d); } catch { /* best-effort */ } }
  // The usage probe: it types `/usage`, waits, and reads whatever is on screen.
  // Handled ahead of the composer because it is not a composer interaction —
  // there is no buffer to echo and no turn to start.
  if (USAGE && d.includes("/usage")) { paintUsage(); return; }
  // The box owns every keystroke while it is up: arrows are a selection, not
  // text, and Return means two different things depending on the cursor.
  if (MODE === "checkbox" && cbOpen) { feedCheckbox(d); return; }
  if (MODE === "demo") { feedDemo(d); return; }
  // permmode: shift+tab moves the footer (unless deaf), and is never text.
  if (MODE === "permmode" && d.includes("\x1b[Z")) {
    const n = d.split("\x1b[Z").length - 1;
    if (process.env.STUB_PERMMODE_DEAF !== "1") pmIdx = (pmIdx + n) % PM_CYCLE.length;
    d = d.split("\x1b[Z").join("");
    if (!d) { paint(); return; }
  }
  if (MODE === "logo" || MODE === "welcome") { feedLogo(d); return; }
  // The sign-in input owns the screen until a code is submitted. Logged in, the
  // link leaves the screen — which is what the host has to notice.
  if (MODE === "login" && !loggedIn) {
    for (const ch of d) {
      if (ch === "\r" || ch === "\n") { loggedIn = true; loginVerdict = `LOGGED IN: ${buf}`; out(`\r\n${loginVerdict}\r\n`); buf = ""; }
      else if (ch === "\x1b") { /* Esc: the test never cancels */ }
      else buf += ch;
    }
    paintLogin();
    return;
  }
  for (const ch of d) {
    // deaf: Return is eaten by the TUI. The text stays in the composer and no
    // turn ever starts — only the repaint churn below keeps bytes flowing.
    if ((ch === "\r" || ch === "\n") && MODE === "menu") {
      // A view is up: Return dismisses it — the keystroke this test exists to
      // catch, so make it loud in the log.
      if (view) { view = false; verdict("\r\nDISMISSED\r\n"); }
      else if (LOCAL.has(buf.trim())) { verdict(`\r\nOPENED: ${buf}\r\n`); view = true; buf = ""; }
      // Files the note, clears the box, opens nothing, starts no turn.
      else if (NOTE.has(buf.trim().split(/\s+/)[0] ?? "")) { verdict(`\r\nNOTED: ${buf}\r\n`); buf = ""; }
      else if (buf) { const p = buf; verdict(`\r\nSUBMITTED: ${buf}\r\n`); buf = ""; hookTurn(p); }
    }
    else if (ch === "\x1b" && MODE === "menu") {
      if (view) { view = false; verdict("\r\nDISMISSED\r\n"); } else buf = "";
    }
    else if ((ch === "\r" || ch === "\n") && DEAF) { /* swallowed */ }
    // paste: a bare \n inside a chunk is a newline IN the text (that is what
    // makes the composer multi-line); only \r — the Return keystroke, written
    // on its own — submits.
    else if (ch === "\n" && (MODE === "paste" || MODE === "answer")) buf += "\n";
    else if ((ch === "\r" || ch === "\n") && MODE === "goal") {
      // **An empty composer submits NOTHING**, exactly like the real CLI. It
      // matters here more than anywhere: the submit ladder presses Return more
      // than once, and a stub that answered the second press with a turn handed
      // the delivery a proof the real binary would never give it — which is how
      // this test passed while the live host filed the same `/compact` as a
      // swallowed Return.
      if (!buf.trim()) continue;
      const local = buf.trim() === "/compact";
      const p = buf;
      verdict(`\r\nSUBMITTED: ${buf}\r\n`); buf = "";
      local ? compactRun() : goalTurn(p);
    }
    // The ordinary submit, and it fires the turn hooks like the real CLI: an
    // accepted prompt IS a turn, whether or not this stub's screen shows it.
    // (`STUB_HOOKS` still gates every post, so a run without it is unchanged.)
    else if (ch === "\r" || ch === "\n") { const p = buf; verdict(`\r\nSUBMITTED: ${buf}\r\n`); buf = ""; MODE === "answer" ? answerTurn(p) : hookTurn(p); }
    else if (ch === "\x15") buf = buf.slice(0, Math.max(0, buf.length - 40)); // ctrl-U kills ONE wrapped line
    else if (ch === "\x1b") { /* Esc: no overlay to close */ }
    else buf += ch;
  }
  // A verdict line is followed by a repaint that clears the screen. Under tmux
  // the host sees a redraw of the FINAL screen, so a line printed and cleared in
  // the same tick never reaches it: let the verdict frame be drawn first.
  if (saidVerdict) { saidVerdict = false; setTimeout(paint, VERDICT_HOLD_MS); } else paint();
});

if (MODE !== "logo" && MODE !== "welcome") out("stub tui ready\r\n");
paint();
