// The exposure watch's accept logic and its setup-checklist rows (`shared/src/exposure.ts`).
// The phone and the CLI count from the same predicates, so these pin the counts a badge shows.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_GATED_FIXES, EXPOSURE_SUMMARY_ID, PRE_ACCEPTED, cleanAcceptRequest, exposureCheckId, exposureKeyOf, applyAccepts, exposureChecks, isSetupConsider, isSetupFinding, isWatchCheck,
} from "../dist/index.js";

const NOW = "2026-10-26T12:00:00Z";
const f = (o) => ({ key: "A1:x@1.0.0", measure: "A1", subject: "x", version: "1.0.0", level: "alert", severity: "high", text: "x is bad", sources: ["npm audit"], ...o });
const row = (findings, o = {}) => ({ v: 1, at: "2026-10-26T06:00:00Z", repo: "r", dir: "/r", findings, absent: [], readings: {}, ...o });
const counts = (checks) => ({
  finding: checks.filter(isSetupFinding).length,
  consider: checks.filter(isSetupConsider).length,
});

test("an open high alert is a failing finding; a digest is a consider", () => {
  const cs = exposureChecks(row([f({}), f({ key: "A6:y", measure: "A6", subject: "y", version: undefined, level: "digest", severity: undefined })]), "r", null, NOW);
  assert.equal(cs[0].id, EXPOSURE_SUMMARY_ID);
  assert.equal(cs[0].status, "pass");
  assert.equal(cs[1].id, exposureCheckId("A1:x@1.0.0"));
  assert.equal(cs[1].status, "fail");
  assert.equal(cs[1].label, "A1 x@1.0.0");
  assert.equal(cs[1].exposure.threshold, "a published advisory against an installed version");
  assert.equal(cs[2].status, "warn");
  assert.equal(cs[2].advisory, true);
  assert.deepEqual(counts(cs), { finding: 1, consider: 1 });
});

test("a moderate alert warns, and an unknown measure carries no threshold", () => {
  const cs = exposureChecks(row([f({ severity: "moderate", measure: "Z9", key: "Z9:x" })]), "r", null, NOW);
  assert.equal(cs[1].status, "warn");
  assert.equal("threshold" in cs[1].exposure, false);
});

test("an accepted finding is neither a finding nor a consider, and is still sent", () => {
  const cs = exposureChecks(row([f({})]), "r", { "A1:x@1.0.0": { reason: "known", at: "2026-10-01" } }, NOW);
  assert.equal(cs.length, 2);
  assert.equal(cs[1].accepted.reason, "known");
  assert.equal(cs[1].accepted.builtIn, undefined);
  assert.deepEqual(counts(cs), { finding: 0, consider: 0 });
  assert.match(cs[0].detail, /0 open alerts, 0 to consider, 1 accepted/);
});

test("PRE_ACCEPTED marks builtIn; a file entry for the same key overrides it", () => {
  assert.ok(PRE_ACCEPTED["A2:node-pty"]);
  const g = f({ key: "A2:node-pty", measure: "A2", subject: "node-pty" });
  const built = exposureChecks(row([g]), "r", null, NOW)[1];
  assert.equal(built.accepted.builtIn, true);
  const mine = exposureChecks(row([g]), "r", { "A2:node-pty": { reason: "mine", at: "2026-10-26" } }, NOW)[1];
  assert.equal(mine.accepted.reason, "mine");
  assert.equal(mine.accepted.builtIn, undefined);
});

test("an expired accept counts again", () => {
  const cs = exposureChecks(row([f({})]), "r", { "A1:x@1.0.0": { reason: "r", at: "a", until: { date: "2026-10-01T00:00:00Z" } } }, NOW);
  assert.equal(cs[1].accepted, undefined);
  assert.equal(counts(cs).finding, 1);
});

test("a stale reading or an absent measure makes the summary warn and names why", () => {
  const stale = exposureChecks(row([], { at: "2026-10-20T00:00:00Z" }), "r", null, NOW)[0];
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /7 days ago/);
  const absent = exposureChecks(row([], { absent: [{ measure: "B1", why: "gh is not logged in", unreachable: false }] }), "r", null, NOW)[0];
  assert.equal(absent.status, "warn");
  assert.match(absent.detail, /B1: gh is not logged in/);
  assert.equal(exposureChecks(row([], { at: "2026-10-20T00:00:00Z" }), "r", null, NOW, { staleMs: 30 * 86400000 })[0].status, "pass");
});

