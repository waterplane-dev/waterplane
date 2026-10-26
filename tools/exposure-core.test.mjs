// node --test: the pure decisions of the exposure watch (tools/exposure/core.mjs) — one key per
// advisory, what carries over between runs, accepts and when they lapse, the exit code and the
// release gate. Values in, values out; nothing here reads a file or the network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRE_ACCEPTED, a4Findings, applyAccepts, carryForward, depDiff, exitCode, findingKey, firstRunOff, gateVerdict, installScriptReadings, isNew,
  mergeAdvisories, readLastRow, renderText, semverCmp, settingChanges, untilVersionProblem,
} from "./exposure/core.mjs";

const NOW = "2026-10-26T00:00:00Z";
const f = (o) => {
  const base = { measure: "A1", subject: "pkg", level: "alert", text: "t", sources: ["x"], ...o };
  return { key: findingKey(base), ...base };
};
const row = (o = {}) => ({ v: 1, at: NOW, repo: "r", dir: "/r", findings: [], absent: [], readings: {}, ...o });

test("key: an advisory id makes A1 and B1 one key; otherwise measure:subject@version", () => {
  assert.equal(findingKey({ measure: "A1", subject: "lodash", advisory: "GHSA-1" }), findingKey({ measure: "B1", subject: "lodash", advisory: "GHSA-1" }));
  assert.equal(findingKey({ measure: "A3", subject: "x", version: "1.0.0" }), "A3:x@1.0.0");
  assert.equal(findingKey({ measure: "A2", subject: "node-pty" }), "A2:node-pty");
});

test("mergeAdvisories: A1 + B1 for one GHSA collapse; sources unioned, max severity, direct OR'd, alert wins", () => {
  const a = f({ measure: "A1", advisory: "GHSA-1", severity: "moderate", level: "digest", sources: ["npm audit"], direct: false });
  const b = f({ measure: "B1", advisory: "GHSA-1", severity: "high", level: "alert", sources: ["dependabot"], direct: true });
  const out = mergeAdvisories([a, b, f({ subject: "other" })]);
  assert.equal(out.length, 2);
  const m = out[0];
  assert.equal(m.measure, "A1");
  assert.deepEqual(m.sources, ["npm audit", "dependabot"]);
  assert.equal(m.severity, "high");
  assert.equal(m.direct, true);
  assert.equal(m.level, "alert");
});

test("carryForward keeps `since`, stamps new findings, and re-adds an open A4 while the package still has the script", () => {
  const a4 = { ...f({ measure: "A4", subject: "esbuild", version: "0.1.0" }), since: "2026-10-01" };
  const old = f({ measure: "A3", subject: "old", since: "2026-09-01" });
  const prev = row({ findings: [a4, old] });
  const cur = [f({ measure: "A3", subject: "old" }), f({ measure: "A3", subject: "fresh" })];
  const out = carryForward(prev, cur, { installScripts: ["esbuild@0.2.0"] }, NOW);
  assert.equal(out.find((x) => x.subject === "old").since, "2026-09-01");
  assert.equal(out.find((x) => x.subject === "fresh").since, NOW);
  assert.equal(out.find((x) => x.measure === "A4").since, "2026-10-01");
  const gone = carryForward(prev, cur, { installScripts: [] }, NOW);
  assert.ok(!gone.some((x) => x.measure === "A4"), "package lost its script: the finding goes");
  assert.equal(carryForward(null, cur, {}, NOW).every((x) => x.since === NOW), true);
});

test("a4Findings: first run is the baseline; later runs flag only names new to the list, ignoring version", () => {
  assert.deepEqual(a4Findings(null, ["a@1.0.0"]), []);
  const out = a4Findings({ installScripts: ["a@1.0.0"] }, ["a@2.0.0", "@s/b@3.0.0"]);
  assert.deepEqual(out.map((x) => [x.measure, x.subject, x.level]), [["A4", "@s/b", "alert"]]);
});

test("settingChanges: a changed value is an alert 'm: old → new'; first run and unchanged give nothing", () => {
  assert.deepEqual(settingChanges(null, { B4: "none" }), []);
  assert.deepEqual(settingChanges({ B4: "none" }, { B4: "none" }), []);
  const [c] = settingChanges({ B4: "protection", B2: "on" }, { B4: "none", B2: "on" });
  assert.equal(c.measure, "B4");
  assert.equal(c.level, "alert");
  assert.equal(c.text, "B4: protection → none");
});

