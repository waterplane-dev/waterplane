/**
 * Landing back on the screen a bundle swap took away (`resumeRoute.ts`).
 *
 *     node --test packages/web/src/resumeRoute.test.mjs
 *
 * The cases worth pinning are the three ways "put me back" goes wrong: putting
 * someone back when they never left (an ordinary launch), putting them back over
 * a route the document was GIVEN (a tapped notification), and following a stored
 * string somewhere that is not this app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_MAX_AGE_MS, bootedOnARoute, parseSavedRoute, resumeTarget, routeWorthResuming,
} from "./resumeRoute.ts";

const NOW = 1_700_000_000_000;
const BARE = { search: "", hash: "" };
const saved = (url, ts = NOW - 1000) => ({ url, ts });

test("an armed restart lands back on the remembered screen", () => {
  assert.equal(resumeTarget(saved("/#a=s1&o=gallery"), true, BARE, NOW), "/#a=s1&o=gallery");
  // Focus lives in the search half and must come back with the rest.
  assert.equal(resumeTarget(saved("/?repo=myapp#a=s1"), true, BARE, NOW), "/?repo=myapp#a=s1");
});

test("an ordinary launch is not a restart into a new version", () => {
  assert.equal(resumeTarget(saved("/#a=s1"), false, BARE, NOW), null);
});

test("a document that booted on a route of its own keeps it", () => {
  // A notification cold-tap: the file it names beats where this phone was.
  const tapped = { search: "", hash: "#dlRepo=myapp&dlPath=.claude/outbox/flow.gif" };
  assert.equal(resumeTarget(saved("/#a=s1"), true, tapped, NOW), null);
  assert.equal(resumeTarget(saved("/#a=s1"), true, { search: "?repo=myapp", hash: "" }, NOW), null);
  assert.equal(bootedOnARoute(BARE), false);
  // An empty marker is not a route.
  assert.equal(bootedOnARoute({ search: "?", hash: "#" }), false);
});

test("nothing is restored that is not this document", () => {
  assert.equal(routeWorthResuming("/#a=s1"), true);
  assert.equal(routeWorthResuming("/?repo=x"), true);
  assert.equal(routeWorthResuming("//evil.example/#a=s1"), false);
  assert.equal(routeWorthResuming("https://evil.example/#a=s1"), false);
  assert.equal(routeWorthResuming("/\\evil.example/#a=s1"), false);
  assert.equal(routeWorthResuming("javascript:alert(1)"), false);
  assert.equal(routeWorthResuming("/#a=s 1"), false);
  assert.equal(routeWorthResuming("/#a=" + "x".repeat(4000)), false);
  // The launcher is where a fresh document already is: nothing to restore.
  assert.equal(routeWorthResuming("/"), false);
  assert.equal(resumeTarget(saved("/"), true, BARE, NOW), null);
});

test("a stale or impossible timestamp reads as nothing remembered", () => {
  assert.equal(resumeTarget(saved("/#a=s1", NOW - RESUME_MAX_AGE_MS + 1), true, BARE, NOW), "/#a=s1");
  assert.equal(resumeTarget(saved("/#a=s1", NOW - RESUME_MAX_AGE_MS - 1), true, BARE, NOW), null);
  // Clock moved backwards — a route from the future is not one we wrote.
  assert.equal(resumeTarget(saved("/#a=s1", NOW + 60_000), true, BARE, NOW), null);
});

test("a half-written or hand-edited key reads as nothing remembered", () => {
  assert.equal(parseSavedRoute(null), null);
  assert.equal(parseSavedRoute(""), null);
  assert.equal(parseSavedRoute("{"), null);
  assert.equal(parseSavedRoute("null"), null);
  assert.equal(parseSavedRoute('{"url":"/#a=s1"}'), null);
  assert.equal(parseSavedRoute('{"ts":1}'), null);
  assert.deepEqual(parseSavedRoute('{"url":"/#a=s1","ts":7}'), { url: "/#a=s1", ts: 7 });
  assert.equal(resumeTarget(null, true, BARE, NOW), null);
});

// ── design round 4: a screen's params ride the resume record ──────────────────────────────────
// A bundle swap reloads the BARE start URL with no history.state, so the git view's repo (its
// entry's `navParams`) was lost: the view fell back to the session's repo. The record carries the
// params in the same shape and the resume landing puts them back as the booted entry's state, where
// the seed adopts them. Driven through landRoute (which remembers), resumeLanding (which restores)
// and landRoute's seed — never routeLanded by hand on the restore side.

function browser() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const loc = { pathname: "/", search: "", hash: "" };
  const fresh = () => {
    const h = {
      entries: [{ state: null }], at: 0,
      get state() { return h.entries[h.at].state; },
      pushState(s, _t, url) { h.entries.length = h.at + 1; h.entries.push({ state: s }); h.at++; if (url) setUrl(url); },
      replaceState(s, _t, url) { h.entries[h.at] = { state: s }; if (url) setUrl(url); },
      go(n) { h.at += n; },
      back() { h.at -= 1; },
    };
    globalThis.history = h;
    return h;
  };
  function setUrl(url) {
    const u = new URL(url, "http://x");
    loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash;
  }
  globalThis.location = loc;
  return { store, loc, fresh, bare() { loc.search = ""; loc.hash = ""; return fresh(); } };
}

async function openGitOnX(withStep) {
  const b = await import("./backStep.ts");
  const { landRoute } = await import("./core/route/landRoute.ts");
  b.routeStack.keys = []; b.routeStack.depth = 0;
  landRoute(null, null, null, true);
  landRoute("s1", null, null, false);
  b.openOn("git", { repoId: "X", failureId: "F" });
  landRoute("s1", "git", null, false);
  if (withStep) b.pushStep(); // the explain pane on top
  return { b, landRoute };
}

/** The bundle swap: memory forgets, the stack is empty, the WebView loads the bare start URL. */
async function bundleSwap(env, b) {
  const { armRouteResume } = await import("./resumeRoute.ts");
  armRouteResume();
  b.routeLanded(0, "||", "push"); // this document's filing gone, as a new module would have it
  b.routeStack.keys = []; b.routeStack.depth = 0;
  return env.bare();
}

