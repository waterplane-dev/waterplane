import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptRefusal, acceptRequest, acceptedLine, digestHead, exposureCut, exposureMeta, exposureSource, inExposureMainList,
  untilChoices, untilVersionOffered, untilWords,
} from "./exposureWords.ts";

const ex = (key, level, extra = {}) => ({
  id: `exposure:${key}`, label: key, status: "warn", detail: extra.detail ?? "d", fix: null,
  ...(level === "digest" ? { advisory: true } : {}),
  exposure: { key, name: "r", measure: "m", subject: "s", level, sources: ["osv"], ...(extra.exposure ?? {}) },
  ...(extra.accepted ? { accepted: extra.accepted } : {}),
});

test("exposureCut: one cut feeds every list", () => {
  const rows = [
    { id: "exposure", label: "Exposure", status: "warn", detail: "", fix: null, advisory: true },
    { id: "claude-md", label: "x", status: "pass", detail: "", fix: null },
    ex("a", "alert"), ex("b", "digest"), ex("c", "digest", { accepted: { reason: "r", at: "2026-10-01" } }),
    ex("d", "alert", { accepted: { reason: "r", at: "2026-10-01" } }),
  ];
  const cut = exposureCut(rows);
  assert.deepEqual(cut.alerts.map((c) => c.id), ["exposure:a"]);
  assert.deepEqual(cut.digest.map((c) => c.id), ["exposure:b"]);
  assert.deepEqual(cut.accepted.map((c) => c.id), ["exposure:c", "exposure:d"]);
  assert.equal(cut.summary.id, "exposure");
  assert.deepEqual(rows.filter(inExposureMainList).map((c) => c.id), ["exposure", "claude-md", "exposure:a"]);
});

test("words", () => {
  assert.equal(digestHead(28), "Digest · 28 — counted in nothing");
  assert.equal(untilWords({ version: "1.2.3" }), "ends once a version newer than 1.2.3 is installed");
  assert.equal(untilWords({ date: "2026-12-01" }), "until 2026-12-01");
  assert.equal(untilWords({ change: "x" }), "until the reading changes");
  assert.equal(untilWords({ change: true }), "until the reading changes");
  assert.equal(untilWords(undefined), "for good");
  const e = { key: "k", name: "n", measure: "m", subject: "s", level: "alert", sources: ["osv", "npm"], severity: "high", threshold: "any high advisory", since: "2026-10-20T10:00:00Z" };
  assert.equal(exposureMeta(e), "any high advisory · high · since 2026-10-20");
  assert.equal(exposureMeta({ ...e, threshold: undefined, severity: undefined, since: undefined, sources: [] }), "");
});

test("exposureSource names where a row came from, and says nothing for a row with no source", () => {
  const e = { key: "k", name: "n", measure: "D3", subject: "s", level: "alert", sources: ["era"] };
  assert.equal(exposureSource(e), "Source: Garmin's ERA crash reports from people's devices, read by the exposure watch on this desktop.");
  // A name the table does not know is the collector's own word, never a guess.
  assert.match(exposureSource({ ...e, sources: ["npm audit package-lock.json", "osv"] }), /^Source: npm audit package-lock\.json, the OSV advisory database, read/);
  assert.equal(exposureSource({ ...e, sources: [] }), null);
});

test("acceptedLine", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(acceptedLine({ reason: "dev only", at: "2026-10-24T00:00:00Z", until: { date: "2026-12-01" } }, now),
    "Accepted 2 days ago: dev only (until 2026-12-01)");
  assert.equal(acceptedLine({ reason: "pinned", at: "x", builtIn: true }, now), "Accepted in code — pinned");
});

test("form: version only when the finding has one; refusal replaces the verb", () => {
  assert.equal(untilVersionOffered(ex("a", "alert")), null);
  const v = ex("a", "alert", { exposure: { version: "2.0.1" } });
  assert.equal(untilVersionOffered(v), "2.0.1");
  assert.deepEqual(untilChoices(null).map((c) => c.key), ["change", "date"]);
  assert.deepEqual(untilChoices("2.0.1").map((c) => c.key), ["change", "date", "version"]);
  assert.ok(acceptRefusal("  ", "change", ""));
  assert.ok(acceptRefusal("why", "date", ""));
  assert.ok(acceptRefusal("why", "version", " "));
  assert.equal(acceptRefusal("why", "change", ""), null);
  assert.deepEqual(acceptRequest("exposure:a", " why ", "version", " 2.0.2 "), { id: "exposure:a", accept: true, reason: "why", until: { version: "2.0.2" } });
  assert.deepEqual(acceptRequest("exposure:a", "why", "change", "").until, { change: true });
});

import { acceptedByMark, clearTriageRequest, triageControl, triageRefusal, triageRequest, TRIAGE_NO_FIXED_WHY } from "./exposureWords.ts";

test("triageRefusal mirrors the host: fixed needs a clean version, commit hex, note length", () => {
  assert.equal(triageRefusal("seen", "", "", ""), null);
  assert.match(triageRefusal("fixed", " ", "", ""), /version that carries the fix/);
  assert.match(triageRefusal("fixed", "1.0 beta", "", ""), /letters, digits/);
  assert.match(triageRefusal("fixed", "x".repeat(33), "", ""), /32/);
  assert.match(triageRefusal("fixed", "1.4.2", "zz", ""), /hex/);
  assert.equal(triageRefusal("fixed", "1.4.2+b-1", "abc1234", "ok"), null);
  assert.match(triageRefusal("seen", "", "", "n".repeat(281)), /280/);
});

