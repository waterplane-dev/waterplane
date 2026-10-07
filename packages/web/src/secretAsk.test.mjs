// The secret-ask detector: the cursor line ENDS with a password prompt, or nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { secretAsk } from "./secretAsk.ts";

test("the asks a shell actually prints", () => {
  for (const line of [
    "Password:",
    "Password: ",
    "[sudo] password for johannes: ",
    "Enter passphrase for key '/Users/me/.ssh/id_ed25519': ",
    "Password for 'https://me@github.com': ",
    "Enter PIN for 'YubiKey':",
    "me@box's password:",
  ]) assert.ok(secretAsk(line), line);
});

test("a mention is not an ask", () => {
  for (const line of [
    "",
    "johannes@mac proj % ",
    "Password:  set in settings — see docs",
    "the password field is required",
    "Sorry, try again.",
    "spinning up: ",
    "% echo password",
  ]) assert.equal(secretAsk(line), null, line);
});

test("quotes the ask as printed", () => {
  assert.equal(secretAsk("[sudo] password for me:  "), "[sudo] password for me:");
});
