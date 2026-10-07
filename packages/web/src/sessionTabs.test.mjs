/**
 * The tab strip's pure half: what a tab is called, what order the tabs are in,
 * and what happens to a device's open counts when a session goes away.
 *
 * Node-tested because every one of those is a decision the strip must not make
 * twice — the drawing reads `orderTabs`' output and decides nothing — and
 * because the two failures worth guarding against here are both invisible on
 * screen: a tab that swaps places when nothing changed, and an ordering history
 * deleted by a dead tunnel.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  TAB_COUNT_DEFAULT, TAB_COUNT_MAX, TAB_COUNT_MIN, TAB_STRIP_H, tabStripHeight,
  TAB_LIMIT_DEFAULT, bumpOpen, clampTabCount, clampTabLimit, limitTabs, cleanTabOrder, migrateOpens, orderTabs, pruneOpens, tabCloseAsk, tabLabel,
} from "./sessionTabs.ts";

const tab = (id, createdAt, over = {}) => ({
  id, createdAt, label: id, repo: "myapp", status: "done", ...over,
});

test("the label is the derived name, and the repo prefix comes off the fallback", () => {
  // The tab is already coloured by its repo and sits under a header naming it,
  // so `myapp · main` in 90 px spends half the label on the stripe beside it.
  assert.equal(tabLabel({ tabTitle: "tab strip", title: "myapp · main" }, "myapp"), "tab strip");
  // No derived name: the branch comes off before the repo prefix is looked for,
  // so a primary on `main` wears the repo rather than the word every tab shares.
  assert.equal(tabLabel({ title: "myapp \u00b7 main" }, "myapp"), "myapp");
  assert.equal(tabLabel({ title: "myapp \u00b7 fix-ui" }, "myapp"), "fix-ui");
  // The trim is not about THIS repo: a session of another repo on its own
  // default branch loses the word too, and keeps the name that identifies it.
  assert.equal(tabLabel({ title: "other · main" }, "myapp"), "other");
  // Only THIS repo's prefix comes off, and only with something left after it.
  assert.equal(tabLabel({ title: "other · fix-ui" }, "myapp"), "other · fix-ui");
  assert.equal(tabLabel({ title: "myapp · " }, "myapp"), "myapp ·");
  assert.equal(tabLabel({ title: "scratch" }, "myapp"), "scratch");
  // Never blank: a tab with no words on it cannot be tapped on purpose.
  assert.equal(tabLabel({ title: "" }, "myapp"), "myapp");
  assert.equal(tabLabel({ title: "" }, ""), "session");
});

test("the open order is the sequence they were started in", () => {
  const tabs = [tab("c", 300), tab("a", 100), tab("b", 200)];
  assert.deepEqual(orderTabs(tabs, "open", {}).map((t) => t.id), ["a", "b", "c"]);
  // The caller's array is App's render data.
  assert.deepEqual(tabs.map((t) => t.id), ["c", "a", "b"]);
});

test("the dynamic order is most-opened first, and ties keep the open sequence", () => {
  const tabs = [tab("a", 100), tab("b", 200), tab("c", 300)];
  const opens = { a: { n: 1, at: 9 }, b: { n: 9, at: 1 }, c: { n: 3, at: 5 } };
  assert.deepEqual(orderTabs(tabs, "frequent", opens).map((t) => t.id), ["b", "c", "a"]);
  // A tab that moves when nothing changed is the failure this whole strip is
  // trying to avoid, so an untouched pair falls back to the stable order rather
  // than to whatever order the session list happened to arrive in.
  const flat = orderTabs([tab("c", 300), tab("a", 100)], "frequent", {});
  assert.deepEqual(flat.map((t) => t.id), ["a", "c"]);
  // A session this device has never opened counts as zero, never as absent.
  assert.deepEqual(orderTabs(tabs, "frequent", { b: { n: 1, at: 1 } }).map((t) => t.id), ["b", "a", "c"]);
});

test("the recency order is last-opened first, and it is not the count", () => {
  const tabs = [tab("a", 100), tab("b", 200), tab("c", 300)];
  // `b` is the habit and `a` is where you just were: the two orders disagree on
  // purpose, which is why this is a third choice and not a tweak to the second.
  const opens = { a: { n: 1, at: 900 }, b: { n: 9, at: 100 }, c: { n: 3, at: 500 } };
  assert.deepEqual(orderTabs(tabs, "recent", opens).map((t) => t.id), ["a", "c", "b"]);
  // A migrated row (a count, no instant) reads as longest-ago — true of a
  // session nobody has opened since the upgrade — and never as "just now".
  const mixed = { a: { n: 4, at: 0 }, b: { n: 1, at: 50 } };
  assert.deepEqual(orderTabs(tabs, "recent", mixed).map((t) => t.id), ["b", "a", "c"]);
  // Nothing known about any of them: the stable order, not the arrival order.
  assert.deepEqual(orderTabs([tab("c", 300), tab("a", 100)], "recent", {}).map((t) => t.id), ["a", "c"]);
});

test("an open records both facts, on the session it names", () => {
  assert.deepEqual(bumpOpen({}, "a", 7), { a: { n: 1, at: 7 } });
  assert.deepEqual(
    bumpOpen({ a: { n: 2, at: 1 }, b: { n: 1, at: 2 } }, "a", 9),
    { a: { n: 3, at: 9 }, b: { n: 1, at: 2 } },
  );
});

test("the old bare-count store is migrated, not dropped", () => {
  // A count takes weeks of use to re-earn; a last-opened instant takes one tap.
  assert.deepEqual(migrateOpens({ a: 3 }), { a: { n: 3, at: 0 } });
  assert.deepEqual(migrateOpens({ a: { n: 2, at: 5 } }), { a: { n: 2, at: 5 } });
  // Junk, an empty row and a hand-edited value are dropped rather than ordered.
  assert.deepEqual(migrateOpens({ a: "x", b: null, c: 0, d: { n: 0, at: 0 } }), {});
  assert.deepEqual(migrateOpens({}), {});
});

test("counts are pruned to the sessions that exist — but never by an empty list", () => {
  const opens = { a: { n: 2, at: 2 }, b: { n: 1, at: 1 } };
  assert.deepEqual(pruneOpens(opens, ["a"]), { a: { n: 2, at: 2 } });
  // A cold start and every dead tunnel look exactly like "no sessions", and
  // deleting this device's whole ordering history because the socket has not
  // answered yet is a loss with no way back.
  assert.deepEqual(pruneOpens(opens, []), opens);
});

test("how many fit is clamped, and an unset or hand-edited value is the default", () => {
  // Three by default: four words of name do not read in a quarter of a phone.
  assert.equal(TAB_COUNT_DEFAULT, 3);
  assert.equal(clampTabCount(4), 4);
  assert.equal(clampTabCount(1), TAB_COUNT_MIN);
  assert.equal(clampTabCount(99), TAB_COUNT_MAX);
  assert.equal(clampTabCount(4.4), 4);
  assert.equal(clampTabCount(undefined), TAB_COUNT_DEFAULT);
  assert.equal(clampTabCount(NaN), TAB_COUNT_DEFAULT);
  assert.equal(clampTabCount("4"), TAB_COUNT_DEFAULT);
});

test("an unknown order reads as the stable one", () => {
  assert.equal(cleanTabOrder("frequent"), "frequent");
  assert.equal(cleanTabOrder("recent"), "recent");
  assert.equal(cleanTabOrder("open"), "open");
  assert.equal(cleanTabOrder("whatever"), "recent");
  assert.equal(cleanTabOrder(undefined), "recent");
});

test("the close question says which verb it is and that the words are kept", () => {
  const live = tabCloseAsk("tab strip", true);
  assert.match(live.title, /Close/);
  assert.equal(live.confirmLabel, "Close");
  assert.match(live.lines[0], /Recently closed/);
  const dead = tabCloseAsk("tab strip", false);
  assert.match(dead.title, /Remove/);
  assert.equal(dead.confirmLabel, "Remove");
  // Neither verb may read as a delete: the conversation outlives both.
  assert.match(dead.lines[0], /kept/);
});

test("the height the strip publishes is the height it draws", () => {
  // Two copies of one number: `TAB_STRIP_H` goes onto `<html>` as
  // `--ui-tabs-h`, which is what every screen and every sheet pads itself
  // clear of, and `.sess-tabs` states its own `height` in the stylesheet. Drift
  // and the bar either floats over the first row of whatever is under it or
  // leaves a band of empty panel above it — on every screen in the app, and
  // with nothing on any of them saying why.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(".sess-tabs {");
  assert.ok(at >= 0, "no .sess-tabs rule");
  const body = css.slice(at, css.indexOf("}", at));
  const m = /height:\s*(\d+)px/.exec(body);
  assert.ok(m, ".sess-tabs states no height");
  assert.equal(Number(m[1]), TAB_STRIP_H);
});

test("the limit: default 10, clamped, the open session always drawn, the cut counted", () => {
  assert.equal(TAB_LIMIT_DEFAULT, 10);
  assert.equal(clampTabLimit(undefined), 10);
  assert.equal(clampTabLimit(1), 2);
  assert.equal(clampTabLimit(999), 50);
  const mk = (i) => ({ id: `s${i}`, label: `s${i}`, repo: "r", status: "done", createdAt: i });
  const all = Array.from({ length: 5 }, (_, i) => mk(i));
  assert.deepEqual(limitTabs(all, 10, null), { shown: all, hidden: 0 });
  const cut = limitTabs(all, 3, "s1");
  assert.deepEqual(cut.shown.map((t) => t.id), ["s0", "s1", "s2"]);
  assert.equal(cut.hidden, 2);
  const far = limitTabs(all, 3, "s4");
  assert.deepEqual(far.shown.map((t) => t.id), ["s0", "s1", "s4"]);
  assert.equal(far.hidden, 2);
});

test("the strip is 34px on a phone with tabs, and 0 in every other case (O3: none in wide)", () => {
  assert.equal(tabStripHeight(true, true, false), TAB_STRIP_H);
  assert.equal(tabStripHeight(true, true, true), 0, "wide hides the strip");
  assert.equal(tabStripHeight(false, true, false), 0);
  assert.equal(tabStripHeight(true, false, false), 0);
});
