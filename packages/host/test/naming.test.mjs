/**
 * **Titling untitled backlog rows — and the one write it may never make.**
 *
 * A headline is the only string in this app a MODEL writes FOR a person, over
 * words that person typed, in the place they look first. Everything here is
 * arranged around that: five rules, and the first two are the whole reason the
 * feature has a test at all.
 *
 *  1. **A name a PERSON typed is never replaced.** `IntentManager.name()`
 *     refuses a `hand` field, per HALF — a row whose title somebody typed can
 *     still take a kind — and `buildNamingInput` does not even offer a row that
 *     has nothing left a machine may write.
 *  2. **Clearing a name by hand means "nobody has said", not "nobody may say".**
 *     `edit()` with `""` drops the value AND the author, so the next pass may
 *     title the row again. Keeping the author would make a row no machine could
 *     ever name, for ever, with nothing on any screen explaining why it is the
 *     only untitled one in the list.
 *  3. **The words go in WHOLE.** An item over the character budget takes a batch
 *     of its own rather than being clipped: a title written from the half of a
 *     prompt a clip keeps can only be the truncation `cleanHeadline` refuses.
 *  4. **One pass per repo, refused in a SENTENCE.** Two passes over one list
 *     write two titles onto the same rows in an order nobody chose.
 *  5. **Every failure is the empty result.** An answer nothing can be read out
 *     of writes nothing and says so, exactly as every other `sidecar.ts` caller
 *     treats one.
 *
 *     node --test packages/host/test/naming.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildNamingInput, namingPrompt, namingSentence, namingStartedNote, NamingManager, NAME_BATCH_ITEMS, NAME_BATCH_CHARS } =
  await import("../dist/naming.js");
const { IntentManager } = await import("../dist/intents/manager.js");

const REPO = "/tmp/waterplane-naming-repo";
const OTHER = "/tmp/waterplane-naming-other";

const roots = [];
/** A real store over its own temp root — the naming rules are ABOUT the store's
 *  own refusals, so a fake one would assert nothing. */
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-naming-"));
  roots.push(root);
  return new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => 0,
    autoSlotsDetail: () => undefined,
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([REPO, OTHER]),
    budgetBlocked: () => false,
    // Off, so nothing this file posts ever starts running underneath it.
    autoFire: () => false,
    logVerdict: () => "unknown",
    executors: {
      freshSession: async () => ({ ok: true }),
      sweep: async () => ({ ok: true }),
      deliver: async () => ({ ok: true }),
      workItem: async () => ({ ok: true }),
      build: async () => ({ ok: true }),
      assess: async () => ({ ok: true }),
    },
    onChange: () => {},
  });
}

/**
 * A clock that always moves, so `list()`'s newest-first order is a FACT rather
 * than a coincidence. Three rows posted inside one millisecond tie on
 * `createdAt`, and the batch cut is read off that order — so the char-budget
 * test below passed or failed depending on how quickly the machine ran it.
 */
let clock = Date.now();

const row = (store, id, text, over = {}) => store.post({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: [text] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "idle" },
  ...over,
}, clock++);

process.on("exit", () => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* gone */ } } });

// ── buildNamingInput ────────────────────────────────────────────────────────

test("a row with nothing left for a machine to write is not in the input", () => {
  const store = makeStore();
  row(store, "both", "hand-named both halves", { headline: "MY TITLE", headlineBy: "hand", category: "bug", categoryBy: "hand" });
  // Half hand-named is the ORDINARY case and must still be offered: the kind is
  // nobody's, and a rule that refused the row on one `hand` field would leave
  // every such kind unset for ever.
  row(store, "half", "hand title, no kind", { headline: "MY TITLE", headlineBy: "hand" });
  row(store, "bare", "nothing said about this one");

  const ids = buildNamingInput(store, REPO).flatMap((b) => b.rows.map((r) => r.id));
  assert.deepEqual(ids.sort(), ["bare", "half"], "the hand-complete row is left out; the half-named one is offered its missing kind");
});

