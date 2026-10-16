/**
 * The half of a route the URL is allowed to forget.
 *
 * `routing.ts` is pure (no DOM), so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it.
 *
 *     node --test packages/web/src/routing.test.mjs
 *
 * The case that matters is the one that lost a typed prompt: the Send sheet is
 * transient, so `routeToHash` writes no `o=` for it — but its history ENTRY
 * exists, keyed on `routeKey`. Unwinding back into it (which is exactly what
 * the annotator's return does) fires popstate, and re-deriving the overlay from
 * the hash alone read "no overlay" for a screen that plainly had one: the app
 * landed on the launcher with the words stranded in a draft nothing opens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURE_SHEET_RE, PERSISTED_OVERLAYS, WIDE_FULL, isWideFull, featureSheetId, isFeatureSheetId, VACANT, overlayFromKey, parseHash, routeFromPop, routeKey, routeStep, routeToHash, routeToUrl, screenOfKey, stepKey } from "./routing.ts";

test("a key names the overlay its own hash cannot", () => {
  for (const o of ["send", "pad", "image", "collage", "queue"]) {
    assert.equal(routeToHash(null, o), "", `${o} must not be in the hash`);
    assert.equal(overlayFromKey(routeKey(null, o, null)), o);
  }
});

test("round trip, with an active session and a focused repo", () => {
  for (const a of [null, "s1"]) {
    for (const r of [null, "myapp"]) {
      for (const o of [null, "send", "gallery"]) {
        assert.equal(overlayFromKey(routeKey(a, o, r)), o, `${a}|${o}|${r}`);
      }
    }
  }
});

test("a persisted overlay agrees with the hash it writes", (t) => {
  const hash = globalThis.location;
  t.after(() => { if (hash === undefined) delete globalThis.location; else globalThis.location = hash; });
  for (const o of PERSISTED_OVERLAYS) {
    globalThis.location = { hash: routeToHash("s1", o), search: "" };
    assert.equal(parseHash().overlay, o);
    assert.equal(overlayFromKey(routeKey("s1", o, null)), o);
  }
});

// ── routeFromPop: what a Back, a swipe or a `history.go` means ───────

/** The stack the annotator's return unwinds through: launcher → Send → mark. */
const SENDING = [routeKey(null, null, null), routeKey(null, "send", null), routeKey(null, "image", null)];
const at = (d, stack) => ({ navRoute: stack[d], navDepth: d });

test("unwinding into a transient sheet lands ON the sheet, not under it", () => {
  // The hash for the Send sheet carries no overlay — that is by design — so the
  // URL alone says "launcher". The prompt typed in that sheet is stranded the
  // moment this answers null.
  const r = routeFromPop(at(1, SENDING), { activeId: null, overlay: null }, SENDING);
  assert.equal(r.overlay, "send");
  assert.equal(r.depth, 1);
});

test("a persisted overlay agrees whichever way it is read", () => {
  const stack = [routeKey(null, null, null), routeKey("s1", null, null), routeKey("s1", "gallery", null)];
  const r = routeFromPop(at(2, stack), { activeId: "s1", overlay: "gallery" }, stack);
  assert.equal(r.overlay, "gallery");
  assert.equal(r.activeId, "s1");
});

test("a key this document never pushed is not trusted", () => {
  // Survived a reload in `history.state`: the entry claims a sheet whose state
  // died with the old document, so the hash wins and the sheet is not painted.
  const r = routeFromPop({ navRoute: routeKey(null, "send", null), navDepth: 1 }, { activeId: null, overlay: null }, []);
  assert.equal(r.overlay, null);
  assert.equal(r.key, routeKey(null, "send", null));
});

test("an entry that disagrees with our stack is not trusted either", () => {
  const r = routeFromPop({ navRoute: routeKey(null, "pad", null), navDepth: 1 }, { activeId: null, overlay: null }, SENDING);
  assert.equal(r.overlay, null);
});

// ── a hand-edited hash: an entry the browser made, with no key of ours ──

test("a stateless entry is adopted ONE ABOVE where we were, under its URL's key", () => {
  // Launcher at depth 0, then `location.hash = "#o=clihealth"`.
  const r = routeFromPop(null, { activeId: null, overlay: "clihealth" }, [routeKey(null, null, null)], 0);
  assert.equal(r.adopt, true);
  assert.equal(r.depth, 1);
  assert.equal(r.key, routeKey(null, "clihealth", null));
  assert.equal(r.overlay, "clihealth");
});

