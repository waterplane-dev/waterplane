// The set-up page's pure half: ticks, outcomes, Go's order, and the footer's words.
import test from "node:test";
import assert from "node:assert/strict";
import { OPT_INS, SETUP_BASICS, SHORT_MAX, optInPrompt, setupRows } from "@waterplane/shared";
import {
  NO_RUN, afterLeave, fixOutcomes, flatRows, footerView, goLabel, goSteps, outcomeWords, pageRows, paidWords, picksWords, planNow,
  planWords, freeWords, untickPaid, queuedOptIns, resultWords, settled, shownOutcomes, standing, tickable, tickedKeys, withPicks,
} from "./logic.ts";

const off = (id, o = {}) => ({ id, relevant: true, state: "off", detail: "", ...o });
const check = (id, fix, o = {}) => ({ id, label: id, status: "warn", detail: "", fix, ...o });
const live = (o = {}, checks = [check("gitignore", "gitignore")]) => setupRows({ rows: OPT_INS.map((d) => off(d.id, o)) }, checks);
const none = new Set();
const run = (o = {}) => ({ ...NO_RUN, ...o });
const keys = (it) => [...it].sort();

test("ticks: the page's own, with only the person's changes over them, whatever a reload brings", () => {
  const rows = flatRows(live().groups);
  assert.deepEqual(keys(tickedKeys(rows, run(), none)), ["apk-download", "basics", "exposure-watch", "requirements"]);
  const mine = run({ ticks: { requirements: false, "local-ci": true } });
  assert.deepEqual(keys(tickedKeys(rows, mine, none)), ["apk-download", "basics", "exposure-watch", "local-ci"]);
  // The checklist arriving later adds its row ticked and moves nothing else.
  const early = flatRows(live({}, []).groups);
  assert.deepEqual(keys(tickedKeys(early, mine, none)), ["apk-download", "exposure-watch", "local-ci"]);
  // A tick for a row no longer drawn, and a door, are not ticks.
  assert.ok(!tickedKeys(rows, run({ ticks: { links: true, nope: true } }), none).has("links"));
});

test("R-onboarding-035: the plan, the button and the rows ticked are one cut", () => {
  const rows = flatRows(live().groups);
  const r = run({ ticks: { "local-ci": true, "security-review": true } });
  const plan = planNow(rows, r, none);
  assert.equal(plan.n, tickedKeys(rows, r, none).size);
  assert.equal(footerView(plan, r, { auto: true, tickableN: 9, unread: false }).go, `Set up these ${plan.n}`);
  assert.equal(goLabel(1), "Set up this one");
});

test("a row with an outcome, or words already in the queue, carries no tick", () => {
  const rows = flatRows(live().groups);
  const ci = rows.find((r) => r.key === "local-ci");
  for (const o of [{ s: "waiting" }, { s: "running" }, { s: "done", text: "" }, { s: "queued", ackId: "a", after: 0 }, { s: "failed", text: "", retry: true }]) {
    assert.equal(tickable(ci, { "local-ci": o }, none), false, o.s);
    assert.equal(planNow(rows, run({ ticks: { "local-ci": true }, outcomes: { "local-ci": o } }), none).paid.length, 0, o.s);
  }
  assert.equal(tickable(ci, {}, new Set(["local-ci"])), false);
  assert.equal(tickable(ci, {}, none), true);
});

test("the basics' done covers the fixes it ran, and no later one", () => {
  const row = flatRows(live().groups).find((r) => r.key === SETUP_BASICS);
  const done = { basics: { s: "done", text: "done", fixes: ["gitignore"] } };
  assert.ok(standing(row, done));
  const more = flatRows(live({}, [check("gitignore", "gitignore"), check("c", "claude-md")]).groups).find((r) => r.key === SETUP_BASICS);
  assert.equal(standing(more, done), null);
});

