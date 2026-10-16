/**
 * Three state writes that used to bypass jsonstore.ts / the O_EXCL rule:
 *  - the limit-events.jsonl rotation (truncating write) -> keepLastLines, atomic;
 *  - tmux.ts loadLive (bare JSON.parse) -> readJsonGuarded, keeps a .corrupt-* copy;
 *  - the inbox upload followed a dangling symlink at the chosen name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const scratch = mkdtempSync(join(tmpdir(), "wp-durable-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;

const { keepLastLines } = await import("../dist/jsonstore.js");
const { loadLive, livePath } = await import("../dist/sessions/tmux.js");
const { saveInboxFile } = await import("../dist/files.js");

test("rotation keeps the last 500 lines and leaves no partial file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-rot-"));
  const p = join(dir, "limit-events.jsonl");
  writeFileSync(p, Array.from({ length: 800 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
  keepLastLines(p, 500);
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 500);
  assert.equal(JSON.parse(lines[0]).i, 300);
  assert.equal(JSON.parse(lines[499]).i, 799);
  assert.deepEqual(readdirSync(dir), ["limit-events.jsonl"]); // no tmp left behind
});

test("loadLive on a corrupt record returns null and keeps a .corrupt-* copy", () => {
  const root = mkdtempSync(join(tmpdir(), "wp-live-"));
  const core = { root, sessions: new Map() };
  const p = livePath(core, "abc");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "{ not json");
  assert.equal(loadLive(core, "abc"), null);
  assert.equal(existsSync(p), false);
  const kept = readdirSync(join(p, "..")).filter((f) => f.startsWith("abc.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(loadLive(core, "missing"), null);
});

test("inbox save does not write through a dangling symlink", () => {
  const wt = mkdtempSync(join(tmpdir(), "wp-inbox-"));
  const outside = join(mkdtempSync(join(tmpdir(), "wp-outside-")), "target.txt");
  const first = saveInboxFile(wt, "seed.txt", Buffer.from("x"));
  assert.ok(!("error" in first));
  const dir = join(wt, first.relPath, "..");
  symlinkSync(outside, join(dir, "photo.png"));
  const r = saveInboxFile(wt, "photo.png", Buffer.from("hello"));
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.notEqual(r.name, "photo.png");
  assert.equal(existsSync(outside), false);
  assert.equal(lstatSync(join(dir, "photo.png")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(dir, r.name), "utf8"), "hello");
});
