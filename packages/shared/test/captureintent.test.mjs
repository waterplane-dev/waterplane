// The capture INTENT — the half of the capture feature that is a pure rule, and
// therefore the half that can be settled before there is a manager to run it.
//
// Everything here runs against `shared/dist` with no host, no filesystem and no
// clock, exactly as `intent.test.mjs` does. What it pins is not the picture: it
// is what the STORE is allowed to say about one.
//
// Three failures are worth this file:
//
//   1. A capture row that classifies as something else. `intentKind` is one
//      classification for BOTH ends, and every screen that answers "did my work
//      run?" is a filter over it. A capture row landing in `build` puts a
//      screenshot under a build button; a capture row landing in `work` puts it
//      in the backlog. Neither throws.
//   2. A backend coerced instead of refused. "window" is the WHOLE DESKTOP, so
//      a junk `backend` quietly defaulting hands back a perfectly valid-looking
//      picture of the wrong thing — the exact failure mode a verified capture
//      exists to eliminate.
//   3. The four classifiers this adds a sixth sibling to drifting. `isBuildRow`
//      and `isBacklogRow` must be untouched by a payload kind they have never
//      heard of, and the `other` bucket must still catch what nothing claims —
//      that bucket is what an APK pinned to a pre-capture bundle renders a
//      capture run with, and a row that vanishes from Activity is worse than a
//      row labelled vaguely.
//
//     node --test packages/shared/test/captureintent.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_BACKEND_IDS,
  DEFAULT_CAPTURE_VIEWPORT,
  cleanIntentRow,
  intentKind,
  isAssessRow,
  isBacklogRow,
  isBuildRow,
  isCaptureRow,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;

const row = (over = {}) => ({
  id: "cr_ab12cd34",
  cwd: "/repo",
  payload: { kind: "capture", targetId: "t_home" },
  target: { kind: "shell" },
  trigger: { kind: "now" },
  state: "queued",
  createdAt: NOW - 1000,
  ...over,
});

// ── The payload survives the sanitizer intact ───────────────────────────────

test("a full capture payload round-trips unchanged", () => {
  const i = cleanIntentRow(
    row({ payload: { kind: "capture", targetId: "t_home", name: "droplet · home", backend: "garmin", watch: true } }),
    NOW,
  );
  assert.ok(i);
  assert.deepEqual(i.payload, {
    kind: "capture",
    targetId: "t_home",
    name: "droplet · home",
    backend: "garmin",
    watch: true,
  });
});

test("the minimum payload is a targetId, and the optionals stay ABSENT rather than empty", () => {
  const i = cleanIntentRow(row(), NOW);
  assert.ok(i);
  assert.equal(i.payload.kind, "capture");
  assert.equal(i.payload.targetId, "t_home");
  // Absent, never "" and never false: an empty name would render as a nameless
  // button, and `watch: false` would claim somebody decided against watching.
  assert.equal(i.payload.name, undefined);
  assert.equal(i.payload.backend, undefined);
  assert.equal(i.payload.watch, undefined);
});

test("a capture payload with nothing to point at is refused outright", () => {
  // `build`'s rule: a row that can only ever fail is not a row worth storing.
  assert.equal(cleanIntentRow(row({ payload: { kind: "capture" } }), NOW), null);
  assert.equal(cleanIntentRow(row({ payload: { kind: "capture", targetId: "   " } }), NOW), null);
});

test("an unknown backend is dropped, never coerced to a default", () => {
  // The whole point: "window" grabs the entire desktop, so a silently defaulted
  // backend produces a real-looking picture of the wrong thing.
  const i = cleanIntentRow(row({ payload: { kind: "capture", targetId: "t_home", backend: "ios" } }), NOW);
  assert.ok(i);
  assert.equal(i.payload.targetId, "t_home");
  assert.equal(i.payload.backend, undefined, "an unrecognised backend must be absent, not substituted");
});

test("every id in CAPTURE_BACKEND_IDS is accepted by the sanitizer", () => {
  // The list is exported so the refusal, the doctor line and the editor's picker
  // cannot each keep their own copy. If they can diverge from what the sanitizer
  // takes, the list is decoration.
  assert.deepEqual([...CAPTURE_BACKEND_IDS], ["web", "android", "garmin", "window"]);
  for (const backend of CAPTURE_BACKEND_IDS) {
    const i = cleanIntentRow(row({ payload: { kind: "capture", targetId: "t", backend } }), NOW);
    assert.equal(i?.payload.backend, backend);
  }
});

test("watch is only true when it was literally true", () => {
  for (const v of [1, "yes", "true", {}]) {
    const i = cleanIntentRow(row({ payload: { kind: "capture", targetId: "t", watch: v } }), NOW);
    assert.equal(i?.payload.watch, undefined, `watch: ${JSON.stringify(v)} must not become true`);
  }
});

test("the name is capped on LENGTH and never on the words of the prompt", () => {
  const i = cleanIntentRow(row({ payload: { kind: "capture", targetId: "t", name: "n".repeat(500) } }), NOW);
  assert.equal(i.payload.name.length, 120);
});

// ── Classification ──────────────────────────────────────────────────────────

test("a capture row classifies as capture and as nothing else", () => {
  const i = cleanIntentRow(row(), NOW);
  assert.equal(intentKind(i), "capture");
  assert.equal(isCaptureRow(i), true);
  assert.equal(isBuildRow(i), false);
  assert.equal(isAssessRow(i), false);
  assert.equal(isBacklogRow(i), false);
});

test("the existing classifiers are untouched by the new kind", () => {
  const build = cleanIntentRow(row({ payload: { kind: "build", buildId: "b1" } }), NOW);
  assert.equal(intentKind(build), "build");
  assert.equal(isCaptureRow(build), false);

  const work = cleanIntentRow(
    row({ payload: { kind: "prompt", steps: ["do the thing"] }, target: { kind: "repo" } }),
    NOW,
  );
  assert.equal(intentKind(work), "work");
  assert.equal(isCaptureRow(work), false);

  const assess = cleanIntentRow(row({ payload: { kind: "assess" } }), NOW);
  assert.equal(intentKind(assess), "assess");
  assert.equal(isCaptureRow(assess), false);
});

test("a scheduled capture is still a SCHEDULE — the trigger wins over the payload", () => {
  // Order matters in `intentKind`, and this is the pair that proves it: a
  // standing "shoot this screen every morning" belongs on the schedule screen,
  // where it can be disarmed, not in a list of things that already ran.
  const i = cleanIntentRow(
    row({ trigger: { kind: "at", rule: { kind: "daily", hour: 9, minute: 0 }, graceMin: 30 } }),
    NOW,
  );
  assert.ok(i);
  assert.equal(intentKind(i), "schedule");
  // The payload classifier still answers truthfully — the two questions are
  // different, and `capture.ts` dispatches on the payload, not on the kind.
  assert.equal(isCaptureRow(i), true);
});

test("an unknown payload kind is still refused, so `other` never fills with junk", () => {
  // `other` is for a kind a NEWER host knows and this bundle does not — it is
  // reached by a row that parsed, not by one that did not.
  assert.equal(cleanIntentRow(row({ payload: { kind: "screenshot", targetId: "t" } }), NOW), null);
});

// ── The default that both ends have to agree on ─────────────────────────────

test("DEFAULT_CAPTURE_VIEWPORT is one phone frame", () => {
  // Shared so the host's frame and the sheet's "390×844" label cannot disagree
  // about what "the default" was.
  assert.deepEqual(DEFAULT_CAPTURE_VIEWPORT, { w: 390, h: 844 });
});
