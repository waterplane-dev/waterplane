// The set-up page's one cut: rows, the ticks it opens with, and what Go does.
// Reasoning: packages/shared/src/reposetup.ts, docs/analysis/repo-setup/PLAN.md.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_GATED_FIXES, OPT_INS, OPT_IN_GROUPS, SETUP_BASICS, optInDef, optInKind, setupDefaultTicks, setupPlan, setupRows, tickGroupsFirst,
} from "../dist/index.js";

const off = (id, o = {}) => ({ id, relevant: true, state: "off", detail: `saw ${id}`, ...o });
const every = (o = {}) => OPT_INS.map((d) => off(d.id, o));
const check = (id, fix, o = {}) => ({ id, label: `label ${id}`, status: "warn", detail: "", fix, ...o });
const flat = (r) => r.groups.flatMap((g) => g.rows);
const keys = (rows) => rows.map((r) => r.key);

test("every offer has a known group, a preset implies a free tick, and no offer is called basics", () => {
  const groups = OPT_IN_GROUPS.map((g) => g.id);
  for (const d of OPT_INS) {
    assert.ok(groups.includes(d.group), d.id);
    if (d.preset) assert.equal(optInKind(d), "free", d.id);
    assert.notEqual(d.id, SETUP_BASICS);
  }
  assert.deepEqual(OPT_INS.filter((d) => d.preset).map((d) => d.id), ["requirements", "exposure-watch", "apk-download"]);
});

test("the kind is the action's: fix and download free, agent and schedule paid, open and a confirm-gated fix a door", () => {
  assert.equal(optInKind(optInDef("requirements")), "free");
  assert.equal(optInKind(optInDef("apk-download")), "free");
  assert.equal(optInKind(optInDef("local-ci")), "paid");
  assert.equal(optInKind(optInDef("security-review")), "paid");
  assert.equal(optInKind(optInDef("links")), "door");
  assert.equal(optInKind(optInDef("local-ci-status")), "door");
  for (const fix of CONFIRM_GATED_FIXES) assert.equal(optInKind({ action: { kind: "fix", fix } }), "door", fix);
});

test("rows are offered plus started, in group and catalog order; on is the active list, declined and unfit are nowhere", () => {
  const r = setupRows({ rows: [
    off("local-ci"), off("links"), off("requirements", { partial: true }), off("npm-supply-chain", { relevant: false }),
    off("gcp-cleanup", { choice: "declined" }), off("repo-health", { state: "on" }), off("apk-download", { choice: "done" }),
    off("from-a-newer-desktop"),
  ] }, []);
  assert.deepEqual(r.groups.map((g) => [g.group, keys(g.rows)]), [["track", ["requirements"]], ["quality", ["local-ci"]], ["phone", ["links"]]]);
  assert.deepEqual(r.active.map((x) => x.id), ["repo-health", "apk-download"]);
  const links = flat(r).find((x) => x.key === "links");
  assert.equal(links.verb, optInDef("links").verb);
  assert.equal(links.detail, "saw links");
});

test("order: groups with a tick row first, door-only groups after, doors after tick rows inside a group; stable otherwise", () => {
  const door = (key) => ({ key, kind: "door" });
  const free = (key) => ({ key, kind: "free" });
  const paid = (key) => ({ key, kind: "paid" });
  const out = tickGroupsFirst([
    { group: "a", title: "A", rows: [door("a1")] },
    { group: "b", title: "B", rows: [door("b1"), paid("b2"), free("b3")] },
    { group: "c", title: "C", rows: [door("c1"), door("c2")] },
    { group: "d", title: "D", rows: [free("d1")] },
  ]);
  assert.deepEqual(out.map((g) => g.group), ["b", "d", "a", "c"]);
  assert.deepEqual(out[0].rows.map((r) => r.key), ["b2", "b3", "b1"]);
  assert.deepEqual(out[3].rows.map((r) => r.key), ["c1", "c2"]);
  // Kind, not state: a started or unknown row is still a tick row, so ticking or Go moves nothing.
  const real = setupRows({ rows: every({ sent: { at: 5, status: "running" } }) }, []);
  assert.deepEqual(real.groups.map((g) => g.group), tickGroupsFirst(real.groups).map((g) => g.group));
});

