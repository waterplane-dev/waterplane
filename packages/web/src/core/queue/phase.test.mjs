import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE_LABEL, failToast, nextConfirmBoundary, phaseNotes, isUnconfirmed, mayBeInSession, revivable, rowPhase } from "./phase.ts";
import { queueRow } from "../../activity/activityQueueRow.ts";
import { CONFIRM_WINDOW_MS } from "../../sendConfirm.ts";

// One reading of "where is this queue row?" — design review 2026-10-30 W3.
// The sheet counted `stale`/`refused` rows into "try N again" while the tap
// revived only rows with no recorded verdict (a count that was not its filter),
// and it called a row the desktop was still confirming "not delivered" while the
// strip and Activity called it confirming. Each reader spelled the phase itself.

const NOW = 1_700_000_000_000;
const FAIL_STATES = [undefined, "other", "unconfirmed", "unsubmitted", "stale", "refused"];
const row = (over = {}) => ({
  ackId: "a1", sessionId: "s1", cwd: "/r", text: "run the suite", ts: NOW - 1000,
  status: "failed", failedAt: NOW - 1000, attempts: 0, ...over,
});

test("revivable is exactly the rows whose re-send cannot run words twice and is not refused again", () => {
  const want = { undefined: true, other: true, unconfirmed: false, unsubmitted: false, stale: false, refused: false };
  for (const failState of FAIL_STATES) {
    assert.equal(revivable(row({ failState })), want[String(failState)], `failState ${failState}`);
  }
  assert.equal(revivable(row({ status: "queued" })), false, "only a failed row is revived");
  assert.equal(revivable(row({ status: "pending" })), false);
});

test("the bulk count and the bulk revive are the same predicate (a count is a filter)", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sheet = src("../../QueueSheet.tsx");
  const verbs = src("./verbs.ts");
  const count = sheet.match(/const retryable = ([^;]+);/);
  assert.ok(count, "QueueSheet names its retry count `retryable`");
  assert.match(count[1], /entries\.filter\(revivable\)\.length/, "the count is `revivable`, not a hand-spelled failState set");
  const revive = verbs.slice(verbs.indexOf("function retryFailedQueued"));
  assert.match(revive.slice(0, 400), /outboxRef\.current\.filter\(revivable\)/, "the revive is `revivable` too");
});

test("rowPhase: every status and failState lands in exactly one phase", () => {
  assert.equal(rowPhase(row({ status: "queued" }), NOW), "waiting");
  assert.equal(rowPhase(row({ status: "queued", retryAt: NOW + 5000 }), NOW), "retrying");
  assert.equal(rowPhase(row({ status: "queued", retryAt: NOW - 5000 }), NOW), "waiting", "a spent backoff is waiting again");
  assert.equal(rowPhase(row({ status: "pending" }), NOW), "sending");
  assert.equal(rowPhase(row({ failState: "unconfirmed" }), NOW), "confirming", "the desktop is still asking");
  assert.equal(rowPhase(row({ failState: "unconfirmed", hostSettled: true }), NOW), "failed-unknown");
  assert.equal(rowPhase(row({ failState: "unconfirmed" }), NOW + CONFIRM_WINDOW_MS), "failed-unknown", "the window ran out");
  assert.equal(rowPhase(row({ failState: "unsubmitted" }), NOW), "failed-unknown", "words sit in the composer: a person's Return");
  assert.equal(rowPhase(row({ failState: "stale" }), NOW), "failed-final");
  assert.equal(rowPhase(row({ failState: "refused" }), NOW), "failed-final");
  assert.equal(rowPhase(row({ failState: "other" }), NOW), "failed-retryable");
  assert.equal(rowPhase(row({}), NOW), "failed-retryable");
});

test("revivable(e) ⇔ rowPhase(e) is failed-retryable, at any clock", () => {
  for (const failState of FAIL_STATES) for (const t of [NOW, NOW + CONFIRM_WINDOW_MS * 2]) {
    const e = row({ failState });
    assert.equal(revivable(e), rowPhase(e, t) === "failed-retryable", `${failState} @${t - NOW}`);
  }
});

test("mayBeInSession: the two verdicts that say the words may already be in that session", () => {
  for (const failState of FAIL_STATES) {
    assert.equal(mayBeInSession(row({ failState })), failState === "unconfirmed" || failState === "unsubmitted", String(failState));
  }
});

test("Activity and the sheet's words agree with rowPhase on every row", () => {
  const deps = {
    isEditableEntry: (e) => e.status === "queued",
    isCreateOp: () => false,
    laneLabel: (e) => e.sessionId,
    repoName: (cwd) => cwd,
  };
  const input = { now: NOW, online: true, hostSeenAt: NOW - 1000, deps };
  const rows = [
    row({ status: "queued" }), row({ status: "pending" }),
    ...FAIL_STATES.map((failState) => row({ failState })),
    row({ failState: "unconfirmed", hostSettled: true }),
  ];
  for (const e of rows) {
    const phase = rowPhase(e, NOW);
    const r = queueRow(e, input);
    const want = phase === "confirming" ? "running" : phase.startsWith("failed") ? "failed" : phase === "sending" ? "starting" : "queued";
    assert.equal(r.state, want, `${e.status}/${e.failState}: activity ${r.state}, phase ${phase}`);
    // The sheet never says "not delivered" over a row that may have run or is
    // still being confirmed — the strip and Activity do not.
    if (phase !== "failed-retryable") assert.notEqual(PHASE_LABEL[phase], "not delivered", phase);
  }
  for (const p of ["waiting", "retrying", "sending", "confirming", "failed-retryable", "failed-unknown", "failed-final"]) {
    assert.equal(typeof PHASE_LABEL[p], "string", `${p} has a label`);
  }
});