async function bootAfterSwap(landRoute) {
  const { resumeLanding } = await import("./resumeRoute.ts");
  const { parseFocus, parseHash } = await import("./routing.ts");
  resumeLanding(location, Date.now()); // main.tsx, before React mounts
  const r = parseHash();
  landRoute(r.activeId, r.overlay, parseFocus(), true); // the routing effect's first run
}

for (const withStep of [false, true]) {
  test(`an update resume with git{X}${withStep ? " and a step" : ""} on top comes back on X, through the seed`, async () => {
    const env = browser();
    env.fresh();
    const { b, landRoute } = await openGitOnX(withStep);
    const h = await bundleSwap(env, b);
    assert.equal(b.screenParams("git"), null, "memory forgot");
    await bootAfterSwap(landRoute);
    assert.equal(h.state.navRoute, "s1|git|", "the route came back");
    assert.deepEqual(b.screenParams("git"), { repoId: "X", failureId: "F" });
    assert.deepEqual(h.state.navParams, { overlay: "git", params: { repoId: "X", failureId: "F" } }, "the seeded entry holds them for the next reload");
    delete globalThis.history; delete globalThis.location; delete globalThis.localStorage;
  });
}

test("a git view closed before the update leaves no params in the resume record", async () => {
  const env = browser();
  env.fresh();
  const { b, landRoute } = await openGitOnX(false);
  const { LS } = await import("./storage.ts");
  landRoute("s1", null, null, false); // the git view closed: the session's own screen is on top
  const rec = JSON.parse(env.store.get(LS.routeLast));
  assert.equal(rec.carried ?? null, null, "a landing with no params on top drops what the git view carried");
  await bundleSwap(env, b);
  await bootAfterSwap(landRoute);
  assert.equal(b.screenParams("git"), null, "nothing brings X back once the view was closed");
  delete globalThis.history; delete globalThis.location; delete globalThis.localStorage;
});

test("an older resume record with no params lands as before", async () => {
  const env = browser();
  env.fresh();
  const { b, landRoute } = await openGitOnX(false);
  const { LS } = await import("./storage.ts");
  const h = await bundleSwap(env, b);
  const rec = JSON.parse(env.store.get(LS.routeLast));
  env.store.set(LS.routeLast, JSON.stringify({ url: rec.url, ts: rec.ts }));
  await bootAfterSwap(landRoute);
  assert.equal(b.screenParams("git"), null);
  assert.equal(h.state.navRoute.endsWith("|git|"), true, "still lands on the git route");
  delete globalThis.history; delete globalThis.location; delete globalThis.localStorage;
});

test("the carried params are bounded and well-formed, or dropped with the URL kept", async () => {
  const { parseCarried, parseSavedRoute } = await import("./resumeRoute.ts");
  const ok = { navRoute: "s1|git|", navParams: { overlay: "git", params: { repoId: "X", failureId: null } } };
  assert.deepEqual(parseCarried(ok), ok);
  assert.equal(parseCarried({ navRoute: "s1|git|", navParams: { overlay: "git", params: { repoId: 3 } } }), null);
  assert.equal(parseCarried({ navRoute: "s1|git|", navParams: { overlay: "git", params: ["X"] } }), null);
  assert.equal(parseCarried({ navRoute: 1, navParams: ok.navParams }), null);
  assert.equal(parseCarried({ navRoute: "s1|git|", navParams: { overlay: "git", params: { repoId: "x".repeat(3000) } } }), null);
  assert.deepEqual(parseSavedRoute(JSON.stringify({ url: "/#a=s1", ts: 7, carried: { navRoute: 1 } })), { url: "/#a=s1", ts: 7 });
  assert.deepEqual(parseSavedRoute(JSON.stringify({ url: "/#a=s1", ts: 7, carried: ok })), { url: "/#a=s1", ts: 7, carried: ok });
});
