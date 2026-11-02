/**
 * The limit toggle's cycle and receipts — strings App carried inline in the
 * toolbar arm and the sheet's props.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { modeToast, nextOverride, overrideSource, overrideToast } from "./logic.ts";

test("the override cycles inherit → on → off → inherit", () => {
  assert.equal(nextOverride(undefined), true);
  assert.equal(nextOverride(null), true);
  assert.equal(nextOverride(true), false);
  assert.equal(nextOverride(false), null);
});

test("the receipt names what inherit means right now", () => {
  assert.equal(overrideToast(null, true), "auto-continue: inherit (on)");
  assert.equal(overrideToast(null, false), "auto-continue: inherit (off)");
  assert.equal(overrideToast(true, false), "auto-continue: on for this session");
  assert.equal(overrideToast(false, true), "auto-continue: off for this session");
});

test("the source is the global setting until a session sets its own", () => {
  assert.equal(overrideSource(null, true), "global (on)");
  assert.equal(overrideSource(undefined, false), "global (off)");
  assert.equal(overrideSource(false, true), "session override");
});

test("each release mode has its own receipt", () => {
  assert.equal(modeToast("one"), "resuming one session at a time");
  assert.equal(modeToast("repo"), "resuming one session per repo at a time");
  assert.equal(modeToast("all"), "resuming every queued session once the limit lifts");
});

test("sign-in card: the newest printed link, else /login into a free signed-out session, else say why", async () => {
  const { signInPlan } = await import("./logic.ts");
  const s = (id, o = {}) => ({ id, cwd: "/dev/app", title: id, running: true, ...o });
  const old = s("old", { login: { url: "https://a", awaitingCode: false, at: 1 } });
  const fresh = s("fresh", { login: { url: "https://b", awaitingCode: true, at: 9 } });
  const plain = s("plain", { signedOut: true });
  assert.deepEqual(signInPlan([plain, old, fresh]), { kind: "link", url: "https://b", from: fresh });
  assert.deepEqual(signInPlan([s("setup", { cliSetup: true, signedOut: true }), plain]), { kind: "login", target: plain });
  // A box up, or the CLI's own setup: /login would be typed into a menu.
  const boxed = s("boxed", { signedOut: true, prompt: { kind: "choice" } });
  assert.equal(signInPlan([boxed, s("setup", { cliSetup: true })]).kind, "setup");
  assert.equal(signInPlan([s("dead", { signedOut: true, running: false })]).kind, "setup");
});

// After the sign-in: the host CONFIRMED it (`signInWait.signedInAt`), the phone ASKS.
const sw = (id, wait, o = {}) => ({ id, cwd: "/dev/app", title: id, running: true, signInWait: wait, ...o });

test("continue all N: N is exactly the ids the tap sends, and only the signed-in-again ones", async () => {
  const { signInSplit, continueAllLabel } = await import("./logic.ts");
  const { blockedGroups } = await import("../../attention.ts");
  const out = sw("out", { since: 1 }, { signedOut: true });
  const a = sw("a", { since: 1, signedInAt: 5 });
  const b = sw("b", { since: 1, signedInAt: 5 });
  const queued = sw("q", { since: 1, signedInAt: 5, queued: true });
  const going = sw("g", { since: 1, signedInAt: 5, continuing: true });
  // A sign-in link on its own screen: that sign-in is still under way there, whatever the account says.
  const linked = sw("l", { since: 1, signedInAt: 5 }, { login: { url: "https://x", awaitingCode: false, at: 9 } });
  const rows = [out, a, b, queued, going, linked];
  // The same call the sheet makes: the auth group of the rows it was handed.
  const auth = blockedGroups(rows).get("auth");
  assert.equal(auth.length, 6, "every one of them is behind the sign-in");
  const sp = signInSplit(auth);
  assert.deepEqual(sp.ready.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(sp.inFlight.map((s) => s.id), ["q", "g"]);
  assert.deepEqual(sp.out.map((s) => s.id), ["out", "l"]);
  assert.deepEqual(sp.unsure, []);
  assert.equal(sp.ready.length + sp.inFlight.length + sp.unsure.length + sp.out.length, auth.length, "a partition: nobody twice, nobody lost");
  assert.equal(continueAllLabel(sp.ready.length), "continue all 2");
  assert.equal(continueAllLabel(1), "continue 1");
});

test("the card's words follow the split: signed out until none is, then signed in again, then continuing", async () => {
  const { signInSplit, signInHeadline, continueAskNote, continueProgressNote } = await import("./logic.ts");
  const mixed = signInSplit([sw("o", { since: 1 }), sw("r", { since: 1, signedInAt: 2 })]);
  assert.equal(signInHeadline(mixed), "Signed out · 1 session stopped");
  const ready = signInSplit([sw("r1", { since: 1, signedInAt: 2 }), sw("r2", { since: 1, signedInAt: 2 })]);
  assert.equal(signInHeadline(ready), "Signed in again · 2 sessions can continue");
  assert.match(continueAskNote(2, true), /nothing is typed until you tap; the first goes alone/);
  assert.doesNotMatch(continueAskNote(2, true), /offline/);
  assert.match(continueAskNote(1, false), /offline: the tap is kept and sent when the link is back/);
  assert.equal(continueProgressNote(ready), null);
  const flying = signInSplit([sw("g", { since: 1, signedInAt: 2, continuing: true }), sw("q", { since: 1, signedInAt: 2, queued: true })]);
  assert.equal(signInHeadline(flying), "Signed in again · continuing");
  assert.equal(continueProgressNote(flying), "1 continuing · 1 waiting behind the first");
});

test("cannot tell: continue is offered with its own sentence, and the sign-in controls stay", async () => {
  const { signInSplit, signInHeadline, continueUnsureNote, signInPlan } = await import("./logic.ts");
  const u1 = sw("u1", { since: 1, unsure: true }, { signedOut: true });
  const u2 = sw("u2", { since: 1, unsure: true }, { signedOut: true });
  const sp = signInSplit([u1, u2]);
  assert.deepEqual(sp.unsure.map((s) => s.id), ["u1", "u2"]);
  assert.deepEqual(sp.ready, []);
  assert.deepEqual(sp.out, []);
  assert.equal(signInHeadline(sp), "Signed in again? · 2 sessions stopped");
  assert.match(continueUnsureNote(2, true), /cannot tell whether you signed in again — if you have, continue them; nothing is typed until you tap/);
  // The sheet hands out + unsure to the sign-in plan: the person may still need to sign in.
  assert.equal(signInPlan([...sp.out, ...sp.unsure]).kind, "login");
});

test("the sign-in controls act on the sessions still signed out, not on the ones already back", async () => {
  const { signInPlan, signInSplit } = await import("./logic.ts");
  const back = sw("back", { since: 1, signedInAt: 2 });
  const still = sw("still", { since: 1 }, { signedOut: true });
  const sp = signInSplit([back, still]);
  assert.deepEqual(signInPlan(sp.out), { kind: "login", target: still });
});

test("a continue queued with the link down says it was kept; its queue row names the count", async () => {
  const { continueQueuedToast, continueQueueLabel } = await import("./logic.ts");
  assert.equal(continueQueuedToast(3), "queued — continues 3 sessions when the link is back");
  assert.equal(continueQueueLabel(1), "continue 1 session after the sign-in");
});