test("isSetupFinding / isSetupConsider skip an accepted check", () => {
  const base = { id: "x", label: "x", status: "warn", detail: "", fix: null };
  const acc = { reason: "r", at: "a" };
  assert.equal(isSetupFinding(base), true);
  assert.equal(isSetupFinding({ ...base, accepted: acc }), false);
  assert.equal(isSetupConsider({ ...base, advisory: true }), true);
  assert.equal(isSetupConsider({ ...base, advisory: true, accepted: acc }), false);
});

test("cleanAcceptRequest refuses in words and cleans what it keeps", () => {
  const id = "exposure:A1:x@1.0.0";
  const err = (b) => { const r = cleanAcceptRequest(b, NOW); assert.equal(r.ok, false); assert.ok(r.error.length > 10); };
  err(null);
  err({ id: "context-weight", accept: true, reason: "r" });
  err({ id: EXPOSURE_SUMMARY_ID, accept: true, reason: "r" });
  err({ id: "exposure:", accept: true, reason: "r" });
  err({ id, accept: "yes" });
  err({ id, accept: true });
  err({ id, accept: true, reason: "   " });
  err({ id, accept: true, reason: "x".repeat(501) });
  err({ id, accept: true, reason: "r", until: { version: "1", date: "2027-01-01" } });
  err({ id, accept: true, reason: "r", until: {} });
  err({ id, accept: true, reason: "r", until: { date: "nonsense" } });
  err({ id, accept: true, reason: "r", until: { date: "2026-01-01" } });
  err({ id, accept: true, reason: "r", until: { change: false } });
  assert.deepEqual(cleanAcceptRequest({ id, accept: true, reason: " ok ", until: { date: "2027-01-01" } }, NOW).value, { id, accept: true, reason: "ok", until: { date: "2027-01-01" } });
  assert.deepEqual(cleanAcceptRequest({ id, accept: true, reason: "ok", until: { change: true } }, NOW).value.until, { change: true });
  assert.deepEqual(cleanAcceptRequest({ id, accept: false, reason: "ignored" }, NOW).value, { id, accept: false });
});

test("a versioned key's accept-until-version survives a patch release, ends past the bound; exact key wins; adv: keys never stem-match", () => {
  const a3 = (v) => f({ key: `A3:left-pad@${v}`, measure: "A3", subject: "left-pad", version: v });
  const acc = { "A3:left-pad@1.2.3": { reason: "r", at: "2026-10-01", until: { version: "2.0.0" } } };
  assert.ok(applyAccepts([a3("1.2.3")], acc, NOW)[0].accepted);
  assert.ok(applyAccepts([a3("1.2.4")], acc, NOW)[0].accepted);
  assert.equal(applyAccepts([a3("2.0.1")], acc, NOW)[0].accepted, undefined);
  const exact = { ...acc, "A3:left-pad@1.2.4": { reason: "exact", at: "2026-10-02" } };
  assert.equal(applyAccepts([a3("1.2.4")], exact, NOW)[0].accepted.reason, "exact");
  const forever = { "A3:left-pad@1.2.3": { reason: "r", at: "2026-10-01" } };
  assert.equal(applyAccepts([a3("1.2.4")], forever, NOW)[0].accepted, undefined);
  const adv = { "adv:GHSA-1:x@1.0.0": { reason: "r", at: "2026-10-01", until: { version: "2.0.0" } } };
  assert.equal(applyAccepts([f({ key: "adv:GHSA-1:x@1.0.1", version: "1.0.1" })], adv, NOW)[0].accepted, undefined);
});

test("keys that are Object.prototype names are not accepts or thresholds", () => {
  assert.equal(applyAccepts([f({ key: "constructor" })], {}, NOW)[0].accepted, undefined);
  const cs = exposureChecks(row([f({ measure: "toString", key: "toString:x" })]), "r", null, NOW);
  assert.equal("threshold" in cs[1].exposure, false);
});

test("until.version is capped and must look like a version", () => {
  const ask = (version) => cleanAcceptRequest({ id: "exposure:A1:x", accept: true, reason: "r", until: { version } }, NOW);
  assert.equal(ask("2.0.0").ok, true);
  assert.equal(ask("v2.0.0-rc.1").ok, true);
  assert.equal(ask("soon").ok, false);
  assert.equal(ask("1." + "0".repeat(70)).ok, false);
  assert.match(ask("soon").error, /version/);
});

test("exposureKeyOf is the inverse of exposureCheckId", () => {
  assert.equal(exposureKeyOf(exposureCheckId("A1:x@1")), "A1:x@1");
  assert.equal(exposureKeyOf("exposure"), null);
  assert.equal(exposureKeyOf("exposure:"), null);
});

