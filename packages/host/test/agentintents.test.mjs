/**
 * **The agent's loopback route, without a daemon** (`agentintents.ts`).
 *
 * The e2e (`scripts/e2e-agentintent.mjs`) boots a host on 127.0.0.1 and so can
 * never arrive from anywhere else; the caller gate's non-loopback half is only
 * reachable here. The draft builder is pure, so every refusal is pinned as a
 * sentence, and the one shared post path (`postClientDraft`) is driven with a
 * fake store to pin what it strips.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addClientBacklogItem, agentBacklogFrom, agentCallerRefusal, agentDraftFrom, agentOrderIds, agentQueue, agentWhenOf, postClientDraft } from "../dist/agentintents.js";

test("only a non-browser, unproxied process on loopback is an agent", () => {
  assert.equal(agentCallerRefusal("127.0.0.1", {}), null);
  assert.equal(agentCallerRefusal("::1", {}), null);
  assert.equal(agentCallerRefusal("::ffff:127.0.0.1", {}), null);
  assert.match(agentCallerRefusal("100.101.102.103", {}), /local only/, "a Tailscale peer");
  assert.match(agentCallerRefusal("192.168.1.20", {}), /local only/, "a LAN peer");
  assert.match(agentCallerRefusal(undefined, {}), /local only/);
  assert.match(agentCallerRefusal("127.0.0.1", { "x-forwarded-for": "100.1.2.3" }), /proxied/);
  assert.match(agentCallerRefusal("127.0.0.1", { "tailscale-user-login": "me@x" }), /proxied/);
  assert.match(agentCallerRefusal("127.0.0.1", { origin: "http://127.0.0.1:8770" }), /browser/);
  assert.match(agentCallerRefusal("127.0.0.1", { "sec-fetch-site": "same-origin" }), /browser/);
});

const NOW = Date.UTC(2026, 8, 30, 12);
const facts = (over = {}) => ({
  now: NOW, cwd: "/root/proj",
  sessionCwd: (id) => (id === "s1" ? "/root/proj" : id === "s2" ? "/root/other" : null),
  intent: (id) => (id === "prev" ? { id, label: "the migration", payload: { kind: "prompt", steps: ["migrate the db"] } } : undefined),
  ...over,
});

test("a body becomes the phone's own draft shape, keyed by the caller", () => {
  const r = agentDraftFrom({ key: "k1", prompt: "do it", when: { kind: "at", at: NOW + 3600e3 } }, facts());
  assert.ok("draft" in r);
  const d = r.draft;
  assert.equal(d.id, "agent-k1");
  assert.deepEqual(d.payload, { kind: "prompt", steps: ["do it"] });
  assert.deepEqual(d.target, { kind: "repo" });
  assert.equal(d.serial, true);
  assert.equal(d.auto, true);
  assert.equal(d.pinned, undefined, "a repo row is held by the person's auto-fire switch");
  assert.equal(d.trigger.kind, "at");
  assert.equal(d.trigger.rule.kind, "once");
  assert.equal(d.origin, undefined, "the MARK is postClientDraft's to write, not the builder's");

  const s = agentDraftFrom({ key: "k2", prompt: "x", session: "s1" }, facts({ cwd: null }));
  assert.deepEqual(s.draft.target, { kind: "session", sessionId: "s1" });
  assert.equal(s.draft.pinned, true);
  assert.equal(s.draft.cwd, "/root/proj");

  const w = agentDraftFrom({ key: "k3", prompt: "x", when: { kind: "window", window: "weekly", leadMin: 180 } }, facts());
  assert.equal(w.draft.trigger.rule.kind, "window");
  assert.equal(w.draft.trigger.rule.offsetMin, -180);
  assert.equal(w.draft.trigger.rule.oneShot, true);

  const cp = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };
  const m = agentDraftFrom({ key: "k3b", prompt: "x", when: { kind: "window", window: "month", leadMin: 60 } }, facts({ periods: () => [cp] }));
  assert.equal(m.draft.trigger.rule.periodId, "month", "a configured period id is accepted");
  assert.match(agentDraftFrom({ key: "k3c", prompt: "x", when: { kind: "window", window: "month" } }, facts()).refused, /no budget period/);
  assert.match(agentDraftFrom({ key: "k3d", prompt: "x", when: { kind: "window", window: "rolling30d" } }, facts({ periods: () => [{ id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 1, scraped: false }] })).refused, /no reset time/);

  const a = agentDraftFrom({ key: "k4", steps: ["one", "two"], when: { kind: "after", id: "prev", onlyIfOk: true } }, facts());
  assert.deepEqual(a.draft.trigger, { kind: "after", id: "prev", onlyIfOk: true, title: "the migration" });
  assert.equal(a.draft.payload.steps.length, 2);
});

test("every refusal is a sentence", () => {
  const refused = (body, f = facts()) => { const r = agentDraftFrom(body, f); assert.ok("refused" in r, JSON.stringify(r)); return r.refused; };
  assert.match(refused({ prompt: "x" }), /key/);
  assert.match(refused({ key: "bad key!", prompt: "x" }), /key/);
  assert.match(refused({ key: "k" }), /prompt/);
  assert.match(refused({ key: "k", prompt: "x" }, facts({ cwd: null })), /repo/);
  assert.match(refused({ key: "k", prompt: "x", session: "gone" }), /no live session/);
  assert.match(refused({ key: "k", prompt: "x", session: "s2" }), /different repo/);
  assert.match(refused({ key: "k", prompt: "x", when: { kind: "at", at: NOW - 1 } }), /passed/);
  assert.match(refused({ key: "k", prompt: "x", when: { kind: "window", window: "daily" } }), /window/);
  assert.match(refused({ key: "k", prompt: "x", when: { kind: "window", window: "session", oneShot: false } }), /one-offs only/);
  assert.match(refused({ key: "k", prompt: "x", when: { kind: "after", id: "nope" } }), /when\.id/);
  assert.match(refused({ key: "k", prompt: "x", when: { kind: "weekly" } }), /when\.kind/);
});

test("the one client path: contains, strips what only the host may write, and owns the agent mark", async () => {
  const posted = [];
  const deps = {
    containRepoDir: async (d) => (d === "/root/proj" ? "/root/proj" : null),
    intents: { post: (draft) => { posted.push(draft); return { ok: true, intent: { ...draft, state: "queued" } }; } },
  };
  const base = { id: "i1", cwd: "/root/proj", payload: { kind: "prompt", steps: ["x"] }, trigger: { kind: "now" } };

  const out = await postClientDraft(deps, { ...base, cwd: "/etc" });
  assert.deepEqual(out, { ok: false, reason: "cwd outside root", refusedCwd: true });
  assert.equal(posted.length, 0, "a refused cwd writes nothing");

  await postClientDraft(deps, { ...base, origin: "agent", headline: "h", headlineBy: "assess", pastBudget: { until: 1 }, budgetPass: { window: "weekly" } });
  const d = posted.at(-1);
  assert.equal(d.origin, undefined, "a socket client cannot claim the agent mark");
  assert.equal(d.headlineBy, "hand");
  assert.equal(d.pastBudget, undefined);
  assert.equal(d.budgetPass, undefined);

  await postClientDraft(deps, base, { origin: "agent" });
  assert.equal(posted.at(-1).origin, "agent", "the agent route writes it");
});

test("when it fires is the send sheet's sentence", () => {
  assert.equal(agentWhenOf({ trigger: { kind: "now" } }), "now");
  assert.equal(agentWhenOf({ trigger: { kind: "after", id: "p", title: "t", onlyIfOk: true } }), "after “t”, only if it worked");
  assert.match(agentWhenOf({ trigger: { kind: "at", rule: { kind: "window", window: "weekly", edge: "before", offsetMin: -180, oneShot: true } }, nextAt: null }), /armed once the host reads the window/);
});

test("a backlog add is words on the list: no clock, no fire, and the shared add path marks it", async () => {
  const r = agentBacklogFrom({ key: "b1", steps: ["one", "two"], label: "l", resume: true }, facts());
  assert.deepEqual(r.add, { id: "agent-b1", repoDir: "/root/proj", text: "one", steps: ["one", "two"], label: "l", targetSessionId: undefined, resume: true });
  const s = agentBacklogFrom({ key: "b2", prompt: "x", session: "s1", resume: true }, facts({ cwd: null }));
  assert.equal(s.add.targetSessionId, "s1");
  assert.equal(s.add.resume, undefined, "resume means a fresh session, which a session target is not");
  assert.match(agentBacklogFrom({ key: "b3", prompt: "x", when: { kind: "now" } }, facts()).refused, /never starts by itself/);
  assert.match(agentBacklogFrom({ key: "b4", prompt: "x", fire: true }, facts()).refused, /never starts by itself/);

  const calls = [];
  const deps = {
    containRepoDir: async (d) => (d === "/root/proj" ? d : null),
    backlog: { add: (...args) => { calls.push(args); return { id: args[5]?.id ?? "x", status: "queued" }; } },
  };
  assert.deepEqual(await addClientBacklogItem(deps, { repoDir: "/etc", text: "x" }), { ok: false, refusedCwd: true });
  assert.equal(calls.length, 0);
  await addClientBacklogItem(deps, { ...r.add, origin: "agent", manual: true });
  const opts = calls.at(-1)[5];
  assert.equal(opts.id, "agent-b1");
  assert.equal(opts.origin, "agent");
  assert.equal(opts.manual, true);
  assert.equal(calls.at(-1)[4], undefined, "no autoFire — the row is never pinned past the switch");
  assert.equal(agentWhenOf({ manual: true, trigger: { kind: "idle" } }), "waits for your tap — nothing starts it by itself");
});

test("an agent may say closeWhenDone for a NEW session — a boolean or nothing; never on a live session", () => {
  const on = agentDraftFrom({ key: "c1", prompt: "x", closeWhenDone: true }, facts());
  assert.equal(on.draft.closeWhenDone, true);
  const keep = agentDraftFrom({ key: "c2", prompt: "x", closeWhenDone: false }, facts());
  assert.equal(keep.draft.closeWhenDone, false, "keep-open is kept as an answer");
  assert.equal("closeWhenDone" in agentDraftFrom({ key: "c3", prompt: "x", closeWhenDone: "yes" }, facts()).draft, false);
  assert.equal("closeWhenDone" in agentDraftFrom({ key: "c4", prompt: "x", session: "s1", closeWhenDone: true }, facts({ cwd: null })).draft, false,
    "typed into a session already there: it opens nothing, so there is nothing to close");
  assert.equal(agentBacklogFrom({ key: "c5", prompt: "x", closeWhenDone: false }, facts()).add.closeWhenDone, false);
});

test("the run order: every waiting row in tick order, and a reorder names only waiting rows", () => {
  const row = (id, over = {}) => ({ id, cwd: "/root/proj", state: "queued", createdAt: 100, payload: { kind: "prompt", steps: [`do ${id}`] }, target: { kind: "repo" }, trigger: { kind: "idle" }, ...over });
  const rows = [
    row("b", { order: 5 }),
    row("a", { order: 2, origin: "agent" }),
    row("ran", { state: "running", order: 1 }),
    row("gone", { state: "done", order: 0 }),
    row("aside", { archived: true, order: 0 }),
    row("other", { cwd: "/root/else", order: 3 }),
  ];
  const q = agentQueue(rows, "/root/proj");
  assert.deepEqual(q.map((r) => [r.seat, r.id]), [[1, "a"], [2, "b"]], "started, settled, archived and other repos have no seat");
  assert.equal(q[1].shownAs, "the person's");
  assert.deepEqual(agentQueue(rows, null).map((r) => r.id), ["a", "other", "b"], "no repo = the tick's own order across repos");

  const get = (id) => rows.find((r) => r.id === id);
  assert.deepEqual(agentOrderIds({ ids: ["b", "a"] }, get), { ids: ["b", "a"] });
  assert.match(agentOrderIds({ ids: ["b"] }, get).refused, /2-200/);
  assert.match(agentOrderIds({ ids: ["b", "b"] }, get).refused, /twice/);
  assert.match(agentOrderIds({ ids: ["b", "nope"] }, get).refused, /no such intent: nope/);
  assert.match(agentOrderIds({ ids: ["b", "ran"] }, get).refused, /ran is running/);
  assert.match(agentOrderIds({ ids: ["b", "aside"] }, get).refused, /aside is archived/);
});
