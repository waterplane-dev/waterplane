// What a prompt's ATTACHMENTS are worth by the time it is sent.
//
// Worth pinning because every branch here is a different sentence shown to
// someone holding a phone, and two of them are dangerous to get wrong in
// opposite directions:
//
//   - calling a file MISSING when the host simply couldn't be asked tells
//     someone their photo is gone while it is sitting in the repo, and the
//     obvious reaction (re-take it, re-attach it) uploads a second copy;
//   - calling a prompt SENDABLE when the file behind it was canceled points the
//     agent at a path nothing will ever write, which it discovers a whole turn
//     later, having burnt a usage limit on nothing.
//
// Neither shows up in a stack trace.
import { attachState, attachStatuses, attachmentsReady, attachBlockers } from "../packages/shared/dist/attach.js";

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

const P = (n) => `.claude/inbox/${n}.jpg`;
const none = { onHost: [], sending: [], kept: [], dead: {} };

// ── The decision table ──────────────────────────────────────────────
check(attachState(P("a"), { ...none, onHost: [P("a")] }) === "host",
  "a file the repo already has is on the host");
check(attachState(P("a"), { ...none, sending: [P("a")] }) === "sending",
  "a file still in the send queue is on its way");
check(attachState(P("a"), { ...none, kept: [P("a")] }) === "kept",
  "a file whose queue entry died but whose bytes are still here is re-attachable");
check(attachState(P("a"), { ...none, dead: { [P("a")]: "the upload was canceled" } }) === "dead",
  "a canceled upload with no bytes left is dead");
check(attachState(P("a"), none) === "missing",
  "a path nothing knows about, with the host answering, is missing");

// The one distinction the whole module exists for.
check(attachState(P("a"), { ...none, onHost: null }) === "unknown",
  "the same path with the host UNASKED is unknown, never missing");
check(attachState(P("a"), { onHost: null, sending: [P("a")], kept: [], dead: {} }) === "sending",
  "…but an offline device still knows what its own queue is holding");

// A dead mark is a local record; the host having the file is a fact. A file can
// arrive by a route this device never saw — an earlier attempt that landed after
// the ack window, the agent writing it, a second phone — and the local record
// would otherwise veto a prompt that is perfectly sendable.
check(attachState(P("a"), { ...none, onHost: [P("a")], dead: { [P("a")]: "canceled" } }) === "host",
  "the host having the file outranks a local record saying the upload died");
check(attachState(P("a"), { ...none, sending: [P("a")], kept: [P("a")] }) === "sending",
  "a live queue entry outranks retained bytes for the same path");

check(attachStatuses([P("a")], { ...none, dead: { [P("a")]: "the host refused the file" } })[0].why
  === "the host refused the file",
  "a dead file carries the reason it died, so the row can say it");

// ── What may be sent ────────────────────────────────────────────────
const ready = attachStatuses([P("a"), P("b")], { ...none, onHost: [P("a")], sending: [P("b")] });
check(attachmentsReady(ready), "already-there plus on-its-way is sendable as written");
check(attachBlockers(ready).length === 0, "…and has nothing to decide first");

check(attachmentsReady(attachStatuses([], none)),
  "a prompt naming no files at all is sendable");

// `kept` is one tap from sendable and is deliberately not sendable NOW: nothing
// is uploading those bytes, so a send would race a re-attach nobody asked for.
check(!attachmentsReady(attachStatuses([P("a")], { ...none, kept: [P("a")] })),
  "bytes parked on the phone with no upload behind them are not sendable yet");
check(!attachmentsReady(attachStatuses([P("a")], { ...none, onHost: null })),
  "an unverifiable file is not sendable — the honest answer is “ask me again”");

// Blockers are ordered by what can be DONE about them: the fixable one first.
// Hand-built rather than derived, because `missing` and `unknown` are answers to
// the same question asked with the link up and with it down — one set of facts
// can never produce both.
const mixed = [
  { relPath: P("m"), state: "missing" },
  { relPath: P("u"), state: "unknown" },
  { relPath: P("k"), state: "kept" },
  { relPath: P("d"), state: "dead", why: "canceled" },
];
check(attachBlockers(mixed).map((s) => s.state).join(",") === "kept,dead,missing,unknown",
  "blockers are listed fixable-first, so the one button that helps is at the top");
check(attachBlockers(attachStatuses([P("a")], { ...none, onHost: [P("a")] })).length === 0,
  "a file that is present is never a blocker");

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