test("a post speaks for its row until the desktop says that very post came to nothing", () => {
  const at = (sent) => flatRows(live({ sent }).groups).find((r) => r.key === "local-ci");
  const done = { "local-ci": { s: "done", text: "in the backlog", after: 100 } };
  assert.ok(standing(at({ at: 200, status: "waiting" }), done));
  assert.ok(standing(at({ at: 200, status: "done" }), done));
  assert.ok(standing(at({ at: 100, status: "failed" }), done), "the send before this one");
  for (const status of ["failed", "canceled", "ended"]) assert.equal(standing(at({ at: 200, status }), done), null, status);
});

test("the queue remembers what a reload forgets: an item, a schedule, an open; another repo's is not this one's", () => {
  const ci = optInPrompt("local-ci", "r");
  const sec = optInPrompt("security-review", "r");
  const entries = [
    { cwd: "/r", text: ci },
    { cwd: "", text: "Weekly", op: { t: "schedule.save", entry: { action: { repoDir: "/r", text: sec } } } },
    { cwd: "/other", text: optInPrompt("gcp-cleanup", "o") },
    { cwd: "/r", text: "nothing to do with it" },
  ];
  assert.deepEqual(keys(queuedOptIns(entries, "/r")), ["local-ci", "security-review"]);
  assert.deepEqual(keys(queuedOptIns(entries, "/other")), ["gcp-cleanup"]);
});

test("R-onboarding-036: suggestions set the ticks of exactly the rows they name", () => {
  const picks = [{ id: "requirements", want: false, why: "x" }, { id: "local-ci", want: true, why: "y" }];
  const rows = flatRows(setupRows({ rows: OPT_INS.map((d) => off(d.id)), picks }, []).groups);
  assert.deepEqual(withPicks({ "gcp-cleanup": true }, rows), { "gcp-cleanup": true, requirements: false, "local-ci": true });
  assert.equal(picksWords(rows), "suggestions used: 1 ticked, 1 unticked");
});

test("R-onboarding-035: Go: every fix in one call, then the download, then one post per paid row", () => {
  const rows = flatRows(live().groups);
  const steps = goSteps(planNow(rows, run({ ticks: { "security-review": true, "local-ci": true } }), none));
  assert.deepEqual(steps.map((s) => s.kind), ["fix", "download", "post", "post"]);
  assert.deepEqual(keys(steps[0].fixes), ["exposure-watch", "gitignore", "requirements"]);
  assert.deepEqual(keys(steps.slice(2).map((s) => s.row.key)), ["local-ci", "security-review"]);
  assert.deepEqual(goSteps({ free: [], paid: [] }), []);
});

test("fix outcomes: one row carries the desktop's words, several get a verdict each and the words once", () => {
  const rows = flatRows(live().groups);
  const basics = rows.find((r) => r.key === "basics");
  const req = rows.find((r) => r.key === "requirements");
  const one = fixOutcomes([basics], { ok: true, applied: ["gitignore"], notes: ["gitignore += .x"] });
  assert.deepEqual(one, { outcomes: { basics: { s: "done", text: "gitignore += .x", fixes: ["gitignore"] } }, said: [] });
  const two = fixOutcomes([basics, req], { ok: true, applied: ["requirements"], notes: ["a", "b"], report: { checks: [check("gitignore", "gitignore")] } });
  assert.equal(two.outcomes.requirements.s, "done");
  assert.deepEqual(two.outcomes.basics, { s: "failed", text: "the desktop changed nothing here", retry: true });
  assert.deepEqual(two.said, ["a", "b"]);
  // Already right by the time it ran: nothing applied, and the re-run checklist no longer asks.
  assert.equal(fixOutcomes([basics], { ok: true, applied: [], notes: [], report: { checks: [] } }).outcomes.basics.s, "done");
  const bad = fixOutcomes([basics, req], { ok: false, applied: ["gitignore"], notes: [], error: "disk full" });
  assert.equal(bad.outcomes.basics.s, "done");
  assert.match(bad.outcomes.requirements.text, /The desktop said: disk full/);
  assert.equal(fixOutcomes([req], { ok: false, applied: [], notes: [], error: "timed out" }, true).outcomes.requirements.text, "no answer from the desktop (timed out)");
});

