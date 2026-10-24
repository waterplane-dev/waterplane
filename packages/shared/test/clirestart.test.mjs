/**
 * A session on an older claude than the installed one: offered a restart only
 * when both versions are known and the install is newer, refused in words when
 * the conversation id is unknown, and asked first when a turn or agent would die.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cliRestartSendAsk, cmpCliVersion, parseCliVersion, cliRestartDue, cliRestartView } from "../dist/clirestart.js";

test("compares dotted versions numerically", () => {
  assert.equal(cmpCliVersion("2.1.283", "2.1.281"), 1);
  assert.equal(cmpCliVersion("2.1.9", "2.1.10"), -1);
  assert.equal(cmpCliVersion("2.1.0", "2.1"), 0);
  assert.equal(cmpCliVersion(undefined, "2.1.0"), 0);
});

test("parses the CLI's --version line and bare fields", () => {
  assert.equal(parseCliVersion("2.1.283 (Claude Code)\n"), "2.1.283");
  assert.equal(parseCliVersion("2.1.283"), "2.1.283");
  assert.equal(parseCliVersion("nonsense"), undefined);
  assert.equal(parseCliVersion(null), undefined);
});

test("due only when both are known and the install is newer", () => {
  assert.deepEqual(cliRestartDue("2.1.281", "2.1.283"), { running: "2.1.281", installed: "2.1.283" });
  assert.equal(cliRestartDue("2.1.283", "2.1.283"), null);
  assert.equal(cliRestartDue("2.1.284", "2.1.283"), null, "a session newer than the install is not stale");
  assert.equal(cliRestartDue(undefined, "2.1.283"), null);
  assert.equal(cliRestartDue("2.1.281", undefined), null);
});

test("the view names what a restart would stop, and refuses without an id", () => {
  const due = { running: "2.1.281", installed: "2.1.283" };
  assert.match(cliRestartView(due, {}).cant ?? "", /conversation id/);
  assert.equal(cliRestartView(due, { resumeId: "x" }).loses, undefined);
  assert.equal(cliRestartView(due, { resumeId: "x", agents: 1 }).loses, "1 background agent");
  assert.equal(cliRestartView(due, { resumeId: "x", turnActive: true, agents: 2 }).loses,
    "the turn that is running and 2 background agents");
  assert.match(cliRestartView(due, { resumeId: "x" }).text, /2\.1\.281.*2\.1\.283/);
});

test("the send ask names both versions on both answers", () => {
  const a = cliRestartSendAsk({ running: "2.1.308", installed: "2.1.310" });
  assert.equal(a.title, "Restart on Claude 2.1.310 first?");
  assert.equal(a.confirmLabel, "Restart, then send");
  assert.equal(a.cancelLabel, "Send on 2.1.308");
  assert.match(a.lines.join(" "), /same conversation reopens on 2\.1\.310/);
});
