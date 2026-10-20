/**
 * The macOS preflight rows (`doctormac.ts`), from injected facts — never the real
 * machine. Pinned: Apple's git stand-in without the Command Line Tools is a fail,
 * and a non-admin account hears exactly what to ask for, only when something is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAC_GIT_STUB, isMacAdmin, macAdminCheck, macAdminNeeds, macGitCheck } from "../dist/doctormac.js";

const facts = (o = {}) => ({
  gitPath: "/opt/homebrew/bin/git", clt: true, user: "kid", groups: "staff everyone",
  tmux: true, brewRepo: "/opt/homebrew", brewWritable: true, brewOwner: null, tailscale: true, ...o,
});

test("git: the stand-in without the Command Line Tools fails and names xcode-select", () => {
  const c = macGitCheck(facts({ gitPath: MAC_GIT_STUB, clt: false }));
  assert.equal(c.status, "fail");
  assert.match(c.detail, /stand-in/);
  assert.match(c.fix, /xcode-select --install/);
  assert.equal(macGitCheck(facts({ gitPath: MAC_GIT_STUB, clt: true })).status, "ok");
  assert.equal(macGitCheck(facts({ clt: false })).status, "ok", "a git that is not the stand-in runs on its own");
  assert.equal(macGitCheck(facts({ gitPath: null })).status, "fail");
});

test("admin: the admin group, and no row on a guess when id could not be run", () => {
  assert.equal(isMacAdmin("staff everyone admin"), true);
  assert.equal(isMacAdmin("staff everyone"), false);
  assert.equal(isMacAdmin("staff administrators"), false, "a whole group name, not a substring");
  assert.equal(isMacAdmin(null), true);
});

test("mac-admin: names only what is missing, in one row", () => {
  assert.equal(macAdminCheck(facts()), null, "nothing missing ⇒ no row");
  assert.equal(macAdminCheck(facts({ groups: "staff admin", tmux: false, brewRepo: null, tailscale: false })), null, "an admin installs these itself");
  const all = macAdminCheck(facts({ tmux: false, brewRepo: null, gitPath: MAC_GIT_STUB, clt: false, tailscale: false }));
  assert.equal(all.status, "warn");
  assert.match(all.detail, /this account \(kid\) is not an administrator/);
  assert.equal(all.fix, "Ask whoever administers this Mac for: tmux, the Xcode Command Line Tools, Tailscale.");
});

test("mac-admin: a usable Homebrew means tmux is not asked for; one owned by another account is named", () => {
  assert.deepEqual(macAdminNeeds(facts({ tmux: false })), [], "brew it yourself");
  const c = macAdminCheck(facts({ tmux: false, brewWritable: false, brewOwner: "mum" }));
  assert.deepEqual(macAdminNeeds(facts({ tmux: false, brewWritable: false })), ["tmux"]);
  assert.match(c.fix, /Homebrew here belongs to mum, so brew install tmux fails for this one/);
});