test("isWatchCheck: exposure rows, the summary and a flagged contributor row are watch; a convention is not", () => {
  const cs = exposureChecks(row([f({})]), "r", null, NOW);
  assert.ok(cs.length >= 2 && cs.every(isWatchCheck));
  assert.equal(isWatchCheck({ id: "scorecard", label: "OpenSSF Scorecard", status: "warn", detail: "", fix: null, watch: true }), true);
  assert.equal(isWatchCheck({ id: "gitignore", label: "x", status: "fail", detail: "", fix: "gitignore" }), false);
});

test("only the default-branch B4 finding offers protect-main, and not once accepted", () => {
  const b4 = { key: "B4:default-branch", measure: "B4", subject: "default-branch", level: "digest", sources: ["github branch rules"], text: "t" };
  const row = { at: NOW, findings: [b4, { ...b4, key: "B5:x", measure: "B5", subject: "x" }], absent: [] };
  const cs = exposureChecks(row, "r", null, NOW);
  assert.deepEqual(cs.filter((c) => c.fix).map((c) => [c.id, c.fix]), [[exposureCheckId("B4:default-branch"), "protect-main"]]);
  const acc = exposureChecks(row, "r", { "B4:default-branch": { reason: "no", at: NOW } }, NOW);
  assert.equal(acc.find((c) => c.id === exposureCheckId("B4:default-branch")).fix, null);
});

test("every open D3 crash group offers era-seen, gated behind the confirm, and not once accepted", () => {
  const d3 = (k) => f({ key: `D3:ciq:${k}#1+`, measure: "D3", subject: `ciq:${k}#1+`, version: undefined, sources: ["era"] });
  const r = row([d3("a/prod/E/1.0/A.mc:1"), d3("b/prod/E/2.0/B.mc:2")]);
  const cs = exposureChecks(r, "connectiq", null, NOW).filter((c) => c.fix);
  assert.deepEqual(cs.map((c) => c.fix), ["era-seen", "era-seen"]);
  assert.ok(CONFIRM_GATED_FIXES.includes("era-seen"));
  const acc = exposureChecks(r, "connectiq", { "D3:ciq:a/prod/E/1.0/A.mc:1#1+": { reason: "known", at: NOW } }, NOW);
  assert.deepEqual(acc.filter((c) => c.fix).map((c) => c.exposure.key), ["D3:ciq:b/prod/E/2.0/B.mc:2#1+"]);
});

// Triage marks (seen / investigating / fixed) on a crash group.
import { applyTriage, cleanTriageFile, semverCmp, exposureTriageId, triageWords } from "../dist/index.js";
const crash = (v, o = {}) => f({ key: `D3:ciq:a/p/E/${v}/X.mc:1#10+`, measure: "D3", subject: `ciq:a/p/E/${v}/X.mc:1#10+`, version: undefined, group: "a/p/E/X.mc:1", appVersion: v, text: `a p v${v}: E`, ...o });
const person = { kind: "person" };

test("semverCmp as the fix compare: numeric parts numerically, pre-release below its release, never throws", () => {
  assert.equal(semverCmp("1.0.10", "1.0.9"), 1);
  assert.equal(semverCmp("1.0", "1.0.0"), 0);
  assert.equal(semverCmp("v1.0.0", "1.0.1"), -1);
  assert.equal(semverCmp("1.0.9-beta.2", "1.0.9"), -1);
  assert.doesNotThrow(() => semverCmp(undefined, null));
  // a beta of the version before the fix is an older install, not a regression
  const t = { "a/p/E/X.mc:1": { state: "fixed", fixedIn: "1.0.9", at: NOW, by: person } };
  assert.ok(applyTriage([crash("1.0.9-beta.2")], t)[0].accepted);
});

test("cleanTriageFile drops malformed entries and never throws; wording tolerates a missing by", () => {
  const good = { state: "seen", at: NOW, by: { kind: "person" } };
  const c = cleanTriageFile({
    ok: good, noBy: { state: "seen", at: NOW }, noAt: { state: "seen", by: good.by }, badState: { ...good, state: "wat" },
    fixedNoVer: { ...good, state: "fixed" }, fixedOk: { ...good, state: "fixed", fixedIn: "1.0.1", junk: 1 }, str: "x", nul: null,
  });
  assert.deepEqual(Object.keys(c).sort(), ["fixedOk", "ok"]);
  assert.equal(c.fixedOk.junk, undefined);
  for (const bad of [null, [], "x", 3, undefined]) assert.deepEqual(cleanTriageFile(bad), {});
  assert.doesNotThrow(() => triageWords({ state: "seen", at: NOW }));
  assert.doesNotThrow(() => applyTriage([crash("1.0.0")], { "a/p/E/X.mc:1": { state: "fixed", at: NOW } }));
});

