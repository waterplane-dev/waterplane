/**
 * Four rules the backlog holds that are not about the LIST: what a failed
 * delivery is entitled to claim, how the config file reaches the disk, what may
 * wear the mark that says a session belongs to machinery, and what a *put them
 * back* tap answers on the wire.
 *
 * The first three were found by review rather than by use, and all three are
 * silent when they go wrong — a prompt typed twice into a second session, a boot
 * that comes up with everything switched off, a session closed under the person
 * driving it. None of them is visible in the list, which is why none of them was
 * covered by the tests that were. The fourth is a CONTRACT rather than a bug: the
 * client draws one button whatever state the merged row is in, and the host
 * answers in words, so the words are what has to be pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BacklogManager, chainDeliveryError, retryableStep, withoutBacklogMark, isBacklogTitle } =
  await import("../dist/backlog.js");
const { sessionRoutes } = await import("../dist/routes/session.js");

// ── 1. only the FIRST step of a chain may be re-run ─────────────────────────

test("a `retry` on step 1 is retryable; a `retry` on any later step is NOT", () => {
  // `retry` means *provably nothing was typed*, and that is a claim about the
  // STEP that returned it — never about the item. A chain is one item delivered
  // a turn at a time, so a `retry` from step 2 arrives with step 1 already run:
  // the store's retry path puts the row back to `queued` with no `sessionId`,
  // the next tick opens a SECOND session, and step 1 is typed into it while the
  // first session is still working on the first copy. "Run it twice" is the one
  // thing the whole intent store is built to prevent.
  assert.equal(retryableStep("retry", 0), true);
  assert.equal(retryableStep("retry", 1), false, "step 2 came back retry — step 1 has already run");
  assert.equal(retryableStep("retry", 5), false);
  // The other three verdicts were never retryable and still are not: `retry` is
  // the only one that claims nothing was typed.
  for (const v of ["unconfirmed", "unsubmitted", "ok"]) {
    assert.equal(retryableStep(v, 0), false, v);
  }
});

test("…and the sentence says which turn stopped, and that the item is not re-run from the top", () => {
  const one = chainDeliveryError("retry", 0, 1);
  assert.doesNotMatch(one, /turn 1 of/, "a one-turn item has no chain to explain");

  const two = chainDeliveryError("retry", 1, 3);
  assert.match(two, /turn 2 of 3/);
  assert.match(two, /turn 1 already ran/);
  assert.match(two, /NOT re-run from the top/, "the thing a person has to know before they re-fire it");

  assert.match(chainDeliveryError("unconfirmed", 2, 3), /turns 1–2 already ran/);
});

test("both executors ask that rule rather than reading the verdict themselves", () => {
  // The rule is one line at each call site and a line is easy to write back the
  // way it was. `backlog.deliver` (now `backlog/backlogsessions.ts`) types into a session that already exists and
  // `server/intentDeps.ts`'s `freshSession` opens one first; both walk a chain, so both had
  // the same `retry: last === "retry"` and both requeued whole items.
  for (const f of ["../dist/backlog/backlogsessions.js", "../dist/server/intentDeps.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /retry:\s*last === "retry"\s*[,}]/, `${f} decides retryability off the verdict alone`);
  }
});

test("both executors SAY which step they stopped on, so the store's Stop shortcut can tell", () => {
  // The rule the shortcut needs is one word at each call site, and a word is easy
  // to leave out. A `Stop` past the baseline is evidence that ONE turn ended; on
  // a chain that turn is step 1's, so a later step's failure must not be read as
  // the item finishing. Without `step` on the result the store cannot tell the
  // two apart, and a three-step item with two turns never typed settled `done`.
  for (const f of ["../dist/backlog/backlogsessions.js", "../dist/server/intentDeps.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /step[,:]/, `${f} never reports the step it stopped on`);
    // Every place that builds the chain error builds it beside a step.
    for (const m of src.matchAll(/chainDeliveryError\(/g)) {
      const around = src.slice(Math.max(0, m.index - 260), m.index + 120);
      assert.match(around, /\bstep\b/, `${f}: a chain failure with no step beside it`);
    }
  }
});

// ── 2. the config file is written the way every store here is ──────────────

/** The two collaborators `setAuto` reaches, and nothing else. */
const fakeIntents = () => ({ kick: () => {}, emitChanged: () => {}, list: () => [] });

test("the backlog's config reaches disk by tmp+rename, never a truncate-in-place", () => {
  // It was a bare `writeFileSync`, and a torn one is silent in the worst
  // possible way: `init()` reads the file inside `try { … } catch { /* fresh */ }`,
  // so half a JSON document comes back as `auto: false` with no repo ticked —
  // auto-fire off and every smart-pick tick off, on the next boot, with nothing
  // said. "Half a JSON document where a backlog used to be" is this repo's
  // recorded failure for exactly this.
  //
  // The observable difference is the INODE: a truncate-in-place keeps it, a
  // rename replaces it. That is the whole of atomicity from the reader's side.
  const root = mkdtempSync(join(tmpdir(), "waterplane-blcfg-"));
  const b = new BacklogManager(root, {}, fakeIntents(), {});
  const path = join(root, ".waterplane", "backlog-config.json");

  b.setAuto(true);
  const first = statSync(path).ino;
  b.setSmartPick("/tmp/waterplane-blcfg-repo", true);
  const second = statSync(path).ino;

  assert.notEqual(second, first, "the file was replaced, not overwritten in place");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(cfg.auto, true, "and both settings travelled together, which is why they share one file");
  assert.ok(cfg.smartPick["/tmp/waterplane-blcfg-repo"]);
  rmSync(root, { recursive: true, force: true });
});

