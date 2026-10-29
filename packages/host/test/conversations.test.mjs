/**
 * The `agents` + `conversations` slots (backend contract v2, WP9): a plugin's source answers the
 * live subagent list and the closed rows / pick sheet; claude's own readers stay providers.
 * "acme" is a made-up backend: public tests never name a private extension.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { derive } = await import("../dist/backends/derive.js");
const { readAgents } = await import("../dist/agents.js");
const { listConversations, conversationExists, deleteConversation, pickRefusal, conversationTabNames, pageBounds } = await import("../dist/archive.js");
const { registerBackend, unregisterBackend, forkAtTurnRefusal, claudeBackend, backendInfos } = await import("../dist/backends/index.js");

const caps = { slash: "none", permissionModes: [], remoteControl: false };
const sess = { id: "s1", cwd: "/tmp/acme-none", spawnedAt: 1 };
const acme = (sources, facts) => ({ caps, forkVia: undefined, facts, sources: { attach: async () => ({}), ...sources } });

test("agents: a plugin's source lists what runs; ended ones are dropped, newest first", () => {
  const b = acme({ agents: { list: () => [
    { id: "a", name: "old", startedAt: 1, lastWriteAt: 5 },
    { id: "b", startedAt: 2, lastWriteAt: 9 },
    { id: "c", name: "done", startedAt: 1, endedAt: 4 },
  ] } }, { agents: [{ source: true }] });
  const rows = readAgents(b, sess);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
  assert.equal(rows[0].what, "agent");
  assert.equal(rows[1].what, "old");
});

test("agents: no provider => null (absent); a null or throwing source passes on, an empty list is a list", () => {
  assert.equal(readAgents(acme({}, {}), sess), null);
  assert.equal(readAgents(acme({}, { agents: [{ source: true }] }), sess), null, "listed but no slot");
  assert.equal(readAgents(acme({ agents: { list: () => null } }, { agents: [{ source: true }] }), sess), null);
  assert.equal(readAgents(acme({ agents: { list: () => { throw new Error("x"); } } }, { agents: [{ source: true }] }), sess), null);
  assert.deepEqual(readAgents(acme({ agents: { list: () => [] } }, { agents: [{ source: true }] }), sess), []);
});

test("agents: claude's store provider is today's reader (empty list for a conversation with no agents)", () => {
  const claude = { caps, facts: { agents: [{ store: "claude-agents" }] } };
  assert.deepEqual(readAgents(claude, { ...sess, claudeSessionId: "nope" }), []);
});

const convs = [
  { id: "ses_old", updatedAt: 10, firstPrompt: "fix the thing" },
  { id: "ses_new", updatedAt: 20, title: "Named", firstPrompt: "other" },
];
const withConvs = (extra = {}) => acme({ conversations: { list: async () => convs, ...extra } }, { conversations: [{ source: true }] });

test("conversations: a plugin's list() fills the archive listing (newest first, paged, q-filtered)", async () => {
  const l = await listConversations(withConvs(), "/r", { limit: 1 });
  assert.equal(l.total, 2);
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0].id, "ses_new");
  assert.equal(l.rows[0].title, "Named");
  assert.equal(l.rows[0].cwd, "/r");
  assert.equal(l.rows[0].mtime, 20);
  const q = await listConversations(withConvs(), "/r", { q: "fix" });
  assert.deepEqual(q.rows.map((r) => r.id), ["ses_old"]);
  assert.equal(q.rows[0].title, "fix the thing");
});

test("conversations: no provider => null; a failing list passes on", async () => {
  assert.equal(await listConversations(acme({}, {}), "/r"), null);
  const bad = acme({ conversations: { list: async () => { throw new Error("down"); } } }, { conversations: [{ source: true }] });
  assert.equal(await listConversations(bad, "/r"), null);
});

test("conversations: exists / delete go through the source, and delete needs remove()", async () => {
  assert.equal(await conversationExists(withConvs(), "/r", "ses_old"), true);
  assert.equal(await conversationExists(withConvs(), "/r", "ses_nope"), false);
  const refused = await deleteConversation(withConvs(), "/r", "ses_old");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cannot delete/);
  const calls = [];
  const ok = await deleteConversation(withConvs({ remove: async (cwd, id) => { calls.push([cwd, id]); return { ok: true }; } }), "/r", "ses_old");
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [["/r", "ses_old"]]);
  const gone = await deleteConversation(withConvs({ remove: async () => ({ ok: true }) }), "/r", "ses_nope");
  assert.equal(gone.ok, false);
});

test("conversations: the pick refusal is a sentence only when no provider lists", () => {
  assert.equal(pickRefusal(withConvs()), null);
  assert.equal(pickRefusal({ caps, facts: { conversations: [{ store: "claude-jsonl" }] } }), null);
  assert.match(pickRefusal(acme({}, {})), /does not keep a list of conversations/);
});

test("derive: resumePick follows the conversations slot; a source's fork() is a fork now the host calls it (R3, P4b2)", () => {
  const w = (b) => derive(b).wireCaps();
  assert.equal(w(withConvs()).resumePick, true);
  assert.equal(w(withConvs()).fork, false);
  // `routes/session.ts` calls `conversations.fork` (`forkViaSource`), so the wire offers the button
  // exactly where that call exists (`sourcefork.test.mjs` pins the route).
  assert.equal(w(withConvs({ fork: async () => null })).fork, true);
  assert.equal(w(acme({}, {})).resumePick, false);
  assert.equal(w({ caps, forkVia: "server", facts: {} }).fork, true);
  const claude = w({ caps, facts: { conversations: [{ store: "claude-jsonl" }] } });
  assert.equal(claude.resumePick, true);
  assert.equal(claude.fork, true);
});

test("R3: a plugin backend with conversations.fork is forked by its source, never claude's forkConversationFile", () => {
  const b = { ...claudeBackend, id: "acmefork", label: "Acme", forkVia: undefined,
    facts: { ...claudeBackend.facts, transcript: [], conversations: [{ source: true }] },
    sources: { attach: async () => ({}), conversations: { list: async () => convs, fork: async () => ({ id: "ses_cut" }) } } };
  registerBackend(b);
  try {
    // No refusal: `routes/session.ts` asks the source (`forkViaSource`), and the file copy is not reached.
    assert.equal(forkAtTurnRefusal("acmefork"), null);
    assert.equal(backendInfos().find((i) => i.id === "acmefork").caps.fork, true);
  } finally { unregisterBackend("acmefork"); }
  assert.equal(forkAtTurnRefusal("claude"), null, "claude's jsonl still forks");
});

test("R9: names and bookmarks reach a plugin's rows, keyed by the backend's own id", async () => {
  const names = conversationTabNames(
    [{ backendSessionId: "ses_new", tabTitle: "live name" }, { claudeSessionId: "c-1", tabTitle: "claude tab" }],
    [{ backendSessionId: "ses_new", tabTitle: "older" }, { backendSessionId: "ses_old", tabTitle: "closed name" }],
  );
  assert.equal(names.get("ses_new"), "live name", "a live session's name beats a closed row's");
  assert.equal(names.get("ses_old"), "closed name");
  assert.equal(names.get("c-1"), "claude tab");
  const bookmarks = new Map([["ses_old", { at: 1, note: "look again" }]]);
  const l = await listConversations(withConvs(), "/r", { names, bookmarks });
  assert.equal(l.rows.find((r) => r.id === "ses_new").name, "live name");
  assert.equal(l.rows.find((r) => r.id === "ses_old").name, "closed name");
  assert.equal(l.rows.find((r) => r.id === "ses_old").bookmark.note, "look again");
});

test("R9: a non-number offset/limit is the default page, never an empty one", async () => {
  assert.deepEqual(pageBounds(NaN, NaN), { offset: 0, limit: 60 });
  assert.deepEqual(pageBounds("x", "y"), { offset: 0, limit: 60 });
  assert.deepEqual(pageBounds(-3, 9999), { offset: 0, limit: 500 });
  assert.deepEqual(pageBounds(1.7, 2.2), { offset: 1, limit: 2 });
  const l = await listConversations(withConvs(), "/r", { offset: NaN, limit: NaN });
  assert.equal(l.rows.length, 2);
  assert.equal(l.offset, 0);
});

test("R7: agents.list() is handed a REALPATHED cwd, like every other slot", async () => {
  const { agentsSourceSession } = await import("../dist/sessions/agentpoll.js");
  const { mkdtempSync, realpathSync, symlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "agents-cwd-"));
  const link = join(dir, "link");
  symlinkSync(dir, link);
  const ss = agentsSourceSession({ spawnedAt: 7, info: { id: "nochannel", cwd: link } });
  assert.deepEqual(ss, { id: "nochannel", cwd: realpathSync(dir), spawnedAt: 7 }, "no backendSessionId key when there is none");
  assert.equal(agentsSourceSession({ spawnedAt: 7, info: { id: "x", cwd: "/no/such/dir", backendSessionId: "b1" } }).cwd, "/no/such/dir");
});
