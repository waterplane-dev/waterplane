// **A bulk verb never skips the queue.**
//
// `intent.run` and `backlog.fire` both reach the host's `runNow`, which skips
// the WHOLE ladder — the budget, one at a time per repo, wait
// until free. That is right for one row a person tapped, and it is how the
// re-time sheet's *run all 4 now, past the budget* once started four agents in
// one worktree at the same second: it sent `intent.run` in a loop. The bulk
// release is `intent.waive` now, which lifts the budget and nothing below it.
//
// This reads the web tree's SOURCE, because the thing it guards is a call
// site — a new loop over `intent.run` is one line in a 16k-line file, and
// review does not see it. The whole tree (not App.tsx alone), so a verb that
// moves into a feature or a core module is still counted, and a copy is two.
// A new single-row caller is a decision: raise the count here in the same
// change and say which tap it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = readdirSync(here, { recursive: true })
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f))
  .sort()
  .map((f) => readFileSync(new URL(f, new URL(".", import.meta.url)), "utf8"))
  .join("\n");
const count = (needle) => src.split(needle).length - 1;

test("intent.run is sent from exactly one place — Activity's single-row run it now", () => {
  assert.equal(count('t: "intent.run"'), 1);
  const at = src.indexOf('t: "intent.run"');
  const around = src.slice(Math.max(0, at - 3000), at);
  assert.match(around, /id === "runNow" \|\| id === "sendNow"/, "the one caller is the Activity row's own verb");
});

test("backlog.fire is sent from exactly two single-row taps (the Backlog row, the compose strip)", () => {
  assert.equal(count('t: "backlog.fire"'), 2);
  // `onFire: (id) =>` since the backlog sheet's props grouped its row verbs
  // (`verbs={{ … }}`, docs/notes/backlog-architecture.md); the JSX spelling is
  // still accepted, so the pin holds wherever the binding is written.
  assert.match(src, /onFire(?:=\{|: )\(id\) => \{ if \(liveSend\(\{ t: "backlog\.fire", id \}/);
});

test("the re-time sheet's bulk release waives the budget and never fires", () => {
  assert.match(src, /onPastBudget=\{\(h\) => \{\s*if \(liveSendAll\(h\.map\(\(id\) => \(\{ t: "intent\.waive", id, rung: "budget", on: true \}\)\)/);
  assert.doesNotMatch(src, /onRunPastBudget/, "the old verb is gone");
});

// The two other messages that reach `runNow` from the phone. Each is one tap on
// one row today — the schedule sheet's *now* (durable, `queueOp`) and the queue
// sheet's *open it now* on a parked launch. A second call site is a decision,
// made here in the same change.
test("schedule.run and launch.run are each sent from exactly one single-row tap", () => {
  assert.equal(count('t: "schedule.run"'), 1);
  assert.match(src, /queueOp\(\{ t: "schedule\.run", id \}/);
  assert.equal(count('t: "launch.run"'), 1);
  assert.match(src, /onRunLaunch=\{\(id\) => liveSend\(\{ t: "launch\.run", id \}/);
});
