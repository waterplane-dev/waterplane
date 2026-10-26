/**
 * The scorecard host half with an injected fetch (no network): slug reading, the reply parser,
 * failing / accept / lapse, the accepts file's refusal, the setup row per state, the handlers via
 * `serve()`, the remedy key and its refusal.
 *
 *     node --test packages/extensions/scorecard/test/scorecard.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const D = "../../../host/dist/extensions/scorecard";
const { createEngine, serve } = await import(`${D}/host/index.mjs`);
const L = await import(`${D}/shared/logic.mjs`);
const G = await import(`${D}/host/gitslug.mjs`);
const E = await import(`${D}/host/engine.mjs`);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "scorecard-")));
const chk = (name, score, extra = {}) => ({ name, score, reason: `${name} reason`, details: ["Warn: x"], documentation: { url: `https://d/${name}`, short: "s" }, ...extra });
const REPLY = (checks, score = 6) => ({ date: "2026-10-26T10:06:12Z", repo: { name: "github.com/o/n", commit: "abc" }, scorecard: { version: "v5.6.0", commit: "z" }, score, checks });
const GOOD = REPLY([chk("Pinned-Dependencies", 3), chk("Code-Review", 0), chk("License", 10), chk("Webhooks", -1, { details: null }), chk("SAST", 5)]);

/** A fetch answering GitHub and the Scorecard API from tables; counts calls per host. */
function fakeFetch({ gh = { status: 200, body: { private: false } }, sc = { status: 200, body: GOOD } } = {}) {
  const f = async (url) => {
    f.calls.push(String(url));
    const r = String(url).startsWith("https://api.github.com/") ? f.gh : f.sc;
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body };
  };
  f.calls = []; f.gh = gh; f.sc = sc;
  return f;
}
function rig(opts = {}) {
  const stateDir = tmp(), worktree = tmp();
  mkdirSync(join(worktree, ".git"));
  writeFileSync(join(worktree, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:o/n.git\n`);
  const fetch = opts.fetch ?? fakeFetch();
  const pushes = [], hands = [];
  const clock = { t: 1_000_000 };
  const engine = createEngine({ stateDir, fetch, now: () => clock.t }, {
    push: (d) => pushes.push(d),
    handToAgent: async (id, prompt, o) => {
      // The host's real key rule (pluginapi.ts): letters/digits/._:- and `plugin-scorecard-<key>` within 64.
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(String(o.key)) || `plugin-scorecard-${o.key}`.length > 64) return { ok: false, reason: `key "${o.key}" is not usable` };
      hands.push({ id, prompt, o });
      const h = typeof opts.hand === "function" ? opts.hand(hands.length - 1, o) : opts.hand;
      return h ?? { ok: true, intentId: "i1", existing: false };
    },
  });
  const scope = { id: "r1", name: basename(worktree), worktree };
  return { stateDir, worktree, fetch, pushes, hands, clock, engine, scope };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("slugs: every URL form, and the first GitHub remote when origin is elsewhere", () => {
  for (const u of ["https://github.com/o/n.git", "https://github.com/o/n", "https://user@github.com/o/n/", "git@github.com:o/n.git", "ssh://git@github.com/o/n", "ssh://git@github.com:22/o/n.git", "git://github.com/o/n.git"]) assert.equal(L.githubSlug(u), "o/n", u);
  assert.equal(L.githubSlug("https://gitlab.com/o/n.git"), null);
  assert.equal(L.githubSlug("https://github.com/o"), null);
  const cfg = `[remote "origin"]\n url = https://gitlab.com/a/b.git\n[remote "mirror"]\n url = git@github.com:m/r.git\n[remote "gh"]\n url = https://github.com/x/y\n`;
  assert.equal(L.slugFromConfig(cfg), "m/r");
  assert.equal(L.slugFromConfig(`[remote "up"]\n url = https://github.com/u/p\n[remote "origin"]\n url = https://github.com/o/n\n`), "o/n");
  assert.equal(L.slugFromConfig(`[core]\n url = https://github.com/o/n\n`), null);
});

test("a linked worktree's .git file leads to the common dir's config; the repo name is the primary folder's", () => {
  const base = tmp();
  const primary = join(base, "usmc"), linked = join(base, "usmc-wt");
  mkdirSync(join(primary, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(linked);
  writeFileSync(join(primary, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/o/n.git\n`);
  writeFileSync(join(primary, ".git", "worktrees", "wt", "commondir"), "../..\n");
  writeFileSync(join(linked, ".git"), `gitdir: ${join(primary, ".git", "worktrees", "wt")}\n`);
  assert.equal(G.slugOfWorktree(linked), "o/n");
  assert.equal(G.slugOfWorktree(primary), "o/n");
  assert.equal(G.repoNameOfWorktree(linked), "usmc");
  assert.equal(G.slugOfWorktree(base), null);
});

test("reply parser: good, caps, -1 and null details, wrong shapes are absent with a reason", () => {
  const ok = L.parseReply(GOOD);
  assert.ok(ok.ok);
  assert.equal(ok.value.score, 6);
  assert.equal(ok.value.commit, "abc");
  assert.equal(ok.value.scorecardVersion, "v5.6.0");
  assert.deepEqual(ok.value.checks[3].details, []);
  assert.equal(ok.value.checks[0].docUrl, "https://d/Pinned-Dependencies");
  const long = L.parseReply(REPLY([chk("A", 1, { details: Array.from({ length: 30 }, () => "x".repeat(500)) })]));
  assert.equal(long.value.checks[0].details.length, 20);
  assert.equal(long.value.checks[0].details[0].length, 300);
  for (const bad of [null, [], "x", {}, { score: "6", checks: [] }, { score: 6 }, { score: 11, checks: [chk("A", 1)] }, { score: 6, checks: [{ nope: 1 }] }, { score: -1, checks: [chk("A", 1)] }]) {
    const r = L.parseReply(bad);
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 10);
  }
});

test("failing, built-in accepts, person accepts and their lapse", () => {
  assert.deepEqual([-1, 0, 5, 9, 10].map(L.isFailing), [false, true, true, true, false]);
  const checks = L.parseReply(GOOD).value.checks;
  let v = L.checkViews(checks, { "Pinned-Dependencies": { reason: "r", score: 3 } });
  assert.equal(L.openCount(v), 1); // SAST open; Code-Review built in; Pinned accepted
  assert.equal(v.find((c) => c.name === "Code-Review").accepted.builtIn, true);
  assert.equal(v.find((c) => c.name === "License").failing, false);
  assert.equal(v.find((c) => c.name === "Webhooks").failing, false);
  v = L.checkViews([{ ...checks[0], score: 2 }, ...checks.slice(1)], { "Pinned-Dependencies": { reason: "r", score: 3 } });
  assert.equal(v[0].accepted, undefined); // below the accepted score: lapsed
  v = L.checkViews([{ ...checks[0], score: 4 }, ...checks.slice(1)], { "Pinned-Dependencies": { reason: "r", score: 3 } });
  assert.ok(v[0].accepted); // better than accepted: still holds
  assert.equal(L.scoredDetail(6, L.checkViews(checks)), "6/10 — 2 failing checks (Pinned-Dependencies, SAST); 1 accepted");
  assert.equal(L.scoredDetail(10, []), "10/10 — no failing check left");
});

test("setup row: null until read, then per state; reading starts in the background", async () => {
  const r = rig();
  assert.equal(r.engine.row(r.worktree), null); // not read yet -> kicks a read
  await settle();
  assert.equal(r.pushes.length, 1);
  assert.deepEqual(r.pushes[0], { at: r.clock.t, slug: "o/n" });
  const row = r.engine.row(r.worktree);
  assert.equal(row.id, "scorecard");
  assert.equal(row.label, "OpenSSF Scorecard");
  assert.equal(row.status, "warn");
  assert.equal(row.advisory, true);
  assert.equal(row.fix, null);
  assert.match(row.detail, /^6\/10 — 2 failing checks \(Pinned-Dependencies, SAST\); 1 accepted$/);
  assert.equal(r.fetch.calls.length, 2);
});

test("setup row: pass when nothing open; private repo gets no row and Scorecard is never asked", async () => {
  const ok = rig({ fetch: fakeFetch({ sc: { status: 200, body: REPLY([chk("License", 10), chk("Code-Review", 0)], 9) } }) });
  ok.engine.row(ok.worktree); await settle();
  const row = ok.engine.row(ok.worktree);
  assert.equal(row.status, "pass");
  assert.equal(row.advisory, undefined);
  assert.equal(row.detail, "9/10 — no failing check left (1 accepted)");

  const priv = rig({ fetch: fakeFetch({ gh: { status: 404, body: {} } }) });
  priv.engine.row(priv.worktree); await settle();
  assert.equal(priv.engine.row(priv.worktree), null);
  assert.deepEqual(priv.fetch.calls, ["https://api.github.com/repos/o/n"]);
  const v = priv.engine.read(priv.scope);
  assert.match(v.absent, /not public on GitHub.*public repos only/);
  assert.equal(v.score, null);
});

test("private repo: a local reading file is the reading, marked local; a bad file stays absent", async () => {
  const priv = rig({ fetch: fakeFetch({ gh: { status: 404, body: {} } }) });
  mkdirSync(join(priv.stateDir, "scorecard", "local"), { recursive: true });
  const f = join(priv.stateDir, "scorecard", "local", "o__n.json");
  writeFileSync(f, JSON.stringify(REPLY([chk("License", 10), chk("Code-Review", 0)], 7)));
  priv.engine.read(priv.scope); await settle();
  const v = priv.engine.read(priv.scope);
  assert.equal(v.score, 7);
  assert.equal(v.local, true);
  assert.equal(v.viewerUrl, undefined);
  assert.equal(v.date, "2026-10-26T10:06:12Z");
  assert.deepEqual(priv.fetch.calls, ["https://api.github.com/repos/o/n"]);
  const row = priv.engine.row(priv.worktree); // the watch region shows the local reading
  assert.equal(row.label, "OpenSSF Scorecard (scored locally)");
  assert.equal(row.watch, true);
  assert.match(row.detail, /^7\/10/);

  const bad = rig({ fetch: fakeFetch({ gh: { status: 404, body: {} } }) });
  mkdirSync(join(bad.stateDir, "scorecard", "local"), { recursive: true });
  writeFileSync(join(bad.stateDir, "scorecard", "local", "o__n.json"), "{ nope");
  bad.engine.read(bad.scope); await settle();
  const b = bad.engine.read(bad.scope);
  assert.equal(b.score, null);
  assert.equal(b.local, undefined);
  assert.match(b.absent, /exposure target/);
  assert.equal(bad.engine.row(bad.worktree), null); // no reading: no row, never a "not public" warn
});

test("setup row: public but unscored, GitHub error, bad shape", async () => {
  const un = rig({ fetch: fakeFetch({ sc: { status: 404, body: {} } }) });
  un.engine.row(un.worktree); await settle();
  const row = un.engine.row(un.worktree);
  assert.equal(row.status, "warn"); assert.equal(row.advisory, true);
  assert.match(row.detail, /not scored yet — no Scorecard results published for github\.com\/o\/n; the ossf\/scorecard-action/);

  const err = rig({ fetch: fakeFetch({ gh: new Error("offline") }) });
  err.engine.row(err.worktree); await settle();
  assert.equal(err.engine.row(err.worktree), null);
  assert.match(err.engine.read(err.scope).absent, /could not ask GitHub whether o\/n is public: offline/);

  const bad = rig({ fetch: fakeFetch({ sc: { status: 200, body: { score: 6 } } }) });
  bad.engine.row(bad.worktree); await settle();
  const v = bad.engine.read(bad.scope);
  assert.equal(v.score, null); assert.match(v.absent, /no list of checks/);
});

test("no slug: no row, and a view that says so; scoredAs overrides, is validated, and clears", async () => {
  const r = rig();
  writeFileSync(join(r.worktree, ".git", "config"), `[remote "origin"]\n\turl = https://gitlab.com/o/n\n`);
  assert.equal(r.engine.row(r.worktree), null);
  assert.equal(r.fetch.calls.length, 0);
  assert.equal(r.engine.read(r.scope).slug, null);
  assert.throws(() => r.engine.scoredAs(r.scope, "not a slug"), /owner\/name/);
  const v = r.engine.scoredAs(r.scope, "waterplane-dev/waterplane");
  assert.equal(v.slug, "waterplane-dev/waterplane"); assert.equal(v.slugFrom, "set");
  await settle();
  assert.equal(r.engine.read(r.scope).score, 6);
  assert.ok(r.fetch.calls[0].endsWith("/repos/waterplane-dev/waterplane"));
  assert.equal(r.engine.row(r.worktree).status, "warn"); // the row honours the override via the repo's folder name
  assert.equal(r.engine.scoredAs(r.scope, null).slug, null);
});

test("read returns the cache at once and re-reads only when stale; refresh awaits", async () => {
  const r = rig();
  const first = r.engine.read(r.scope);
  assert.equal(first.readAt, null); assert.equal(first.absent, "not read yet");
  await settle();
  assert.equal(r.engine.read(r.scope).readAt, r.clock.t);
  await settle();
  assert.equal(r.fetch.calls.length, 2); // fresh: no new read
  r.clock.t += 7 * 3600_000;
  r.fetch.sc = { status: 200, body: REPLY([chk("SAST", 8)], 8) };
  assert.equal(r.engine.read(r.scope).score, 6); // stale answer returned, new read started
  await settle();
  assert.equal(r.engine.read(r.scope).score, 8);
  r.fetch.sc = { status: 200, body: REPLY([chk("SAST", 9)], 9) };
  assert.equal((await r.engine.refresh(r.scope)).score, 9);
  assert.equal(r.fetch.calls.filter((c) => c.startsWith("https://api.github.com")).length, 1); // visibility cached 24h
});

test("accept: reason rules, not-failing refused, built-in refused, stored, lapses, unaccept", async () => {
  const r = rig();
  await r.engine.refresh(r.scope);
  assert.throws(() => r.engine.accept(r.scope, "SAST", "  "), /reason/);
  assert.throws(() => r.engine.accept(r.scope, "SAST", "x".repeat(501)), /500/);
  assert.throws(() => r.engine.accept(r.scope, "License", "fine"), /not failing/);
  assert.throws(() => r.engine.accept(r.scope, "Webhooks", "fine"), /not failing/);
  assert.throws(() => r.engine.accept(r.scope, "Nope", "fine"), /no check called/);
  assert.throws(() => r.engine.accept(r.scope, "Code-Review", "mine"), /built in/);
  assert.throws(() => r.engine.unaccept(r.scope, "Code-Review"), /cannot be withdrawn/);
  assert.throws(() => r.engine.unaccept(r.scope, "SAST"), /nothing to withdraw/);
  let v = r.engine.accept(r.scope, "SAST", "  no\n code  ");
  assert.equal(v.open, 1);
  const saved = JSON.parse(readFileSync(join(r.stateDir, "scorecard", "accepted.json"), "utf8"));
  assert.equal(saved.accepts["o/n"].SAST.reason, "no code");
  assert.equal(saved.accepts["o/n"].SAST.score, 5);
  r.fetch.sc = { status: 200, body: REPLY([chk("Pinned-Dependencies", 3), chk("SAST", 2)], 4) };
  v = await r.engine.refresh(r.scope);
  assert.equal(v.checks.find((c) => c.name === "SAST").accepted, undefined); // lapsed: 2 < 5
  assert.equal(v.open, 2);
  v = r.engine.unaccept(r.scope, "SAST");
  assert.equal(JSON.parse(readFileSync(join(r.stateDir, "scorecard", "accepted.json"), "utf8")).accepts["o/n"], undefined);
});

test("an accepts file that does not parse is not overwritten; reads still work", async () => {
  const r = rig();
  await r.engine.refresh(r.scope);
  mkdirSync(join(r.stateDir, "scorecard"));
  const f = join(r.stateDir, "scorecard", "accepted.json");
  writeFileSync(f, "{ not json");
  assert.equal(r.engine.read(r.scope).score, 6);
  assert.throws(() => r.engine.accept(r.scope, "SAST", "why"), (e) => e.message.includes(f) && /not valid JSON/.test(e.message));
  assert.throws(() => r.engine.scoredAs(r.scope, "a/b"), /not valid JSON/);
  assert.equal(readFileSync(f, "utf8"), "{ not json");
});

test("handlers via serve(): scope errors, read/accept/remedy, remedy key and refusal", async () => {
  const r = rig();
  const handlers = {};
  const api = { handle: (m, fn) => { handlers[m] = fn; return () => {}; }, repo: async (id) => (id === "r1" ? r.scope : null) };
  serve(api, r.engine);
  assert.deepEqual(Object.keys(handlers).sort(), ["accept", "read", "refresh", "remedy", "scoredAs", "unaccept"]);
  await assert.rejects(handlers.read({}), /which repo/);
  await assert.rejects(handlers.read({ repo: "zz" }), /no repo "zz"/);
  assert.equal((await handlers.refresh({ repo: "r1" })).score, 6);
  assert.equal((await handlers.accept({ repo: "r1", check: "SAST", reason: "ok" })).open, 1);

  const res = await handlers.remedy({ repo: "r1", check: "Pinned-Dependencies" });
  assert.deepEqual(res, { intentId: "i1", existing: false });
  assert.equal(r.hands[0].id, "r1");
  assert.match(r.hands[0].o.key, /^sc-[0-9a-f]{16}$/);
  assert.equal(r.hands[0].o.key, E.remedyKey("o/n", "Pinned-Dependencies", 3));
  assert.equal(r.hands[0].o.label, "Scorecard: Pinned-Dependencies");
  assert.equal(r.hands[0].o.fire, undefined);
  assert.match(r.hands[0].prompt, /github\.com\/o\/n.*"Pinned-Dependencies" 3\/10/);
  assert.match(r.hands[0].prompt, /full commit SHA/);
  assert.match(r.hands[0].prompt, /Warn: x/);
  assert.match(r.hands[0].prompt, /https:\/\/d\/Pinned-Dependencies/);
  assert.match(r.hands[0].prompt, /commit, and say plainly what you could not fix/);
  await assert.rejects(handlers.remedy({ repo: "r1", check: "License" }), /not failing/);
  await assert.rejects(handlers.remedy({ repo: "r1", check: "Webhooks" }), /not failing/);
  assert.equal(r.hands.length, 1);
});

test("remedy: a refused hand-off is a sentence; Branch-Protection says admin and no running it", async () => {
  const r = rig({ hand: { ok: false, reason: "the backlog is full" } });
  await r.engine.refresh(r.scope);
  await assert.rejects(r.engine.remedy(r.scope, "SAST"), /backlog is full/);
  const p = L.remedyPrompt("o/n", { name: "Branch-Protection", score: 0, reason: "r", details: [], docUrl: null, short: "" });
  assert.match(p, /repo admin/); assert.match(p, /gh api/); assert.match(p, /do NOT run/);
  assert.ok(L.remedyPrompt("o/n", { name: "Unheard-Of", score: 1, reason: "", details: [], docUrl: null, short: "" }).includes("Unheard-Of"));
});

test("remedy: a finished row gets the next key; a waiting one is the answer; state is returned", async () => {
  const r = rig({ hand: (i) => (i < 2 ? { ok: true, intentId: `old${i}`, existing: true, state: "done" } : { ok: true, intentId: "new", existing: false }) });
  await r.engine.refresh(r.scope);
  const res = await r.engine.remedy(r.scope, "SAST");
  assert.deepEqual(res, { intentId: "new", existing: false });
  assert.deepEqual(r.hands.map((h) => h.o.key), [E.remedyKey("o/n", "SAST", 5), E.remedyKey("o/n", "SAST", 5, 1), E.remedyKey("o/n", "SAST", 5, 2)]);
  const w = rig({ hand: { ok: true, intentId: "q", existing: true, state: "queued" } });
  await w.engine.refresh(w.scope);
  assert.deepEqual(await w.engine.remedy(w.scope, "SAST"), { intentId: "q", existing: true, state: "queued" });
  assert.equal(w.hands.length, 1);
});

test("a transient failure keeps the good reading and the row; it retries after 10 minutes", async () => {
  const r = rig();
  await r.engine.refresh(r.scope);
  assert.equal(r.engine.row(r.worktree).status, "warn");
  r.clock.t += 7 * 3600_000;
  r.fetch.sc = { status: 503, body: {} };
  await r.engine.refresh(r.scope);
  const v = r.engine.read(r.scope);
  assert.equal(v.score, 6); assert.equal(v.checks.length, 5);
  assert.match(r.engine.row(r.worktree).detail, /^6\/10/);
  const n = r.fetch.calls.length;
  r.engine.read(r.scope); await settle();
  assert.equal(r.fetch.calls.length, n); // not hammered
  r.clock.t += 11 * 60_000; r.fetch.sc = { status: 200, body: REPLY([chk("SAST", 8)], 8) };
  r.engine.read(r.scope); await settle();
  assert.equal(r.engine.read(r.scope).score, 8);
  // transient-only: no row (like a GitHub blip)
  const t = rig({ fetch: fakeFetch({ sc: { status: 500, body: {} } }) });
  t.engine.row(t.worktree); await settle();
  assert.equal(t.engine.row(t.worktree), null);
  assert.match(t.engine.read(t.scope).absent, /answered 500/);
});

test("an unparseable accepts file is named on the view and the row", async () => {
  const r = rig();
  await r.engine.refresh(r.scope);
  mkdirSync(join(r.stateDir, "scorecard"));
  writeFileSync(join(r.stateDir, "scorecard", "accepted.json"), "{ nope");
  const v = r.engine.read(r.scope);
  assert.match(v.problem, /accepted\.json.*not valid JSON/);
  assert.match(r.engine.row(r.worktree).detail, /accepted\.json/);
});

test("scoredAs is per repo (common git dir), not per folder name; a missing slug is refused, null clears", async () => {
  const a = rig(), b = rig();
  // same folder name under different parents
  const mk = (base) => { const w = join(base, "same"); mkdirSync(join(w, ".git"), { recursive: true }); writeFileSync(join(w, ".git", "config"), `[remote "origin"]\n\turl = https://gitlab.com/x/y\n`); return { id: "r", name: "same", worktree: w }; };
  const s1 = mk(tmp()), s2 = mk(tmp());
  const e = createEngine({ stateDir: a.stateDir, fetch: a.fetch, now: () => a.clock.t }, { push() {}, handToAgent: async () => ({ ok: true, intentId: "i", existing: false }) });
  assert.equal(e.scoredAs(s1, "p/q").slug, "p/q");
  assert.equal(e.read(s2).slug, null);
  assert.throws(() => e.scoredAs(s1, undefined), /which repo/);
  assert.equal(e.read(s1).slug, "p/q");
  assert.throws(() => e.scoredAs(s1, "o/.."), /owner\/name/);
  assert.equal(e.scoredAs(s1, null).slug, null);
  assert.ok(b);
});

test("check names that are Object.prototype keys are ordinary names", async () => {
  const body = REPLY([chk("constructor", 2), chk("__proto__", 3), chk("toString", 10)], 5);
  const r = rig({ fetch: fakeFetch({ sc: { status: 200, body } }) });
  const v0 = await r.engine.refresh(r.scope);
  assert.equal(v0.open, 2);
  const v = r.engine.accept(r.scope, "constructor", "ok");
  assert.equal(v.checks.find((c) => c.name === "constructor").accepted.reason, "ok");
  assert.equal(v.checks.find((c) => c.name === "__proto__").accepted, undefined);
  assert.equal(r.engine.accept(r.scope, "__proto__", "ok2").open, 0);
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(join(r.stateDir, "scorecard", "accepted.json"), "utf8")).accepts["o/n"], "__proto__"));
  assert.match(L.remedyPrompt("o/n", { name: "constructor", score: 1, reason: "", details: [], docUrl: null, short: "" }), /constructor/);
  assert.equal(L.builtInAccept("constructor"), undefined);
});

test("reply caps, dot slugs, and a renamed repo", async () => {
  const many = L.parseReply(REPLY(Array.from({ length: 60 }, (_, i) => chk(`C${i}`, 1, { reason: "r".repeat(900) }))));
  assert.equal(many.value.checks.length, 40);
  assert.equal(many.value.checks[0].reason.length, 500);
  assert.equal(L.githubSlug("https://github.com/o/.."), null);
  assert.equal(L.githubSlug("https://github.com/o/."), null);
  const r = rig({ fetch: fakeFetch({ gh: { status: 200, body: { private: false, full_name: "o/renamed" } } }) });
  const v = await r.engine.refresh(r.scope);
  assert.match(v.absent, /moved on GitHub to o\/renamed.*scored as/);
  assert.equal(r.fetch.calls.length, 1);
});
