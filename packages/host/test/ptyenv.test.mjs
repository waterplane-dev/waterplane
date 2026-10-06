/**
 * The PTY environment's locale floor (`ptyenv.ts`): with NO locale set, a
 * UTF-8 one is supplied so tmux forwards UTF-8 — `en_US.UTF-8` on macOS,
 * `C.UTF-8` on Linux, where `en_US` is often not generated (minimal
 * Debian/Ubuntu, WSL, containers) and a missing locale falls back to ASCII.
 * A locale that IS set is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLocale, ptyEnv } from "../dist/ptyenv.js";

const KEYS = ["LANG", "LC_ALL", "LC_CTYPE"];
function withLocale(vals, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vals);
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("defaultLocale: macOS keeps en_US.UTF-8, Linux (and anything else) gets C.UTF-8", () => {
  assert.equal(defaultLocale("darwin"), "en_US.UTF-8");
  assert.equal(defaultLocale("linux"), "C.UTF-8");
});

test("ptyEnv supplies the platform's UTF-8 LANG only when no locale is set", () => {
  withLocale({}, () => {
    assert.equal(ptyEnv("darwin").LANG, "en_US.UTF-8");
    assert.equal(ptyEnv("linux").LANG, "C.UTF-8");
  });
  withLocale({ LANG: "de_DE.UTF-8" }, () => assert.equal(ptyEnv("linux").LANG, "de_DE.UTF-8", "a set LANG is kept"));
  withLocale({ LC_CTYPE: "UTF-8" }, () => assert.equal(ptyEnv("linux").LANG, undefined, "LC_CTYPE counts as a locale"));
  withLocale({ LC_ALL: "C" }, () => assert.equal(ptyEnv("darwin").LANG, undefined, "even a non-UTF-8 one is the person's to fix"));
});
