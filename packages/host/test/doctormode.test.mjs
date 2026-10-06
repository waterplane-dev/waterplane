/**
 * The doctor's remedies are worded for the KIND of install reading them: a
 * release tarball has no `scripts/` and no workspace, so `npm rebuild node-pty
 * && node scripts/fix-node-pty.mjs` and "run `npm run doctor`" were commands
 * that could not run there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "@waterplane/shared";
import { doctorCommand, printBootSummary, ptyFix } from "../dist/doctor.js";

test("node-pty's fix: the installer for a tarball, npm -g for npm, the checkout's scripts otherwise", () => {
  assert.match(ptyFix("tarball"), /re-run the installer/);
  assert.doesNotMatch(ptyFix("tarball"), /npm|scripts\//);
  assert.match(ptyFix("npm"), new RegExp(`npm install -g ${BRAND.slug}`));
  assert.doesNotMatch(ptyFix("npm"), /scripts\//);
  for (const k of ["checkout", "unknown"]) assert.match(ptyFix(k), /npm rebuild --ignore-scripts=false node-pty && node scripts\/fix-node-pty\.mjs/);
});

test("the full-report hint names the command this install has", () => {
  assert.equal(doctorCommand("tarball"), `${BRAND.slug} doctor`);
  assert.equal(doctorCommand("npm"), `${BRAND.slug} doctor`);
  assert.equal(doctorCommand("checkout"), "npm run doctor");
  const lines = [];
  const warn = console.warn;
  console.warn = (s) => lines.push(String(s));
  try { printBootSummary([{ id: "x", status: "warn", detail: "d" }], "tarball"); } finally { console.warn = warn; }
  assert.match(lines.at(-1), new RegExp(`run \`${BRAND.slug} doctor\` for the full preflight report`));
  assert.ok(!lines.some((l) => /npm run doctor/.test(l)));
});
