import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptRefusal, acceptRequest, cutElsewhereWords, acceptedLine, digestHead, exposureCut, exposureMeta, inExposureMainList,
  untilChoices, untilVersionOffered, untilWords,
} from "./exposureWords.ts";

const ex = (key, level, extra = {}) => ({
  id: `exposure:${key}`, label: key, status: "warn", detail: "d", fix: null,
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
  assert.equal(exposureMeta(e), "any high advisory · high · from osv, npm · since 2026-10-20");
  assert.equal(exposureMeta({ ...e, threshold: undefined, severity: undefined, since: undefined, sources: [] }), "");
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

test("cutElsewhereWords names the other region and agrees in number", () => {
  assert.equal(cutElsewhereWords(1, "watch"), "1 more finding is under watch");
  assert.equal(cutElsewhereWords(3, "setup"), "3 more findings are under set-up");
});
