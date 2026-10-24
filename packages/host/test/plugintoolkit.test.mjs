// The host plugin toolkit (contract 2.0): api.tail (rotation-safe JSONL follower), api.screen
// (the live grid as rows + the host's squash) and the launch-dir lookup behind api.sessionFiles.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { tailJsonl } = await import("../dist/plugins/plugintoolkit/tail.js");
const { screenOf } = await import("../dist/plugins/plugintoolkit/screen.js");
const { sessionFilesDir } = await import("../dist/plugins/plugintoolkit/sessionfiles.js");

const tmp = () => mkdtempSync(join(tmpdir(), "wp-tail-"));

test("tail delivers each complete line once and holds a partial line back", () => {
  const f = join(tmp(), "a.jsonl");
  writeFileSync(f, '{"n":1}\n{"n":2}\n{"n"');
  const got = [];
  const t = tailJsonl(f, (o) => got.push(o));
  assert.equal(t.advance(), true);
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }]);
  assert.equal(t.advance(), false, "nothing new");
  appendFileSync(f, ':3}\n');
  assert.equal(t.advance(), true);
  assert.deepEqual(got.at(-1), { n: 3 });
  assert.equal(got.length, 3);
  t.close();
  assert.equal(t.advance(), null, "closed");
});

test("tail on a file truncated and regrown re-reads from 0, each line once", () => {
  const f = join(tmp(), "b.jsonl");
  writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3}\n');
  const got = [];
  const t = tailJsonl(f, (o) => got.push(o.n));
  t.advance();
  writeFileSync(f, '{"n":10}\n');
  assert.equal(t.advance(), true);
  assert.deepEqual(got, [1, 2, 3, 10]);
  assert.equal(t.advance(), false);
});

test("tail follows a rotation (new inode, same or larger size) from the start", () => {
  const dir = tmp();
  const f = join(dir, "c.jsonl");
  writeFileSync(f, '{"n":1}\n');
  const got = [];
  const t = tailJsonl(f, (o) => got.push(o.n));
  t.advance();
  renameSync(f, join(dir, "c.old"));
  writeFileSync(f, '{"n":2}\n{"n":3}\n{"n":4}\n');
  t.advance();
  assert.deepEqual(got, [1, 2, 3, 4]);
});

test("tail: a missing file is null-then-picks-up; garbage lines and the filter are skipped; offset is exposed", () => {
  const dir = tmp();
  const f = join(dir, "d.jsonl");
  const got = [];
  const t = tailJsonl(f, (o) => got.push(o.n), { filter: (l) => !l.includes("skip") });
  assert.equal(t.advance(), null, "no file yet: unknown, not 'no news'");
  writeFileSync(f, 'not json\n{"n":1,"skip":1}\n{"n":2}\n');
  assert.equal(t.advance(), true);
  assert.deepEqual(got, [2]);
  assert.equal(t.offset(), Buffer.byteLength('not json\n{"n":1,"skip":1}\n{"n":2}\n'));
});

test("tail reads a big backlog in 1 MiB windows without losing a line at a window edge", () => {
  const f = join(tmp(), "e.jsonl");
  const pad = "x".repeat(1000);
  const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ n: i, pad }));
  writeFileSync(f, lines.join("\n") + "\n");
  const got = [];
  const t = tailJsonl(f, (o) => got.push(o.n));
  while (t.advance()) { /* drain */ }
  assert.equal(got.length, 2500);
  assert.deepEqual(got.slice(0, 3), [0, 1, 2]);
  assert.equal(got.at(-1), 2499);
});

test("screen on an unknown session is null; known gives rows and a squashed text", () => {
  const grid = "  Hello   World\nsecond  line\n\n";
  const live = { get: (id) => (id === "s1" ? {} : undefined), liveGrid: (id) => (id === "s1" ? grid : "") };
  assert.equal(screenOf(live, "nope"), null);
  const s = screenOf(live, "s1");
  assert.ok(s);
  assert.deepEqual(s.rows(), ["  Hello   World", "second  line"], "trailing blank rows dropped");
  assert.equal(s.rows(1).length, 1);
  assert.equal(s.rows(1)[0], "second  line", "the LAST n rows");
  assert.equal(s.squashed(), "helloworldsecondline");
});

test("sessionFiles: the launch dir only for a session of this plugin's backend, and only if it exists", () => {
  const state = tmp();
  const dir = join(state, "launch", "sid1");
  mkdirSync(dir, { recursive: true });
  const sessions = { get: (id) => (id === "sid1" ? { backend: "mine" } : id === "sid2" ? { backend: "claude" } : undefined) };
  assert.equal(sessionFilesDir(sessions, state, new Set(["mine"]), "sid1"), dir);
  assert.equal(sessionFilesDir(sessions, state, new Set(["mine"]), "sid2"), null, "another backend's session");
  assert.equal(sessionFilesDir(sessions, state, new Set(["mine"]), "nope"), null);
  mkdirSync(join(state, "launch", "x"), { recursive: true });
  assert.equal(sessionFilesDir(sessions, state, new Set(["mine"]), "../x"), null, "no traversal");
});
