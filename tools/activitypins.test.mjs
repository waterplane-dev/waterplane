/**
 * Pins for splitting the activity sheet (docs/notes/activity-architecture.md).
 *
 * `activityRows.ts` (1950 lines of pure row logic) and `ActivitySheet.tsx`
 * (927) are cut into `activity/`. Two things must not change in a move:
 *
 *  1. The EXPORT SURFACE, read off the type checker (values and types alike —
 *     half of it is types, which no runtime import sees).
 *  2. The BEHAVIOUR of the row builders: a deterministic matrix of queue
 *     entries, intents, pulls and filters is run through every exported pure
 *     function and compared (as per-observation digests) with `activitypins.golden.json`. The golden was
 *     recorded BEFORE the move. Regenerate with
 *     `WATERPLANE_REGOLDEN=1 node --test tools/activitypins.test.mjs` only for a
 *     deliberate behaviour change, named as such in its commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as R from "../packages/web/src/activityRows.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const BARREL = here("../packages/web/src/activityRows.ts");
const GOLDEN = here("./activitypins.golden.json");

const SURFACE = [
  "ACTIVITY_FILTERS:value", "ActivityAction:type", "ActivityActionId:type", "ActivityBucket:type",
  "ActivityDeps:type", "ActivityFilter:type", "ActivityGroup:type", "ActivityInput:type",
  "ActivityKind:type", "ActivityRow:type", "ActivitySort:type", "ActivitySource:type",
  "ActivitySubject:type", "ActivityTarget:type", "DeliveryTruth:type",
  "activityCounts:value", "activityHeadlineCut:value", "activityRows:value", "activityTextKey:value",
  "bulkLines:value", "compareActivity:value", "dismissBlocker:value", "entryProse:value",
  "groupActivity:value", "intentRowKey:value", "intentTitle:value", "isActivityDebris:value",
  "matchesFilter:value", "onlyUploadsFailed:value", "partitionBulk:value", "queueRowKey:value",
  "refireBlocker:value", "restorableFailed:value", "sortActivity:value",
];

function surface(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${file} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

test("activityRows.ts exports exactly its pinned surface, values and types alike", () => {
  assert.deepEqual(surface(BARREL), [...SURFACE].sort());
});

// The sheet facade's surface: the props type and `ReviewMarks` are re-exported
// from `activity/activitySheetTypes.ts`, the component is declared in place.
test("ActivitySheet.tsx exports exactly its pinned surface", () => {
  assert.deepEqual(surface(here("../packages/web/src/ActivitySheet.tsx")), [
    "ActivitySheet:value", "ActivitySheetProps:type", "ReviewMarks:type",
  ]);
});

// ── the golden ──────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;
const deps = {
  isEditableEntry: (e) => e.status === "queued" && e.mode !== "upload" && !e.answer,
  isCreateOp: (e) => e.mode === "op" && e.op?.t === "session.create",
  laneLabel: (e) => e.sessionId,
  repoName: (cwd) => cwd.split("/").pop(),
};

function matrix() {
  const outbox = [];
  const queueBlocked = new Map();
  const blocks = ["inflight", "pendingCreate", "held", "serial", "backoff", "lane", "budget", "sessionBudget", "sessionGone", "gate", undefined];
  let n = 0;
  for (const status of ["queued", "pending", "failed"])
    for (const failState of [undefined, "unconfirmed", "unsubmitted", "stale", "refused", "other"])
      for (const mode of [undefined, "input", "backlog", "upload", "op"]) {
        n += 1;
        const e = {
          ackId: `a${n}`, sessionId: n % 7 === 0 ? "pending:x" : `s${n % 3}`, cwd: n % 4 ? `/dev/r${n % 4}` : "",
          text: n % 5 === 0 ? "Continue please" : `fix thing ${n % 9}`, ts: NOW - n * 90_000, status,
          ...(status === "failed" ? { failState, failedAt: NOW - n * 1000, reason: n % 2 ? "no route" : undefined } : {}),
          ...(status === "pending" ? { sentAt: NOW - 5000 } : {}),
          ...(mode ? { mode } : {}),
          ...(mode === "op" ? { op: { t: n % 2 ? "session.create" : "other" } } : {}),
          ...(n % 6 === 0 ? { retryAt: NOW + 4000, attempts: 3 } : {}),
          ...(n % 11 === 0 ? { answer: true } : {}),
          ...(n % 13 === 0 ? { hostSettled: true } : {}),
          ...(n % 8 === 0 ? { kind: "command" } : {}),
        };
        outbox.push(e);
        const b = blocks[n % blocks.length];
        if (b && status === "queued") queueBlocked.set(e.ackId, b);
      }
  const intents = [];
  const states = ["queued", "blocked", "starting", "running", "done", "failed", "canceled"];
  const reasons = [undefined, "offline", "gate", "budget", "sessionBudget", "sessionBusy", "sessionGone", "awaitingAnswer", "limit", "filesMissing", "notYet", "serial", "hostBusy", "noSlot"];
  const payloads = [
    { kind: "prompt", steps: ["add the export button", "then test it"] },
    { kind: "build", buildId: "b", name: "Release APK", cmd: "gradle", cwd: "/dev/r1" },
    { kind: "capture", targetId: "t", name: "home", backend: "web" },
    { kind: "assess", name: "assess r1" },
  ];
  const targets = [{ kind: "repo" }, { kind: "repo", fresh: true }, { kind: "session", sessionId: "s1" }, { kind: "shell" }, { kind: "repos", dirs: ["/a", "/b"] }];
  const triggers = [{ kind: "idle" }, { kind: "now" }, { kind: "files", needs: ["a.jpg"], deadlineAt: NOW + 3600e3 }, { kind: "at", rule: { kind: "weekly" }, graceMin: 30 }, { kind: "at", rule: { kind: "once", at: NOW - 1000 } }];
  let k = 0;
  for (const state of states) for (const blockReason of reasons) {
    k += 1;
    const settled = state === "done" || state === "failed" || state === "canceled";
    intents.push({
      id: `i${k}`, cwd: `/dev/r${k % 4}`, payload: payloads[k % payloads.length], target: targets[k % targets.length],
      trigger: triggers[k % triggers.length], state, createdAt: NOW - k * 60_000,
      ...(state === "blocked" && blockReason ? { blockReason, blockDetail: `why ${blockReason}` } : {}),
      ...(k % 3 === 0 ? { label: `label ${k}` } : {}), ...(k % 5 === 0 ? { headline: `headline ${k}` } : {}),
      ...(k % 4 === 0 ? { nextAt: NOW + k * 1000 } : {}),
      ...(k % 7 === 0 ? { origin: "assess:1" } : {}), ...(k % 9 === 0 ? { origin: "agent" } : {}),
      ...(settled ? { settledAt: NOW - k * 100, result: { at: NOW, ok: state === "done", detail: `result ${k}`, exitCode: state === "done" ? 0 : 1, artifacts: [] } } : {}),
      ...(state === "running" ? { sessionId: "s1" } : {}),
      ...(k % 10 === 0 ? { requeues: [{ at: NOW, by: "run" }] } : {}),
    });
  }
  // a sweep: the parent, plus one child per repo sharing its groupId
  intents.push({ id: "f1", groupId: "f1", origin: "fanout:run", cwd: "/dev/r1", payload: { kind: "prompt", steps: ["bump deps"] }, target: { kind: "repos", dirs: ["/a", "/b", "/c"] }, trigger: { kind: "now" }, state: "running", createdAt: NOW - 60_000 });
  ["done", "failed", "running"].forEach((state, i) => intents.push({
    id: `f1-${i}`, groupId: "f1", origin: "fanout", cwd: `/dev/c${i}`, title: `child ${i}`, payload: { kind: "prompt", steps: ["bump deps"] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "now" }, state, createdAt: NOW - 60_000 + i, order: i,
    ...(state === "failed" ? { result: { at: NOW, ok: false, detail: "boom" }, settledAt: NOW } : {}),
    ...(state === "done" ? { settledAt: NOW, sessionId: "s9" } : {}),
  }));
  const pulls = ["queued", "downloading", "paused", "done", "failed"].map((state, i) => ({
    item: { id: `p${i}`, repoId: "r", repoDir: "/dev/r1", repoName: "r1", name: `app${i}.apk`, relPath: `out/app${i}.apk`, size: 1000 * (i + 1), mtime: NOW, ts: NOW - i * 1000, source: i % 2 ? "build" : "outbox" },
    state, received: i * 100, attempts: i, ...(state === "failed" ? { error: "net down" } : {}),
  }));
  const sessions = [{ id: "s1", cwd: "/dev/r1", title: "one" }, { id: "s9", cwd: "/dev/c0", title: "nine" }];
  const dismissed = new Map([["intent:i3", NOW - 100], ["queue:a2", NOW - 200], ["intent:i10", NOW - 300]]);
  const confirmedDone = new Map([["intent:i20", NOW - 100], ["queue:a5", NOW - 100]]);
  return { outbox, queueBlocked, intents, pulls, sessions, dismissed, confirmedDone, goneLanes: new Set(["s1"]) };
}

function observe() {
  const m = matrix();
  const out = {};
  for (const online of [true, false]) for (const withExtras of [true, false]) {
    const input = {
      now: NOW, online, hostSeenAt: online ? NOW - 1000 : null, deps,
      outbox: m.outbox, queueBlocked: m.queueBlocked, intents: m.intents, pulls: m.pulls, sessions: m.sessions,
      ...(withExtras ? { dismissed: m.dismissed, confirmedDone: m.confirmedDone, goneLanes: m.goneLanes } : {}),
    };
    const rows = R.activityRows(input);
    const tag = `${online ? "on" : "off"}${withExtras ? "+x" : ""}`;
    out[`rows:${tag}`] = rows;
    out[`counts:${tag}`] = R.activityCounts(rows);
    out[`headline:${tag}`] = R.activityHeadlineCut(rows, online)?.text ?? null;
    out[`headline-empty:${tag}`] = R.activityHeadlineCut([], online)?.text ?? null;
    out[`debris:${tag}`] = rows.map((r) => R.isActivityDebris(r));
    out[`textkey:${tag}`] = rows.map((r) => R.activityTextKey(r));
    out[`refire:${tag}`] = rows.map((r) => R.refireBlocker(r));
    out[`dismiss:${tag}`] = rows.map((r) => R.dismissBlocker(r));
    out[`cmp:${tag}`] = [...rows].reverse().sort(R.compareActivity).map((r) => r.key);
    for (const f of R.ACTIVITY_FILTERS) {
      const shown = rows.filter((r) => R.matchesFilter(r, f.id));
      out[`filter:${tag}:${f.id}`] = shown.map((r) => r.key);
      for (const sort of ["ranked", "oldest"]) for (const group of [true, false]) {
        out[`group:${tag}:${f.id}:${sort}:${group}`] = R.groupActivity(R.sortActivity(shown, sort), rows, { group });
      }
    }
    const failed = rows.filter((r) => r.bucket === "failed");
    for (const verb of ["dismiss", "refire", "restore"]) {
      out[`bulk:${tag}:${verb}`] = R.bulkLines(failed, { verb, repoName: deps.repoName, skipped: verb === "refire" ? 2 : 0 });
      out[`bulk1:${tag}:${verb}`] = R.bulkLines(failed.slice(0, 1), { verb, repoName: deps.repoName });
    }
    out[`partition:${tag}`] = R.partitionBulk(rows, R.refireBlocker);
  }
  out.titles = m.intents.map((i) => R.intentTitle(i));
  out.keys = [R.queueRowKey("x"), R.intentRowKey("y"), R.ACTIVITY_FILTERS];
  out.restorable = [
    R.restorableFailed([{ status: "failed", mode: "upload" }, { status: "failed" }]),
    R.onlyUploadsFailed([{ status: "failed", mode: "upload" }]), R.onlyUploadsFailed([{ status: "failed" }]),
    R.entryProse({ ackId: "a", sessionId: "s", cwd: "/x", text: "words", ts: 1, status: "queued" }),
  ];
  return JSON.parse(JSON.stringify(out, (_k, v) => (v === undefined ? null : v)));
}

/** One sha256 per observation: the full golden is 17 MB, a digest of each is 10 KB and says WHICH moved. */
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

test("the row builders still produce the recorded golden over the matrix", () => {
  const got = observe();
  assert.ok(Object.keys(got).length > 80, "the matrix shrank");
  assert.ok(got["rows:on+x"].length > 150, "too few rows to mean anything");
  const digests = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, digest(v)]));
  if (process.env.WATERPLANE_REGOLDEN === "1") {
    writeFileSync(GOLDEN, JSON.stringify(digests, null, 1) + "\n");
    return;
  }
  const want = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(digests).sort(), Object.keys(want).sort());
  const moved = Object.keys(want).filter((k) => digests[k] !== want[k]);
  assert.deepEqual(moved, [], "these observations changed");
});
