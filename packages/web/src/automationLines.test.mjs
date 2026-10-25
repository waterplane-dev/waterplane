// The Automation sheet's "Runs on its own, no clock" foot: every line one
// sentence and one door, a count that IS the cut it opens (the backlog's own
// `▶ next` predicate), and a source the phone has not read drawing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { automationLines, autoNextIds, backlogLines, peerLines, pullLine, weekBurnLine } from "./automationLines.ts";
import { nextFireIdsOf } from "./backlogFilter/nextFire.ts";

const NOW = 1_800_000_000_000;
const A = "/r/alpha";
const B = "/r/beta";
const name = (d) => d.split("/").pop();
const item = (id, o = {}) => ({ id, repoDir: A, text: id, status: "queued", createdAt: 0, ...o });
const base = (o = {}) => ({ repoDir: null, items: [], auto: true, sessions: [], now: NOW, repoName: name, when: (t) => `@${t}`, ...o });

test("auto off is one sentence, no count, opening the backlog", () => {
  const ls = backlogLines(base({ auto: false, items: [item("a")] }));
  assert.equal(ls.length, 1);
  assert.match(ls[0].text, /auto is off/);
  assert.doesNotMatch(ls[0].text, /\d/);
  assert.deepEqual(ls[0].door, { kind: "backlog", repoDir: null });
});

test("the count is exactly the backlog's next-fire set, and the door carries those ids", () => {
  const sess = { id: "s1", cwd: A, running: true };
  const items = [
    item("fresh1"), item("fresh2"),                        // one group: only the first is next
    item("aimed", { targetSessionId: "s1" }),              // the live session's queue: next
    item("closed", { targetSessionId: "gone" }),           // held: never next
    item("clock", { at: { nextAt: NOW + 1000 } }),         // clock ahead: not next
    item("arch", { archived: true }),                      // set aside
  ];
  const o = base({ repoDir: A, items, sessions: [sess] });
  const ids = autoNextIds(o, A);
  assert.deepEqual(new Set(ids), nextFireIdsOf(items.filter((i) => !i.archived), new Set(["s1"]), true, NOW));
  assert.deepEqual(new Set(ids), new Set(["fresh1", "aimed"]));
  const [l] = backlogLines(o);
  assert.equal(l.text, "Backlog auto is on: 2 rows in alpha will start when free.");
  assert.equal(l.verb, "see those 2");
  assert.deepEqual(new Set(l.door.ids), new Set(ids));
  assert.equal(l.door.repoDir, A);
});

test("across repos: one line per repo with rows, auto said once; zero is a sentence", () => {
  const ls = backlogLines(base({ items: [item("a"), item("b", { repoDir: B })] }));
  assert.equal(ls.length, 2);
  assert.match(ls[0].text, /^Backlog auto is on: 1 row in alpha/);
  assert.equal(ls[1].text, "1 row in beta will start when free.");
  const none = backlogLines(base({ items: [item("x", { status: "done" })] }));
  assert.equal(none.length, 1);
  assert.doesNotMatch(none[0].text, /\d/);
});

test("auto-download: absent until read and outside a repo cut; on/off said in words", () => {
  assert.equal(pullLine(base({ repoDir: A })), null);
  assert.equal(pullLine(base({ pull: { enabled: true, scope: "outbox", match: [], maxBytes: 0, builds: false, supersede: true } })), null);
  const on = pullLine(base({ repoDir: A, pull: { enabled: true, scope: "outbox", match: [], maxBytes: 0, builds: true, supersede: true } }));
  assert.match(on.text, /on for alpha: new files in its outbox and build artifacts/);
  assert.deepEqual(on.door, { kind: "pull", repoDir: A });
  const off = pullLine(base({ repoDir: A, pull: { enabled: false, scope: "repo", match: [], maxBytes: 0, builds: false, supersede: true } }));
  assert.equal(off.text, "Auto-download is off for alpha.");
});

test("week-end burn: absent when unread or unavailable; per repo only when picked or posting", () => {
  const st = (o = {}) => ({ prefs: { repos: [A], weekOf: 1, recurring: false, lastRepos: [], stopPct: 90 }, available: true,
    weeklyPct: 40, weeklyResetAt: null, plan: { startAt: 5, windows: 2, ptsPerWindow: 10, reasonText: "", projectedPct: 60 },
    pickedThisWeek: true, running: [], ...o });
  assert.equal(weekBurnLine(base({ weekburn: null })), null);
  assert.equal(weekBurnLine(base({ weekburn: st({ available: false, unavailableText: "no windows" }) })), null);
  assert.match(weekBurnLine(base({ weekburn: st() })).text, /picked alpha this week, from @5\./);
  assert.match(weekBurnLine(base({ repoDir: A, weekburn: st() })).text, /picked alpha this week/);
  assert.equal(weekBurnLine(base({ repoDir: B, weekburn: st() })), null);
  assert.match(weekBurnLine(base({ weekburn: st({ pickedThisWeek: false }) })).text, /No repo is picked/);
  assert.match(weekBurnLine(base({ repoDir: B, weekburn: st({ running: [{ repoDir: B, posted: 1, live: null }] }) })).text, /posting .* in beta now/);
});

test("peer jobs: queued rows a peer posted, counted per repo, the door is those ids", () => {
  const items = [
    item("p1", { origin: "peer:zen" }), item("p2", { origin: "peer:zen" }),
    item("p3", { origin: "peer:zen", status: "running" }),  // started: not waiting
    item("p4", { origin: "peer:" }),                        // no name: not a peer row
    item("p5", { origin: "agent" }),
  ];
  const ls = peerLines(base({ items }));
  assert.equal(ls.length, 1);
  assert.equal(ls[0].text, "2 jobs from peer zen wait in alpha's backlog.");
  assert.deepEqual(ls[0].door.ids, ["p1", "p2"]);
  assert.deepEqual(peerLines(base({ repoDir: B, items })), []);
});

test("the foot's order: backlog, auto-download, burn, peers — and no health-watch line", () => {
  const ls = automationLines(base({ repoDir: A, items: [item("p1", { origin: "peer:zen" })],
    pull: { enabled: false, scope: "outbox", match: [], maxBytes: 0, builds: false, supersede: true } }));
  assert.deepEqual(ls.map((l) => l.icon), ["backlog", "pull", "peer"]);
  for (const l of ls) assert.ok(l.verb && l.door, "every line has exactly one door");
});
