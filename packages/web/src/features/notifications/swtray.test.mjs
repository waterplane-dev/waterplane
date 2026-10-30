/**
 * A web-push tray tap lands where a feed-row tap does (bughunt 2026-10-29 review A3c M2).
 *
 * The service worker is a classic script with no exports, so it is RUN here in a `vm` context
 * with a fake `self`: a push arrives carrying the host's item (now the item itself — key and
 * branch included, `server/clients.ts`), the notification is tapped, and the item the page is
 * handed (warm `open-notif`, or a cold start's `#notif=`) goes through the same `notifTarget`
 * the feed row uses. A failed push of one branch must open the git view ON THAT failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { notifTarget } from "./logic.ts";

const SRC = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

function worker(wins) {
  const on = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (t, fn) => { on[t] = fn; },
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: { matchAll: async () => wins, openWindow: async (u) => { opened.push(u); }, claim: async () => {} },
  };
  vm.runInNewContext(SRC, { self, URL, URLSearchParams, Response, caches: {}, console, setTimeout });
  const run = async (t, ev) => { const waits = []; on[t]({ ...ev, waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  return { run, shown, opened };
}

// What the host now pushes for a failed push of `feature` (the stored item; no `pull`).
const pushed = {
  id: "A1", ts: 1, kind: "git", title: "Push failed · myapp", body: "lint", tag: "git-rid-push-feature",
  level: "attention", key: "git:rid:push", branch: "feature", open: { to: "git", repoId: "rid", verb: "push" },
};

test("warm tap: the page is handed the whole item, and it opens the git view on that failure", async () => {
  const posted = [];
  const { run, shown } = worker([{ focus() {}, postMessage: (m) => posted.push(m) }]);
  await run("push", { data: { json: () => pushed } });
  const n = shown[0].opts;
  await run("notificationclick", { notification: { data: n.data, close() {} } });
  assert.equal(posted[0].type, "open-notif");
  const item = posted[0].item;
  assert.equal(item.key, pushed.key, "the key survives the worker");
  assert.equal(item.branch, "feature", "the branch survives the worker");
  assert.deepEqual(notifTarget(item), { to: "git", repoId: "rid", failureId: "A1" });
});

test("cold tap: the `#notif=` item carries the key too", async () => {
  const { run, shown, opened } = worker([]);
  await run("push", { data: { json: () => pushed } });
  await run("notificationclick", { notification: { data: shown[0].opts.data, close() {} } });
  const item = JSON.parse(new URLSearchParams(opened[0].slice(2)).get("notif"));
  assert.deepEqual(notifTarget(item), { to: "git", repoId: "rid", failureId: "A1" });
});

test("an older host's push with no id is no item, as before", async () => {
  const { run, shown } = worker([]);
  await run("push", { data: { json: () => ({ title: "t", body: "b" }) } });
  assert.equal(shown[0].opts.data.item, null);
});