test("a LABEL a person typed is a title already, and no headline is bought for it", () => {
  // The host and the phone have to agree about what "needs a title" means, and
  // they did not: `itemHeadline` is the ONE display rule and it says a typed
  // label beats a headline ALWAYS, so a headline bought for such a row is a
  // headline nothing will ever show. With the phone's own `ids` the two agreed
  // by accident — the cut was computed under the display rule — but `ids: []`
  // or a cut a moment out of date spent real money on rows that were named.
  const store = makeStore();
  const text = "the picker forgets its scroll position when the phone rotates";
  row(store, "named", text, { label: "picker scroll", category: "bug", categoryBy: "hand" });
  // A label that is merely the row's own first 40 characters is the DERIVATION
  // this app writes itself, not a name — `typedName`'s whole job — so this row
  // still has nothing on it and is offered.
  row(store, "derived", text, { label: text.slice(0, 40), category: "bug", categoryBy: "hand" });
  // A typed label with no kind is still offered, for the kind: the halves are
  // decided separately, here as everywhere else.
  row(store, "half", text, { label: "picker scroll" });

  const rows = buildNamingInput(store, REPO).flatMap((b) => b.rows);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["derived", "half"]);
});

test("another repo's rows, finished rows and non-prompt rows are not in the input", () => {
  const store = makeStore();
  row(store, "mine", "this repo's");
  store.post({
    id: "theirs", cwd: OTHER, payload: { kind: "prompt", steps: ["another repo's"] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "idle" },
  }, clock++);
  row(store, "shell", "a build", { payload: { kind: "shell", cmd: "npm test" }, target: { kind: "shell" } });
  row(store, "gone", "already finished");
  store.markDone("gone");

  const ids = buildNamingInput(store, REPO).flatMap((b) => b.rows.map((r) => r.id));
  assert.deepEqual(ids, ["mine"], "one repo, open work, words only");
});

test("a scope narrows the input and is still put through every filter", () => {
  const store = makeStore();
  row(store, "a", "first");
  row(store, "b", "second");
  row(store, "named", "already titled", { headline: "MINE", headlineBy: "hand", category: "chore", categoryBy: "hand" });

  const ids = buildNamingInput(store, REPO, ["a", "named", "nobody-has-this-id"]).flatMap((b) => b.rows.map((r) => r.id));
  assert.deepEqual(ids, ["a"], "a scope naming a titled row and a ghost produces fewer rows, never a wider pass");
});

test("batches are cut by COUNT", () => {
  const store = makeStore();
  for (let i = 0; i < NAME_BATCH_ITEMS + 3; i++) row(store, `r${i}`, `item number ${i}`);
  const batches = buildNamingInput(store, REPO);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].rows.length, NAME_BATCH_ITEMS);
  assert.equal(batches[1].rows.length, 3);
});

test("batches are cut by CHARS, and an item over the budget goes in alone AT FULL LENGTH", () => {
  const store = makeStore();
  const huge = "x".repeat(NAME_BATCH_CHARS + 500);
  row(store, "small1", "a short one");
  row(store, "huge", huge);
  row(store, "small2", "another short one");

  // `list()` is newest first, so the store's own order is small2, huge, small1.
  const batches = buildNamingInput(store, REPO);
  const holding = batches.find((b) => b.rows.some((r) => r.id === "huge"));
  assert.equal(holding.rows.length, 1, "an item nothing else fits beside is a batch of one");
  assert.equal(holding.rows[0].text.length, huge.length,
    "…and it goes in WHOLE — a title written off a clip can only be the truncation the cleaner refuses");
  assert.equal(batches.length, 3, "and it does not take its neighbours with it");
});

test("the prompt is the ids and the words, and nothing else", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  const doc = JSON.parse(namingPrompt(buildNamingInput(store, REPO)[0]));
  assert.deepEqual(doc, { items: [{ id: "a", text: "the picker forgets its scroll position" }] });
});

// ── edit(): a person's own name ─────────────────────────────────────────────

test("edit() stamps `hand`, and `\"\"` clears the value AND the author", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");

  store.edit("a", { headline: "picker loses its scroll", category: "bug" });
  assert.equal(store.get("a").headline, "picker loses its scroll");
  assert.equal(store.get("a").headlineBy, "hand");
  assert.equal(store.get("a").category, "bug");
  assert.equal(store.get("a").categoryBy, "hand");
  // Not in the input any more: there is nothing left a machine may write.
  assert.equal(buildNamingInput(store, REPO).length, 0);

  store.edit("a", { headline: "", category: "" });
  assert.equal(store.get("a").headline, undefined);
  assert.equal(store.get("a").headlineBy, undefined, "the author goes with the value — absent means NOBODY HAS SAID");
  assert.equal(store.get("a").category, undefined);
  assert.equal(store.get("a").categoryBy, undefined);
  // …and the row is nameable again, which is the whole point of clearing the
  // author too.
  assert.equal(buildNamingInput(store, REPO)[0].rows[0].id, "a");
});

