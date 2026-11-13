import test from "node:test";
import assert from "node:assert/strict";
import {
  bucket, canInherit, chipCount, chipKeys, draftChanges, levelFor, matches, pluginTag, reconcileDraft, receiptWords, saveWords, saveNote, applyNote, suggestionName, sortRows, splitRows,
  stateTag, summaryWords, rowView, sourceWords, overriddenWords, withPin, fallbackAt, globalDraftOf, suggestionChanges, suggestionLevers, suggestionMeanings, suggestionUses, applyFilesWords, tickedChars, applyWords, spendWords, emptyWords, usageWords, usesWords, withChoice, withoutSent, moveDraft, parkedWords, reconcileSuggestions,
} from "./logic.ts";

const skill = (id, o = {}) => ({ kind: "skill", id, source: "personal", set: {}, effective: "on", from: "default", switchable: true, listingChars: 400, ...o });
const plugin = (id, o = {}) => ({ kind: "plugin", id, name: id.split("@")[0], scope: "user", set: {}, enabled: true, from: "default", skills: [], listingChars: 800, ...o });

test("the level is a different file", () => {
  assert.equal(levelFor("all", false), "global");
  assert.equal(levelFor("repo", false), "repo-local");
  assert.equal(levelFor("repo", true), "repo-shared");
});

test("a choice that changes nothing drops the draft entry", () => {
  const r = skill("a");
  let d = withChoice({}, r, "repo-local", "off");
  assert.deepEqual(d, { "skill:a": "off" });
  d = withChoice(d, r, "repo-local", "on"); // back to what it resolves to, no key at this level
  assert.deepEqual(d, {});
  // a key the level already holds: choosing it again is no change; choosing another is
  const held = skill("b", { set: { "repo-local": "off" }, effective: "off", from: "repo-local" });
  assert.deepEqual(withChoice({}, held, "repo-local", "off"), {});
  assert.deepEqual(withChoice({}, held, "repo-local", "on"), { "skill:b": "on" });
  assert.deepEqual(withChoice({}, held, "repo-local", "inherit"), { "skill:b": "inherit" });
  assert.deepEqual(withChoice({}, r, "repo-local", "inherit"), {}, "nothing to remove");
});

test("a plugin choice is a boolean and the changes carry kind and id", () => {
  const p = plugin("sales@synced");
  const d = withChoice({}, p, "global", false);
  assert.deepEqual(draftChanges(d, [p]), [{ kind: "plugin", id: "sales@synced", to: false }]);
  assert.deepEqual(draftChanges({ "skill:gone": "off" }, [p]), [], "rows that are gone are dropped");
  assert.deepEqual(reconcileDraft({ "skill:gone": "off", "plugin:sales@synced": false }, [p]), { "plugin:sales@synced": false });
});

test("inherit is offered only where this level holds a key", () => {
  const held = skill("b", { set: { global: "off" } });
  assert.equal(canInherit(held, "global", {}), true);
  assert.equal(canInherit(held, "repo-local", {}), false);
  assert.equal(canInherit(held, "global", { "skill:b": "inherit" }), false);
});

test("plugin skills and bundled skills stay out of the top-level list", () => {
  const rows = [plugin("p@synced", { skills: ["x"] }), skill("x", { source: "plugin", plugin: "p@synced" }), skill("y"), skill("z", { source: "bundled" })];
  const s = splitRows(rows);
  assert.deepEqual([s.plugins.length, s.skills.length, s.bundled.length, s.pluginSkills.size], [1, 1, 1, 1]);
});

test("a chip's number is the length of the cut it opens", () => {
  const rows = [plugin("p@synced"), skill("a", { uses: { d30: 0, all: 5, typed30: 0, typedAll: 0 } }), skill("b", { uses: { d30: 2, all: 5, typed30: 0, typedAll: 0 } }), skill("c")];
  const s = splitRows(rows);
  const draft = { "skill:a": "off" };
  for (const k of chipKeys(true)) {
    const cut = bucket(k, s, draft, true);
    assert.equal(chipCount(k, s, draft, true), cut.plugins.length + cut.skills.length, k);
  }
  assert.deepEqual(bucket("unused30", s, draft, true).skills.map((r) => r.id), ["a"], "c has no counts: not unused");
  assert.equal(chipKeys(false).includes("unused30"), false, "no counts, no chip");
});

