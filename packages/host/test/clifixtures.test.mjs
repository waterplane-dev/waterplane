/**
 * The fixture shelf (`src/clifixtures.ts`): one capture per signal per CLI
 * version, its source asked only when one is wanted, never for a signal whose
 * evidence may not be kept, and never under a path a version string built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureShelf, maskZones } from "../dist/clifixtures.js";

const settle = () => new Promise((r) => setTimeout(r, 20));

test("one capture per signal per version; the source is asked once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shelf = new FixtureShelf(dir);
  let asked = 0;
  const src = () => { asked++; return "Pick?\n❯ 1. Yes\nEnter to select · Esc to cancel"; };
  shelf.offer("prompt.box", "2.1.303", src);
  shelf.offer("prompt.box", "2.1.303", src);
  await settle();
  shelf.offer("prompt.box", "2.1.303", src);
  await settle();
  assert.equal(asked, 1);
  assert.equal(readFileSync(join(dir, "2.1.303", "prompt.box.txt"), "utf8"), "Xxxx?\n❯ 1. Xxx\nEnter to select · Esc to cancel\n");
  shelf.offer("prompt.box", "2.1.304", src);
  shelf.offer("hook.pipe", "2.1.303", () => JSON.stringify({ hook_event_name: "Stop", session_id: "secret" }));
  await settle();
  assert.equal(asked, 2, "a new version is a new capture");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "2.1.303", "hook.pipe.json"), "utf8")), { hook_event_name: "Stop", session_id: "<string>" });
});

test("nothing for an unusable version, an unknown signal, or a source that fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shelf = new FixtureShelf(dir);
  let asked = 0;
  for (const v of [null, "", "latest", "../2.1.303", "2.1"]) shelf.offer("prompt.box", v, () => { asked++; return "x"; });
  shelf.offer("not.asignal", "2.1.303", () => { asked++; return "x"; });
  assert.equal(asked, 0);
  shelf.offer("prompt.box", "2.1.303", () => { throw new Error("no screen"); });
  shelf.offer("context.meter", "2.1.303", async () => null);
  await settle();
  assert.equal(existsSync(join(dir, "2.1.303")) ? readdirSync(join(dir, "2.1.303")).length : 0, 0);
  let later = 0;
  shelf.offer("prompt.box", "2.1.303", () => { later++; return "Pick?"; });
  await settle();
  assert.equal(later, 1, "a failed capture leaves the slot open for the next good");
});

test("wants: true until a capture is kept or being taken, for that version only", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shelf = new FixtureShelf(dir);
  assert.equal(shelf.wants("deliver.echo", "2.1.304"), true);
  assert.equal(shelf.wants("deliver.echo", null), false);
  shelf.offer("deliver.echo", "2.1.304", () => JSON.stringify({ prompt: "hi", grid: "❯ hi" }));
  assert.equal(shelf.wants("deliver.echo", "2.1.304"), false, "pending");
  await settle();
  assert.equal(shelf.wants("deliver.echo", "2.1.304"), false, "kept");
  assert.ok(existsSync(join(dir, "2.1.304", "deliver.echo.txt")));
  assert.equal(shelf.wants("deliver.echo", "2.1.305"), true);
});

test("an IANA zone name never reaches a kept capture, chrome rows included", async (t) => {
  assert.equal(maskZones("resets 7pm (Europe/Berlin) or (America/Argentina/Buenos_Aires)"), "resets 7pm (UTC) or (UTC)");
  assert.equal(maskZones("a/b and Europe only"), "a/b and Europe only");
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shelf = new FixtureShelf(dir);
  shelf.offer("slash.local", "2.1.303", () => "Claude Code v2.1.303 (Europe/Berlin)\n/usage");
  await settle();
  const kept = readFileSync(join(dir, "2.1.303", "slash.local.txt"), "utf8");
  assert.match(kept, /Claude Code v2\.1\.303 \(UTC\)/);
  assert.doesNotMatch(kept, /Berlin/);
});