test("edit() refuses a 'title' that is only the item's first words, and SAYS SO", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  assert.deepEqual(store.edit("a", { headline: "a real title" }), { ok: true },
    "a title that lands says nothing — there is nothing to report");

  const said = store.edit("a", { headline: "the picker forgets", category: "bugfix" });
  assert.equal(said.ok, true, "the row is fine and the rest of the patch landed — this is not a failed op");
  assert.match(said.refused, /"the picker forgets"/, "the refused half is named, and named in the words that were typed");
  assert.match(said.refused, /"bugfix" is not one of/, "both halves in one sentence, never two toasts racing");
  assert.equal(store.get("a").headline, "a real title",
    "a tap meant to rename a row must never be the tap that un-names it");
  assert.equal(store.get("a").category, undefined);
});

test("a title that merely OPENS with a short item is written, not silently dropped", () => {
  // The second half of the same defect: for any prompt under 40 characters the
  // old two-way rule refused every title that began with the whole prompt, and
  // the phone closed its editor over words that were gone.
  const store = makeStore();
  row(store, "a", "dark mode");
  const said = store.edit("a", { headline: "dark mode toggle for settings" });
  assert.deepEqual(said, { ok: true });
  assert.equal(store.get("a").headline, "dark mode toggle for settings");
  assert.equal(store.get("a").headlineBy, "hand");
});

test("edit() on a row that is gone is the one `ok: false`, and it is not a refusal", () => {
  const store = makeStore();
  assert.deepEqual(store.edit("nobody", { headline: "x" }), { ok: false },
    "there is no half to report on — nothing was typed at a row that exists");
});

// ── name(): a machine's ─────────────────────────────────────────────────────

test("name() writes where nobody has said, and refuses a `hand` field per HALF", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  store.edit("a", { headline: "MY OWN TITLE" });

  const wrote = store.name("a", { headline: "picker loses its scroll", category: "bug" }, "name");
  assert.deepEqual(wrote, { headline: false, category: true },
    "what comes back is what was WRITTEN, not what was offered");
  assert.equal(store.get("a").headline, "MY OWN TITLE");
  assert.equal(store.get("a").headlineBy, "hand");
  assert.equal(store.get("a").category, "bug");
  assert.equal(store.get("a").categoryBy, "name");
});

test("name() over a machine's own earlier name is allowed — that is what makes a pass repeatable", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  store.name("a", { headline: "first go" }, "assess");
  const wrote = store.name("a", { headline: "second go" }, "name");
  assert.equal(wrote.headline, true);
  assert.equal(store.get("a").headline, "second go");
  assert.equal(store.get("a").headlineBy, "name");
});

test("name() on a gone row, or with nothing usable, writes nothing", () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  assert.deepEqual(store.name("nobody", { headline: "x" }, "name"), { headline: false, category: false });
  // `bugfix` is not a synonym for `chore` and is not repaired into one.
  assert.deepEqual(store.name("a", { category: "bugfix" }, "name"), { headline: false, category: false });
  assert.equal(store.get("a").category, undefined);
});

// ── the manager ─────────────────────────────────────────────────────────────

/** A pass whose completion is whatever the test says it is. */
function makeManager(store, answer) {
  const calls = [];
  const mgr = new NamingManager({
    intents: store,
    onChange: () => {},
    run: async (req) => { calls.push(req); return answer(req, calls.length); },
  });
  return { mgr, calls };
}

const ok = (text) => ({ text, failed: !text, limited: false, durationMs: 1 });

test("a pass writes the names it was given and says what it did", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  row(store, "b", "write the migration guide for the v2 store");
  const { mgr, calls } = makeManager(store, () => ok(JSON.stringify({
    items: [
      { id: "a", headline: "picker loses its scroll", category: "bug" },
      { id: "b", headline: "migration guide for v2", category: "chore" },
    ],
  })));

  const said = await mgr.start(REPO);
  assert.equal(calls.length, 1, "two small items are one batch");
  assert.equal(said, "named 2");
  assert.equal(store.get("a").headline, "picker loses its scroll");
  assert.equal(store.get("a").headlineBy, "name");
  assert.equal(store.get("b").category, "chore");
  assert.equal(mgr.running.size, 0, "the repo is released when the pass ends");
});

