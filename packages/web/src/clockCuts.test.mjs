/**
 * The Schedules sheet's directory of clocks, pinned without a browser.
 *
 * `clockCuts.ts` is pure, so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it:
 *
 *     node --test packages/web/src/clockCuts.test.mjs
 *
 * What is worth pinning here is not the markup — it is the three ways a row can
 * be LOST between two lists, which is the failure this whole change is about:
 *
 *  - a timed row in neither the directory nor its foot (it vanishes off the
 *    sheet entirely, and the phone has no other host-wide view of clocks);
 *  - a timed row in BOTH (two homes for one piece of work, which is the
 *    complaint this change exists to answer);
 *  - a horizon cut made with a second copy of `<= 1h`, which is how a chip
 *    saying "2 within the hour" opens a list of three;
 *  - and the one that actually shipped: three hand-rolled readings of "this row
 *    is a standing clock" saying **13 · 8 · 2** about one set of rows. The
 *    chip, the sentence written on that chip, and the sheet it opens are one
 *    call now, so the last three tests here assert an IDENTITY rather than an
 *    agreement — a fourth reading added beside them fails instead of drifting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clockCuts, clocksByRepo, entryIsTimedWork, repoClocksLabel } from "./clockCuts.ts";

const NOW = 1_700_000_000_000;
const H = 3600_000;

/** A one-off aimed at ONE place: a backlog row whose WHEN is an instant. */
const timed = (over = {}) => ({
  id: "t1", cwd: "/dev/myapp",
  payload: { kind: "prompt", steps: ["tidy the exports"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: { kind: "once", at: NOW + 2 * H }, graceMin: 120 },
  nextAt: NOW + 2 * H, state: "queued", createdAt: NOW - H, ...over,
});
const cuts = (intents, over = {}) =>
  clockCuts({ intents, pending: [], focus: null, focusIds: null, now: NOW, ...over });

test("a one-off aimed at one place is a LINE; a rule and a sweep are not", () => {
  // Recurrence, not trigger kind, decides which list a row lives in.
  const rule = timed({ id: "r1", trigger: { kind: "at", rule: { kind: "weekly", day: 4 }, graceMin: 120 } });
  // A one-off SWEEP has no single backlog to live in, so it stays a card.
  const sweep = timed({ id: "s1", target: { kind: "repos", dirs: ["/a", "/b"] } });
  // An untimed item is a backlog row and always was — it has no clock to list.
  const plain = timed({ id: "p1", trigger: { kind: "idle" }, nextAt: undefined });
  const c = cuts([timed(), rule, sweep, plain]);
  assert.deepEqual(c.live.map((i) => i.id), ["t1"]);
  assert.deepEqual(c.gone, []);
});

test("every timed row is in exactly ONE of the two lists — never both, never neither", () => {
  const rows = [
    timed({ id: "waiting" }),
    timed({ id: "blocked", state: "blocked", nextAt: NOW + 6 * H }),
    timed({ id: "running", state: "running", nextAt: null }),
    // Missed: the instant went by while the desktop slept. This is the shape of
    // all seven rows that started this change.
    timed({ id: "missed", state: "failed", nextAt: null, trigger: { kind: "at", rule: { kind: "once", at: NOW - 3 * H }, graceMin: 0 } }),
    timed({ id: "ran", state: "done", nextAt: null, lastOccurrence: NOW - H, trigger: { kind: "at", rule: { kind: "once", at: NOW - H }, graceMin: 0 } }),
    // Queued but its instant has gone by and the host has not ticked yet: NOT
    // standing, so it belongs with the history rather than nowhere at all.
    timed({ id: "stale", nextAt: null, trigger: { kind: "at", rule: { kind: "once", at: NOW - 5 * H }, graceMin: 0 } }),
  ];
  const c = cuts(rows);
  const seen = [...c.live, ...c.gone].map((i) => i.id).sort();
  assert.deepEqual(seen, rows.map((i) => i.id).sort(), "no timed row falls off both lists");
  assert.equal(new Set(seen).size, seen.length, "and none is in both");
  // Soonest first, and the sort key is "when does this next happen" — so a row
  // with nothing armed sorts LAST, running one included. That is not an
  // oversight: a running row has no next instant, it is already the thing that
  // happened, and the head of this list is the next thing that is going to.
  assert.deepEqual(c.live.map((i) => i.id), ["waiting", "blocked", "running"]);
  assert.deepEqual(c.gone.map((i) => i.id).sort(), ["missed", "ran", "stale"]);
});

test("archived leaves entirely; dismissed leaves the FOOT and never the list of what is coming", () => {
  // Archived is the store's own "I have seen this" and is out of both.
  assert.deepEqual(cuts([timed({ archived: true })]).live, []);
  assert.deepEqual(cuts([timed({ archived: true })]).gone, []);
  // Dismissed is Activity's "I have dealt with this": a foot that keeps
  // counting it is a count nobody can ever clear.
  const done = timed({ id: "d", state: "done", nextAt: null, lastOccurrence: NOW - H,
    trigger: { kind: "at", rule: { kind: "once", at: NOW - H }, graceMin: 0 }, dismissedAt: NOW });
  assert.deepEqual(cuts([done]).gone, []);
  // …but a row still WAITING is never hidden by it. Being filed is not the same
  // as not happening, and this sheet is the only place the clock is visible.
  assert.deepEqual(cuts([timed({ id: "w", dismissedAt: NOW })]).live.map((i) => i.id), ["w"]);
});

test("the horizon cut is the SAME edge the launcher chip counted with", () => {
  // "2 within the hour" has to open exactly those two — and the two may be one
  // rule and one timed item, which is precisely why both go through
  // `horizonBucket` and neither re-derives `<= 1h`.
  const rows = [
    timed({ id: "soon", nextAt: NOW + 30 * 60_000 }),
    timed({ id: "edge", nextAt: NOW + H }),          // inclusive, like the chip
    timed({ id: "day", nextAt: NOW + 5 * H }),
    // An instant already behind us is DUE, not "later": a missed occurrence
    // inside its grace is the most urgent thing in this list.
    timed({ id: "late", nextAt: NOW - 60_000, state: "blocked" }),
  ];
  assert.deepEqual(cuts(rows, { focus: "soon" }).shown.map((i) => i.id).sort(), ["edge", "late", "soon"]);
  assert.deepEqual(cuts(rows, { focus: "day" }).shown.map((i) => i.id), ["day"]);
  // An IDS cut is over EVERY timed row, standing and spent alike, and wins over
  // a bucket: somebody who followed a link by name must not be handed an empty
  // list minus a window they never asked for.
  const spent = timed({ id: "old", state: "failed", nextAt: null,
    trigger: { kind: "at", rule: { kind: "once", at: NOW - 3 * H }, graceMin: 0 } });
  const byId = cuts([...rows, spent], { focus: "soon", focusIds: { ids: ["old"] } });
  assert.deepEqual(byId.shown.map((i) => i.id), ["old"]);
});

test("the foot groups by REPO, because the count is the filter and a backlog is one repo's", () => {
  const gone = (id, cwd) => timed({ id, cwd, state: "failed", nextAt: null,
    trigger: { kind: "at", rule: { kind: "once", at: NOW - 3 * H }, graceMin: 0 } });
  const c = cuts([gone("a1", "/dev/myapp"), gone("b1", "/dev/garmin"), gone("a2", "/dev/myapp")]);
  assert.deepEqual(c.goneByRepo.map(([dir, rows]) => [dir, rows.length]),
    [["/dev/myapp", 2], ["/dev/garmin", 1]]);
});

test("a queued save of a one-off is a LINE, and it stops being one the moment the host lists it", () => {
  // Otherwise the row a phone just wrote sits in the CARDS until the link comes
  // back and then jumps into the directory — the same row in two places, which
  // is the shape this change exists to remove.
  const entry = { id: "s_new", name: "tidy", enabled: true, rule: { kind: "once", at: NOW + H },
    action: { kind: "backlog", repoDir: "/dev/myapp", text: "tidy", autoFire: true },
    createdAt: NOW, nextAt: NOW + H, graceMin: 120 };
  assert.equal(entryIsTimedWork(entry), true);
  assert.equal(entryIsTimedWork({ ...entry, rule: { kind: "weekly", day: 4 } }), false, "a rule that repeats is a card");
  assert.equal(entryIsTimedWork({ ...entry, action: { kind: "fanout", dirs: ["/a"], text: "x" } }), false, "a sweep is a card");

  const pending = [{ entry }];
  assert.deepEqual(cuts([], { pending }).pending.map((p) => p.entry.id), ["s_new"]);
  // Once the host holds it, the intent's own line replaces it — with facts the
  // desktop stands behind rather than this device's preview of the rule.
  assert.deepEqual(cuts([timed({ id: "s_new" })], { pending }).pending, []);
});

/**
 * ── The number, its sentence and the header are ONE reading ──────────────────
 *
 * The failure this pins, measured on the user's own store: the launcher chip
 * said **13** (`11 not armed`), the title written on that same chip said **8**,
 * and the sheet the chip opens said **2**. Three hand-rolled copies of "this
 * row is a standing clock", disagreeing by eleven — and a count on a control is
 * a filter, so eleven of those rows were a tap that could reach nothing.
 *
 * They are one call now, so the assertion is an IDENTITY: if anybody ever adds
 * a second reading beside it, these fail rather than drifting quietly.
 */
test("the chip's number, the chip's sentence and the sheet's header are one reading", () => {
  const rule = { id: "weekly", trigger: { kind: "at", rule: { kind: "weekly", day: 4 }, graceMin: 120 }, nextAt: NOW + 3 * H };
  const entries = [
    { id: "weekly", name: "tidy", enabled: true, rule: { kind: "weekly", day: 4 },
      action: { kind: "backlog", repoDir: "/dev/myapp", text: "tidy", autoFire: true },
      createdAt: NOW, nextAt: NOW + 3 * H, graceMin: 120 },
  ];
  const c = clockCuts({
    intents: [timed({ id: "t1" }), timed({ id: "t2", nextAt: NOW + 40 * 60_000 }), timed(rule)],
    entries, pending: [], focus: null, focusIds: null, now: NOW,
  });
  // The chip's number IS the header's — not a second count that agrees.
  assert.equal(c.horizon.total, c.standingTotal);
  assert.equal(c.standingTotal, c.cards.length + c.live.length + c.pending.length);
  // …and the chip's SENTENCE is a split of exactly that pool, never its own walk.
  assert.equal(c.kinds.rules + c.kinds.timed, c.horizon.total);
  assert.deepEqual(c.kinds, { rules: 1, timed: 2 });
  // The bucket the chip leads with opens exactly the rows it counted.
  assert.equal(c.horizon.soon, 1);
  assert.deepEqual(
    clockCuts({ intents: [timed({ id: "t1" }), timed({ id: "t2", nextAt: NOW + 40 * 60_000 })], entries, pending: [], focus: "soon", focusIds: null, now: NOW })
      .shown.map((i) => i.id),
    ["t2"],
  );
});

test("a spent `window oneShot` is counted by NONE of the three — the eleven rows the chip could not open", () => {
  // The exact shape on the user's desktop: a `window`/`oneShot` row that has
  // already run or already failed, with `lastOccurrence` never stamped.
  //
  // Two bugs stacked here, and one predicate answers both. `isSpentOnce`'s
  // `window`/`oneShot` branch is ONLY `lastOccurrence != null`, so a reading
  // that drops that field can never call such a row spent (five rows); and a
  // row that has SETTLED is not waiting for anything whatever its rule says
  // (six more). Between them: "11 not armed" over a sheet showing two lines.
  const win = (over) => timed({
    trigger: { kind: "at", rule: { kind: "window", window: "weekly", leadMin: 0, oneShot: true }, graceMin: 0 },
    nextAt: null, ...over,
  });
  const rows = [
    win({ id: "ran", state: "done" }),
    win({ id: "missed", state: "failed" }),
    win({ id: "gone-too", state: "canceled" }),
    // Still queued with no reading yet: this one IS standing, and says so.
    win({ id: "waiting", state: "queued" }),
  ];
  const c = clockCuts({ intents: rows, entries: [], pending: [], focus: null, focusIds: null, now: NOW });
  assert.deepEqual(c.live.map((i) => i.id), ["waiting"]);
  assert.equal(c.horizon.total, 1, "the chip counts the one that is still coming");
  assert.equal(c.standingTotal, 1, "and so does the sheet it opens");
  assert.deepEqual(c.kinds, { rules: 0, timed: 1 });
  // `canceled` is settled too — it is history, not a clock somebody can arm.
  assert.deepEqual(c.gone.map((i) => i.id).sort(), ["gone-too", "missed", "ran"]);
});

test("a queued save is counted where it is drawn — a card in the cards, a one-off in the lines", () => {
  // Both kinds are in the pool the chip counts, because both are drawn on the
  // sheet it opens. A save the chip counted and the sheet did not draw is the
  // same broken promise in the other direction.
  const card = { id: "s_sweep", name: "sweep", enabled: true, rule: { kind: "once", at: NOW + H },
    action: { kind: "fanout", dirs: ["/a", "/b"], text: "x" }, createdAt: NOW, nextAt: NOW + H, graceMin: 120 };
  const line = { id: "s_one", name: "tidy", enabled: true, rule: { kind: "once", at: NOW + 2 * H },
    action: { kind: "backlog", repoDir: "/dev/myapp", text: "tidy", autoFire: true }, createdAt: NOW, nextAt: NOW + 2 * H, graceMin: 120 };
  const c = clockCuts({ intents: [], entries: [], pending: [{ entry: card }, { entry: line }], focus: null, focusIds: null, now: NOW });
  assert.deepEqual(c.cards.map((e) => e.id), ["s_sweep"]);
  assert.deepEqual(c.pending.map((p) => p.entry.id), ["s_one"]);
  assert.equal(c.horizon.total, 2);
  assert.equal(c.standingTotal, 2);
  assert.deepEqual(c.kinds, { rules: 1, timed: 1 });
});

test("the per-repo chip is the host-wide pool GROUPED, so its number and its cut agree", () => {
  // The repo row's question is not the header's. The header counts every clock
  // on the desktop; this counts the ones that fire HERE, and the tap opens
  // exactly those ids — which only holds because both come out of one cut.
  const mine = timed({ id: "mine", cwd: "/dev/myapp" });
  const theirs = timed({ id: "theirs", cwd: "/dev/picture-app", nextAt: NOW + 30 * 60_000 });
  const card = { id: "s_weekly", name: "weekly sweep", enabled: true, rule: { kind: "weekly", day: 4 },
    action: { kind: "fanout", dirs: ["/dev/myapp", "/dev/picture-app"], text: "x" }, createdAt: NOW, nextAt: NOW + 3 * H, graceMin: 120 };
  const c = cuts([mine, theirs], { entries: [card] });
  const per = clocksByRepo({ cuts: c, repoOf: (d) => d.split("/").pop() || null, now: NOW });
  assert.deepEqual(per.get("myapp").ids.sort(), ["mine", "s_weekly"]);
  assert.deepEqual(per.get("picture-app").ids.sort(), ["s_weekly", "theirs"]);
  // A sweep fires in both, so it is counted in both: one rule that is true of
  // two repos, never one list counted twice.
  assert.equal(per.get("myapp").horizon.total, 2);
  assert.equal([...per.values()].reduce((n, r) => n + r.ids.length, 0), c.standingTotal + 1);
  // The bucketing is `horizonBucket`'s, same as the header's — "2 within the
  // hour" on a repo row opens those two and no others.
  assert.equal(per.get("picture-app").horizon.soon, 1);
  // A row whose directory maps to no repo is left out, never filed under a guess.
  const orphan = clocksByRepo({ cuts: cuts([timed({ id: "nowhere", cwd: "/tmp/x" })]), repoOf: () => null, now: NOW });
  assert.equal(orphan.size, 0);
});

test("a spent or settled clock is in nobody's per-repo count", () => {
  // Same predicate as the header: `clocksByRepo` groups `cuts.live`/`cards`,
  // so a row that has been and gone cannot come back through this door.
  const gone = timed({ id: "ran", state: "done", nextAt: null, lastOccurrence: NOW - H,
    trigger: { kind: "at", rule: { kind: "once", at: NOW - H }, graceMin: 0 } });
  const per = clocksByRepo({ cuts: cuts([gone]), repoOf: (d) => d.split("/").pop() || null, now: NOW });
  assert.equal(per.size, 0);
});

test("the filter bar's words name the repo and the count it was tapped with", () => {
  assert.equal(repoClocksLabel("myapp", 3), "the 3 on a clock in myapp");
  assert.match(repoClocksLabel("myapp", 1), /myapp/);
});

test("a directory line may be ticked for re-timing only where the host accepts a new trigger", async () => {
  const { retimeIntentEligible } = await import("./clockCuts.ts");
  const at = { kind: "at", rule: { kind: "once", at: 1, offsetMin: 0 }, graceMin: 120 };
  const row = (o) => ({ id: "x", state: "queued", trigger: at, ...o });
  for (const st of ["queued", "blocked", "failed"]) assert.equal(retimeIntentEligible(row({ state: st })), true, st);
  for (const st of ["starting", "running", "done", "canceled"]) assert.equal(retimeIntentEligible(row({ state: st })), false, st);
  assert.equal(retimeIntentEligible(row({ archived: true })), false);
  assert.equal(retimeIntentEligible(row({ trigger: { kind: "idle" } })), false);
});

test("the search narrows ON TOP of a horizon cut, and each count is its own control's", () => {
  const rows = [
    timed({ id: "soon-a", nextAt: NOW + 20 * 60_000, payload: { kind: "prompt", steps: ["fix the flaky test"] } }),
    timed({ id: "soon-b", nextAt: NOW + 30 * 60_000, payload: { kind: "prompt", steps: ["sort the launcher"] } }),
    timed({ id: "later", nextAt: NOW + 30 * H, payload: { kind: "prompt", steps: ["flaky again"] } }),
  ];
  const c = cuts(rows, { focus: "soon", text: "  FLAKY " });
  // The bar's "n of N" is the cut before the search; the box's is after it.
  assert.equal(c.cutTotal, 2);
  assert.equal(c.shownTotal, 1);
  assert.deepEqual(c.shown.map((i) => i.id), ["soon-a"]);
  // The chip has no search box: what it counts never moves with one.
  assert.equal(c.standingTotal, 3);
  // A repo is matched by its folder name, never by a path segment above it.
  assert.equal(cuts(rows, { text: "myapp" }).shownTotal, 3);
  assert.equal(cuts(rows, { text: "dev" }).shownTotal, 0);
});
