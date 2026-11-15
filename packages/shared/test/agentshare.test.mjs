/**
 * The setup block (R-metrics-073): `setupShareOf` writes only what the owner allowed out (start-context
 * part medians by group, start tokens, model, CLI, whole days, the repo's
 * name + hash, the chosen name, a probe slot), folds a part key it does not name into `unlisted`;
 * `parseSetupShare` refuses malformed, oversized and tool-named input with a sentence and keeps no
 * extra field; `setupShareCompare` puts two figures side by side and flags a repo half that is NOT
 * identical.
 *
 *     node --test packages/shared/test/agentshare.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  setupShareOf, setupShareText, parseSetupShare, probeDrawKey, setupShareCompare, shareNameProblem, shareSourceText,
  SETUP_SHARE_MAX_CHARS, SHARE_MIN_N,
} from "../dist/index.js";

const NOW = new Date(2026, 10, 14, 12, 0).getTime();
let ids = 0;
const pt = (t0, o = {}) => ({
  id: `secret-session-${ids++}`, t0, repo: "/Users/someone/dev/private-repo", fresh: true, headless: false,
  model: "claude-sonnet-4-5", cli: "2.1.300", req: 10, commit: true, start: 20000, look: 17, skills: 3,
  parts: { projectMd: 1000, userMd: 3000, system: 6000, "mcp__slack_private": 400, "plugin:acme-secret": 200 }, ...o,
});
const points = () => Array.from({ length: 12 }, (_, i) => pt(NOW - (i + 1) * 3_600_000, { req: 10 + i }));
const repo = { name: "waterplane", key: "0123456789abcdef" };
const build = (o = {}) => setupShareOf(points(), { now: NOW, from: "Ana", backend: "claude", repo, ...o });

test("R-metrics-073: the block holds only the allowed fields, and none of the forbidden ones can appear", () => {
  const b = build();
  assert.ok(!("absent" in b), b.absent);
  assert.deepEqual(Object.keys(b), ["kind", "schema", "from", "backend", "models", "cli", "repo", "days", "startTok", "groups"]);
  const text = setupShareText(b);
  // No paths, session ids, plugin/connector names, behaviour readings, counts or times finer than a day.
  for (const bad of ["/Users", "private-repo", "secret-session", "slack", "acme", "plugin", "mcp__", "look", "skills", "req", "commit", "\"n\"", "sessions", "markers", "T12:", "t0"]) {
    assert.ok(!text.includes(bad), `"${bad}" must not leave: ${text}`);
  }
  assert.deepEqual(b.days, { from: "2026-10-31", to: "2026-11-14" });
  assert.deepEqual(b.models, ["claude-sonnet-4-5"]);
  assert.deepEqual(b.cli, ["2.1.300"]);
  assert.equal(b.startTok, 20000);
  // No setup cost: cost tokens ÷ start tokens would be requests per session, a behaviour reading (owner, 2026-11-14).
  assert.ok(!("cost" in b) && !/usd|cost/.test(text));
});

test("R-metrics-073: a part key this version does not name collapses into its group's unlisted part", () => {
  const b = build();
  const mixed = b.groups.find((g) => g.group === "mixed");
  assert.deepEqual(mixed, { group: "mixed", chars: 600, parts: { unlisted: 600 } });
  assert.deepEqual(b.groups.map((g) => g.group), ["repo", "yours", "cli", "mixed"]);
  assert.deepEqual(b.groups.find((g) => g.group === "yours").parts, { userMd: 3000 });
});

test("R-metrics-073: a figure under the minimum is left out, never counted; too few sessions is absent", () => {
  const ps = points();
  ps[0].parts = { ...ps[0].parts, memory: 900 }; // one session only measured memory
  const b = setupShareOf(ps, { now: NOW, from: "Ana", backend: "claude", repo });
  assert.equal(b.groups.find((g) => g.group === "yours").parts.memory, undefined);
  const few = setupShareOf(points().slice(0, SHARE_MIN_N - 1), { now: NOW, from: "Ana", backend: "claude", repo });
  assert.match(few.absent, /at least 5/);
  assert.match(setupShareOf(points(), { now: NOW, from: "  ", backend: "claude" }).absent, /name/);
});

test("R-metrics-073: export → text → import round-trips exactly", () => {
  const b = build();
  const p = parseSetupShare(setupShareText(b));
  assert.ok(p.ok, p.why);
  assert.equal(setupShareText(p.block), setupShareText(b));
  assert.deepEqual(p.dropped, []);
});

test("R-metrics-073: import keeps no extra field, and says which it dropped", () => {
  const b = { ...build(), markers: [{ detail: "CLAUDE.md, skills/foo" }], sessions: 42, prompt: "secret" };
  const p = parseSetupShare(JSON.stringify(b));
  assert.ok(p.ok, p.why);
  assert.deepEqual(p.dropped, ["markers", "sessions", "prompt"]);
  assert.ok(!JSON.stringify(p.block).match(/markers|sessions|secret/));
  // Nested extras go too.
  const nested = parseSetupShare(JSON.stringify({ ...build(), repo: { ...repo, path: "/Users/x" } }));
  assert.ok(nested.ok);
  assert.ok(!JSON.stringify(nested.block).includes("/Users"));
});

test("R-metrics-073: a P5 block's setup cost figure is dropped on import and counted, never kept (a behaviour reading)", () => {
  const p = parseSetupShare(JSON.stringify({ ...build(), cost: { tok: 123400, usd: 0.37 } }));
  assert.ok(p.ok, p.why);
  assert.deepEqual(p.dropped, ["cost"]);
  assert.ok(!("cost" in p.block) && !setupShareText(p.block).includes("cost"));
  // Even a malformed one cannot refuse the block: it is simply not read.
  const bad = parseSetupShare(JSON.stringify({ ...build(), cost: { tok: "lots" } }));
  assert.ok(bad.ok && bad.dropped.includes("cost"));
});

test("R-metrics-073: malicious, oversized and malformed input is refused with a sentence", () => {
  const good = build();
  const cases = [
    ["", /Nothing to read/],
    ["x".repeat(SETUP_SHARE_MAX_CHARS + 1), /at most/],
    ["{not json", /JSON/],
    ["[1,2]", /one JSON object/],
    [JSON.stringify({ ...good, kind: "other" }), /kind/],
    [JSON.stringify({ ...good, schema: 9 }), /newer version/],
    [JSON.stringify({ ...good, from: "<script>alert(1)</script>" }), /name/],
    [JSON.stringify({ ...good, from: "a".repeat(41) }), /name/],
    [JSON.stringify({ ...good, models: ["x".repeat(200)] }), /model/],
    [JSON.stringify({ ...good, cli: ["../../etc"] }), /CLI/],
    [JSON.stringify({ ...good, repo: { name: "w", key: "nothex" } }), /repo/],
    [JSON.stringify({ ...good, days: { from: "2026-11-14T12:00", to: "2026-11-14" } }), /date range/],
    [JSON.stringify({ ...good, days: { from: "2026-11-15", to: "2026-11-14" } }), /date range/],
    [JSON.stringify({ ...good, startTok: -1 }), /start tokens/],
    [JSON.stringify({ ...good, startTok: 1e300 }), /start tokens/],
    [JSON.stringify({ ...good, groups: [{ group: "admin", chars: 1, parts: {} }] }), /group/],
    [JSON.stringify({ ...good, groups: [{ group: "repo", chars: 1, parts: { mcp__slack: 1 } }] }), /named like a tool/],
    [JSON.stringify({ ...good, groups: [{ group: "repo", chars: 1, parts: { "skills/foo.md": 1 } }] }), /named like a tool/],
    [JSON.stringify({ ...good, groups: [{ group: "yours", chars: 1, parts: { projectMd: 1 } }] }), /different group/],
    [JSON.stringify({ ...good, groups: [{ group: "repo", chars: 1, parts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 1])) }] }), /short list/],
    [JSON.stringify({ ...good, probe: { day: "x" } }), /probe/],
    [`{"__proto__":{"polluted":1},"kind":"agent-setup-block"}`, /format/],
  ];
  for (const [text, why] of cases) {
    const p = parseSetupShare(text);
    assert.equal(p.ok, false, `refused: ${text.slice(0, 80)}`);
    assert.match(p.why, why);
    assert.ok(p.why.endsWith(".") && p.why.length < 220, p.why);
  }
  assert.equal({}.polluted, undefined);
});

test("R-metrics-073: the probe slot is typed and validated", () => {
  const b = build({ probe: { day: "2026-11-13", kind: "models", correct: 0.9, tokPerQuestion: 31234.6, repeats: 3, extra: "x" } });
  assert.deepEqual(b.probe, { day: "2026-11-13", kind: "models", correct: 0.9, tokPerQuestion: 31235, repeats: 3 });
  assert.ok(parseSetupShare(setupShareText(b)).ok);
});

test("R-metrics-073: the probe slot carries its model, how many questions and a fingerprint of which; older blocks without them still parse", () => {
  const withIds = build({ probe: { day: "2026-11-13", kind: "baseline", correct: 0.9, tokPerQuestion: 31000, repeats: 3, model: "haiku", questions: 20, draw: probeDrawKey(["b", "a"]) } });
  assert.equal(withIds.probe.model, "haiku");
  assert.equal(withIds.probe.questions, 20);
  assert.equal(probeDrawKey(["b", "a", "a"]), probeDrawKey(["a", "b"]));
  assert.notEqual(probeDrawKey(["a", "b"]), probeDrawKey(["a", "c"]));
  assert.deepEqual(parseSetupShare(setupShareText(withIds)).block.probe, withIds.probe);
  const good = JSON.parse(setupShareText(withIds));
  for (const bad of [{ model: "a b" }, { questions: 0 }, { questions: 1.5 }, { draw: "xyz" }]) {
    assert.equal(parseSetupShare(JSON.stringify({ ...good, probe: { ...good.probe, ...bad } })).ok, false, JSON.stringify(bad));
  }
  // The question ids themselves never travel.
  assert.doesNotMatch(setupShareText(withIds), /"a"|"b"/);
});

test("R-metrics-073: side by side flags a repo half that is not identical, and another repo", () => {
  const mine = build();
  const same = setupShareCompare(mine, { ...mine, from: "Ben" });
  assert.equal(same.repoHalf, "identical");
  const g = same.groups.find((x) => x.group === "yours");
  assert.deepEqual([g.mine, g.theirs], [3000, 3000]);
  const changed = { ...mine, groups: mine.groups.map((x) => (x.group === "repo" ? { ...x, chars: 4000, parts: { projectMd: 4000 } } : x)) };
  assert.equal(setupShareCompare(mine, changed).repoHalf, "differs");
  assert.equal(setupShareCompare(mine, { ...mine, repo: { name: "other", key: "fedcba9876543210" } }).repoHalf, "otherRepo");
  const { repo: _r, ...noRepo } = mine;
  assert.equal(setupShareCompare(mine, noRepo).repoHalf, "unknownRepo");
});

test("R-metrics-069: the imported block names whose desktop it came from", () => {
  const t = shareSourceText("Ben", { from: "2026-10-31", to: "2026-11-14" });
  assert.match(t, /^From Ben's desktop only/);
  assert.match(t, /not built from git/);
  assert.equal(shareNameProblem(""), "Type the name the others will see beside your figures.");
  assert.equal(shareNameProblem("Ana"), null);
});
