/**
 * The requirements sheet's cut and the wire's two pure strings. One predicate feeds the chips' numbers
 * and the list — asserted for every key, with and without a search and the other axis on.
 *
 *     node --test packages/extensions/requirements/web/cut.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NO_CUT, areaBucket, askedWords, builtWords, cutItems, cutWords, statusBucket } from "./cut.ts";
import { REQ_UPDATE_GUIDANCE, updateBrief, updateKey } from "../shared/methods.mts";
import { REQUIREMENT_STATUSES } from "@waterplane/shared";

const it = (id, area, status, text = "words") => ({ id, area, status, text, asked: [], shipped: [], supersededBy: null });
const ITEMS = [
  it("R-ui-001", "ui", "shipped", "a button that says foo"),
  it("R-ui-002", "ui", "requested", "the list scrolls"),
  it("R-host-001", "host", "requested", "restart is one command"),
  it("R-host-002", "host", "dropped", "foo everywhere"),
  it("R-host-003", "host", "superseded"),
];
const AREAS = ["ui", "host"];

test("every chip's count is exactly the rows its tap leaves", () => {
  for (const q of ["", "foo", "  FOO "]) {
    for (const cut of [NO_CUT, { status: "requested", area: null }, { status: null, area: "host" }, { status: "shipped", area: "ui" }]) {
      const sb = statusBucket(ITEMS, cut, q);
      for (const s of REQUIREMENT_STATUSES) {
        assert.equal(sb(s).count, cutItems(ITEMS, { ...cut, status: s }, q).length, `status ${s} q=${q}`);
      }
      const ab = areaBucket(ITEMS, cut, q);
      for (const a of AREAS) {
        assert.equal(ab(a).count, cutItems(ITEMS, { ...cut, area: a }, q).length, `area ${a} q=${q}`);
      }
    }
  }
});

test("cutWords: null uncut, otherwise n of N against the unfiltered list", () => {
  assert.equal(cutWords(NO_CUT, "  ", 5, 5), null);
  assert.equal(cutWords({ status: "requested", area: null }, "", 2, 5), "2 of 5 · requested");
  assert.equal(cutWords({ status: "requested", area: "ui" }, "foo", 0, 5), "0 of 5 · requested · area ui · “foo”");
});

test("builtWords never prints a count it could not make", () => {
  const ago = () => "6d ago";
  const base = { lastRun: null, promptsBehind: 12, commitsBehind: 3 };
  assert.equal(builtWords(base, ago), "never built — 12 prompts to read");
  assert.equal(builtWords({ ...base, promptsBehind: 1 }, ago), "never built — 1 prompt to read");
  assert.equal(builtWords({ ...base, promptsBehind: null }, ago), "never built");
  const built = { ...base, lastRun: "2026-09-01T10:00:00.000Z", promptsBehind: 40 };
  assert.equal(builtWords(built, ago), "last built 6d ago · 40 prompts behind · 3 commits");
  assert.equal(builtWords({ ...built, commitsBehind: 0 }, ago), "last built 6d ago · 40 prompts behind");
  assert.equal(builtWords({ ...built, promptsBehind: null, commitsBehind: null }, ago), "last built 6d ago");
});

test("askedWords keeps what each entry has", () => {
  assert.equal(askedWords(["2026-09-16 (session 61c1e521)", "c40d28d7", "2026-09-27 (user request)"]),
    "2026-09-16 · session 61c1e521 · c40d28d7 · 2026-09-27 · user request");
  assert.equal(askedWords([]), "");
});

test("updateKey: charset and length, stable, moves with the build and the repo", () => {
  const k = updateKey("repo-one", "2026-09-20T10:00:00.000Z");
  assert.match(k, /^[A-Za-z0-9._:-]{1,44}$/);
  assert.equal(k, updateKey("repo-one", "2026-09-20T10:00:00.000Z"));
  assert.notEqual(k, updateKey("repo-one", "2026-09-21T10:00:00.000Z"));
  assert.notEqual(k, updateKey("repo-two", "2026-09-20T10:00:00.000Z"));
  assert.match(updateKey("x".repeat(500), null), /^u\.[0-9a-f]{8}\.never$/);
});

test("updateBrief carries the command, the guidance verbatim and the no-commit rule", () => {
  const b = updateBrief({ repoName: "myapp", detail: "Set up, never built.", cmd: "node /x/update.mjs ." });
  assert.ok(b.includes("node /x/update.mjs ."));
  assert.ok(b.includes(REQ_UPDATE_GUIDANCE));
  assert.ok(b.includes("Do not commit"));
  assert.ok(b.startsWith("Update the requirements list in myapp."));
});