test("applyAccepts: no until, version, date and change; expired is open; a newer version reopens", () => {
  const acc = { reason: "ok", at: "2026-10-01" };
  const a = f({ subject: "a", version: "1.0.0", text: "same" });
  const b = f({ subject: "b", version: "1.1.0" });
  const c = f({ subject: "c", version: "1.0.0" });
  const d = f({ subject: "d", text: "now" });
  const e = f({ subject: "e", text: "now" });
  const g = f({ subject: "g" });
  const out = applyAccepts([a, b, c, d, e, g], {
    [a.key]: acc,
    [b.key]: { ...acc, until: { version: "1.0.0" } }, // finding is newer: reopened
    [c.key]: { ...acc, until: { version: "1.0.0" } }, // not newer: accepted
    [d.key]: { ...acc, until: { change: "now" } },
    [e.key]: { ...acc, until: { change: "then" } },
    [g.key]: { ...acc, until: { date: "2026-10-25" } }, // expired
  }, NOW);
  assert.deepEqual(out.map((x) => !!x.accepted), [true, false, true, true, false, false]);
  assert.equal(out[0].accepted.reason, "ok");
  const future = applyAccepts([g], { [g.key]: { ...acc, until: { date: "2026-11-01" } } }, NOW);
  assert.ok(future[0].accepted);
});

test("PRE_ACCEPTED applies by default and the accepts file overrides it", () => {
  const pty = f({ measure: "A2", subject: "node-pty" });
  assert.ok(PRE_ACCEPTED["A2:node-pty"]);
  assert.ok(applyAccepts([pty], {}, NOW)[0].accepted);
  const over = applyAccepts([pty], { "A2:node-pty": { reason: "x", at: "a", until: { date: "2020-01-01" } } }, NOW);
  assert.equal(over[0].accepted, undefined, "an expired file entry replaces the built-in one");
  assert.ok(applyAccepts([f({ measure: "A5", subject: "web-push" })], null, NOW)[0].accepted);
});

test("exitCode: 10 beats 2 beats 0; accepted alerts and digests do not count; a known open alert is quiet", () => {
  const alert = f({ measure: "A3", subject: "x" });
  const unreach = [{ measure: "A1", why: "offline", unreachable: true }];
  assert.equal(exitCode(row({ findings: [alert], absent: unreach }), row()), 10);
  assert.equal(exitCode(row({ findings: [{ ...alert, accepted: { reason: "r", at: "a" } }], absent: unreach }), row()), 2);
  assert.equal(exitCode(row({ findings: [alert] }), row({ findings: [alert] })), 0, "seen yesterday");
  assert.equal(exitCode(row({ findings: [{ ...alert, level: "digest" }] }), row()), 0);
  assert.equal(exitCode(row({ absent: [{ measure: "A7", why: "n/a", unreachable: false }] }), row()), 0);
  const a4 = f({ measure: "A4", subject: "s" });
  assert.equal(exitCode(row({ findings: [a4] }), row({ findings: [a4] })), 10, "A4 stays 10 until accepted");
  const [chg] = settingChanges({ B4: "x" }, { B4: "y" });
  assert.equal(exitCode(row({ findings: [chg] }), row({ findings: [chg] })), 10);
  assert.equal(isNew(alert, null), true);
});

test("gateVerdict: stops on A1 high/critical, A4, C1 alert, an unreadable A1/C1; accepted ones do not stop", () => {
  const hi = f({ measure: "A1", subject: "a", severity: "high" });
  const mod = f({ measure: "A1", subject: "b", severity: "moderate" });
  const a4 = f({ measure: "A4", subject: "c" });
  const c1 = f({ measure: "C1", subject: "npm:waterplane" });
  const v = gateVerdict(row({ findings: [hi, mod, a4, c1] }));
  assert.deepEqual(v.stops.map((x) => x.key), [hi.key, a4.key, c1.key]);
  assert.deepEqual(v.prints.map((x) => x.key), [mod.key]);
  const acc = { reason: "r", at: "a" };
  const quiet = gateVerdict(row({ findings: [{ ...hi, accepted: acc }, { ...a4, accepted: acc }] }));
  assert.deepEqual([quiet.stops, quiet.prints], [[], []]);
  const dark = gateVerdict(row({ absent: [{ measure: "A1", why: "no network", unreachable: true }, { measure: "C1", why: "n/a", unreachable: false }, { measure: "A7", why: "x", unreachable: true }] }));
  assert.equal(dark.stops.length, 1);
  assert.match(dark.stops[0].text, /could not read A1: no network/);
});

test("depDiff: added, removed and gained-install-script by name, with versions shown", () => {
  const lock = (o) => ({ lockfileVersion: 3, packages: { "": { name: "root" }, ...o } });
  const old = lock({ "node_modules/a": { version: "1.0.0" }, "node_modules/gone": { version: "2.0.0" }, "node_modules/x/node_modules/b": { version: "1.0.0" } });
  const next = lock({
    "node_modules/a": { version: "1.1.0", hasInstallScript: true },
    "node_modules/new": { version: "3.0.0" },
    "node_modules/x/node_modules/b": { version: "1.0.0" },
    "node_modules/@s/c": { version: "0.1.0", hasInstallScript: true },
  });
  assert.deepEqual(depDiff(old, next), { added: ["@s/c@0.1.0", "new@3.0.0"], removed: ["gone@2.0.0"], gainedInstallScript: ["@s/c@0.1.0", "a@1.1.0"] });
  assert.deepEqual(depDiff(null, lock({ "node_modules/a": { version: "1.0.0" } })).added, ["a@1.0.0"]);
});

