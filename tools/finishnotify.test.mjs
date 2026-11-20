/**
 * Every long-running task tells the phone when it ends, and the notification carries a tap target
 * (`open`, `file`, `backlog` or `sessionId`) — owner, 2026-11-17: "a tap opens the screen showing
 * that task's result". Source-level, because the finishers are wired inside a running daemon: the
 * test reads each known call site, finds its `notify(...)` calls and refuses one with no target.
 * A new finisher is a new row in SITES.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const H = "packages/host/src/";
const TARGET = /\b(open|file|backlog|sessionId)\s*[:,}]|\.\.\.\(?\s*fail\b/;

/** Every `notify(…)` / `ctx.notify(…)` call in `src`, as its balanced argument text. */
function notifyCalls(src) {
  const out = [];
  const re = /\bnotify\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

const SITES = [
  // [finisher, file, which calls (title pattern) must carry a target]
  ["assessment", "assess/hassexec.ts", /Assessment of/],
  ["build", "server/scan.ts", /Build “/],
  ["pre-push check / push / pull", "gitnotify.ts", /Checks (passed|failed)|git-/],
  ["backlog item", "server/intentEvents.ts", /Backlog item (done|not delivered)/],
  ["peer job report", "peers/jobs.ts", /Report from/],
];

for (const [name, file, pick] of SITES) {
  test(`${name}: every finishing notification carries a tap target (${file})`, () => {
    const calls = notifyCalls(readFileSync(H + file, "utf8")).filter((c) => pick.test(c));
    assert.ok(calls.length > 0, `no notify call matching ${pick} in ${file} — the finisher moved; update SITES`);
    for (const c of calls) assert.match(c, TARGET, `a ${name} notification with no open/file/backlog/sessionId:\n${c.slice(0, 300)}`);
  });
}

test("the assess open reaches the phone: shared type, tap routing and nav entry all name it", () => {
  assert.match(readFileSync("packages/shared/src/wire/notify.ts", "utf8"), /to: "assess"; repoId: string/);
  assert.match(readFileSync("packages/web/src/features/notifications/logic.ts", "utf8"), /o\?\.to === "assess"/);
  assert.match(readFileSync("packages/web/src/features/notifications/actions.ts", "utf8"), /case "assess"/);
});