test("sorts: heaviest puts unmeasured last, most used reads 30 days first", () => {
  const rows = [skill("a", { listingChars: 100 }), skill("b", { listingChars: undefined }), skill("c", { listingChars: 900 })];
  assert.deepEqual(sortRows(rows, "heaviest").map((r) => r.id), ["c", "a", "b"]);
  const u = (d30, all) => ({ uses: { d30, all, typed30: 0, typedAll: 0 } });
  assert.deepEqual(sortRows([skill("a", u(1, 50)), skill("b", u(3, 4)), skill("c")], "used").map((r) => r.id), ["b", "a", "c"]);
  assert.deepEqual(sortRows(rows, "name").map((r) => r.id), ["a", "b", "c"]);
});

test("search matches the id and a plugin's name", () => {
  assert.equal(matches(skill("deploy-prod"), "DEPLOY"), true);
  assert.equal(matches(plugin("sales@synced"), "sales"), true);
  assert.equal(matches(skill("a"), "zzz"), false);
  assert.equal(matches(skill("a"), "  "), true);
});

test("the summary says its split and what nobody could measure; never a bare total", () => {
  assert.equal(summaryWords({ skillChars: 4000, pluginChars: 2000, unmeasured: 2 }), "Up to ~1,500 tokens every turn: skills ~1,000 tokens, plugins ~500 tokens, and 2 items nobody could measure.");
  assert.equal(summaryWords({ unmeasured: 0 }), "Weight not measured.");
  assert.match(summaryWords({ unmeasured: 1 }), /1 item\./);
});