test("a queued post reads queued until the receipt; refused may be tried again, unknown may not", () => {
  const q = { s: "queued", ackId: "a1", after: 7 };
  assert.match(outcomeWords(q), /^queued/);
  assert.equal(settled(q, null), null);
  assert.equal(settled(q, { kind: "pending" }), null);
  assert.deepEqual(settled(q, { kind: "acked" }), { s: "done", text: "in the backlog", after: 7 });
  assert.equal(settled({ ...q, rule: true }, { kind: "acked" }).text, "weekly schedule saved");
  const no = settled(q, { kind: "refused", reason: "no such repo" });
  assert.deepEqual([no.retry, no.ackId, no.text], [true, "a1", "The desktop said: no such repo"]);
  assert.equal(settled(q, { kind: "dropped", reason: "timed out" }).retry, false);
  assert.equal(settled({ s: "done", text: "" }, { kind: "refused" }), null);
});

test("rows Go ran stay on the page, in their place, and are not counted as already on too", () => {
  const before = live();
  const kept = before.groups;
  const after = setupRows({ rows: OPT_INS.map((d) => (d.id === "requirements" ? off(d.id, { state: "on" }) : off(d.id))) }, []);
  const outcomes = { requirements: { s: "done", text: "" }, basics: { s: "done", text: "", fixes: ["gitignore"] } };
  const page = pageRows(after, { kept, outcomes });
  assert.deepEqual(flatRows(page.groups).map((r) => r.key), flatRows(before.groups).map((r) => r.key));
  assert.deepEqual(page.active, []);
  // A row that went without Go having run it is not kept, and with nothing run the live page stands.
  assert.ok(!flatRows(pageRows(after, { kept, outcomes: {} }).groups).some((r) => r.key === "requirements"));
  assert.equal(pageRows(after, { kept: [], outcomes }), after);
});

test("leaving forgets a failure, never what landed, is queued, or has a refused queue row to replace", () => {
  const r = afterLeave(run({
    kept: live().groups, said: ["x"], ticks: { a: true },
    outcomes: { a: { s: "failed", text: "", retry: true }, b: { s: "failed", text: "", retry: true, ackId: "z" }, c: { s: "done", text: "" }, d: { s: "queued", ackId: "q", after: 0 } },
  }));
  assert.deepEqual(keys(Object.keys(r.outcomes)), ["b", "c", "d"]);
  assert.deepEqual([r.kept, r.said, r.ticks], [[], [], { a: true }]);
});

test("the line above the button says when the paid ones run, by the person's own auto switch", () => {
  const rows = flatRows(live().groups);
  const of = (ticks) => planNow(rows, run({ ticks: { basics: false, requirements: false, "exposure-watch": false, "apk-download": false, ...ticks } }), none);
  assert.equal(planWords(of({ basics: true }), true), "Runs now, free: Fix the basics.");
  assert.equal(planWords(of({ "local-ci": true }), true), "1 goes to the backlog: it starts by itself when this repo is free.");
  assert.equal(planWords(of({ "local-ci": true }), false), "1 goes to the backlog: auto is off, so it waits there until you start it.");
  assert.equal(planWords(of({ "local-ci": true, "npm-supply-chain": true, requirements: true, "security-review": true }), false),
    "Runs now, free: Requirements list. 2 go to the backlog: auto is off, so they wait there until you start them. 1 becomes a weekly schedule.");
  assert.equal(paidWords({ kind: "agent" }), "costs an agent session");
});

test("the free clause names what runs when the names fit one line, else counts", () => {
  assert.equal(freeWords([{ title: "Exposure watch" }, { title: "Requirements list" }]), "Runs now, free: Exposure watch, Requirements list.");
  const four = ["Exposure watch", "Requirements list", "Fix the basics", "Phone downloads"].map((title) => ({ title }));
  assert.equal(freeWords(four), "4 run now, free.");
  assert.equal(freeWords(four.slice(0, 1)), "Runs now, free: Exposure watch.");
});

