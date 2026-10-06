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