// ── 3. the mark that says a session is machinery's ─────────────────────────

test("`backlog · ` is stripped from a title that came off the wire", () => {
  assert.equal(withoutBacklogMark("backlog · myapp · fix the flaky test"), "myapp · fix the flaky test");
  assert.equal(withoutBacklogMark("backlog · myapp"), "myapp");
  assert.equal(withoutBacklogMark("my own tab"), "my own tab", "an ordinary title is untouched");
  assert.equal(withoutBacklogMark(undefined), undefined);
  assert.equal(withoutBacklogMark("backlog · "), undefined, "nothing left is no title, not an empty one");
  assert.equal(isBacklogTitle(withoutBacklogMark("backlog · myapp") ?? ""), false);
});

test("a session REOPENED from Recently closed is not counted, reaped or lingered as machinery's", () => {
  // The prefix is the only mark: it is what `autoSessionCount()` counts against
  // the cap, what `reapAutoSession` may close to make room and what
  // `lingerSweep` retires after ten minutes. A finished item's session is closed
  // WITH its title, so it sits in *Recently closed* still called `backlog · myapp
  // · …` — and the reopen button sends that very title back. The session the
  // person was then driving counted against the cap and was reapable after sixty
  // seconds of a silent screen (a permission box, a long tool call), with the
  // socket detached because the phone was in a pocket.
  const created = [];
  const a = {
    dir: "/tmp/waterplane-reopen-repo",
    msg: {
      t: "session.create", cwd: "/tmp/waterplane-reopen-repo",
      title: "backlog · myapp · fix the flaky test",
      resumeSessionId: "conv-1", resumeMode: "continue",
    },
    ws: {},
    att: { add: () => {} },
    c: {
      sessions: { create: (cwd, opts) => { created.push(opts); return { id: "s-new" }; }, kill: () => {} },
      intents: { post: () => ({ ok: false }) },
      recomputeWatched: () => {},
      startPrompt: () => {},
      send: () => {},
    },
  };
  const res = sessionRoutes["session.create"].run(a);
  assert.equal(res.ok, true);
  assert.equal(created.length, 1);
  assert.equal(isBacklogTitle(created[0].title ?? ""), false, "the person's tab does not wear the machine's mark");
  assert.equal(created[0].title, "myapp · fix the flaky test", "…but it keeps the name that tells them which one it is");
  assert.equal(created[0].resumeSessionId, "conv-1", "and it is still the same conversation");
});

test("an ordinary create's title is passed through exactly", () => {
  const created = [];
  const a = {
    dir: "/tmp/waterplane-reopen-repo",
    msg: { t: "session.create", cwd: "/tmp/waterplane-reopen-repo", title: "review the diff" },
    ws: {}, att: { add: () => {} },
    c: {
      sessions: { create: (cwd, opts) => { created.push(opts); return { id: "s2" }; }, kill: () => {} },
      intents: { post: () => ({ ok: false }) },
      recomputeWatched: () => {}, startPrompt: () => {}, send: () => {},
    },
  };
  sessionRoutes["session.create"].run(a);
  assert.equal(created[0].title, "review the diff");
});

test("a scratch root is left clean", () => {
  // The config write leaves no `.tmp` behind — a rename consumes it, and a
  // leftover would be the half-written document all over again.
  const root = mkdtempSync(join(tmpdir(), "waterplane-blcfg2-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  writeFileSync(join(root, ".waterplane", "backlog-config.json"), "{\"auto\":false}");
  const b = new BacklogManager(root, {}, fakeIntents(), {});
  b.setAuto(true);
  assert.equal(statSync(join(root, ".waterplane", "backlog-config.json")).isFile(), true);
  assert.throws(() => statSync(join(root, ".waterplane", "backlog-config.json.tmp")));
  rmSync(root, { recursive: true, force: true });
});

// ── 4. what a `backlog.unmerge` tap answers, on the wire ───────────────────

const unmergeRoute = (await import("../dist/routes/work.js")).workRoutes["backlog.unmerge"];

/** The four things that route touches, and nothing else. */
function fakeCtx(unmerge) {
  const sent = [];
  const broadcast = [];
  return {
    sent, broadcast,
    a: {
      msg: { t: "backlog.unmerge", id: "mgabc123" },
      ws: {},
      c: {
        backlog: { unmerge },
        send: (_ws, m) => sent.push(m),
        broadcast: (m) => broadcast.push(m),
        backlogSnapshot: () => ({ t: "backlog.list", items: [] }),
      },
    },
  };
}

test("a successful put-back says out loud WHAT it did, because the same tap means two things", () => {
  // The web draws the button on any merged row and never greys it out; the host
  // decides what the tap does and answers in words. "Your 2 originals are back
  // and will run again" and "put back, they never ran" are the difference a
  // person has to be told, and a toast is the only place it can be told.
  const f = fakeCtx(() => ({ ok: true, ran: true, detail: "the merged item already ran — your 2 originals are back in the list and will run as they were" }));
  unmergeRoute(f.a);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].t, "toast");
  assert.match(f.sent[0].text, /will run as they were/);
  assert.equal(f.broadcast.length, 1, "…and the list everyone is looking at is refreshed");
  assert.equal(f.broadcast[0].t, "backlog.list");
});

test("a refusal is still a toast carrying the host's own sentence, and changes no list", () => {
  const f = fakeCtx(() => ({ ok: false, reason: "that row was not made by the smart pick, so there is nothing to put back" }));
  unmergeRoute(f.a);
  assert.match(f.sent[0].text, /not made by the smart pick/);
  assert.equal(f.broadcast.length, 0);
});