test("nothing paid stays ticked after Go: a reset outcome brings the row back unticked, only a fresh tap ticks it", () => {
  const rows = flatRows(live().groups);
  const ci = rows.find((r) => r.key === "local-ci");
  const basics = rows.find((r) => r.key === SETUP_BASICS);
  const before = run({ ticks: { "local-ci": true } });
  assert.deepEqual(planNow(rows, before, none).paid.map((r) => r.key), ["local-ci"]);
  // Go takes the paid row and the free one; only the paid tick is cleared.
  const ticks = untickPaid(before.ticks, [ci, basics]);
  assert.deepEqual(ticks, { "local-ci": false });
  // Its post was sent, then the item was cancelled: the later "sent" state resets the outcome.
  const outcomes = { "local-ci": { s: "done", text: "in the backlog", after: 100 } };
  const reset = flatRows(live({ sent: { at: 200, status: "canceled" } }).groups);
  assert.equal(standing(reset.find((r) => r.key === "local-ci"), outcomes), null);
  const gone = run({ ticks, outcomes });
  assert.ok(!tickedKeys(reset, gone, none).has("local-ci"));
  assert.ok(!planNow(reset, gone, none).paid.some((r) => r.key === "local-ci"));
  // A fresh tap, or the suggestions, tick it again.
  assert.ok(tickedKeys(reset, run({ ticks: { ...ticks, "local-ci": true }, outcomes }), none).has("local-ci"));
  const picked = flatRows(setupRows({ rows: OPT_INS.map((d) => off(d.id, { sent: { at: 200, status: "canceled" } })), picks: [{ id: "local-ci", want: true, why: "y" }] }, []).groups);
  assert.equal(withPicks(ticks, picked)["local-ci"], true);
});

test("the footer: nothing ticked is a sentence, running has no button, a result counts its failures", () => {
  const rows = flatRows(live().groups);
  const empty = { free: [], paid: [], n: 0 };
  const o = { auto: true, tickableN: 4, unread: false };
  assert.deepEqual(footerView(empty, NO_RUN, o), { line: "Nothing ticked, so there is nothing to set up.", go: null, leave: "skip" });
  assert.equal(footerView(empty, NO_RUN, { ...o, unread: true }).line, "Nothing is read yet, so there is nothing to tick.");
  assert.equal(footerView(empty, NO_RUN, { ...o, tickableN: 0 }).line, "Nothing here to tick.");
  const busy = footerView(planNow(rows, NO_RUN, none), run({ busy: true, outcomes: { basics: { s: "running" }, requirements: { s: "waiting" } } }), o);
  assert.deepEqual(busy, { line: "Setting up: 2 to go.", go: null, leave: "done" });
  const outcomes = { basics: { s: "done", text: "" }, requirements: { s: "failed", text: "", retry: true }, "local-ci": { s: "queued", ackId: "a", after: 0 } };
  assert.deepEqual(footerView(empty, run({ outcomes }), o), { line: "1 done, 1 queued, 1 did not work.", go: null, leave: "done" });
  assert.equal(resultWords(shownOutcomes(rows.filter((r) => r.key === "basics"), { ...outcomes, basics: { s: "done", text: "" } })), "1 done.");
  // More can be ticked after a run: the button is back, the way out stays `done`.
  assert.equal(footerView(planNow(rows, run({ outcomes }), none), run({ outcomes }), o).leave, "done");
});

test("every row has one short line within the cap, plain words", () => {
  for (const r of flatRows(live().groups)) {
    assert.ok(r.short && r.short.length <= SHORT_MAX, `${r.key}: ${r.short}`);
    assert.ok(r.short.length < r.pitch.length || r.key === SETUP_BASICS);
  }
  for (const d of OPT_INS) assert.ok(d.short.length <= SHORT_MAX && d.short.length > 10, d.id);
});
