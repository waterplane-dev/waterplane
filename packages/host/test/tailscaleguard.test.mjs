/**
 * The Tailscale watchdog: its label, and the one rule its script holds — act
 * only when Tailscale is stopped AND its app is gone, so a person's own "off"
 * (app still running) is never undone.
 *
 *     node --test packages/host/test/tailscaleguard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tailscaleWatchdogRow, watchdogLabel, watchdogPlist, watchdogScript } from "../dist/tailscaleguard.js";

test("the label is the host's with .host swapped for the job", () => {
  assert.equal(watchdogLabel("dev.waterplane.host"), "dev.waterplane.tailscale-watchdog");
});

test("the script exits unless stopped, and exits while the app runs, before it touches anything", () => {
  const s = watchdogScript("/x/Tailscale");
  const stopped = s.indexOf(`*"Tailscale is stopped"*) ;; *) exit 0`);
  const appUp = s.indexOf("pgrep -xq Tailscale && exit 0");
  const reopen = s.indexOf("open -g -a Tailscale");
  assert.ok(stopped > 0 && appUp > stopped && reopen > appUp, "stopped check, then app check, then the reopen");
  assert.ok(s.indexOf('"$TS" up') > reopen, "`up` only after the reopen did not bring it back");
});

test("the plist runs the script every minute and at load", () => {
  const p = watchdogPlist("a.b.tailscale-watchdog", "/c/w.sh");
  assert.match(p, /<string>\/c\/w\.sh<\/string>/);
  assert.match(p, /<key>StartInterval<\/key><integer>60<\/integer>/);
});

test("no row off macOS", () => {
  assert.equal(tailscaleWatchdogRow("linux"), null);
});