test("triageRequest sends only what the state carries", () => {
  assert.deepEqual(triageRequest("a", "seen", "9", "abc1234", " hi "), { id: "a", state: "seen", note: "hi" });
  assert.deepEqual(triageRequest("a", "fixed", " 1.4.2 ", " abc1234 ", ""), { id: "a", state: "fixed", fixedIn: "1.4.2", commit: "abc1234" });
  assert.deepEqual(clearTriageRequest("a"), { id: "a", clear: true });
});

test("triageControl: unmarked offers Mark…; marked offers change + clear, fixed adds its line once", () => {
  const base = ex("k", "alert");
  assert.deepEqual(triageControl(base), { open: "Mark…", canClear: false, line: null, offerFixed: false, noFixedWhy: TRIAGE_NO_FIXED_WHY });
  const at = "2026-10-20";
  const seen = ex("k", "alert", { exposure: { triage: { state: "seen", at, by: { kind: "person" } } } });
  assert.deepEqual(triageControl(seen), { open: "Change mark…", canClear: true, line: null, offerFixed: false, noFixedWhy: TRIAGE_NO_FIXED_WHY });
  const fixed = ex("k", "alert", { exposure: { triage: { state: "fixed", fixedIn: "1.4.2", at, by: { kind: "person" } } } });
  const c = triageControl(fixed);
  assert.equal(c.canClear, true);
  assert.match(c.line, /^fixed in 1\.4\.2/);
});

test("acceptedByMark reads the host's byMark flag, not the reason text", () => {
  const triage = { state: "fixed", fixedIn: "1.4.2", at: "2026-10-20", by: { kind: "person" } };
  const mine = ex("k", "alert", { exposure: { triage }, accepted: { reason: "because", at: "2026-10-01" } });
  assert.equal(acceptedByMark(mine), false);
  const made = ex("k", "alert", { exposure: { triage }, accepted: { reason: "anything", at: "2026-10-20", byMark: true } });
  assert.equal(acceptedByMark(made), true);
});

test("triageControl hides fixed without an app version and says why; a regression card adds no line", () => {
  const noVer = ex("k", "alert");
  assert.equal(triageControl(noVer).offerFixed, false);
  assert.match(triageControl(noVer).noFixedWhy, /app version/);
  const triage = { state: "fixed", fixedIn: "1.4.2", at: "2026-10-20", by: { kind: "person" } };
  const reg = ex("k", "alert", { detail: "crashes again in 1.5.0 after the fix in 1.4.2: x", exposure: { appVersion: "1.5.0", triage } });
  assert.equal(triageControl(reg).offerFixed, true);
  assert.equal(triageControl(reg).line, null);
});

test("markedHead counts", () => {
  assert.equal(markedHead(2), "Marked fixed (2)");
});

import { crashOfGroup, crashOfSubject, crashTitle, markShort, markedHead, notMeasuredLine, tidyWhy, watchRowTitle, watchTally, watchVerdict } from "./exposureWords.ts";

test("a crash subject and a crash group read as app · error, then place · version", () => {
  const s = crashOfSubject("ciq:boulder-app-v3/prod/Out Of Memory Error/3.2.20/Streak.mc:179#1+");
  assert.deepEqual(crashTitle(s), { title: "boulder-app-v3 · Out Of Memory Error", where: "Streak.mc:179 · v3.2.20 · 1+ crashes" });
  const g = crashOfGroup("baby-sling/beta/System Error/a/b.mc:1");
  assert.deepEqual(crashTitle(g), { title: "baby-sling (beta) · System Error", where: "a/b.mc:1" });
  assert.equal(crashOfSubject("npm:left-pad"), null);
  assert.equal(crashOfGroup("adv:GHSA-x"), null);
  assert.equal(watchRowTitle({ label: "C6 domain:x", exposure: { subject: "domain:x" } }).title, "C6 domain:x");
});

test("watchVerdict: open alerts first, then unknown, never 'nothing' over an unread measure", () => {
  const base = { alerts: 0, digest: 0, marked: 7, accepted: 0, notMeasured: 0, stale: false };
  assert.deepEqual(watchVerdict({ ...base, alerts: 1 }), { tone: "needs", head: "1 open finding to look at" });
  assert.equal(watchVerdict({ ...base, notMeasured: 1 }).tone, "unknown");
  assert.equal(watchVerdict({ ...base, stale: true }).tone, "unknown");
  assert.deepEqual(watchVerdict(base), { tone: "ok", head: "Nothing open — all handled" });
});

test("watchTally, notMeasuredLine and markShort", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  assert.equal(watchTally({ readAt: "2026-11-21T08:00:00Z", now, marked: 7, accepted: 0, digest: 2 }), "read 2 h ago · 7 fixed, listed below · 2 to consider");
  assert.equal(tidyWhy("ERROR: the vault refused.."), "the vault refused.");
  assert.match(notMeasuredLine({ measure: "D3", why: "x" }), /^The crash list \(Connect IQ ERA\) could not be read: x$/);
  assert.equal(markShort({ state: "fixed", fixedIn: "1.0.9", commit: "525bd812", at: "2026-10-27T08:24:55Z", by: { kind: "person" } }), "fixed in 1.0.9 · 27 Oct");
});
