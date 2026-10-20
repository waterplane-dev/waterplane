/**
 * Which package manager owns the `claude` on this desktop, and what the update
 * button may therefore run.
 *
 * This exists because the module was Homebrew-only, on a desktop where the
 * Homebrew cask sat eight patch releases behind the npm release the CLI's own
 * nag was asking for. The button ran `brew upgrade`, brew said "the latest
 * version is already installed", the nag stayed up, and nothing on screen said
 * why. The route is read off the RESOLVED binary path rather than configured,
 * so the rules worth pinning are: the near end of the symlink tells you nothing
 * (`/opt/homebrew/bin/claude` is the same path under brew and under npm), an
 * unrecognised path is `unknown` and gets NO command, and version comparison is
 * numeric — `2.1.9` is older than `2.1.10`, which a string compare gets wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlan, cmpVersion, detectUpdateBanner, nativeChannel, routeFromPath } from "../dist/update.js";

test("route is read off the far end of the symlink", () => {
  assert.equal(routeFromPath("/opt/homebrew/Caskroom/claude-code/2.1.273/claude"), "brew");
  assert.equal(routeFromPath("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "npm");
  assert.equal(routeFromPath("/Users/x/.nvm/versions/node/v22.0.0/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "npm");
  assert.equal(routeFromPath("/Users/x/.claude/local/claude"), "native");
  assert.equal(routeFromPath("/Users/x/.local/bin/claude"), "native");
});

test("an unrecognised path is unknown, and unknown gets no command", () => {
  assert.equal(routeFromPath("/usr/local/bin/claude"), "unknown");
  assert.equal(routeFromPath(undefined), "unknown");
  assert.equal(applyPlan("unknown", "claude"), null);
});

test("each known route names its own upgrade", () => {
  const brew = applyPlan("brew", "claude");
  assert.equal(brew.label, "brew upgrade");
  // `brew update` first, or the cask index it compares against stays stale.
  assert.deepEqual(brew.steps.map((s) => [s.cmd, ...s.args].join(" ")), [
    "brew update",
    "brew upgrade --cask claude-code",
  ]);
  const npm = applyPlan("npm", "claude");
  assert.deepEqual(npm.steps.map((s) => [s.cmd, ...s.args].join(" ")), [
    "npm install -g @anthropic-ai/claude-code@latest",
  ]);
  // The native installer updates itself, through whichever binary we spawn.
  assert.deepEqual(applyPlan("native", "/Users/x/.local/bin/claude").steps[0].args, ["update"]);
});

test("versions compare as numbers, not as strings", () => {
  assert.equal(cmpVersion("2.1.281", "2.1.273"), 1);
  assert.equal(cmpVersion("2.1.10", "2.1.9"), 1); // a string compare says the opposite
  assert.equal(cmpVersion("2.1.273", "2.1.273"), 0);
  assert.equal(cmpVersion("2.1.0", "2.2.0"), -1);
  // Unknown on either side is NOT "up to date" — it is no comparison at all.
  assert.equal(cmpVersion(undefined, "2.1.0"), 0);
  assert.equal(cmpVersion("2.1.0", undefined), 0);
});

test("the CLI's own nag is still read, whichever upgrade it names", () => {
  assert.equal(detectUpdateBanner("Update available! Run: brew upgrade claude-code").available, true);
  assert.equal(
    detectUpdateBanner("✻ Update available! Run: npm i -g @anthropic-ai/claude-code v2.1.281").latest,
    "2.1.281",
  );
  // Prose that merely says the words is not a nag.
  assert.equal(detectUpdateBanner("there is an update available for the docs").available, false);
});

test("a native install is checked against the npm dist-tag of its own update channel", () => {
  // Asking `latest` for a stable-channel install would raise a nag `claude update` never clears.
  assert.equal(nativeChannel('{"autoUpdatesChannel":"stable"}'), "stable");
  assert.equal(nativeChannel('{"autoUpdatesChannel":"latest"}'), "latest");
  assert.equal(nativeChannel("{}"), "latest");
  assert.equal(nativeChannel(undefined), "latest");
  assert.equal(nativeChannel("not json"), "latest");
  assert.equal(nativeChannel('{"autoUpdatesChannel":"nightly"}'), "latest");
});