test("uses are absent while uncounted, and the usage line says what is happening", () => {
  assert.equal(usesWords(skill("a")), null);
  assert.equal(usesWords(skill("a", { uses: { d30: 2, all: 40, typed30: 1, typedAll: 1 } })), "used 3 in 30 days · 41 ever");
  assert.equal(usageWords({ state: "counting", done: 1204, total: 12531, since30: 0 }), "counting uses… 1,204 of 12,531 logs");
  assert.equal(usageWords({ state: "absent", why: "no logs", since30: 0 }), "no logs");
  assert.match(usageWords({ state: "ready", since30: 0 }), /this repo's Claude conversations/);
});

test("a tag appears only when the state is not the default", () => {
  assert.equal(stateTag(skill("a")), null);
  assert.equal(stateTag(skill("a", { effective: "off", from: "repo-local" })), "off here");
  assert.equal(stateTag(skill("a", { effective: "name-only", from: "global" })), "names only for all repos");
  assert.equal(stateTag(skill("a", { locked: "policy", effective: "off", from: "locked" })), "locked by policy");
  assert.equal(pluginTag(plugin("p@s")), null);
  assert.equal(pluginTag(plugin("p@s", { enabled: false, from: "global" })), "off for all repos");
});

test("the save words name the file, the count and the saving", () => {
  assert.equal(saveWords(3), "Save 3 changes");
  assert.equal(saveWords(1), "Save 1 change");
  assert.ok(saveWords(30).length < 20, "the label fits a phone");
  assert.equal(saveNote(".claude/settings.local.json", 840, 0), "Writes .claude/settings.local.json · up to about 840 tokens fewer per turn.");
  assert.equal(saveNote("f", 0, 0), "Writes f.");
  assert.match(saveNote("f", 10, 2), /plus 2 unmeasured/);
  assert.equal(receiptWords(3, "f"), "3 changes written to f; new sessions only.");
});

const sug = (id, o = {}) => ({ kind: "skill", id, to: "off", reason: "r", ...o });

test("only ticked suggestions are written, split by file; a plugin's on/off is a boolean", () => {
  const list = [sug("a"), sug("p@s", { kind: "plugin" }), sug("b", { to: "name-only" }), sug("c", { to: "on", toAll: "off" }), sug("q@s", { kind: "plugin", to: undefined, toAll: "off" })];
  assert.deepEqual(suggestionChanges(list, ["skill:b"]), {
    all: [{ kind: "skill", id: "c", to: "off" }, { kind: "plugin", id: "q@s", to: false }],
    here: [{ kind: "skill", id: "a", to: "off" }, { kind: "plugin", id: "p@s", to: false }, { kind: "skill", id: "c", to: "on" }],
  });
  assert.deepEqual(suggestionChanges(list, list.map((s) => `${s.kind}:${s.id}`)), { all: [], here: [] });
  const c = suggestionChanges(list, []);
  assert.equal(applyFilesWords(c, "~/.claude/settings.json", ".claude/settings.local.json"), "Writes ~/.claude/settings.json for all repos (2) and .claude/settings.local.json for this repo (4).");
});

test("a suggestion names both levers, what its words mean, and the counts it rests on", () => {
  assert.deepEqual(suggestionLevers(sug("a", { to: "name-only" }), [skill("a")]), { all: null, here: "This repo: on → names only" });
  assert.deepEqual(suggestionLevers(sug("a", { to: "on", toAll: "off" }), [skill("a")]), { all: "All repos: on → off", here: "This repo: stays on (kept for this repo)" });
  assert.deepEqual(suggestionLevers(sug("a", { to: undefined, toAll: "name-only" }), [skill("a")]), { all: "All repos: on → names only", here: "This repo: follows All repos, on → names only" });
  assert.equal(suggestionLevers(sug("a", { to: undefined, toAll: "off" }), [skill("a", { set: { "repo-local": "on" } })]).here, "This repo: keeps its own value, on");
  assert.deepEqual(suggestionLevers(sug("p@s", { kind: "plugin" }), [plugin("p@s")]), { all: null, here: "This repo: on → off" });
  const m = suggestionMeanings([sug("a", { to: "off" }), sug("b", { to: "name-only", toAll: "off" }), sug("c", { to: "on", toAll: "off" })]);
  assert.equal(m.length, 2, "each word once, on not glossed");
  assert.match(m[0], /^names only: Claude sees only its name/);
  assert.match(m[1], /^off: /);
  assert.equal(suggestionUses(sug("a", { uses30: 0, usesAll: 2, everywhere30: 1, everywhereAll: 9 })), "this repo 0 in 30 days, 2 ever · all repos 1 in 30 days, 9 ever");
});

test("a suggestion says from to, and the saving counts only ticked host figures", () => {
  const list = [sug("a", { savedChars: 400 }), sug("b", { savedChars: 800 }), sug("c")];
  assert.equal(tickedChars(list, ["skill:b"]), 400);
  assert.equal(applyWords(2), "Apply 2 suggestions");
  assert.equal(applyWords(1), "Apply 1 suggestion");
  assert.equal(applyNote(1200), "Up to about 300 tokens fewer per turn.");
  assert.equal(applyNote(0), null);
  assert.equal(suggestionName({ kind: "plugin", id: "legal@synced", to: "off" }, [{ kind: "plugin", id: "legal@synced", name: "legal" }]), "legal");
  assert.equal(suggestionName({ kind: "skill", id: "x", to: "off" }, []), "x");
});

test("the spend line and the empty sentence come from the host", () => {
  assert.equal(spendWords({ costUsd: 0.004, model: "haiku" }, 2), "this suggestion cost under 1 cent on haiku; 2 the desktop could not use were left out.");
  assert.equal(spendWords(undefined, 0), null);
  assert.equal(emptyWords({ ok: false, suggestions: [], dropped: 0, error: "Usage limit." }), "Usage limit.");
  assert.match(emptyWords({ ok: true, suggestions: [], dropped: 0 }), /Nothing worth/);
});

test("switching file or repo sets the draft aside and brings it back; nothing typed is dropped", () => {
  const d = { "skill:a": "off", "skill:b": "name-only" };
  const away = moveDraft({}, { repoId: "r1", level: "repo-local", draft: d }, { repoId: "r1", level: "global" });
  assert.deepEqual(away.draft, {});
  assert.match(parkedWords(away.parked, "r1", "global"), /^2 unsaved choices are kept for This repo/);
  assert.equal(parkedWords(away.parked, "r2", "global"), null);
  const back = moveDraft(away.parked, { repoId: "r1", level: "global", draft: {} }, { repoId: "r1", level: "repo-local" });
  assert.deepEqual(back.draft, d);
  assert.deepEqual(back.parked, {});
  const other = moveDraft(away.parked, { repoId: "r1", level: "global", draft: { "plugin:p": false } }, { repoId: "r2", level: "repo-local" });
  assert.deepEqual(other.draft, {});
  assert.equal(Object.keys(other.parked).length, 2, "both repos' drafts are kept");
});

test("suggestions that a save or re-read made untrue are dropped (never off -> names)", () => {
  const sug = (id, to, kind = "skill") => ({ kind, id, to, reason: "r" });
  const rows = [skill("a", { effective: "off" }), skill("b", { effective: "on" }), skill("c", { effective: "name-only" }), plugin("p@x", { enabled: false }), plugin("q@x")];
  const out = reconcileSuggestions([sug("a", "name-only"), sug("b", "name-only"), sug("c", "off"), sug("gone", "off"), sug("p@x", "off", "plugin"), sug("q@x", "off", "plugin")], rows);
  assert.deepEqual(out.map((s) => s.id), ["b", "c", "q@x"]);
  // Each lever on its own: All repos never raised back; a keep only while All repos is still lowered.
  const both = reconcileSuggestions([
    { kind: "skill", id: "k", to: "on", toAll: "off", reason: "r" }, { kind: "skill", id: "m", to: "on", toAll: "off", reason: "r" }, { kind: "skill", id: "n", toAll: "name-only", reason: "r" },
  ], [skill("k"), skill("m", { set: { global: "off" } }), skill("n", { set: { global: "off" } })]);
  assert.deepEqual(both.map((s) => [s.id, s.toAll, s.to]), [["k", "off", "on"]]);
});

test("a tap at a level that holds no key writes, even when another level already gives that value", () => {
  const shadowed = skill("s", { set: { "repo-local": "off" }, effective: "off", from: "repo-local" });
  assert.deepEqual(withChoice({}, shadowed, "global", "off"), { "skill:s": "off" }, "global holds nothing, so off is a write");
  const p = plugin("x@y", { set: { "repo-local": false }, enabled: false, from: "repo-local" });
  assert.deepEqual(withChoice({}, p, "global", false), { "plugin:x@y": false });
  const plain = skill("t"); // nothing anywhere: tapping the default is still no change
  assert.deepEqual(withChoice({}, plain, "global", "on"), {});
});

test("a save clears only the entries it sent; taps made during the round trip stay", () => {
  const draft = { "skill:a": "off", "skill:b": "name-only", "skill:c": "off" };
  const sent = [{ kind: "skill", id: "a", to: "off" }, { kind: "skill", id: "b", to: "off" }];
  assert.deepEqual(withoutSent(draft, sent), { "skill:b": "name-only", "skill:c": "off" }, "b was changed after it was sent, c was never sent");
});

test("a repo row follows All repos until it is changed here", () => {
  const p = plugin("sales@synced", { set: { global: false }, enabled: false, from: "global" });
  const v = rowView(p, "repo-local", {});
  assert.equal(v.value, false);
  assert.equal(v.own, false);
  assert.equal(sourceWords(v), "follows All repos: off");
  assert.equal(sourceWords(rowView(plugin("plain@y"), "repo-local", {})), null, "nothing set anywhere: the row says nothing");
  // tapping the value it already follows is no change: it keeps following
  assert.deepEqual(withChoice({}, p, "repo-local", false), {});
  // a different value is this repo's own
  const d = withChoice({}, p, "repo-local", true);
  assert.deepEqual(d, { "plugin:sales@synced": true });
  assert.equal(sourceWords(rowView(p, "repo-local", d)), "set for this repo · overrides All repos: off");
});

test("an unsaved All-repos choice shows on the repo rows that follow it", () => {
  const p = plugin("sales@synced");
  const g = { "plugin:sales@synced": false };
  const v = rowView(p, "repo-local", {}, g);
  assert.equal(v.value, false);
  assert.equal(sourceWords(v), "follows All repos (unsaved): off");
  assert.deepEqual(globalDraftOf({ "r1\nglobal": g }, "r1", "repo-local", {}), g);
  assert.deepEqual(globalDraftOf({}, "r1", "global", g), g);
  // a repo that set its own value is not moved by it
  const own = plugin("data@synced", { set: { "repo-local": true }, from: "repo-local" });
  assert.equal(rowView(own, "repo-local", {}, { "plugin:data@synced": false }).value, true);
});

test("All repos shows the all-repos value, not this repo's, and says when this repo overrides it", () => {
  const p = plugin("sales@synced", { set: { global: false, "repo-local": true }, enabled: true, from: "repo-local" });
  const v = rowView(p, "global", {});
  assert.equal(v.value, false);
  assert.match(overriddenWords(v), /This repo sets its own: on/);
  assert.equal(overriddenWords(rowView(plugin("x@y"), "global", {})), null);
  const s = skill("a", { set: { "repo-local": "off" }, effective: "off", from: "repo-local" });
  assert.equal(rowView(s, "global", {}).value, "on");
});

test("keep for this repo pins the followed value; follow removes it", () => {
  const s = skill("a", { set: { global: "name-only" }, effective: "name-only", from: "global" });
  const pinned = withPin({}, s, "repo-local");
  assert.deepEqual(pinned, { "skill:a": "name-only" });
  assert.equal(withChoice(pinned, s, "repo-local", "name-only"), pinned, "tapping the kept value keeps it");
  assert.equal(sourceWords(rowView(s, "repo-local", pinned)), "kept for this repo · All repos: names only");
  assert.equal(fallbackAt(s, "repo-local").from, "global");
  const held = skill("b", { set: { "repo-local": "off", global: "on" }, effective: "off", from: "repo-local" });
  assert.deepEqual(withPin({}, held, "repo-local"), {}, "already its own");
  assert.equal(rowView(held, "repo-local", { "skill:b": "inherit" }).value, "on");
  assert.equal(canInherit(skill("c"), "repo-local", { "skill:c": "off" }), true, "an unsaved own value can be undone");
});
