#!/usr/bin/env node
// E2E stand-in for `claude` for the resume-queue tests: a session that is AT the
// usage limit. It prints the blocked banner at boot, echoes what it is typed
// behind a prompt marker (so the host's post-echo limit scan has the same shape
// it does against the real TUI), and answers "continue" one of two ways:
//
//   default          — the banner again, i.e. the FAILED resume the host-wide
//                      hold-off exists for (e2e-limitqueue).
//   STUB_LIMIT_OK=1  — a working prompt and no banner, i.e. the resume that
//                      TOOK. The release modes only mean anything past a resume
//                      that worked, so the parallel test needs this half
//                      (e2e-limitparallel).
//
// STUB_LIMIT_WALL=1 — a line containing "wall" is a NEW prompt that hits the
//                      limit again: the banner, printed BELOW the earlier
//                      continue's echo (e2e-limitrepaint's second wall).
//
// Ignores all claude flags.
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

const out = (s) => process.stdout.write(s);
out(BANNER + "\r\n❯ ");

try { process.stdin.setRawMode(true); } catch { /* not a tty in some runners */ }
process.stdin.resume();

let line = "";
process.stdin.on("data", (buf) => {
  const chunk = buf.toString("utf8");
  out(chunk); // echo like a TUI does
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") {
      const said = line;
      line = "";
      out("\r\n");
      if (/continue/i.test(said)) {
        // Either the limit has not reset (banner again), or it has and the
        // session is simply working — a screen with no banner on it is the only
        // evidence the host's idle scan needs.
        setTimeout(() => out(process.env.STUB_LIMIT_OK === "1" ? "working…\r\n❯ " : BANNER + "\r\n❯ "), 120);
      } else if (process.env.STUB_LIMIT_WALL === "1" && /wall/i.test(said)) {
        setTimeout(() => out(BANNER + "\r\n❯ "), 120);
      } else {
        out("❯ ");
      }
    } else if (ch === "") {
      process.exit(0);
    } else {
      line += ch;
    }
  }
});
