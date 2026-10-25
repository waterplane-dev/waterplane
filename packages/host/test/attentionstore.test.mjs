/**
 * The attention half of the notification feed (`attentionstore.ts`) and the
 * level gate in `notify()` (`server/clients.ts`): what is kept across a
 * restart, what counts once, what a done or a resolve changes, and which
 * frames and pushes an information item still produces.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AttentionStore, ATTENTION_CAP, gitFailedFor, buildFailedFor } = await import("../dist/attentionstore.js");
const { createClients } = await import("../dist/server/clients.js");
const { gitAttentionKey, buildAttentionKey, needsYou } = await import("@waterplane/shared");
const { hostStateDir } = await import("../dist/branddirs.js");

function root() {
  const r = mkdtempSync(join(tmpdir(), "waterplane-attn-"));
  after(() => rmSync(r, { recursive: true, force: true }));
  return r;
}
let n = 0;
const item = (over = {}) => ({ id: `i${++n}`, ts: 1_000 + n, kind: "git", title: "t", body: "b", ...over });

test("add keeps the item as attention; a reload of the file has it back with its extras", () => {
  const r = root();
  const s = new AttentionStore(r);
  s.add(item({ key: gitAttentionKey("r1", "push"), body: "FAILED: lint" }), { detail: "whole text" });
  const again = new AttentionStore(r);
  assert.equal(again.items().length, 1);
  assert.equal(again.items()[0].level, "attention");
  assert.equal(again.unhandled()[0].extras.detail, "whole text");
  assert.equal("detail" in again.items()[0], false, "the wire item never carries detail");
});

test("a new item under a still-unhandled key hands the older one off as resolved", () => {
  const s = new AttentionStore(null);
  const key = gitAttentionKey("r1", "push");
  assert.equal(s.add(item({ key })), false);
  assert.equal(s.add(item({ key })), true);
  assert.equal(s.unhandled().length, 1, "one cause counts once");
  const old = s.items()[1];
  assert.equal(old.handled.by, "resolved");
  assert.equal(old.handled.note, "replaced by a newer one");
  // A different key is left alone.
  s.add(item({ key: gitAttentionKey("r1", "pull") }));
  assert.equal(s.unhandled().length, 2);
});

test("resolve marks every unhandled item of that key, keeps them, and is silent when nothing matches", () => {
  const s = new AttentionStore(null);
  let changes = 0;
  s.onChange(() => changes++);
  const key = gitAttentionKey("r2", "pull");
  s.add(item({ key }));
  s.add(item({ key: "followup:s1" }));
  changes = 0;
  assert.equal(s.resolve(key, "fixed by the 14:02 pull", { at: 5 }), 1);
  assert.equal(changes, 1);
  const done = s.items().find((i) => i.key === key);
  assert.deepEqual(done.handled, { at: 5, by: "resolved", note: "fixed by the 14:02 pull" });
  assert.equal(s.items().length, 2, "a resolved item stays in the feed");
  assert.equal(s.resolve(key, "again"), 0, "already handled ⇒ nothing");
  assert.equal(s.resolve("nope", "x"), 0);
  assert.equal(changes, 1, "a no-op resolve writes nothing");
  // Prefix
  s.add(item({ key: buildAttentionKey("r2", "apk") }));
  s.add(item({ key: buildAttentionKey("r2", "web") }));
  assert.equal(s.resolve(buildAttentionKey("r2", ""), "repo gone", { prefix: true }), 2);
});

test("handle is the person's done: once, idempotent, unknown ids ignored", () => {
  const s = new AttentionStore(null);
  const it = item({ key: "followup:s9" });
  s.add(it);
  assert.equal(s.handle(it.id, 7), true);
  assert.deepEqual(s.items()[0].handled, { at: 7, by: "person" });
  assert.equal(s.handle(it.id, 8), false);
  assert.deepEqual(s.items()[0].handled, { at: 7, by: "person" }, "the first done stands");
  assert.equal(s.handle("missing"), false);
  assert.equal(needsYou(s.items()[0]), false);
});

test("caps: newest 50 unhandled and newest 50 handled are kept", () => {
  const s = new AttentionStore(null);
  for (let i = 0; i < ATTENTION_CAP + 10; i++) s.add(item());
  assert.equal(s.unhandled().length, ATTENTION_CAP);
  const ids = s.items().map((x) => x.id);
  for (const id of ids) s.handle(id);
  for (let i = 0; i < ATTENTION_CAP + 5; i++) s.add(item());
  assert.equal(s.unhandled().length, ATTENTION_CAP);
  assert.equal(s.items().filter((x) => x.handled).length, ATTENTION_CAP);
});

test("clear empties it; a corrupt file is moved aside and the store starts empty", () => {
  const r = root();
  const s = new AttentionStore(r);
  s.add(item());
  s.clear();
  assert.equal(new AttentionStore(r).items().length, 0);
  const dir = hostStateDir(r);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "attention.json"), "{not json");
  const fresh = new AttentionStore(r);
  assert.equal(fresh.items().length, 0);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("attention.json.corrupt-")), "the bytes are kept, not overwritten");
});

test("gitFailedFor / buildFailedFor: newest unhandled of that worktree only", () => {
  const s = new AttentionStore(null);
  s.add(item({ key: gitAttentionKey("wt", "pull"), body: "pull line" }));
  s.add(item({ key: gitAttentionKey("wt", "push"), body: "push line" }), { detail: "push full" });
  s.add(item({ key: gitAttentionKey("other", "push") }));
  const g = gitFailedFor(s, "wt");
  assert.equal(g.verb, "push");
  assert.equal(g.error, "push full");
  s.resolve(gitAttentionKey("wt", "push"), "fixed");
  assert.equal(gitFailedFor(s, "wt").verb, "pull");
  assert.equal(gitFailedFor(s, "wt").error, "pull line", "no detail ⇒ the body");
  assert.equal(gitFailedFor(s, "nobody"), undefined);
  s.add(item({ kind: "artifact", key: buildAttentionKey("wt", "apk") }), { detail: "gradle said no", build: { id: "apk", name: "Android APK" } });
  assert.deepEqual(Object.keys(buildFailedFor(s, "wt")).sort(), ["at", "buildId", "error", "id", "name"]);
  assert.equal(buildFailedFor(s, "wt").name, "Android APK");
  assert.equal(buildFailedFor(s, "w"), undefined, "a prefix of another id is not that id");
});

function clientsWith({ pushInfo = false, prefs = {} } = {}) {
  const pushed = [];
  const c = createClients({
    auth: { passive: {} }, notifyPrefs: { enabled: () => true, pushInfo: () => pushInfo, get: () => prefs },
    push: { notify: (p) => { pushed.push(p); } }, sessions: { list: () => [] },
  });
  const frames = { full: [], link: [] };
  const sock = (into) => ({ OPEN: 1, readyState: 1, send: (b) => into.push(JSON.parse(b)) });
  const full = sock(frames.full), link = sock(frames.link);
  c.clients.add(full); c.clients.add(link);
  c.wsRole.set(link, "notify");
  return { c, pushed, frames };
}

test("notify: attention is pushed and reaches the notify link; information reaches full clients only", () => {
  const { c, pushed, frames } = clientsWith();
  c.notify("git", { title: "Push failed · r", body: "x", outcome: "failed", key: gitAttentionKey("r", "push"), detail: "secret-ish full text" });
  c.notify("git", { title: "Pushed · r", body: "y", outcome: "ok" });
  c.notify("artifact", { title: "f", body: "z", pull: "p1" });
  assert.deepEqual(pushed.map((p) => [p.title, p.level]), [["Push failed · r", "attention"], ["f", "info"]]);
  assert.equal(pushed.some((p) => "detail" in p || "outcome" in p), false, "host-only fields never leave");
  assert.deepEqual(frames.link.map((f) => f.item.title), ["Push failed · r", "f"]);
  assert.deepEqual(frames.full.map((f) => f.item.title), ["Push failed · r", "Pushed · r", "f"]);
  assert.equal(frames.full[0].item.detail, undefined);
  assert.equal(frames.full[0].item.key, gitAttentionKey("r", "push"));
  // The feed is both halves, newest first; attention lives in the store, not the info array.
  assert.deepEqual(c.notificationFeed().map((i) => i.title).sort(), ["Push failed · r", "Pushed · r", "f"].sort());
  assert.equal(c.notifications.length, 2);
  assert.equal(c.attention.items().length, 1);
});

test("notify: pushInfo on ⇒ information is pushed and reaches the link too", () => {
  const { c, pushed, frames } = clientsWith({ pushInfo: true });
  c.notify("git", { title: "Pushed · r", body: "y", outcome: "ok" });
  assert.equal(pushed.length, 1);
  assert.equal(frames.link.length, 1);
});

test("notify: a default-off kind the person switched ON is pushed though it is information", () => {
  const off = clientsWith();
  off.c.notify("idle", { title: "Idle", body: "x" });
  assert.equal(off.pushed.length, 0, "default off + not asked for: stays quiet");
  const on = clientsWith({ prefs: { idle: true } });
  on.c.notify("idle", { title: "Idle", body: "x" });
  on.c.notify("git", { title: "Pushed · r", body: "y", outcome: "ok" });
  assert.deepEqual(on.pushed.map((p) => p.title), ["Idle"], "only the asked-for kind, not all information");
});

test("resolveAttention / handleNotification / clear broadcast the merged list only on a change", () => {
  const { c, frames } = clientsWith();
  const key = gitAttentionKey("r", "pull");
  c.notify("git", { title: "Pull failed · r", body: "x", outcome: "failed", key });
  frames.full.length = 0;
  assert.equal(c.resolveAttention("nothing", "n"), 0);
  assert.equal(frames.full.length, 0);
  assert.equal(c.resolveAttention(key, "fixed by the 09:00 pull"), 1);
  assert.equal(frames.full.at(-1).t, "notification.list");
  assert.equal(frames.full.at(-1).items[0].handled.note, "fixed by the 09:00 pull");
  c.notify("git", { title: "Pull failed · r", body: "x", outcome: "failed", key });
  const id = c.attention.unhandled()[0].item.id;
  frames.full.length = 0;
  assert.equal(c.handleNotification(id), true);
  assert.equal(c.handleNotification(id), false);
  assert.equal(frames.full.filter((f) => f.t === "notification.list").length, 1);
  assert.equal(frames.link.filter((f) => f.t === "notification.list").length, 0, "the link is sent its allow-list only");
  c.clearNotifications();
  assert.deepEqual(c.notificationFeed(), []);
});

const { reportGitOutcome, gitFailureHeadline } = await import("../dist/gitnotify.js");
const { setGitOutcomeSink, gitPull, startPush } = await import("../dist/git.js");
const { execFileSync } = await import("node:child_process");

test("reportGitOutcome: failed ⇒ attention with key/tag/open/detail; push ok ⇒ resolve + receipt; pull ok ⇒ resolve only", () => {
  const calls = [];
  const ctx = { notify: (k, p) => calls.push(["notify", k, p]), resolveAttention: (k, note) => { calls.push(["resolve", k, note]); return 0; } };
  const repo = { id: "rid", name: "myapp", branch: "main" };
  reportGitOutcome({ repo, verb: "push", ok: false, error: "\nThe pre-push check stopped it — lint\n\nlots", startedAt: 0, finishedAt: 1 }, ctx);
  const [, kind, p] = calls[0];
  assert.equal(kind, "git");
  assert.equal(p.title, "Push failed · myapp");
  assert.equal(p.body, "The pre-push check stopped it — lint");
  assert.equal(p.outcome, "failed");
  assert.equal(p.key, gitAttentionKey("rid", "push"));
  assert.equal(p.tag, "git-rid-push");
  assert.deepEqual(p.open, { to: "git", repoId: "rid", verb: "push" });
  assert.match(p.detail, /lots/);
  calls.length = 0;
  reportGitOutcome({ repo, verb: "push", ok: true, startedAt: 0, finishedAt: 125_000 }, ctx);
  assert.equal(calls[0][0], "resolve");
  assert.match(calls[0][2], /^fixed by the \d\d:\d\d push$/);
  assert.equal(calls[1][2].title, "Pushed · myapp");
  assert.equal(calls[1][2].outcome, "ok");
  assert.equal(calls[1][2].key, undefined, "a receipt has no cause to resolve");
  calls.length = 0;
  reportGitOutcome({ repo, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
  assert.deepEqual(calls.map((c) => c[0]), ["resolve"]);
  assert.equal(gitFailureHeadline(""), "No reason was given.");
});

test("git.ts reports a run's outcome once — a pull with no upstream, a push joined twice", async () => {
  const wt = root();
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  execFileSync("git", ["-C", wt, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"]);
  const seen = [];
  setGitOutcomeSink((o) => seen.push(o));
  after(() => setGitOutcomeSink(null));
  const repo = { id: "w1", name: "w" };
  const r = await gitPull(wt, repo);
  assert.equal(r.ok, false);
  assert.deepEqual(seen.map((o) => [o.verb, o.ok, o.repo.id]), [["pull", false, "w1"]]);
  const a = startPush(wt, repo), b = startPush(wt, repo);
  assert.equal(a, b, "the second start joins");
  await a.done;
  assert.deepEqual(seen.map((o) => o.verb), ["pull", "push"], "one report per run, not per joiner");
  await gitPull(wt); // no repo ⇒ not reported
  assert.equal(seen.length, 2);
});