test("the adopted key is the one the routing effect will compute — so it pushes no twin", () => {
  // The bug: the effect compared routeKey(active, overlay, focus) against a
  // state-less entry, found it unknown, and PUSHED a copy on top. The sheet's
  // back button then unwound onto the stateless entry, whose hash re-opened it.
  const r = routeFromPop(undefined, { activeId: "s1", overlay: "gallery", focusRepo: "myapp" }, [], 2);
  assert.deepEqual([r.depth, r.key, r.activeId, r.overlay], [3, routeKey("s1", "gallery", "myapp"), "s1", "gallery"]);
  // …and once stamped, the next pop onto it is an ordinary entry of ours.
  const stack = [];
  stack[r.depth] = r.key;
  const again = routeFromPop({ navRoute: r.key, navDepth: r.depth }, { activeId: "s1", overlay: "gallery" }, stack, 3);
  assert.deepEqual([again.adopt, again.depth, again.overlay], [false, 3, "gallery"]);
});

test("a hand-edited transient overlay is adopted as the screen the hash CAN carry", () => {
  // parseHash already filtered `#o=send` to null; the key must agree with it.
  const r = routeFromPop(null, { activeId: null, overlay: null }, [routeKey(null, null, null)], 0);
  assert.equal(r.key, routeKey(null, null, null));
  assert.equal(r.overlay, null);
});

test("a keyed entry is never adopted", () => {
  const r = routeFromPop(at(1, SENDING), { activeId: null, overlay: null }, SENDING, 2);
  assert.equal(r.adopt, false);
  assert.equal(r.depth, 1);
});

test("the launcher stays the launcher", () => {
  const r = routeFromPop(at(0, SENDING), { activeId: null, overlay: null }, SENDING);
  assert.equal(r.overlay, null);
  assert.equal(r.depth, 0);
});

// ── routeStep: a tap that changes the screen — and why a close is ONE Back ──

const K = (a, o, r = null) => routeKey(a, o, r);

test("closing a sheet opened from a sheet returns to that sheet, not the session", () => {
  // The reported bug: the in-app arrow on the second sheet unwound past the
  // first to the bare session, while the gesture popped one entry. Both must
  // land on the first sheet.
  const stack = [K(null, null), K("s1", null), K("s1", "settings"), K("s1", "storage")];
  assert.deepEqual(routeStep(stack, 3, K("s1", null)), { kind: "go", delta: -1 });
});

test("closing the only sheet lands on its session, as before", () => {
  const stack = [K(null, null), K("s1", null), K("s1", "backlog")];
  assert.deepEqual(routeStep(stack, 2, K("s1", null)), { kind: "go", delta: -1 });
});

test("a sheet over the LAUNCHER closes to the sheet below on the launcher", () => {
  const stack = [K(null, null), K(null, "settings"), K(null, "apps")];
  assert.deepEqual(routeStep(stack, 2, K(null, null)), { kind: "go", delta: -1 });
});

test("a close whose entry below is another session is not a Back into it", () => {
  // s2 was opened from s1's backlog: closing s2's sheet lands on s2, which is
  // in the stack — the one-step rule does not apply across sessions.
  const stack = [K(null, null), K("s1", null), K("s1", "backlog"), K("s2", null), K("s2", "git")];
  assert.deepEqual(routeStep(stack, 4, K("s2", null)), { kind: "go", delta: -1 });
  // …and a close with nothing of this session below it is pushed.
  const lone = [K(null, null), K("s1", "backlog"), K("s2", "git")];
  assert.deepEqual(routeStep(lone, 2, K("s2", null)), { kind: "push" });
});

test("opening a new screen pushes; reaching one already in the stack unwinds to it", () => {
  const stack = [K(null, null), K("s1", null), K("s1", "backlog")];
  assert.deepEqual(routeStep(stack, 2, K("s1", "git")), { kind: "push" });
  assert.deepEqual(routeStep(stack, 2, K(null, null)), { kind: "go", delta: -2 });
  assert.deepEqual(routeStep(stack, 2, K("s1", "backlog")), { kind: "stay" });
});

test("a sheet closed with a step open takes the step with it", () => {
  // The file browser with a file open: the arrow on the browser itself (or a
  // close from inside the file) lands on the session, never on the browser.
  const browse = K("s1", "browse");
  const stack = [K(null, null), K("s1", null), browse, stepKey(browse, 7)];
  assert.deepEqual(routeStep(stack, 3, K("s1", null)), { kind: "go", delta: -2 });
});