test("a row the model left out stays ABSENT and is counted as unnamed", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  row(store, "b", "write the migration guide for the v2 store");
  const { mgr } = makeManager(store, () => ok(JSON.stringify({
    items: [{ id: "a", headline: "picker loses its scroll" }],
  })));

  const said = await mgr.start(REPO);
  assert.equal(said, "named 1 · 1 left unnamed — the model gave no usable title");
  assert.equal(store.get("b").headline, undefined, "a row nobody titled shows its own first line, as it always did");
});

test("a field refused because a person wrote it is REPORTED, not hidden", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  store.edit("a", { headline: "MY OWN TITLE" });
  const { mgr } = makeManager(store, () => ok(JSON.stringify({
    items: [{ id: "a", headline: "picker loses its scroll", category: "bug" }],
  })));

  const said = await mgr.start(REPO);
  assert.equal(said, "named 1 · 1 kept the name you typed",
    "the one place the rule is visible — a silent refusal looks identical to a model that said nothing");
  assert.equal(store.get("a").headline, "MY OWN TITLE");
});

test("an empty answer writes NOTHING and says why", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  const { mgr } = makeManager(store, () => ({ text: "", failed: true, limited: false, detail: "the model answered nothing", durationMs: 1 }));

  const said = await mgr.start(REPO);
  assert.equal(said, "nothing written — the model answered nothing");
  assert.equal(store.get("a").headline, undefined);
});

test("an answer nothing can be parsed out of writes NOTHING", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  const { mgr } = makeManager(store, () => ok("Sure! I had a look and here are my thoughts about your backlog."));

  const said = await mgr.start(REPO);
  assert.equal(said, "nothing written — the model gave no usable title");
  assert.equal(store.get("a").headline, undefined);
});

test("a fenced answer, and an answer with prose around it, are both read", async () => {
  for (const wrap of [
    (j) => "```json\n" + j + "\n```",
    (j) => `Here you go: ${j} — let me know if you want different ones.`,
  ]) {
    const store = makeStore();
    row(store, "a", "the picker forgets its scroll position");
    const { mgr } = makeManager(store, () => ok(wrap(JSON.stringify({ items: [{ id: "a", headline: "picker loses its scroll" }] }))));
    assert.equal(await mgr.start(REPO), "named 1");
  }
});

test("an ACCOUNT BLOCK stops the remaining batches instead of spending them", async () => {
  const store = makeStore();
  for (let i = 0; i < NAME_BATCH_ITEMS + 5; i++) row(store, `r${i}`, `item number ${i}`);
  const { mgr, calls } = makeManager(store, () => ({ text: "", failed: false, limited: true, detail: "the usage limit is reached", durationMs: 1 }));

  const said = await mgr.start(REPO);
  assert.equal(calls.length, 1, "the first batch to come back limited is the last one bought");
  assert.equal(said, "nothing written — the usage limit is reached");
});

test("a second pass while one is running is refused IN WORDS, and the first is unaffected", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  let release;
  const held = new Promise((r) => { release = r; });
  const { mgr, calls } = makeManager(store, async () => {
    await held;
    return ok(JSON.stringify({ items: [{ id: "a", headline: "picker loses its scroll" }] }));
  });

  const first = mgr.start(REPO);
  await new Promise((r) => setTimeout(r, 10));
  const second = await mgr.start(REPO);
  assert.match(second, /already running for this repo/);
  assert.equal(calls.length, 1, "the refusal spends nothing");
  assert.deepEqual(mgr.runningIds(), ["a"], "…and the rows the live pass is on are on the snapshot while it thinks");

  release();
  assert.equal(await first, "named 1");
  assert.deepEqual(mgr.runningIds(), [], "released at the end, so the next tap is allowed");
});

test("a repo with nothing to title refuses in its own words and buys nothing", async () => {
  const store = makeStore();
  row(store, "a", "already named", { headline: "MINE", headlineBy: "hand", category: "bug", categoryBy: "hand" });
  const { mgr, calls } = makeManager(store, () => ok("{}"));
  assert.match(await mgr.start(REPO), /nothing here needs a title/);
  assert.match(await mgr.start(REPO, ["a"]), /nothing in that cut needs a title/);
  assert.equal(calls.length, 0);
});

