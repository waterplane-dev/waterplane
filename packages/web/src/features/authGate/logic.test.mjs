/**
 * The shell's gate. A LAN refusal once drew the password form, which cannot work in the shell, on a
 * card that covers Settings, so a LAN-only phone had no way back to pairing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { askedName, goneLead, shellCase } from "./logic.ts";

const card = readFileSync(new URL("./AuthGate.tsx", import.meta.url), "utf8");

test("in the shell every refusal leaves the password form; a sealed one offers the unlock first", () => {
  assert.equal(shellCase(true, false), "gone");
  assert.equal(shellCase(true, true), "locked");
});

test("a browser keeps the form, sealed or not", () => {
  assert.equal(shellCase(false, false), null);
  assert.equal(shellCase(false, true), null);
});

test("the one caller asks only of a gate with a password set, and the gone card offers pairing", () => {
  assert.equal(card.match(/shellCase\(/g).length, 1);
  assert.match(card, /authGate\.enabled \? shellCase\(isNativeShell\(\), sealedMode\(\) && !heldTokens\(\)\) : null/);
  const shell = card.slice(card.indexOf("if (shell) {"), card.indexOf('type="password"'));
  assert.match(shell, /goneLead\(authGate\.kind\)/);
  assert.match(shell, /onClick=\{requestHostSetup\}/);
  assert.ok(!/\{shell === "[a-z]+" && <Button[^\n]*requestHostSetup/.test(shell), "pair with code is on both cards");
});

test("the LAN says there is no password here, and the tailnet's words stay", () => {
  assert.match(goneLead("lan"), /local network/);
  assert.match(goneLead("lan"), /password cannot/);
  assert.equal(goneLead("tailscale"), "This phone's sign-in for this desktop is gone.");
  assert.equal(goneLead("public"), "This phone's sign-in for this desktop is gone.");
});

test("a page opened under a name says the name is why, an address or another kind never does (R-security-034)", () => {
  assert.equal(askedName("unknown", "mac.local"), "mac.local");
  assert.match(card, /does not trust this name, because another device on the network could answer for it: <code>\{name\}<\/code>/);
  assert.match(card, /ends after \{NAME_SIGNIN_HOURS\} hours/, "how long a sign-in there lasts (R-security-035)");
  for (const page of ["localhost", "127.0.0.1", "100.64.0.1", "[::1]", ""]) assert.equal(askedName("unknown", page), null, page);
  for (const kind of ["lan", "tailscale", "public", "loopback"]) assert.equal(askedName(kind, "mac.local"), null, kind);
  assert.equal(card.match(/\{name\n/g).length, 2, "both the form and the no-password card say it");
});