test("a vacant step slot is searched past, never landed on", () => {
  const stack = [K(null, null), K("s1", null), K("s1", "browse"), VACANT, K("s1", "image")];
  // closing the image returns to the browser under the dead step
  assert.deepEqual(routeStep(stack, 4, K("s1", null)), { kind: "go", delta: -2 });
  // a vacant TOP: the screen under it is where we are
  const top = [K(null, null), K("s1", null), VACANT];
  assert.deepEqual(routeStep(top, 2, K("s1", null)), { kind: "go", delta: -1 });
  assert.deepEqual(routeStep(top, 2, K("s1", "git")), { kind: "push" });
});

test("a step key names its sheet and is never mistaken for a screen", () => {
  const browse = K("s1", "browse", "myapp");
  const k = stepKey(browse, 3);
  assert.equal(overlayFromKey(k), "browse");
  assert.equal(screenOfKey(k), browse);
  assert.notEqual(k, browse);
  assert.equal(screenOfKey(browse), browse);
});

// ── extension sheets: feature:<id>/<sheet> ──

test("featureSheetId builds and validates", () => {
  assert.equal(featureSheetId("requirements", "list"), "feature:requirements/list");
  assert.ok(isFeatureSheetId("feature:requirements/list"));
  for (const [f, sh] of [["req|x", "list"], ["req#", "list"], ["Req", "list"], ["requirements", "Lis"], ["requirements", ""], ["", "list"], ["a", "list"], ["req", "a/b"]]) {
    assert.throws(() => featureSheetId(f, sh), /not a feature sheet id/, `${f}/${sh}`);
  }
  for (const bad of ["feature:requirements", "feature:/list", "feature:requirements/", "backlog", null, 3]) assert.ok(!isFeatureSheetId(bad), String(bad));
  assert.ok(FEATURE_SHEET_RE.test("feature:ab/c"));
});

test("a feature sheet id survives the route key and is never persisted", () => {
  const o = featureSheetId("requirements", "list");
  assert.equal(overlayFromKey(routeKey("s1", o, "myapp")), o);
  assert.equal(overlayFromKey(routeKey(null, o, null)), o);
  assert.ok(!PERSISTED_OVERLAYS.has(o));
  assert.equal(routeToHash("s1", o), "#a=s1", "the hash names the session and no overlay");
});

test("a feature sheet over the backlog closes to the backlog in one Back", () => {
  const o = featureSheetId("requirements", "list");
  const stack = [K(null, null), K("s1", null), K("s1", "backlog"), K("s1", o)];
  assert.deepEqual(routeStep(stack, 3, K("s1", "backlog")), { kind: "go", delta: -1 });
  const back = routeFromPop({ navRoute: K("s1", o), navDepth: 3 }, { activeId: "s1", overlay: null }, stack, 2);
  assert.equal(back.overlay, o, "a pop inside our own stack restores the sheet");
});

test("a hand-edited #o=feature:… opens nothing", () => {
  globalThis.location = { hash: "#a=s1&o=feature:requirements/list" };
  try { assert.equal(parseHash().overlay, null); } finally { delete globalThis.location; }
});

test("a route keeps ?demo= — the URL is what keeps a URL-entered demo across a reload", () => {
  const had = globalThis.location;
  try {
    globalThis.location = { pathname: "/", search: "?demo=first-look", hash: "" };
    assert.equal(routeToUrl("demo-g1", null, null), "/?demo=first-look#a=demo-g1");
    assert.equal(routeToUrl(null, null, "todo"), "/?demo=first-look&repo=todo");
    globalThis.location = { pathname: "/", search: "?repo=x", hash: "" };
    assert.equal(routeToUrl(null, null, null), "/", "focus is still the route's own to drop");
  } finally {
    if (had === undefined) delete globalThis.location; else globalThis.location = had;
  }
});

// ── WIDE_FULL: which sheets take the main pane on a wide window ─────

/** The literal names of the `Overlay` union, read off the source — the type
 *  has no runtime value, and a misspelt name in the set would silently panel. */
function overlayNames() {
  const src = readFileSync(new URL("./routing.ts", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.startsWith("export type Overlay ="));
  assert.ok(line, "the Overlay union is on one line");
  return new Set([...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

test("WIDE_FULL is a subset of the Overlay names", () => {
  const names = overlayNames();
  assert.ok(names.size > 40);
  for (const o of WIDE_FULL) assert.ok(names.has(o), `${o} is not an Overlay`);
});

test("isWideFull: the canvas and chart sheets yes, everything else a panel", () => {
  for (const o of ["swipe", "image", "clip", "collage", "tokens", "context", "repohealth", "scrollback", "git", "text", "outline"]) {
    assert.equal(isWideFull(o), true, o);
  }
  for (const o of [null, "send", "settings", "backlog", "gallery", "queue", featureSheetId("demo", "main")]) {
    assert.equal(isWideFull(o), false, String(o));
  }
});
