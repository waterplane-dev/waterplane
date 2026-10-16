/**
 * **The send sheet's *model* row reaches every path a new session is opened
 * by** — pinned on the source, `createOp.test.mjs`'s posture: these are wiring
 * facts inside a hook that closes over twenty refs, and the failure each one
 * guards is silent (a model somebody picked, dropped on the way to the desktop,
 * and the session starts on the defaults looking perfectly normal).
 *
 *     node --test packages/web/src/core/send/sendlaunch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const useSend = read("./useSend.tsx");

test("a sheet send is never routed through the launch ask: its launch goes over as the override", () => {
  assert.match(read("../../send/useSendSheet.ts"), /onSend\(\{ prompts: final, target, when, sequential, launchChosen: true \}\)/,
    "the sheet's button no longer says its *model* row is the launch question");
  // `startSessionWithPrompt`'s 5th argument is the override — `shouldAskLaunch`
  // skips the ask for one, and the hosted gate still runs on it.
  assert.match(useSend, /const chosen = i\.target\.launch \?\? \(i\.launchChosen \? launch : undefined\);/);
  assert.match(useSend, /startSessionWithPrompt\(cwd, [^\n]*, steps, i\.sequential, chosen, i\.target\.resume,/);
});

test("every LATER new session carries the picked launch, gated by wireLaunch", () => {
  // when it's free (a backlog item), a one-off/recurring clock (the schedule's
  // backlog action), a chain (`intent.post`), one-at-a-time sweeps, a re-decided row.
  const wired = useSend.match(/wireLaunch\(i\.target\.launch\)/g) ?? [];
  assert.ok(wired.length >= 6, `expected every deferred arm to carry the launch through wireLaunch, found ${wired.length}`);
  assert.match(useSend, /\(i\.target\.kind === "repos" \|\| i\.target\.kind === "repo"\) && i\.target\.launch \? \{ launch: wireLaunch/,
    "a chain into a new session drops the model");
  assert.match(useSend, /launch: i\.target\.kind === "repo" \? \(i\.target\.launch \? wireLaunch\(i\.target\.launch\) : null\) : undefined,/,
    "re-deciding a waiting row must send its model absolutely — null is the defaults");
});

test("a row opened for an edit comes back with the launch it has", () => {
  assert.match(useSend, /\.\.\.\(i\.budget \? \{ budget: i\.budget \} : \{\}\), \.\.\.\(i\.launch \? \{ launch: i\.launch \} : \{\}\) \}/,
    "seedFromIntent drops the row's model, so the next save clears it");
  assert.match(useSend, /a\.kind === "backlog" && a\.launch \? \{ launch: a\.launch \}/, "seedFromSchedule drops the rule's model");
});

test("the picker is the launch ask's own, never a fork of it", () => {
  const row = read("../../send/LaunchRow.tsx");
  assert.match(row, /import \{ LaunchPicker, launchOf \} from "\.\.\/LaunchPicker"/);
  assert.doesNotMatch(row, /disabled/, "a control that cannot act says why in text");
});