test("readLastRow: the last good line; a torn last line is skipped; empty is null", () => {
  assert.deepEqual(readLastRow('{"a":1}\n{"a":2}\n'), { a: 2 });
  assert.deepEqual(readLastRow('{"a":1}\n{"a":2,"b"'), { a: 1 });
  assert.equal(readLastRow(""), null);
  assert.equal(readLastRow("not json"), null);
});

test("semverCmp: pre-release is lower than its release; numeric, not lexical", () => {
  assert.equal(semverCmp("1.2.0-beta.15", "1.2.0"), -1);
  assert.equal(semverCmp("1.2.0", "1.2.0-beta.15"), 1);
  assert.equal(semverCmp("1.2.0-beta.9", "1.2.0-beta.15"), -1);
  assert.equal(semverCmp("1.10.0", "1.9.0"), 1);
  assert.equal(semverCmp("v2.0.0", "2.0.0"), 0);
});

test("firstRunOff and renderText name what is off, absent and open", () => {
  const r = row({
    findings: [f({ measure: "A3", subject: "x" }), { ...f({ measure: "A5", subject: "web-push", level: "alert" }), accepted: { reason: "MPL", at: "a" } }, f({ measure: "A6", subject: "d", level: "digest" })],
    absent: [{ measure: "A7", why: "no engines", unreachable: false }],
    readings: { settings: { B2: "on", B4: "none", B5: "write" } },
  });
  const off = firstRunOff(r);
  assert.ok(off.includes("B4: none") && off.includes("B5: write") && !off.some((l) => l.startsWith("B2:")));
  assert.ok(off.some((l) => l.includes("A7") && l.includes("no engines")));
  const text = renderText(r, row()).join("\n");
  assert.match(text, /NEW A3 x/);
  assert.match(text, /MPL/);
  assert.match(text, /digest: A6 1/);
  assert.match(text, /absent A7/);
});

test("firstRunOff lists a compound B2 reading that has anything off", () => {
  const off = firstRunOff(row({ readings: { settings: { B2: "scanning on, push protection off", B3: "on", B6: "off" } } }));
  assert.ok(off.includes("B2: scanning on, push protection off") && off.includes("B6: off") && !off.some((l) => l.startsWith("B3:")));
  assert.ok(!firstRunOff(row({ readings: { settings: { B2: "scanning on, push protection on" } } })).length);
});

test("gateVerdict: an unparseable tracked lockfile (A1 absent, unreachable) is a synthetic stop that cannot be accepted", () => {
  const v = gateVerdict(row({ absent: [{ measure: "A1", why: "packages/app/package-lock.json: not JSON", unreachable: true }] }));
  assert.equal(v.stops.length, 1);
  assert.equal(v.stops[0].synthetic, true);
  assert.match(v.stops[0].text, /not JSON/);
  assert.equal(gateVerdict(row({ findings: [f({ severity: "high" })] })).stops[0].synthetic, undefined, "a real finding is not synthetic");
});

test("installScriptReadings: an incomplete lockfile read keeps the last complete baseline, so the next run alerts on nothing", () => {
  const prev = { installScripts: ["esbuild@0.21.0", "fsevents@2.3.3"] };
  assert.deepEqual(installScriptReadings(prev, ["fsevents@2.3.3"], true), ["fsevents@2.3.3"]);
  const kept = installScriptReadings(prev, ["fsevents@2.3.3"], false);
  assert.deepEqual(kept, prev.installScripts);
  // the next, complete run diffs against the kept baseline: esbuild is not "new"
  assert.deepEqual(a4Findings({ installScripts: kept }, ["esbuild@0.21.0", "fsevents@2.3.3"]), []);
  // a first run that is incomplete has no baseline yet: none stored, none alerted
  assert.equal(installScriptReadings(null, ["x@1.0.0"], false), undefined);
  assert.deepEqual(a4Findings({}, ["x@1.0.0"]), []);
});

test("untilVersionProblem: --until-version needs a finding that carries a version", () => {
  assert.equal(untilVersionProblem(undefined, undefined), null);
  assert.match(untilVersionProblem("7.1.0", undefined), /needs the finding in the newest row/);
  assert.match(untilVersionProblem("7.1.0", f({ advisory: "GHSA-1" })), /no version.*--until-change or --until-date/);
  assert.equal(untilVersionProblem("7.1.0", f({ version: "7.0.0" })), null);
});
