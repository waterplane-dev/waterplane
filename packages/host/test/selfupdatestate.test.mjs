/**
 * `update` snapshots the host's stores before it switches versions, and
 * `--rollback` / `--restore-state` put them back (`cli/statesnap.ts`). Plus the
 * two sentences that used to assume a git checkout and now say what to do in a
 * release install too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

process.env[`${BRAND.envPrefix}ROOT`] ??= mkdtempSync(join(tmpdir(), "wp-snap-root-"));
const { isSnapshotFile, readSnapshot, restoreState, snapshotState } = await import("../dist/cli/statesnap.js");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "wp-snap-"));
  const state = join(base, "state");
  mkdirSync(join(state, "screenlogs"), { recursive: true });
  writeFileSync(join(state, "intents.json"), JSON.stringify({ schema: 3, intents: [{ id: "a" }] }));
  writeFileSync(join(state, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(join(state, "intents-archive.jsonl"), "{}\n");
  writeFileSync(join(state, "acks.json.corrupt-2026"), "evidence");
  writeFileSync(join(state, ".intents.json.123.tmp"), "half");
  writeFileSync(join(state, "screenlogs", "big.log"), "x".repeat(1000));
  symlinkSync(join(state, "intents.json"), join(state, "link.json"));
  return { base, state, snap: join(base, "data", "state-snapshots", "0.1.0") };
}

test("which files a snapshot carries: the stores, never evidence, tmp files or dot-files", () => {
  assert.equal(isSnapshotFile("intents.json"), true);
  assert.equal(isSnapshotFile("intents-archive.jsonl"), true);
  assert.equal(isSnapshotFile("intents.json.bak"), true);
  assert.equal(isSnapshotFile("auth.json.corrupt-2026-10-05T10-00-00-000Z"), false);
  assert.equal(isSnapshotFile(".intents.json.1.tmp"), false);
  assert.equal(isSnapshotFile("screen.log"), false);
});

test("snapshot copies the stores (keeping a secret's mode), then a rollback restores them and keeps the newer state", () => {
  const { state, snap } = fixture();
  const meta = snapshotState(state, snap, { from: "0.1.0", to: "0.2.0" });
  assert.deepEqual(meta.files, ["auth.json", "intents-archive.jsonl", "intents.json"]);
  assert.equal(statSync(join(snap, "auth.json")).mode & 0o777, 0o600);
  assert.equal(readSnapshot(snap)?.from, "0.1.0");
  // The newer host converts a store and writes one of its own.
  writeFileSync(join(state, "intents.json"), JSON.stringify({ schema: 4, intents: [] }));
  writeFileSync(join(state, "newstore.json"), "{}");
  const r = restoreState(state, snap);
  assert.deepEqual(r.restored.sort(), ["auth.json", "intents-archive.jsonl", "intents.json"]);
  assert.equal(JSON.parse(readFileSync(join(state, "intents.json"), "utf8")).schema, 3, "the older host's file is back");
  assert.equal(existsSync(join(state, "newstore.json")), false);
  assert.ok(r.keptIn, "what was replaced is kept, never deleted");
  assert.equal(JSON.parse(readFileSync(join(r.keptIn, "intents.json"), "utf8")).schema, 4);
  assert.ok(readdirSync(r.keptIn).includes("newstore.json"));
  assert.equal(readFileSync(join(state, "acks.json.corrupt-2026"), "utf8"), "evidence", "evidence is not touched");
  assert.ok(existsSync(join(state, "screenlogs", "big.log")));
});

test("a second snapshot of the same version replaces the first, and a missing state dir is an empty snapshot", () => {
  const { base, state, snap } = fixture();
  snapshotState(state, snap, { from: "0.1.0", to: "0.2.0" });
  const empty = snapshotState(join(base, "nope"), snap, { from: "0.1.0", to: "0.3.0" });
  assert.deepEqual(empty.files, []);
  assert.equal(readSnapshot(snap)?.to, "0.3.0");
  assert.deepEqual(readdirSync(snap), ["snapshot.json"]);
});

test("restore without a snapshot refuses rather than guessing", () => {
  const { base, state } = fixture();
  assert.throws(() => restoreState(state, join(base, "none")), /no state snapshot/);
  assert.ok(existsSync(join(state, "intents.json")), "nothing was moved");
});

test("the state-move refusal says what to do in a checkout AND in a release install", async () => {
  const { stateMoveRefusedSentence } = await import("../dist/branddirs.js");
  const s = stateMoveRefusedSentence("/old", "/new", "http://127.0.0.1:8770");
  assert.match(s, /npm run restart/);
  assert.match(s, /git checkout/);
  assert.match(s, /release install/);
  assert.match(s, new RegExp(`${BRAND.slug} service status`));
});

test("a dist without build-id.txt says what to do in a checkout AND in a release install", async () => {
  const { NO_BUILD_ID_REASON } = await import("../dist/webbundle.js");
  assert.match(NO_BUILD_ID_REASON, /npm run build/);
  assert.match(NO_BUILD_ID_REASON, /git checkout/);
  assert.match(NO_BUILD_ID_REASON, /release install/);
});