test("a seen mark survives a growth-bucket key change; a fixed mark's accepted entry says byMark; stale marks are listed", () => {
  const t = { "a/p/E/X.mc:1": { state: "seen", at: NOW, by: person }, "gone/g": { state: "seen", at: NOW, by: person } };
  const grown = crash("1.0.0", { key: "D3:ciq:a/p/E/1.0.0/X.mc:1#100+", subject: "ciq:a/p/E/1.0.0/X.mc:1#100+" });
  const cs = exposureChecks(row([grown]), "r", null, NOW, undefined, t);
  assert.equal(cs[1].exposure.triage.state, "seen");
  assert.deepEqual(cs[0].staleMarks.map((m) => m.triageId), ["gone/g"]);
  const fx = { "a/p/E/X.mc:1": { state: "fixed", fixedIn: "1.0.9", at: NOW, by: person } };
  assert.equal(exposureChecks(row([crash("1.0.0")]), "r", null, NOW, undefined, fx)[1].accepted.byMark, true);
  assert.equal(exposureChecks(row([crash("1.0.0")]), "r", null, NOW, undefined, null)[0].staleMarks, undefined);
});

test("triage id is the group when there is one", () => {
  assert.equal(exposureTriageId(crash("1.0.0")), "a/p/E/X.mc:1");
  assert.equal(exposureTriageId(f({})), "A1:x@1.0.0");
});

test("seen / investigating stay open, counted, and say who", () => {
  const t = { "a/p/E/X.mc:1": { state: "investigating", at: "2026-10-27T08:00:00Z", by: { kind: "agent", repo: "garmin-monorepo" } } };
  const cs = exposureChecks(row([crash("1.0.0")]), "r", null, NOW, undefined, t);
  assert.equal(counts(cs).finding, 1);
  assert.equal(cs[1].accepted, undefined);
  assert.match(cs[1].detail, /investigating .* agent session in garmin-monorepo, 2026-10-27/);
  assert.equal(cs[1].exposure.triage.state, "investigating");
  assert.equal(cs[1].exposure.group, "a/p/E/X.mc:1");
  const seen = applyTriage([crash("1.0.0")], { "a/p/E/X.mc:1": { state: "seen", at: NOW, by: person } });
  assert.equal(seen[0].accepted, undefined);
});

test("fixed: older installs are listed, not counted; same-or-newer is a regression", () => {
  const t = { "a/p/E/X.mc:1": { state: "fixed", fixedIn: "1.0.9", commit: "abc1234", at: "2026-10-27T08:00:00Z", by: person } };
  const old = exposureChecks(row([crash("1.0.0"), crash("1.0.10")]), "r", null, NOW, undefined, t);
  assert.equal(counts(old).finding, 1, "1.0.10 is newer than 1.0.9: regression counts");
  assert.match(old[1].accepted.reason, /fixed in 1\.0\.9 \(commit abc1234\).*installs on 1\.0\.0 still report it/);
  assert.match(old[2].detail, /^crashes again in 1\.0\.10 after the fix in 1\.0\.9: /);
  assert.equal(old[2].accepted, undefined);
  assert.notEqual(old[1].id, old[2].id);
  assert.equal(applyTriage([crash("1.0.9")], t)[0].accepted, undefined);
  assert.match(triageWords(t["a/p/E/X.mc:1"]), /^fixed in 1\.0\.9 \(commit abc1234\)/);
});

test("fixed without appVersion: not counted; an existing accept is kept", () => {
  const plain = f({});
  const t = { [plain.key]: { state: "fixed", fixedIn: "2.0.0", at: NOW, by: person } };
  const r = applyTriage([plain], t)[0];
  assert.ok(r.accepted);
  assert.match(r.accepted.reason, /until the reading changes/);
  const kept = applyTriage([{ ...plain, accepted: { reason: "mine", at: "a" } }], t)[0];
  assert.equal(kept.accepted.reason, "mine");
  assert.equal(applyTriage([plain], null)[0], plain);
  assert.equal(applyTriage([crash("1.0.0")], { "other": { state: "fixed", at: NOW, by: person } })[0].accepted, undefined);
});