test("basics: the one-tap checklist fixes, each fix once, first in the list; gated, host, watch, ignored and an offer's own fix are not in it", () => {
  const r = setupRows({ rows: [off("links")] }, [
    check("gitignore", "gitignore"), check("gitignore-2", "gitignore"), check("claude-md", "claude-md"),
    check("ok", "state-dir", { status: "pass" }), check("agent-job", null), check("signing", "signing-key"),
    check("gemini", "host-key", { scope: "host" }), check("card", "scorecard", { watch: true }),
    check("weight", "weight", { advisory: true }), check("req", "requirements"),
  ]);
  assert.deepEqual(r.groups.map((g) => g.group), ["basics", "phone"]);
  const b = r.groups[0].rows[0];
  assert.deepEqual(b.fixes, ["gitignore", "claude-md"]);
  assert.equal(b.detail, "label gitignore, label gitignore-2, label claude-md");
  assert.equal(b.kind, "free");
  assert.deepEqual(setupRows({ rows: [] }, [check("signing", "signing-key")]), { groups: [], active: [] });
});

test("R-onboarding-035: default ticks: the basics and the free presets; never a paid row, a door, or one already begun", () => {
  const all = flat(setupRows({ rows: every() }, [check("gitignore", "gitignore")]));
  assert.deepEqual(setupDefaultTicks(all).sort(), ["apk-download", "basics", "exposure-watch", "requirements"]);
  for (const status of ["waiting", "running", "open", "ended"]) {
    const sent = { at: 5, status };
    const rows = flat(setupRows({ rows: every({ sent }) }, []));
    assert.deepEqual(setupDefaultTicks(rows), [], status);
    assert.ok(rows.every((x) => x.started && x.sent === sent), status);
  }
  assert.deepEqual(setupDefaultTicks(flat(setupRows({ rows: [off("apk-download", { partial: true })] }, []))), []);
  // A preset that lost its free kind is still not a tick.
  assert.deepEqual(setupDefaultTicks([{ key: "x", kind: "paid", preset: true, title: "", pitch: "", cost: "", detail: "" }]), []);
});

test("a row the desktop could not read is drawn, says so, and is never ticked in advance", () => {
  const rows = flat(setupRows({ rows: every({ state: "unknown" }) }, []));
  assert.ok(rows.length > 0 && rows.every((r) => r.unknown === true));
  assert.deepEqual(setupDefaultTicks(rows), []);
  assert.ok(flat(setupRows({ rows: every() }, [])).every((r) => !("unknown" in r)));
});

test("a download that is on but whose rule leaves the file out is a door, not a tick", () => {
  const [row] = flat(setupRows({ rows: [off("apk-download", { partial: true })] }, []));
  assert.deepEqual([row.kind, row.verb], ["door", "open downloads"]);
  assert.equal(setupPlan([row], ["apk-download"]).n, 0);
});

test("R-onboarding-036: a suggestion rides its row, changes no default tick, and a door carries none", () => {
  const picks = [{ id: "requirements", want: false, why: "no users yet" }, { id: "local-ci", want: true, why: "has tests" }, { id: "links", want: true, why: "x" }];
  const rows = flat(setupRows({ rows: every(), picks }, []));
  const of = (k) => rows.find((r) => r.key === k);
  assert.deepEqual(of("requirements").pick, { want: false, why: "no users yet" });
  assert.deepEqual(of("local-ci").pick, { want: true, why: "has tests" });
  assert.ok(!("pick" in of("links")));
  assert.deepEqual(setupDefaultTicks(rows), setupDefaultTicks(flat(setupRows({ rows: every() }, []))));
});

test("the plan is exactly the ticked rows, split by what Go does with them; a door and an unknown key are not ticks", () => {
  const rows = flat(setupRows({ rows: every() }, [check("gitignore", "gitignore")]));
  const p = setupPlan(rows, ["basics", "requirements", "security-review", "local-ci", "links", "local-ci-status", "nope", "basics"]);
  assert.deepEqual(keys(p.free), ["basics", "requirements"]);
  assert.deepEqual(keys(p.paid), ["security-review", "local-ci"]);
  assert.equal(p.n, 4);
  assert.deepEqual(setupPlan(rows, new Set()), { free: [], paid: [], n: 0 });
});