test("the queue readers take the phase from rowPhase, never from status alone", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sheet = src("../../QueueSheet.tsx");
  const bars = src("./QueueBars.tsx");
  const act = src("../../activity/activityQueueRow.ts");
  for (const [name, s] of [["QueueSheet.tsx", sheet], ["QueueBars.tsx", bars], ["activityQueueRow.ts", act]]) {
    assert.match(s, /\browPhase\(/, `${name} calls rowPhase`);
  }
  assert.doesNotMatch(sheet, /STATUS\[e\.status\]/, "the sheet's label is keyed by phase");
  assert.doesNotMatch(bars, /hostStillConfirming\(/, "the strip reads confirming off rowPhase");
});

test("failToast: unsubmitted never promises the desktop will re-send it", () => {
  const t = (s) => failToast(s, "no", false);
  assert.match(t("unconfirmed"), /confirming it ran\. It re-sends it itself/);
  assert.doesNotMatch(t("unsubmitted"), /re-sends it itself|confirming it ran/);
  assert.match(t("unsubmitted"), /press Return/);
  assert.match(t("unsubmitted"), /won't send it again/);
  assert.match(failToast("refused", "no", true), /^Not sent — no\. Your words are kept; the row is below\.$/);
  assert.match(failToast(undefined, "no", false), /restore or re-aim/);
});

test("nextConfirmBoundary: the earliest confirming row's window end, else null", () => {
  assert.equal(nextConfirmBoundary([], NOW), null);
  assert.equal(nextConfirmBoundary([row({ failState: "stale" }), row({ status: "queued" })], NOW), null);
  assert.equal(nextConfirmBoundary([row({ failState: "unconfirmed", hostSettled: true })], NOW), null, "settled: nothing to wait for");
  const a = row({ failState: "unconfirmed", failedAt: NOW - 1000 });
  const b = row({ ackId: "a2", failState: "unconfirmed", failedAt: NOW - 100_000 });
  assert.equal(nextConfirmBoundary([a], NOW), CONFIRM_WINDOW_MS - 1000);
  assert.equal(nextConfirmBoundary([a, b], NOW), CONFIRM_WINDOW_MS - 100_000, "the earliest wins");
  assert.equal(rowPhase(b, NOW + CONFIRM_WINDOW_MS - 100_000), "failed-unknown", "at the boundary it has stopped confirming");
  assert.equal(nextConfirmBoundary([b], NOW + CONFIRM_WINDOW_MS - 100_000), null);
});

test("phaseNotes: singular and plural each read as English", () => {
  assert.deepEqual(phaseNotes(0, 0, 0), []);
  const one = phaseNotes(1, 1, 1).join(" ");
  assert.match(one, /open it and look, or rewrite it/);
  assert.match(one, /The desktop refused 1 — rewrite it/);
  const many = phaseNotes(3, 2, 4).join(" ");
  assert.match(many, /3 were typed .* confirming that they ran — it types them again/);
  assert.match(many, /2 may already be in their sessions — open each and look, or rewrite them/);
  assert.match(many, /The desktop refused 4 — rewrite them/);
  assert.doesNotMatch(many, /their session —|rewrite it/);
});

test("the sheet's phase words are wired, not just defined (revert-proof)", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sheet = src("../../QueueSheet.tsx");
  const css = readFileSync(new URL("../../styles/03-compose.css", import.meta.url), "utf8");
  assert.match(sheet, /const notQueued = PHASE_NOT_QUEUED\[phase\]/, "the 'not queued' reason is keyed by phase");
  assert.match(sheet, /phase !== "failed-retryable" \? PHASE_NOT_QUEUED\[phase\]/, "the retry control's title says why it is not a retry");
  assert.match(sheet, /phase === "confirming" \? "confirming"/, "a confirming row wears the confirming class");
  assert.match(css, /\.queue-row\.confirming\s*\{[^}]*opacity/, "and that class has a rule");
  assert.match(sheet, /phaseNotes\(/, "the above-list sentences come from phaseNotes");
  assert.equal(isUnconfirmed(row({ failState: "unconfirmed" })), true);
  assert.equal(isUnconfirmed(row({ failState: "unsubmitted" })), false);
  assert.equal(isUnconfirmed(row({ status: "queued" })), false);
});

test("the ratchet's pattern catches a deliveryOf(...) comparison", () => {
  assert.ok('deliveryOf(e.failState) === "unconfirmed"'.match(LITERAL), "caught");
  assert.ok('failState !== "x"'.match(LITERAL));
});

// Ratchet: a failState verdict compared by hand outside the phase module is the
// design cause this replaced. A count may only go DOWN; a new file is zero.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNERS = new Set([
  "core/queue/phase.ts",   // the one reading
  "sendConfirm.ts",        // the confirm window it is built on (`ASKING`)
  "core/queue/wire.ts",    // where a host verdict BECOMES a failState
]);
const ALLOWED = {};
const LITERAL = /\bfailState\s*[!=]==|\bdeliveryOf\([^)]*\)\s*[!=]==|\bstate\s*[!=]==\s*"(?:unconfirmed|unsubmitted)"|case\s+"(?:unconfirmed|unsubmitted|stale)"/g;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

test("ratchet: no failState verdict is compared by hand outside the phase module", () => {
  const over = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (OWNERS.has(rel)) continue;
    const n = (readFileSync(f, "utf8").match(LITERAL) ?? []).length;
    const cap = ALLOWED[rel] ?? 0;
    if (n > cap) over.push(`${rel}: ${n} > ${cap}`);
  }
  assert.deepEqual(over, [], "ask core/queue/phase.ts (rowPhase / revivable / mayBeInSession) instead");
});
