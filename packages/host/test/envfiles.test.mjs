/**
 * How the daemon's `.env` files combine (`envfiles.ts`, called once by `env.ts`).
 *
 * Until 2026-09-28 the files went through `process.loadEnvFile`, which never
 * overwrites, so the FIRST file to set a key won — and the per-user config file,
 * the one set-secret writes and hot-reloads, was last in the list: a secret set
 * from the phone worked until the next restart, then a stale repo `.env` won.
 * The rule now is the dotenv-flow one: the process's own env beats every file,
 * a later file beats an earlier one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "../dist/envfiles.js";

const dir = mkdtempSync(join(tmpdir(), "waterplane-envfiles-"));
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

test("a later file overrides an earlier one", () => {
  const env = {};
  loadEnvFiles([file("legacy.env", "K=legacy\nA=1\n"), file("repo.env", "K=repo\n"), file("user.env", "K=user\nB=2\n")], env);
  assert.deepEqual(env, { K: "user", A: "1", B: "2" });
});

test("the process's own environment beats every file", () => {
  const env = { K: "shell" };
  loadEnvFiles([file("a.env", "K=a\n"), file("b.env", "K=b\n")], env);
  assert.equal(env.K, "shell");
});

test("an empty value from the shell still counts as set", () => {
  const env = { K: "" };
  loadEnvFiles([file("c.env", "K=file\n")], env);
  assert.equal(env.K, "");
});

test("a missing file is skipped, the rest still load", () => {
  const env = {};
  loadEnvFiles([join(dir, "nope.env"), file("d.env", "K=d\n")], env);
  assert.deepEqual(env, { K: "d" });
});