test("a runner that THROWS releases the repo — a refusal that never lifts is worse than a failure", async () => {
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  const { mgr } = makeManager(store, () => { throw new Error("the socket died"); });
  assert.equal(await mgr.start(REPO), "nothing written — the socket died");
  assert.equal(mgr.running.size, 0);
});

test("begin() answers BEFORE the pass does — the ack is not the pass", async () => {
  // The defect: `backlog.name` is `durable: true` and awaited the whole pass —
  // up to ten sequential batches at up to `NAME_TIMEOUT_MS` (120 s) each —
  // against the phone's 20 s ack deadline and 8 attempts. A pass that was
  // working perfectly was re-sent eight times (suppressed by `opsInFlight`, so
  // nothing was bought twice) and then shown as FAILED while it was still
  // running, after which the host sent up to eight acks for it.
  const store = makeStore();
  row(store, "a", "the picker forgets its scroll position");
  row(store, "b", "write the migration guide for the v2 store");
  let release;
  const held = new Promise((r) => { release = r; });
  const { mgr, calls } = makeManager(store, async () => {
    await held;
    return ok(JSON.stringify({ items: [{ id: "a", headline: "picker loses its scroll" }] }));
  });

  const started = mgr.begin(REPO);
  assert.equal(started.refusal, undefined);
  assert.equal(started.rows, 2, "the ack can say how many it is working on — the tap could not");
  // Everything below happens with the pass still in flight, which is the whole
  // point: the route returns here.
  assert.equal(calls.length, 1, "…and it really has started");
  assert.deepEqual(mgr.runningIds().sort(), ["a", "b"], "the rows ride the snapshot while it thinks");
  assert.equal(store.get("a").headline, undefined, "nothing is written yet");

  release();
  assert.equal(await started.finished, "named 1 · 1 left unnamed — the model gave no usable title",
    "and the pass's own sentence is the toast it always was, whenever it lands");
  assert.deepEqual(mgr.runningIds(), []);
});

test("begin() refuses without starting anything, and a refusal is the whole answer", () => {
  const store = makeStore();
  row(store, "a", "already named", { headline: "MINE", headlineBy: "hand", category: "bug", categoryBy: "hand" });
  const { mgr, calls } = makeManager(store, () => ok("{}"));
  const r = mgr.begin(REPO);
  assert.match(r.refusal, /nothing here needs a title/);
  assert.equal(r.finished, undefined, "there is no pass to wait for — the route acks the sentence and is done");
  assert.equal(calls.length, 0);
  assert.deepEqual(mgr.runningIds(), []);
});

// ── the sentences ───────────────────────────────────────────────────────────

test("namingSentence is the whole of what a person is told", () => {
  assert.equal(namingSentence({ named: 11, unnamed: 1, kept: 0 }), "named 11 · 1 left unnamed — the model gave no usable title");
  assert.equal(namingSentence({ named: 3, unnamed: 0, kept: 0 }), "named 3", "a zero is not mentioned");
  assert.equal(namingSentence({ named: 3, unnamed: 0, kept: 2 }), "named 3 · 2 kept the name you typed");
  assert.equal(namingSentence({ named: 0, unnamed: 4, kept: 0 }), "nothing written — the model gave no usable title");
  assert.equal(namingSentence({ named: 0, unnamed: 0, kept: 0 }), "nothing written — nothing here needed a title");
  assert.equal(namingSentence({ named: 0, unnamed: 2, kept: 0, detail: "the usage limit is reached" }),
    "nothing written — the usage limit is reached", "a failure says what failed, never that something did");
  assert.equal(namingSentence({ named: 5, unnamed: 3, kept: 0, detail: "the usage limit is reached" }),
    "named 5 · 3 left unnamed — the model gave no usable title · the usage limit is reached",
    "a half-titled list says both — the rows are real and the reason the rest are missing is the only thing that explains it");
});

test("namingStartedNote says the NUMBER and promises the sentence that follows", () => {
  assert.equal(namingStartedNote(11), "titling 11 items — this runs on, and will say what it wrote");
  assert.equal(namingStartedNote(1), "titling 1 item — this runs on, and will say what it wrote");
});
