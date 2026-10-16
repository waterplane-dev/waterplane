import test from "node:test";
import assert from "node:assert/strict";

import {
  codeLeftText, countHostWords, deviceRouteText, devicesEmptyText, hostAddress, hostRows, qrPath, removeLines, revokeLines, seenAgo,
  nextHostId, shortHostName, showHostName, wordsText,
} from "./logic.ts";

const KEYS = {
  composeDrafts: "d", composeSheets: "s", compose: "c", backlogDraft: "b", fanoutText: "f",
  pad: "p", composeOutbox: "o", outbox: "ol",
};

test("words are counted by kind; blank drafts and unreadable values count as nothing", () => {
  const store = {
    d: JSON.stringify({ s1: "hello", s2: "   ", s3: "x" }),
    s: JSON.stringify({ send: "sheet words" }),
    c: "",
    b: "an idea",
    f: "\"\"",
    p: JSON.stringify([{ id: "n1", text: "a", ts: 1 }, { id: "n2", text: "b", ts: 2 }]),
    o: JSON.stringify([{ ackId: "1", status: "queued" }, { ackId: "2", status: "failed" }]),
    ol: "{not json",
  };
  assert.deepEqual(countHostWords((k) => store[k] ?? null, KEYS), { drafts: 4, notes: 2, queued: 2 });
  assert.deepEqual(countHostWords(() => null, KEYS), { drafts: 0, notes: 0, queued: 0 });
});

test("the sentence names each kind with its number, and nothing when there is nothing", () => {
  assert.equal(wordsText({ drafts: 3, notes: 0, queued: 1 }), "3 drafts and 1 queued prompt");
  assert.equal(wordsText({ drafts: 1, notes: 2, queued: 3 }), "1 draft, 2 pad notes and 3 queued prompts");
  assert.equal(wordsText({ drafts: 0, notes: 1, queued: 0 }), "1 pad note");
  assert.equal(wordsText({ drafts: 0, notes: 0, queued: 0 }), null);
});

test("the remove question says what STAYS, and where the app goes when it is the host in use", () => {
  assert.deepEqual(removeLines({ drafts: 3, notes: 0, queued: 1 }, false, null),
    ["3 drafts and 1 queued prompt stay saved on this phone; re-add the host to see them."]);
  assert.deepEqual(removeLines({ drafts: 1, notes: 0, queued: 0 }, false, null),
    ["1 draft stays saved on this phone; re-add the host to see them."]);
  const next = { id: "b", name: "laptop", base: "http://100.64.0.9:8770" };
  assert.deepEqual(removeLines({ drafts: 0, notes: 0, queued: 0 }, true, next), [
    "Nothing unsent is saved for it on this phone.",
    "It is the host in use: the app switches to laptop first, then reloads.",
  ]);
  assert.match(removeLines({ drafts: 0, notes: 0, queued: 0 }, true, null)[1], /connect screen/);
});

test("rows: active first; the header names a host only when there are two", () => {
  const a = { id: "a", name: "desk", base: "http://100.64.0.5:8770" };
  const b = { id: "b", name: "laptop", base: "https://laptop.tail.ts.net" };
  assert.deepEqual(hostRows([a, b], "b").map((h) => h.id), ["b", "a"]);
  assert.equal(showHostName([a]), false);
  assert.equal(showHostName([a, b]), true);
  assert.equal(hostAddress(a.base), "100.64.0.5");
  assert.equal(hostAddress(b.base), "laptop.tail.ts.net");
});

test("qrPath: one rectangle per dark run, row by row", () => {
  const grid = ["#.#", "###", "..."];
  const d = qrPath(3, (r, c) => grid[r][c] === "#");
  assert.equal(d, "M0 0h1v1h-1zM2 0h1v1h-1zM0 1h3v1h-3z");
  assert.equal(qrPath(2, () => false), "");
});

test("the code countdown never reads 0:00 while it still works, and is null once spent", () => {
  assert.equal(codeLeftText(600_000), "10:00 left");
  assert.equal(codeLeftText(61_001), "1:02 left");
  assert.equal(codeLeftText(1), "0:01 left");
  assert.equal(codeLeftText(0), null);
  assert.equal(codeLeftText(-5), null);
  assert.equal(codeLeftText(Number.NaN), null);
});

test("paired devices: route words, ages, and the revoke question for this phone vs another", () => {
  assert.equal(deviceRouteText("lan"), "over the Wi-Fi (LAN)");
  assert.equal(deviceRouteText(null), "route not recorded");
  assert.equal(seenAgo(10_000), "just now");
  assert.equal(seenAgo(5 * 60_000), "5 min ago");
  assert.deepEqual(revokeLines({ name: "Pixel", current: false }), ["Pixel will need a new pairing code to connect again."]);
  const mine = revokeLines({ name: "Pixel", current: true }).join(" ");
  assert.match(mine, /signs this phone out/);
  assert.match(devicesEmptyText(false), /Set a host password to give each phone its own sign-in/);
  assert.doesNotMatch(devicesEmptyText(true), /password/);
});

test("shortHostName: first word, capped to fit beside the cog, never blank for a named host", () => {
  assert.equal(shortHostName("DeskMini-von-Alex"), "DeskM…");
  assert.equal(shortHostName("laptop.tail.ts.net"), "laptop");
  assert.equal(shortHostName("  wp peer "), "wp");
  assert.equal(shortHostName("Supercalifragilistic").length, 6);
  assert.equal(shortHostName(""), "");
});

test("nextHostId: two flip, three go round, one or none is no toggle", () => {
  const h = (id) => ({ id, name: id, base: "http://x" });
  assert.equal(nextHostId([h("a"), h("b")], "a"), "b");
  assert.equal(nextHostId([h("a"), h("b")], "b"), "a");
  assert.equal(nextHostId([h("a"), h("b"), h("c")], "c"), "a");
  assert.equal(nextHostId([h("a"), h("b"), h("c")], "b"), "c");
  // In the demo (not in the list): the first real host.
  assert.equal(nextHostId([h("a"), h("b")], "demo"), "a");
  assert.equal(nextHostId([h("a")], "a"), null);
  assert.equal(nextHostId([], null), null);
});
