/**
 * The `limits` fact (backend contract v2, WP5): which provider decides whether a session is
 * blocked by its ACCOUNT, asked in the descriptor's order (`sessions/wall.ts`'s `checkLimit`).
 *
 * Two halves, and the first is the one that must not move:
 *  - claude's `{screen:"limit-ts"}` is today's screen + log reading, verbatim. Its outcomes on
 *    the limit fixtures are pinned here against the parser itself (`detectLimitText` on the same
 *    text): same `blocked`, same `resetAt`, same `weekly`, same events.
 *  - a plugin's `{source:true}` is `sources.usage.wall(s)`: a blocked verdict with a DATED reset
 *    marks the session blocked at that instant and arms the continue ladder (`limitretry.ts`
 *    unchanged); no reset ⇒ NOTHING scheduled, `needsYou` carries its words (review B2), never a
 *    weekly guess; null or a throw is no
 *    answer and the screen is never read for a backend that did not list it. A backend with no
 *    `limits` provider gets NO `limit` field at all (`hasAccountLimit`).
 *
 * Banner phrases are built from halves (CLAUDE.md: never a banner phrase in a string).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WallSlice, hasAccountLimit } = await import("../dist/sessions/wall.js");
const { detectLimitText } = await import("../dist/limit.js");
const { stripAnsi } = await import("../dist/prompt.js");
const { resolveBackend } = await import("../dist/backends/index.js");
const { setLiveSourceLookup } = await import("../dist/livesources.js");
const { LIMIT_RESET_BUFFER_MS } = await import("../dist/sessions/knobs.js");

const root = mkdtempSync(join(tmpdir(), "wp-limitsslot-"));
after(() => { setLiveSourceLookup(null); rmSync(root, { recursive: true, force: true }); });

const H = (a, b) => a + b;
const WALL = H("You've reached your ", "usage limit.");
const STUB = H("You've reached your Fable 5 ", "limit. Run /usage-credits to continue or switch models with /model.");
const WEEKLY = H("You've hit your ", "weekly limit. Resets at 7pm");
const MENU = H("1. Stop and wait for the ", "limit to reset");
const IN2H = H("You've reached your ", "usage limit. Resets in 2 hours");
const WARN = H("Note: approaching your ", "usage limit for this window.");

const CAPS = { turns: true, slash: "none", remoteControl: false, permissionModes: [] };

function harness(backend) {
  const events = [];
  const sessions = new Map();
  const timers = [];
  const base = {
    root, sessions,
    emit: (ev, _id, info, phase) => { events.push(ev === "limit" ? `limit:${phase}` : ev); return true; },
    isResuming: () => false,
    resumeQueue: () => [],
    resumeHoldUntil: () => 0,
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const wall = new WallSlice(core);
  const s = {
    info: { id: "s1", cwd: root, running: true, title: "demo", ...(hasAccountLimit(backend) ? { limit: wall.newLimitState() } : {}) },
    backend, scrollback: "", limitTimer: null, spawnedAt: Date.now(),
  };
  sessions.set("s1", s);
  const done = () => { wall.clearLimitTimer(s); for (const t of timers) clearTimeout(t); };
  after(done);
  return { wall, s, events, done };
}

const outcome = (s, events) => {
  const l = s.info.limit;
  return { blocked: l.blocked, resetAt: l.resetAt, weekly: l.weekly, spend: !!l.spend, armed: l.nextAttemptAt != null, events: [...events] };
};

// ── claude: today's verdicts, byte for byte ───────────────────────────────────
const claude = resolveBackend("claude");

for (const [name, text] of Object.entries({ WALL, STUB, WEEKLY, MENU, IN2H, WARN, plain: "Running tests…\n  42 passed" })) {
  test(`claude limit-ts: ${name} reads exactly as the parser says`, () => {
    const h = harness(claude);
    h.s.scrollback = `some output\r\n${text}\r\n❯ `;
    h.wall.checkLimit(h.s);
    const det = detectLimitText(stripAnsi(h.s.scrollback.slice(-6000)));
    const o = outcome(h.s, h.events);
    assert.equal(o.blocked, det.blocked);
    assert.equal(o.weekly, det.blocked ? det.weekly : false);
    // A weekly screen banner is never dated (`markLimitBlocked`).
    assert.equal(o.resetAt, det.blocked && !det.weekly ? det.resetAt : null);
    assert.deepEqual(o.events, det.blocked ? ["updated", "limit:blocked", "updated", "limit:scheduled"] : []);
    assert.equal(o.armed, det.blocked, "a block arms the continue ladder; nothing else does");
    assert.equal(h.s.info.limit.needsYou, undefined, "claude's walls never carry needsYou");
    h.done();
  });
}

test("claude limit-ts: a block clears only on a turn starting after it, and says resumed", () => {
  const h = harness(claude);
  h.s.scrollback = `${WALL}\r\n❯ `;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, true);
  h.s.scrollback = "x".repeat(7000) + "\r\n❯ ";
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, true, "the banner scrolling off is not evidence");
  h.s.info.turnStartedAt = h.s.info.limit.blockedSince + 1;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, false);
  assert.ok(h.events.includes("limit:resumed"));
  h.done();
});

test("claude: an account limit exists; the accountless claude kinds and a shell have none", () => {
  assert.equal(hasAccountLimit(claude), true);
  assert.equal(hasAccountLimit(resolveBackend("shell")), false);
  for (const id of ["claude-local", "claude-endpoint"]) {
    let b; try { b = resolveBackend(id); } catch { continue; }
    assert.equal(hasAccountLimit(b), false, id);
  }
});

// ── a plugin's {source:true}: sources.usage.wall ──────────────────────────────
function acme({ wall, facts = { turns: [{ source: true }], limits: [{ source: true }] } } = {}) {
  const usage = { source: "acme", label: "Acme", windows: async () => [] };
  if (wall) usage.wall = wall;
  const sources = { usage, attach: async () => ({ close: async () => {}, health: () => ({ state: "up", since: 1 }) }) };
  return { id: "acme", plugin: "acme", label: "Acme", caps: CAPS, facts, sources };
}
const live = (h) => setLiveSourceLookup((id) => (id === h.s.info.id
  ? { session: { id, cwd: root, spawnedAt: h.s.spawnedAt }, sources: h.s.backend.sources, health: () => ({ state: "up", since: 1 }) }
  : null));

test("source wall: blocked with a dated reset ⇒ blocked at that instant, the ladder armed for it", () => {
  const resetAt = Date.now() + 3 * 3_600_000;
  const asked = [];
  const h = harness(acme({ wall: (ss) => { asked.push(ss.id); return { blocked: true, resetAt, why: "quota spent" }; } }));
  live(h);
  assert.ok(h.s.info.limit, "a backend whose wall can answer has a limit state");
  h.wall.checkLimit(h.s);
  assert.deepEqual(asked, ["s1"]);
  const l = h.s.info.limit;
  assert.equal(l.blocked, true);
  assert.equal(l.resetAt, resetAt);
  assert.equal(l.weekly, false);
  assert.ok(l.nextAttemptAt != null && l.nextAttemptAt >= resetAt, "a DATED reset is trusted: the attempt waits for it");
  assert.ok(l.nextAttemptAt <= resetAt + LIMIT_RESET_BUFFER_MS + 1000);
  assert.deepEqual(h.events.slice(0, 2), ["updated", "limit:blocked"]);
  h.done();
});

test("source wall: blocked with no reset ⇒ blocked, undated, and NOTHING scheduled — it needs the person", () => {
  // Review B2: the undated ladder typed `continue`⏎ into Gemini's credit wall at 5 s, 1 m, 5 m…
  // — prompts nobody sent, and the first one after credit landed would have spent it.
  const h = harness(acme({ wall: () => ({ blocked: true, why: "no credit" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  const l = h.s.info.limit;
  assert.equal(l.blocked, true);
  assert.equal(l.resetAt, null);
  assert.equal(l.weekly, false, "a source never arms the weekly special case");
  assert.equal(l.nextAttemptAt, null, "no probe, no ladder");
  assert.equal(h.s.limitTimer, null, "no timer armed");
  assert.equal(l.needsYou, "no credit", "the backend's own words reach the phone");
  assert.deepEqual(h.events, ["updated", "limit:blocked"], "blocked is said; nothing is scheduled");
  // The minute sweep re-asks (`markLimitBlocked`'s `!s.limitTimer` branch), and an attempt the
  // queue bounced passes an `atOverride`: neither arms anything.
  h.wall.checkLimit(h.s);
  h.wall.scheduleLimitAttempt(h.s, Date.now() + 60_000);
  assert.equal(h.s.limitTimer, null);
  assert.equal(l.nextAttemptAt, null);
  h.done();
});

test("source wall: an empty why still reaches the phone as a sentence naming the backend", () => {
  const h = harness(acme({ wall: () => ({ blocked: true, why: "" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  assert.match(h.s.info.limit.needsYou, /^Acme reports this session blocked/);
  assert.equal(h.s.info.limit.nextAttemptAt, null);
  h.done();
});

test("source wall: undated then DATED ⇒ the person's call lifts and the dated attempt is armed", () => {
  let resetAt;
  const h = harness(acme({ wall: () => ({ blocked: true, ...(resetAt ? { resetAt } : {}), why: "q" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.needsYou, "q");
  resetAt = Date.now() + 3_600_000;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.needsYou, undefined);
  assert.ok(h.s.info.limit.nextAttemptAt >= resetAt, "a dated wall keeps today's rule");
  h.done();
});

test("source wall: DATED then undated ⇒ the armed attempt is dropped, nothing re-armed", () => {
  let resetAt = Date.now() + 3_600_000;
  const h = harness(acme({ wall: () => ({ blocked: true, ...(resetAt ? { resetAt } : {}), why: "no credit" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  assert.ok(h.s.limitTimer, "dated: armed");
  resetAt = undefined;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.needsYou, "no credit");
  assert.equal(h.s.limitTimer, null, "the dated timer is gone");
  assert.equal(h.s.info.limit.nextAttemptAt, null);
  h.done();
});

test("source wall: an undated wall that clears drops needsYou with the block", () => {
  let blocked = true;
  const h = harness(acme({ wall: () => (blocked ? { blocked: true, why: "no credit" } : { blocked: false, why: "served" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  blocked = false;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, false);
  assert.equal(h.s.info.limit.needsYou, undefined);
  h.done();
});

test("source wall: the screen is never read for a backend that did not list limit-ts", () => {
  const h = harness(acme({ wall: () => ({ blocked: false, why: "fine" }) }));
  live(h);
  h.s.scrollback = `${WALL}\r\n❯ `;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, false);
  assert.deepEqual(h.events, []);
  h.done();
});

test("source wall: null and a throw are no answer — nothing changes either way", () => {
  for (const wall of [() => null, () => { throw new Error("boom"); }]) {
    const h = harness(acme({ wall }));
    live(h);
    h.s.scrollback = `${WALL}\r\n❯ `;
    h.wall.checkLimit(h.s);
    assert.equal(h.s.info.limit.blocked, false);
    assert.deepEqual(h.events, []);
    h.done();
  }
});

test("source wall: a blocked session the source calls clear is resumed", () => {
  let blocked = true;
  const h = harness(acme({ wall: () => (blocked ? { blocked: true, resetAt: Date.now() + 60_000, why: "q" } : { blocked: false, why: "served" }) }));
  live(h);
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, true);
  blocked = false;
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, false);
  assert.equal(h.s.info.limit.resetAt, null);
  assert.ok(h.events.includes("limit:resumed"));
  h.done();
});

test("source wall: no channel (no live source) ⇒ no answer, nothing marked", () => {
  const h = harness(acme({ wall: () => ({ blocked: true, why: "q" }) }));
  setLiveSourceLookup(null);
  h.wall.checkLimit(h.s);
  assert.equal(h.s.info.limit.blocked, false);
  h.done();
});

test("hasAccountLimit: a {source} limits provider counts only with a wall to ask; absent ⇒ no limit field", () => {
  assert.equal(hasAccountLimit(acme({ wall: () => null })), true);
  assert.equal(hasAccountLimit(acme()), false, "usage without wall: no wall to ask");
  assert.equal(hasAccountLimit(acme({ wall: () => null, facts: { turns: [{ source: true }] } })), false, "wall but limits not listed");
  const h = harness(acme());
  assert.equal(h.s.info.limit, undefined, "absent, never an unblocked limit");
  h.wall.checkLimit(h.s); // must not throw
  h.done();
});
