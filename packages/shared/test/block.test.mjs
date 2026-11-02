/** `blockOf` (`block.ts`) — the one derivation of why a session is blocked on
 *  something outside it — and the `auth`/`net` walls `sessionWall` reads off it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockOf, blockWallOf, LIMIT_HELD_DRAFT, SIGNED_IN_AGAIN_DETAIL, SIGNED_OUT_DETAIL, SIGNIN_CONTINUING_DETAIL, SIGNIN_QUEUED_DETAIL, SIGNIN_UNSURE_DETAIL, intentReasonText, INTENT_BLOCK_ORDER, laneBusy, serialHolders, serialWaitText, sessionWall } from "../dist/index.js";

const limit = (over = {}) => ({
  blocked: true, blockedSince: 1000, resetAt: 9000, nextAttemptAt: 5000, attempts: 2, weekly: false,
  autoContinue: true, autoContinueOverride: null, queuePos: null, resuming: false, first: false, ...over,
});
const net = (over = {}) => ({ state: "waiting", attempt: 1, max: 8, nextAt: 4000, error: "Connection dropped (ECONNRESET)", at: 2000, ...over });

test("nothing outside the session: null", () => {
  assert.equal(blockOf({}), null);
  assert.equal(blockOf({ limit: limit({ blocked: false }), netRetry: null, login: null }), null);
});

test("auth: signed out, a sign-in link, or first-launch setup — needs you, no timer", () => {
  assert.deepEqual(blockOf({ signedOut: true }), { kind: "auth", phase: "needsYou", since: null, attempts: 0, nextAt: null });
  assert.deepEqual(blockOf({ login: { url: "https://x", awaitingCode: true, at: 777 } }),
    { kind: "auth", phase: "needsYou", since: 777, attempts: 0, nextAt: null });
  assert.equal(blockOf({ cliSetup: true })?.kind, "auth");
});

test("limit: phase follows what the host is doing", () => {
  assert.deepEqual(blockOf({ limit: limit() }),
    { kind: "limit", phase: "waiting", since: 1000, attempts: 2, nextAt: 5000, resetAt: 9000 });
  assert.equal(blockOf({ limit: limit({ resuming: true, nextAttemptAt: null }) }).phase, "retrying");
  assert.equal(blockOf({ limit: limit({ nextAttemptAt: null, queuePos: 3 }) }).phase, "waiting");
  assert.equal(blockOf({ limit: limit({ nextAttemptAt: null, autoContinue: false }) }).phase, "needsYou");
  assert.equal(blockOf({ limit: limit({ nextAttemptAt: null }) }).phase, "gaveUp");
  assert.equal(blockOf({ limit: limit({ blockedSince: 0 }) }).since, null);
});

test("limit/spend held on a draft: waiting, no countdown, the reason as detail", () => {
  const b = blockOf({ limit: limit({ held: LIMIT_HELD_DRAFT }) });
  assert.deepEqual(b, { kind: "limit", phase: "waiting", since: 1000, attempts: 2, nextAt: null, resetAt: 9000, detail: LIMIT_HELD_DRAFT });
  assert.equal(blockOf({ limit: limit({ spend: true, held: LIMIT_HELD_DRAFT }) }).detail, LIMIT_HELD_DRAFT);
  // Not held (absent or null): the countdown is a real try again.
  assert.equal(blockOf({ limit: limit({ held: null }) }).nextAt, 5000);
  assert.equal(blockOf({ limit: limit({ held: null }) }).detail, undefined);
  // A source wall's own sentence outranks it.
  assert.equal(blockOf({ limit: limit({ needsYou: "no credit left", held: LIMIT_HELD_DRAFT }) }).detail, "no credit left");
});

test("spend: its own kind; nothing scheduled is needs-you, never gave-up", () => {
  assert.equal(blockOf({ limit: limit({ spend: true }) }).kind, "spend");
  assert.equal(blockOf({ limit: limit({ spend: true }) }).phase, "waiting");
  assert.equal(blockOf({ limit: limit({ spend: true, nextAttemptAt: null, resetAt: null }) }).phase, "needsYou");
  const src = blockOf({ limit: limit({ needsYou: "no credit left", nextAttemptAt: null }) });
  assert.equal(src.phase, "needsYou");
  assert.equal(src.detail, "no credit left");
});

test("net: ladder, in flight, stall probe, gave up, dismissed", () => {
  assert.deepEqual(blockOf({ netRetry: net() }),
    { kind: "net", phase: "waiting", since: 2000, attempts: 1, nextAt: 4000, detail: "Connection dropped (ECONNRESET)" });
  assert.equal(blockOf({ netRetry: net({ state: "sent", nextAt: null }) }).phase, "retrying");
  // A stall probe is retrying slowly, never failed: due ⇒ waiting, running ⇒ retrying.
  assert.equal(blockOf({ netRetry: net({ state: "gaveup", attempt: 8, nextAt: 99_000 }) }).phase, "waiting");
  assert.equal(blockOf({ netRetry: net({ state: "waiting", probe: true }) }).phase, "waiting");
  assert.equal(blockOf({ netRetry: net({ state: "sent", probe: true, nextAt: null }) }).phase, "retrying");
  // No next probe (switch off, halt, cancelled): the host stopped.
  assert.equal(blockOf({ netRetry: net({ state: "gaveup", attempt: 8, nextAt: null }) }).phase, "gaveUp");
  // Dismissing only hides the line: the stall — and the block — stand.
  assert.equal(blockOf({ netRetry: net({ state: "gaveup", nextAt: null, dismissed: true }) })?.kind, "net");
});

test("net: a held retry carries who holds it, only while waiting", () => {
  assert.equal(blockOf({ netRetry: net({ heldBy: "n1" }) }).heldBy, "n1");
  assert.equal("heldBy" in blockOf({ netRetry: net({ heldBy: null }) }), false);
  assert.equal("heldBy" in blockOf({ netRetry: net({ state: "gaveup", heldBy: "n1" }) }), false);
});

test("precedence: auth > spend > limit > net", () => {
  assert.equal(blockOf({ signedOut: true, limit: limit({ spend: true }), netRetry: net() }).kind, "auth");
  assert.equal(blockOf({ limit: limit({ spend: true }), netRetry: net() }).kind, "spend");
  assert.equal(blockOf({ limit: limit(), netRetry: net() }).kind, "limit");
  assert.equal(blockOf({ limit: limit({ blocked: false }), netRetry: net() }).kind, "net");
});

test("never filters on running: an exited session still says what it was behind", () => {
  assert.equal(blockOf({ running: false, signedOut: true }).kind, "auth");
});

test("sessionWall: auth and net are walls after limit; absent is today's behaviour", () => {
  assert.equal(sessionWall({}), null);
  assert.equal(sessionWall({ block: "auth" }), "auth");
  assert.equal(sessionWall({ block: "net" }), "net");
  assert.equal(sessionWall({ block: "net", turnActive: true }), "net");
  assert.equal(sessionWall({ block: "auth", promptKind: "tool" }), "auth");
  assert.equal(sessionWall({ block: "auth", limitBlocked: true }), "limit");
  // limit/spend are `limitBlocked`'s; the block field adds nothing for them.
  assert.equal(sessionWall({ block: "limit" }), null);
  assert.equal(sessionWall({ block: "spend" }), null);
  assert.equal(sessionWall({ block: null }), null);
  assert.equal(laneBusy({ block: blockOf({ signedOut: true }).kind }), true);
  assert.equal(laneBusy({ block: blockOf({ netRetry: net({ state: "gaveup", nextAt: null }) }).kind }), true);
});

test("the new walls are worded: intent reasons and the serial sentence", () => {
  assert.ok(INTENT_BLOCK_ORDER.includes("auth") && INTENT_BLOCK_ORDER.includes("net"));
  assert.ok(INTENT_BLOCK_ORDER.indexOf("auth") < INTENT_BLOCK_ORDER.indexOf("limit"));
  assert.match(intentReasonText("auth"), /signed out/);
  assert.match(intentReasonText("net"), /network error/);
  const holders = (s) => [...serialHolders([{ id: "a", cwd: "/r", name: "fix it", ...s }], []).values()][0];
  assert.equal(serialWaitText(holders({ block: "auth" })), "one at a time in this repo — waiting for 'fix it' (signed out)");
  assert.equal(serialWaitText(holders({ block: "net" })), "one at a time in this repo — waiting for 'fix it' (retrying a network error)");
  // A stalled net session keeps its own, more specific sentence.
  assert.match(serialWaitText(holders({ block: "net", netStalled: true })), /stalled item: API unreachable/);
});

test("blockWallOf: the wall drops the blocks nothing is working to lift", () => {
  // A net give-up with no next probe: nothing re-arms it, so a lane must not wait on it.
  assert.equal(blockWallOf({ netRetry: net({ state: "gaveup", nextAt: null }) }), null);
  // …but a stall probe still scheduled is a wall, and the badge still sees the give-up.
  assert.equal(blockWallOf({ netRetry: net({ state: "gaveup", nextAt: 9000 }) }), "net");
  assert.equal(blockOf({ netRetry: net({ state: "gaveup", nextAt: null }) }).phase, "gaveUp");
  // First-launch setup alone is shown, never a hold; a real sign-out is.
  assert.equal(blockWallOf({ cliSetup: true }), null);
  assert.equal(blockOf({ cliSetup: true }).kind, "auth");
  assert.equal(blockWallOf({ cliSetup: true, signedOut: true }), "auth");
  assert.equal(blockWallOf({ login: { url: "https://x", awaitingCode: false, at: 1 } }), "auth");
  assert.equal(blockWallOf({ limit: limit() }), "limit");
  assert.equal(blockWallOf({}), null);
});

test("auth: a sign-in episode member (signInWait) reads needsYou 'signed out', then waiting 'signed in again'; a wall either way", () => {
  const out = { signInWait: { since: 5 } };
  assert.deepEqual(blockOf(out), { kind: "auth", phase: "needsYou", since: 5, attempts: 0, nextAt: null, detail: SIGNED_OUT_DETAIL });
  const back = { signInWait: { since: 5, signedInAt: 9 }, signedOut: true };
  assert.equal(blockOf(back).phase, "waiting");
  assert.equal(blockOf(back).detail, SIGNED_IN_AGAIN_DETAIL);
  assert.deepEqual(blockOf({ signInWait: { since: 5, signedInAt: 9, queued: true } }), { kind: "auth", phase: "waiting", since: 5, attempts: 0, nextAt: null, detail: SIGNIN_QUEUED_DETAIL });
  assert.deepEqual(blockOf({ signInWait: { since: 5, signedInAt: 9, continuing: true } }), { kind: "auth", phase: "retrying", since: 5, attempts: 0, nextAt: null, detail: SIGNIN_CONTINUING_DETAIL });
  assert.equal(blockOf({ signInWait: { since: 5, signedInAt: 9 }, login: { url: "https://x", awaitingCode: false, at: 3 } }).phase, "needsYou");
  assert.equal(blockWallOf({ signInWait: { since: 5, signedInAt: 9 } }), "auth", "automatic work never types into it unasked");
  // The host cannot tell (a stale local "in"): the person's continue decides; a confirmation outranks it.
  assert.deepEqual(blockOf({ signInWait: { since: 5, unsure: true } }), { kind: "auth", phase: "needsYou", since: 5, attempts: 0, nextAt: null, detail: SIGNIN_UNSURE_DETAIL });
  assert.equal(blockOf({ signInWait: { since: 5, signedInAt: 9, unsure: true } }).detail, SIGNED_IN_AGAIN_DETAIL);
});
