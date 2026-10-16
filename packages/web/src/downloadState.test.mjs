/**
 * The download button's own rules, pinned without a browser.
 *
 * Same arrangement as `contextPlot.test.mjs`: `downloadState.ts` has no DOM in
 * it (its only import is a type), so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it.
 *
 *     node --test packages/web/src/downloadState.test.mjs
 *
 * Every case below is a way the same button could be wrong in a way nobody
 * notices until the file is missing: offering *download* for bytes that are
 * already here, offering *save* for bytes that were evicted last week, or
 * treating a tap on a running transfer as a reason to start a second one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoSaveEligible, browserPullAsk, downloadAction, downloadStatus, fileMatch, needsFetch, pumpEligible, stripRows, syncKeeps } from "./downloadState.ts";

const rec = (over = {}) => ({
  item: { id: "l_x", repoId: "r", repoDir: "", repoName: "repo", name: "app.apk", relPath: ".claude/outbox/app.apk", size: 1000, mtime: 5, ts: 5, source: "manual" },
  state: "queued", received: 0, attempts: 0, updatedAt: 0,
  ...over,
});

test("no record at all is an offer to fetch it", () => {
  const st = downloadStatus(undefined);
  assert.equal(st.phase, "idle");
  assert.equal(st.label, "download");
  assert.equal(st.pct, null);
  assert.equal(downloadAction(undefined), "start");
});

test("an evicted download offers a fresh fetch, and SAYS it was here before", () => {
  const st = downloadStatus(rec({ state: "done", received: 1000, evicted: true, savedAt: 1 }));
  assert.equal(st.phase, "idle");
  assert.equal(downloadAction(rec({ state: "done", evicted: true })), "start");
  assert.match(st.detail, /cleared to save space/);
});

test("a transfer in flight reports, and a tap on it opens the queue", () => {
  const r = rec({ state: "downloading", received: 250 });
  const st = downloadStatus(r);
  assert.equal(st.phase, "downloading");
  assert.equal(st.pct, 25);
  assert.match(st.label, /25%/);
  // The one thing it must NOT do is start a second copy of the same file.
  assert.equal(downloadAction(r), "open");
});

test("queued says whether anything is here yet — 0% and 'no idea' are different", () => {
  const fresh = downloadStatus(rec({ state: "queued" }));
  assert.equal(fresh.pct, null);
  assert.match(fresh.detail, /waiting its turn/);
  const part = downloadStatus(rec({ state: "queued", received: 400 }));
  assert.equal(part.pct, 40);
  assert.match(part.detail, /resumes from there/);
  assert.equal(downloadAction(rec({ state: "paused" })), "open");
});

test("a failure offers a retry and names the reason", () => {
  const r = rec({ state: "failed", received: 100, error: "http 404" });
  const st = downloadStatus(r);
  assert.equal(st.phase, "failed");
  assert.equal(st.label, "retry download");
  assert.match(st.detail, /http 404/);
  assert.equal(downloadAction(r), "start");
});

test("bytes here but never saved out offers the hand-off, not another download", () => {
  const r = rec({ state: "done", received: 1000 });
  const st = downloadStatus(r);
  assert.equal(st.phase, "have");
  assert.equal(st.label, "save to phone");
  assert.equal(st.pct, 100);
  assert.equal(downloadAction(r), "save");
});

test("a failed save is a different sentence from a failed download", () => {
  const st = downloadStatus(rec({ state: "done", received: 1000, saveError: "no space" }));
  assert.equal(st.phase, "have");            // the file IS here; only the hand-off failed
  assert.match(st.detail, /saving it out failed: no space/);
});

test("a saved file says where it went, and can be saved again", () => {
  const r = rec({ state: "done", received: 1000, savedAt: 9, savedTo: "Downloads/app.apk" });
  const st = downloadStatus(r);
  assert.equal(st.phase, "saved");
  assert.equal(st.label, "save again");
  assert.match(st.detail, /Downloads\/app\.apk/);
  assert.equal(downloadAction(r), "save");
});

test("a percentage is never invented from a size nobody knows", () => {
  const st = downloadStatus(rec({ state: "downloading", received: 0, item: { ...rec().item, size: 0 } }));
  assert.equal(st.pct, 0);      // nothing received and no total: 0 is the truth here
  const st2 = downloadStatus(rec({ state: "downloading", received: 512, item: { ...rec().item, size: 0 } }));
  assert.equal(st2.pct, 100);   // all we know is that everything we have, we have
});

// ── what a tap actually MOVES, and which row it moves ────────────────────
// The labels above were pinned from the start; these two rules were not, and
// the first bug this refactor shipped lived in exactly that gap: the button
// said "downloading…" and nothing was ever queued.

test("an evicted record must be FETCHED again, not treated as done", () => {
  assert.equal(needsFetch(rec({ state: "done", received: 1000, evicted: true })), true);
  assert.equal(needsFetch(rec({ state: "done", received: 1000 })), false);
});

test("a running transfer is never restarted, everything stalled is", () => {
  assert.equal(needsFetch(rec({ state: "downloading", received: 10 })), false);
  for (const state of ["queued", "paused", "failed"]) {
    assert.equal(needsFetch(rec({ state })), true, state);
  }
});

test("two known mtimes that differ are two FILES, never one row", () => {
  const r = rec();   // mtime 5
  assert.equal(fileMatch(r, "r", ".claude/outbox/app.apk", 5), "exact");
  // The rebuilt artifact: same path, new mtime. Matching here is how a tap on
  // this week's build hands over last week's bytes.
  assert.equal(fileMatch(r, "r", ".claude/outbox/app.apk", 9), null);
  assert.equal(fileMatch(r, "other", ".claude/outbox/app.apk", 5), null);
  assert.equal(fileMatch(r, "r", ".claude/outbox/other.apk", 5), null);
});

test("a side that does not know the mtime matches loosely — a notification carries none", () => {
  assert.equal(fileMatch(rec(), "r", ".claude/outbox/app.apk"), "loose");
  const blind = rec({ item: { ...rec().item, mtime: 0 } });
  assert.equal(fileMatch(blind, "r", ".claude/outbox/app.apk", 9), "loose");
  assert.equal(fileMatch(blind, "r", ".claude/outbox/app.apk"), "loose");
});

test("a FINISHED record that never knew its mtime is not this version of the file", () => {
  // The screenshot fetched on Monday from a viewer that had no mtime. On Tuesday
  // the agent regenerates the file. Matching Monday's bytes to Tuesday's mtime
  // is how a tap "saves" last week's file under this week's name — and how the
  // grid then marks this week's file downloaded.
  const doneBlind = rec({ item: { ...rec().item, mtime: 0 }, state: "done", received: 1000 });
  assert.equal(fileMatch(doneBlind, "r", ".claude/outbox/app.apk", 77), null);
  // ...but a caller with no mtime of its own still means that row,
  assert.equal(fileMatch(doneBlind, "r", ".claude/outbox/app.apk"), "loose");
  // and while the transfer is unfinished the bytes ARE whatever is being served
  // now, so adopting the mtime is right.
  const midBlind = rec({ item: { ...rec().item, mtime: 0 }, state: "queued", received: 200 });
  assert.equal(fileMatch(midBlind, "r", ".claude/outbox/app.apk", 77), "loose");
  const evictedBlind = rec({ item: { ...rec().item, mtime: 0 }, state: "done", evicted: true });
  assert.equal(fileMatch(evictedBlind, "r", ".claude/outbox/app.apk", 77), "loose");
});

test("a host sync withdraws only what is the host's to withdraw", () => {
  // Named by the host: kept, obviously.
  assert.equal(syncKeeps(rec(), true, false), true);
  // Gone from the host queue: an ordinary row goes...
  assert.equal(syncKeeps(rec(), false, false), false);
  // ...but not one this device asked for, not one whose bytes are here, and not
  // the transfer that is running.
  assert.equal(syncKeeps(rec({ local: true }), false, false), true);
  assert.equal(syncKeeps(rec({ state: "done", received: 1000 }), false, false), true);
  assert.equal(syncKeeps(rec(), false, true), true);
});

test("the auto-download switch governs the host's queue, never a tap", () => {
  const o = { auto: true, force: false, maxAttempts: 50, now: 1000 };
  const host = rec(), mine = rec({ local: true });
  assert.equal(pumpEligible(host, o), true);
  // Switch off: the host's own queue waits, the file a person tapped does not.
  assert.equal(pumpEligible(host, { ...o, auto: false }), false);
  assert.equal(pumpEligible(mine, { ...o, auto: false }), true);
  // A tap outranks the backoff and the give-up count as well.
  const beaten = rec({ attempts: 99, nextRetryAt: 9999 });
  assert.equal(pumpEligible(beaten, o), false);
  assert.equal(pumpEligible(beaten, { ...o, force: true }), true);
  // Only a queued row is ever started.
  for (const state of ["downloading", "done", "failed", "paused"]) {
    assert.equal(pumpEligible(rec({ state, local: true }), { ...o, force: true }), false, state);
  }
  assert.equal(pumpEligible(undefined, o), false);
  // A row the native download service is holding is not this page's to start —
  // and a tap does not waive it, because re-handing a row that is backing off
  // clears the service's give-up count. `retry()` clears the flag first, which
  // is what makes a tap mean something.
  const owned = rec({ local: true, nativeOwned: true });
  assert.equal(pumpEligible(owned, o), false);
  assert.equal(pumpEligible(owned, { ...o, force: true }), false);
  assert.equal(pumpEligible(rec({ local: true, nativeOwned: false }), o), true);
});

const saved = (over = {}) => rec({ state: "done", received: 1000, savedAt: 9, saveVia: "device", savedTo: "Downloads/app.apk", ...over });

test("a file the folder confirms is THERE is not an offer to save", () => {
  const st = downloadStatus(saved({ savedPresent: true }));
  assert.equal(st.phase, "saved");
  assert.equal(st.label, "in Downloads");
  assert.match(st.detail, /in Downloads\/app\.apk/);
  // The whole point: MediaStore renames rather than overwrites, so a second
  // save is a second copy — the tap must mean something else.
  assert.equal(downloadAction(saved({ savedPresent: true })), "open");
});

test("a file that WAS saved and is gone from Downloads says so, and offers to put it back", () => {
  const st = downloadStatus(saved({ savedPresent: false }));
  assert.match(st.detail, /not in Downloads any more/);
  assert.match(st.detail, /still on this phone/);
  assert.equal(st.label, "save again");
  assert.equal(downloadAction(saved({ savedPresent: false })), "save");
});

test("nobody asked the folder is not the same claim as the file being gone", () => {
  // A browser, or an APK whose plugin predates `find`: the row must say what
  // was done and nothing about where the file is now.
  const st = downloadStatus(saved());
  assert.match(st.detail, /saved to Downloads\/app\.apk/);
  assert.doesNotMatch(st.detail, /not in Downloads/);
  assert.equal(downloadAction(saved()), "save");
  // The browser hand-off keeps its own sentence whatever the folder says: it
  // has no folder to be asked about.
  const via = downloadStatus(saved({ saveVia: "browser", savedTo: "your browser's downloads", savedPresent: true }));
  assert.match(via.detail, /handed to/);
});

test("what the automatic hand-off will and will not put in Downloads", () => {
  const done = (over = {}) => rec({ state: "done", received: 1000, ...over });
  // A tap promised it; the preference promises it for everything.
  assert.equal(autoSaveEligible(done({ autoSave: true }), false), true);
  assert.equal(autoSaveEligible(done(), false), false);
  assert.equal(autoSaveEligible(done(), true), true);
  // Three ways of saving the same file twice, all refused.
  assert.equal(autoSaveEligible(done({ evicted: true }), true), false);
  assert.equal(autoSaveEligible(done({ savedAt: 5 }), true), false);
  assert.equal(autoSaveEligible(done({ saveError: "no space" }), true), false);
  // Nothing that has not finished.
  for (const state of ["queued", "downloading", "paused", "failed"]) {
    assert.equal(autoSaveEligible(rec({ state, autoSave: true }), true), false, state);
  }
});

// ── A row that says "downloading" while nothing is carrying it ──────────────
//
// Reported from a phone: "No downloads start at all", with the queue showing
// `DOWNLOADING · 1 · 0 B of 24.4 MB` and the row reading "waiting to start" for
// three hours. `state: "downloading"` is a claim about an ENGINE, and the engine
// lives where the record cannot see it — in the page, in the browser, or in the
// native service. Lose the carrier and the row is stranded in the one state
// nothing picks up again: `pumpEligible` takes only `queued`, `watchdog` returns
// early with no `active`, and `whyIdle` used to inspect neither.

test("a page-run transfer whose carrier is gone is stranded", async () => {
  const { strandedDownload } = await import("./downloadState.ts");
  const rec = { item: { id: "a" }, state: "downloading" };
  assert.equal(strandedDownload(rec, { activeId: null }), true);
  // …but not while THIS page is the one running it.
  assert.equal(strandedDownload(rec, { activeId: "a" }), false);
});

test("a carrier that outlives the page is never called stranded", async () => {
  const { strandedDownload } = await import("./downloadState.ts");
  // The native service keeps moving bytes with the page dead — re-queueing one
  // of these starts a SECOND copy of a live download.
  assert.equal(strandedDownload(
    { item: { id: "a" }, state: "downloading", nativeOwned: true }, { activeId: null }), false);
  assert.equal(strandedDownload(
    { item: { id: "a" }, state: "downloading", engine: "native" },
    { activeId: null, nativeSupported: true }), false);
  // The browser is carrying a Background Fetch unless the caller has asked the
  // registration and been told otherwise. Guessing either way is a bug: a false
  // yes strands it another page-life, a false no duplicates a live transfer.
  assert.equal(strandedDownload(
    { item: { id: "a" }, state: "downloading", engine: "bgfetch" }, { activeId: null }), false);
  assert.equal(strandedDownload(
    { item: { id: "a" }, state: "downloading", engine: "bgfetch" },
    { activeId: null, bgLive: false }), true);
});

test("a native row is stranded once the platform carrying it is not there", async () => {
  const { strandedDownload } = await import("./downloadState.ts");
  // The APK's service cannot be holding anything in a plain browser tab.
  assert.equal(strandedDownload(
    { item: { id: "a" }, state: "downloading", engine: "native" },
    { activeId: null, nativeSupported: false }), true);
});

test("every other state is somebody else's problem", async () => {
  const { strandedDownload } = await import("./downloadState.ts");
  for (const state of ["queued", "paused", "failed", "done"]) {
    assert.equal(strandedDownload({ item: { id: "a" }, state }, { activeId: null }), false, state);
  }
  assert.equal(strandedDownload(undefined, { activeId: null }), false);
});

test("a stranded row is not eligible for the pump — which is why it must be requeued", async () => {
  const { strandedDownload, pumpEligible } = await import("./downloadState.ts");
  const rec = { item: { id: "a" }, state: "downloading", attempts: 0, local: true };
  assert.equal(strandedDownload(rec, { activeId: null }), true);
  // Even forced. This is the whole trap: nothing the user can tap reaches it.
  assert.equal(pumpEligible(rec, { auto: true, force: true, maxAttempts: 5, now: Date.now() }), false);
  // Back in `queued`, the same row runs.
  assert.equal(pumpEligible({ ...rec, state: "queued" }, { auto: true, force: false, maxAttempts: 5, now: Date.now() }), true);
});

test("an open socket refutes a WebView that claims to be offline", async () => {
  const { noNetwork } = await import("./downloadState.ts");
  // The reported bug: `onLine` stuck false in the APK while the header showed a
  // 17 ms round trip. The queue must run.
  assert.equal(noNetwork(false, true), false);
  // Genuinely offline: nothing contradicts the browser.
  assert.equal(noNetwork(false, false), true);
  // A dead HOST is not a dead phone — the attempt is what tells them apart.
  assert.equal(noNetwork(true, false), false);
  assert.equal(noNetwork(true, true), false);
});

test("with auto-download off, the strip counts only what moves or was tapped", () => {
  const waiting = rec({ state: "queued" });
  const tapped = rec({ state: "queued", local: true });
  const running = rec({ state: "downloading" });
  const done = rec({ state: "done" });
  const paused = rec({ state: "paused" });
  assert.deepEqual(stripRows([waiting, tapped, running, done, paused], true), [waiting, tapped, running, paused]);
  assert.deepEqual(stripRows([waiting, tapped, running, done, paused], false), [tapped, running]);
});

test("a browser beside the APK is asked once, and only about automatic work", () => {
  const auto = rec({ state: "downloading" });
  const base = { native: false, android: true, auto: true, answered: false, records: [auto] };
  assert.equal(browserPullAsk(base), true);
  assert.equal(browserPullAsk({ ...base, native: true }), false, "the shell is the app");
  assert.equal(browserPullAsk({ ...base, android: false }), false, "no APK off Android");
  assert.equal(browserPullAsk({ ...base, auto: false }), false, "already off here");
  assert.equal(browserPullAsk({ ...base, answered: true }), false, "asked once");
  assert.equal(browserPullAsk({ ...base, records: [rec({ local: true })] }), false, "a tap is not automatic");
  assert.equal(browserPullAsk({ ...base, records: [rec({ state: "done" })] }), false, "nothing on its way");
});
