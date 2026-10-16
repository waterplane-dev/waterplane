/**
 * `sweepSessionStores` — the only thing in the daemon that deletes a session's
 * own history and summary.
 *
 * `.myapp/history/` and `.myapp/summaries/` are written per session and were only
 * ever unwritten by `remove()`, the one exit a session usually does not take.
 * Measured on the live host: 436 history files and 98 summaries against ~107
 * live sessions. The sweep that fixes that is a delete loop, so its guards are
 * pinned here rather than trusted: the ALIVE set, the age gate that makes a
 * transient rediscover failure survivable, and the filename rule.
 *
 * Pure fs in, files gone — no `SessionManager`, no PTY, no tmux.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { sweepSessionStores } = await import("../dist/sessions.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 10);

let n = 0;
/** A store directory holding `{ name: ageInDays }`. */
function store(files) {
  const dir = join(mkdtempSync(join(tmpdir(), "waterplane-sweep-")), `store${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, days] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, "{}");
    const t = new Date(NOW - days * DAY);
    utimesSync(p, t, t);
  }
  return dir;
}
const names = (dir) => readdirSync(dir).sort();

test("an orphan past the age gate goes; a live session's file never does", () => {
  const dir = store({ "deadbeef.json": 30, "cafef00d.json": 30, "0badf00d.json": 400 });
  const r = sweepSessionStores([dir], new Set(["cafef00d"]), NOW);
  assert.deepEqual(names(dir), ["cafef00d.json"]);
  assert.deepEqual(r, { deleted: 2, kept: 1, skipped: false });
});

test("a file younger than the age gate is kept even with no session anywhere", () => {
  // This is the rule the whole sweep rests on. The alive set comes from a
  // `tmux ls` and a directory read, either of which can come back empty for
  // reasons that say nothing about the sessions — and answering one transient
  // failure by deleting every live session's prompt history is not a tidy-up.
  const dir = store({ "aaaa1111.json": 6.9, "bbbb2222.json": 7.1 });
  sweepSessionStores([dir], new Set(), NOW);
  assert.deepEqual(names(dir), ["aaaa1111.json"]);
});

test("only bare `<id>.json` is matched — a traversal-shaped name is refused, never sanitised", () => {
  const dir = store({
    "..json": 99, "...json": 99, "..%2fetc.json": 99, "-lead.json": 99,
    "notes.txt": 99, "deadbeef.json.bak": 99, "deadbeef.json": 99,
  });
  sweepSessionStores([dir], new Set(), NOW);
  assert.deepEqual(names(dir), ["-lead.json", "..%2fetc.json", "...json", "..json", "deadbeef.json.bak", "notes.txt"]);
});

test("it deletes files and nothing else: no recursion, no directory removal", () => {
  const dir = store({ "deadbeef.json": 99 });
  mkdirSync(join(dir, "feedface.json"));                       // a DIRECTORY wearing a matching name
  writeFileSync(join(dir, "feedface.json", "abcd1234.json"), "{}");
  sweepSessionStores([dir], new Set(), NOW);
  assert.ok(existsSync(dir), "the store directory itself survives an empty sweep");
  assert.deepEqual(names(dir), ["feedface.json"]);
  assert.deepEqual(names(join(dir, "feedface.json")), ["abcd1234.json"], "nothing recurses");
});

test("a store that was never created is not an error", () => {
  const dir = store({ "deadbeef.json": 99 });
  const r = sweepSessionStores([join(dir, "nope"), dir], new Set(), NOW);
  assert.equal(r.deleted, 1);
});

test("an unanswerable alive set deletes nothing at all", () => {
  // `aliveSessionIds()` returns null when the `live/` store EXISTS and could not
  // be read — the one failure the age gate cannot cover, since a live tmux
  // session idle past the gate is absent from the map too. Null must mean "do
  // not sweep", never "nothing is alive": the second reading deletes every
  // long-idle live session's prompt history on one bad readdir.
  const dir = mkdtempSync(join(tmpdir(), "waterplane-sweep-null-"));
  const old = join(dir, "deadbeef.json");
  writeFileSync(old, "{}");
  const ancient = Date.now() / 1000 - 90 * 24 * 60 * 60;
  utimesSync(old, ancient, ancient);

  const r = sweepSessionStores([dir], null);
  assert.equal(r.skipped, true);
  assert.equal(r.deleted, 0);
  assert.ok(existsSync(old), "a null alive set must not delete even a 90-day-old orphan");

  // ...and the same file with a real (empty) alive set IS swept, so the test
  // above is proving the null branch and not an unrelated reason to keep it.
  const r2 = sweepSessionStores([dir], new Set());
  assert.equal(r2.skipped, false);
  assert.equal(r2.deleted, 1);
  assert.equal(existsSync(old), false);
});

// ── `staleLiveIds`: which `live/` records the boot reclaim may delete ────────
//
// A record is how a restart finds its pane, and `aliveSessionIds` reads every
// record as a session — so a record whose pane died while the daemon was down
// used to protect its own history and summary for ever (162 of 277 on this
// desktop). The reclaim that fixes it deletes records, so every reason it has to
// keep one is pinned here.

const { staleLiveIds } = await import("../dist/sessions.js");
const HOUR = 60 * 60 * 1000;
const SOCK = "/tmp/tmux-501/waterplane";
const SERVER = { socket: SOCK, isDefault: true };
/** `{ id: [ageInHours, tmuxSocket?] }` → the facts map `staleLiveIds` takes. */
const facts = (o) => new Map(Object.entries(o).map(([id, [hours, tmuxSocket]]) => [id, { mtimeMs: NOW - hours * HOUR, ...(tmuxSocket ? { tmuxSocket } : {}) }]));
const { tmuxName } = await import("../dist/sessions/knobs.js");
const tmux = (...ids) => new Set(ids.map(tmuxName));

test("a listing that could not be had reclaims nothing — a failed `tmux ls` is never an empty one", () => {
  const f = facts({ deadbeef: [999, SOCK] });
  assert.deepEqual(staleLiveIds(["deadbeef"], null, NOW, f, HOUR, SERVER), []);
  // …and the same record against a real (empty) listing IS reclaimed, so the
  // line above proves the null branch and not some other reason to keep it.
  assert.deepEqual(staleLiveIds(["deadbeef"], tmux(), NOW, f, HOUR, SERVER), ["deadbeef"]);
});

test("a record whose tmux session is listed is kept, however old", () => {
  const f = facts({ aaaa1111: [999, SOCK], bbbb2222: [999, SOCK] });
  assert.deepEqual(staleLiveIds(["aaaa1111", "bbbb2222"], tmux("aaaa1111"), NOW, f, HOUR, SERVER), ["bbbb2222"]);
});

test("a record younger than the gate is kept — its spawn may still be in flight", () => {
  const f = facts({ aaaa1111: [0.5, SOCK], bbbb2222: [1.5, SOCK] });
  assert.deepEqual(staleLiveIds(["aaaa1111", "bbbb2222"], tmux(), NOW, f, HOUR, SERVER), ["bbbb2222"]);
});

test("old and absent from the listing is the one case that is listed", () => {
  const f = facts({ aaaa1111: [48, SOCK], bbbb2222: [48, SOCK], cccc3333: [48, SOCK] });
  assert.deepEqual(staleLiveIds(["aaaa1111", "bbbb2222", "cccc3333"], tmux("bbbb2222"), NOW, f, HOUR, SERVER), ["aaaa1111", "cccc3333"]);
});

test("a traversal-shaped id is refused, never sanitised", () => {
  const ids = ["..", "../etc", "a/b", "-lead", ".hidden", "deadbeef.json", ""];
  const f = new Map(ids.map((id) => [id, { mtimeMs: NOW - 999 * HOUR, tmuxSocket: SOCK }]));
  assert.deepEqual(staleLiveIds(ids, tmux(), NOW, f, HOUR, SERVER), []);
});

test("an id this host holds (the map, the parked set) is kept even with no name listed", () => {
  const f = facts({ aaaa1111: [48, SOCK], bbbb2222: [48, SOCK] });
  assert.deepEqual(staleLiveIds(["aaaa1111", "bbbb2222"], tmux(), NOW, f, HOUR, SERVER, new Set(["aaaa1111"])), ["bbbb2222"]);
});

test("a record stamped with ANOTHER tmux server is kept — this listing says nothing about it", () => {
  const f = facts({ aaaa1111: [48, "/tmp/tmux-501/other"], bbbb2222: [48, SOCK] });
  assert.deepEqual(staleLiveIds(["aaaa1111", "bbbb2222"], tmux(), NOW, f, HOUR, SERVER), ["bbbb2222"]);
});

test("an unstamped (older) record is judged only by a host on the default socket", () => {
  const f = facts({ aaaa1111: [48, undefined] });
  assert.deepEqual(staleLiveIds(["aaaa1111"], tmux(), NOW, f, HOUR, SERVER), ["aaaa1111"]);
  assert.deepEqual(staleLiveIds(["aaaa1111"], tmux(), NOW, f, HOUR, { socket: SOCK, isDefault: false }), []);
});

test("a record with no facts (unreadable, unparseable) is kept", () => {
  assert.deepEqual(staleLiveIds(["aaaa1111"], tmux(), NOW, new Map(), HOUR, SERVER), []);
});
