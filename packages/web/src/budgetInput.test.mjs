/**
 * What a typed session budget means (`budgetInput.ts`).
 *
 *     node --test packages/web/src/budgetInput.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BUDGET_UNITS, budgetPreview, budgetSpentLine, budgetStateLine, budgetText, calibrationWords, parseBudgetInput, presetLabel } from "./budgetInput.ts";

const ok = (unit, text) => { const r = parseBudgetInput(unit, text); assert.equal(r.ok, true, `${unit} ${text}: ${r.reason}`); return r.max; };
const no = (unit, text) => { const r = parseBudgetInput(unit, text); assert.equal(r.ok, false, `${unit} ${text}`); return r.reason; };

test("tokens take plain numbers and k/m/b suffixes", () => {
  assert.equal(ok("tok", "500000"), 500000);
  assert.equal(ok("tok", "500k"), 500000);
  assert.equal(ok("tok", " 1.5M "), 1500000);
  assert.equal(ok("tok", "2,000,000"), 2000000);
  assert.equal(ok("tok", "1_000"), 1000);
});

test("dollars take a $ and a decimal comma", () => {
  assert.equal(ok("usd", "$2"), 2);
  assert.equal(ok("usd", "0.50"), 0.5);
  assert.equal(ok("usd", "2,50"), 2.5);
  assert.equal(ok("usd", "1,000"), 1000);
});

test("a percent takes an optional % and refuses past 100", () => {
  assert.equal(ok("sessionPct", "2%"), 2);
  assert.equal(ok("weeklyPct", "0.5"), 0.5);
  assert.equal(ok("weeklyPct", "100"), 100);
  assert.match(no("weeklyPct", "101"), /more than 100/);
});

test("a refusal is a sentence: blank, not a number, zero, negative", () => {
  assert.equal(no("usd", ""), "type a number");
  assert.match(no("usd", "two"), /not a number/);
  assert.match(no("tok", "lots"), /try 500k or 2m/);
  assert.match(no("usd", "0"), /more than zero/);
  assert.match(no("usd", "-3"), /not a number/);
  // The suffix means nothing on a dollar field — refused, never guessed at.
  assert.match(no("usd", "5k"), /not a number/);
});

test("the field text round-trips a cap the person typed", () => {
  for (const [unit, text] of [["tok", "500k"], ["tok", "2m"], ["usd", "2.5"], ["sessionPct", "0.5"]]) {
    const max = ok(unit, text);
    assert.equal(ok(unit, budgetText({ unit, max, interrupt: true })), max);
  }
});

test("four units, dollars first — the default, and the one a person reasons in", () => {
  assert.deepEqual(BUDGET_UNITS.map((u) => u.unit), ["usd", "tok", "sessionPct", "weeklyPct"]);
});

test("every quick pick parses in its own unit, and its chip says the unit", () => {
  for (const u of BUDGET_UNITS) {
    assert.ok(u.presets.length >= 3, u.unit);
    for (const p of u.presets) ok(u.unit, p);
  }
  assert.equal(presetLabel("usd", "2"), "$2");
  assert.equal(presetLabel("tok", "1m"), "1m");
  assert.equal(presetLabel("weeklyPct", "10"), "10%");
});

const spark = { usageTok: 1_200_000, agentTok: 300_000, costUsd: 0.48, agentCostUsd: 0.12 };
const NOW = 10_000_000;
const cal = { checkedAt: NOW - 60_000, sessionUsdPerPct: 0.1, weeklyUsdPerPct: null };

test("spent so far: never a total without its subagent split", () => {
  assert.equal(budgetSpentLine("usd", spark, null, NOW), "$0.48 so far — $0.36 in this conversation, $0.12 in subagents");
  assert.equal(budgetSpentLine("tok", spark, null, NOW), "1.2M tokens so far — 900k tokens in this conversation, 300k tokens in subagents");
  assert.match(budgetSpentLine("usd", { ...spark, agentCostUsd: 0 }, null, NOW), /none of it in subagents/);
  assert.match(budgetSpentLine("usd", { ...spark, agentCostUsd: undefined }, null, NOW), /subagent share is not logged/);
  assert.match(budgetSpentLine("sessionPct", spark, cal, NOW), /^≈4\.8% of the 5-hour window so far — ≈3\.6% .*≈1\.2% in subagents$/);
  // No session (a launch): nothing to orient by, so nothing is said.
  assert.equal(budgetSpentLine("usd", undefined, undefined, NOW), null);
});

test("a percent that cannot be converted still says the dollars", () => {
  // No budget yet: the host sent no calibration because it sends one only with a budget.
  assert.match(budgetSpentLine("weeklyPct", spark, undefined, NOW), /^in dollars, \$0\.48 so far — .*\$0\.12 in subagents$/);
  // A budget, but the week cannot be converted: shared's sentence, then the dollars.
  const w = budgetSpentLine("weeklyPct", spark, cal, NOW);
  assert.match(w, /nothing is held\. In dollars: \$0\.48 so far/);
  assert.match(budgetSpentLine("usd", { ...spark, costUsd: undefined }, null, NOW), /no list price/);
});

test("the preview puts the typed cap against the spend", () => {
  assert.equal(budgetPreview({ unit: "usd", max: 2 }, spark, null, NOW), "$0.48 of $2.00 — 24% used");
  assert.equal(budgetPreview({ unit: "tok", max: 3e6 }, spark, null, NOW), "1.2M of 3M — 40% used");
  assert.equal(budgetPreview({ unit: "sessionPct", max: 10 }, spark, cal, NOW), "≈4.8% of 10% — 48% used");
  assert.match(budgetPreview({ unit: "usd", max: 0.4 }, spark, null, NOW), /already past it: .* held as soon as it is set/);
  assert.equal(budgetPreview({ unit: "usd", max: 1000 }, spark, null, NOW), "$0.48 of $1,000 — under 1% used");
  // Unknown spend or no session: no preview (the spent line says why).
  assert.equal(budgetPreview({ unit: "weeklyPct", max: 5 }, spark, cal, NOW), null);
  assert.equal(budgetPreview({ unit: "usd", max: 2 }, null, null, NOW), null);
});

test("no budget, but a spark: the state line says what was spent, split", () => {
  assert.equal(budgetStateLine(undefined, NOW), "No budget on this session.");
  // With a spark the caller is the context card, whose TITLE says "no budget on
  // this session": the line is the spend alone, never that sentence a second time.
  assert.equal(budgetStateLine(undefined, NOW, spark), "Spent: $0.48 so far — $0.36 in this conversation, $0.12 in subagents.");
  assert.match(budgetStateLine(undefined, NOW, { ...spark, costUsd: undefined }), /^Spent: 1\.2M tokens so far/);
  // Nothing known: no line at all — the card is its title and its door.
  assert.equal(budgetStateLine(undefined, NOW, null), null);
});

test("calibration: dollars and tokens need none; a percent says what one point costs or why it cannot", () => {
  const now = 10_000_000;
  assert.equal(calibrationWords("usd", null, now), null);
  assert.equal(calibrationWords("tok", null, now), null);
  assert.match(calibrationWords("sessionPct", null, now), /no usage reading/);
  const cal = { checkedAt: now - 5 * 60_000, sessionUsdPerPct: 0.5, weeklyUsdPerPct: null };
  assert.match(calibrationWords("sessionPct", cal, now), /^1% of the 5-hour window ≈ \$0\.50 .* 5 min ago/);
  // The direction of the error is said where the rate is: other use of the account reads high.
  assert.match(calibrationWords("sessionPct", cal, now), /other use of the account makes it read high\)$/);
  assert.match(calibrationWords("weeklyPct", cal, now), /has not run enough/);
  assert.match(calibrationWords("sessionPct", { ...cal, checkedAt: now - 40 * 60_000 }, now), /40 min old/);
  // Every unknown ends on what it means for the person.
  for (const w of [calibrationWords("weeklyPct", cal, now), calibrationWords("sessionPct", null, now)]) assert.match(w, /nothing is held/);
});

// ── P2: a session judged from its backend's own source ───────────────────────
import { budgetUnitsFor } from "./budgetInput.ts";
import { sourceSpendSpark } from "@waterplane/shared";

test("budgetUnitsFor: no percent where the backend spends from no claude window — except a cap already set in one", () => {
  assert.deepEqual(budgetUnitsFor(false).map((u) => u.unit), ["usd", "tok", "sessionPct", "weeklyPct"]);
  assert.deepEqual(budgetUnitsFor(true).map((u) => u.unit), ["usd", "tok"]);
  assert.deepEqual(budgetUnitsFor(true, "weeklyPct").map((u) => u.unit), ["usd", "tok", "weeklyPct"], "never silently swapped");
});

test("the spent line off a source: its own figures and split, and a sentence where it stated none", () => {
  const spark = sourceSpendSpark({ at: 1, tok: 1000, agentTok: 400 });
  assert.match(budgetSpentLine("tok", spark, undefined, 0), /^1\.4k tokens so far — 1k tokens in this conversation, 400 tokens in subagents$/);
  assert.match(budgetSpentLine("usd", spark, undefined, 0), /has not stated what it spent in dollars — nothing is held/);
  assert.match(budgetSpentLine("weeklyPct", spark, undefined, 0), /claude's account/);
  assert.match(budgetSpentLine("tok", sourceSpendSpark({ at: 1, tok: 10 }), undefined, 0), /not stated by this session's backend/);
});

import { budgetUnitsFor as _bu, launchSpendUnit as _lsu, parseBudgetInput as _pbi, budgetText as _bt, budgetPreview as _bp } from "./budgetInput.ts";

test("native unit: offered only with a spendUnit or a kept native cap", () => {
  assert.ok(!_bu(false).some((u) => u.unit === "native"));
  assert.ok(!_bu(true, "usd").some((u) => u.unit === "native"));
  const n = _bu(true, "usd", "AI credits").find((u) => u.unit === "native");
  assert.equal(n.label, "AI credits");
  assert.ok(_bu(true, "native").some((u) => u.unit === "native"), "a kept native cap is never swapped");
  assert.deepEqual(_lsu([{ id: "copilot", caps: { spendUnit: " AI credits " } }], "copilot"), "AI credits");
  assert.equal(_lsu([{ id: "claude", caps: {} }], "claude"), undefined);
  assert.equal(_lsu(null, "x"), undefined);
});

test("native unit: plain positive number, round-trips with nativeUnit", () => {
  assert.deepEqual(_pbi("native", "12.5"), { ok: true, max: 12.5 });
  assert.equal(_pbi("native", "$5").ok, false);
  assert.equal(_pbi("native", "500k").ok, false, "no k/m suffix on a native unit");
  assert.equal(_pbi("native", "0").ok, false);
  const cfg = { unit: "native", max: 1500, interrupt: true, nativeUnit: "AI credits" };
  assert.equal(_bt(cfg), "1500");
  assert.match(_bp(cfg, { native: { amount: 300, unit: "AI credits" } }, null, 0) ?? "", /300 of 1\.5k — 20% used/);
});

import { budgetAcrossBackend } from "./budgetInput.ts";

test("a cap crossing a backend switch: kept where the new backend counts its unit, else cleared NAMING the old value (bughunt 2026-10-29 C2-2)", () => {
  // No backend declares caps.spendUnit yet — a fake list does, so the latent path runs.
  const bs = [
    { id: "claude", label: "Claude Code", caps: { slash: true, promptBoxes: true, hooks: true, transcript: true } },
    { id: "copilot", label: "Copilot", caps: { spendUnit: "AI credits" } },
    { id: "other", label: "Other", caps: { spendUnit: "requests" } },
  ];
  const nat = { unit: "native", max: 20, interrupt: true, nativeUnit: "AI credits" };
  // Same unit on the new backend: kept, said nothing.
  assert.deepEqual(budgetAcrossBackend(nat, bs, "copilot"), { budget: nat, cleared: null });
  // A backend with no native unit, and one with ANOTHER: cleared, never re-united.
  for (const to of ["claude", "other"]) {
    const r = budgetAcrossBackend(nat, bs, to);
    assert.equal(r.budget, null, to);
    assert.match(r.cleared, /20 AI credits/, "the sentence names the typed value");
    assert.match(r.cleared, to === "claude" ? /Claude Code/ : /Other/);
  }
  // A percent cap onto a backend that spends from no claude window: same rule.
  const pct = { unit: "weeklyPct", max: 10, interrupt: true };
  assert.equal(budgetAcrossBackend(pct, bs, "copilot").budget, null);
  assert.match(budgetAcrossBackend(pct, bs, "copilot").cleared, /10% of this week/);
  assert.deepEqual(budgetAcrossBackend(pct, bs, "claude"), { budget: pct, cleared: null });
  // Dollars and tokens mean the same on every backend; no cap is nothing to say.
  const usd = { unit: "usd", max: 2, interrupt: true };
  assert.deepEqual(budgetAcrossBackend(usd, bs, "other"), { budget: usd, cleared: null });
  assert.deepEqual(budgetAcrossBackend(null, bs, "other"), { budget: null, cleared: null });
  // A host that listed no backends: nothing is known to differ, so nothing is cleared.
  assert.deepEqual(budgetAcrossBackend(usd, null, undefined), { budget: usd, cleared: null });
});

import { capOnStart, sendBackend } from "./budgetInput.ts";
import { withLaunch } from "./sendIntent/sendLaunch.ts";

// The two backends every cap-transition test below runs over.
const BS = [
  { id: "claude", label: "Claude Code", caps: { slash: true, promptBoxes: true, hooks: true, transcript: true } },
  { id: "copilot", label: "Copilot", caps: { spendUnit: "AI credits" } },
];
const NAT = { unit: "native", max: 20, interrupt: true, nativeUnit: "AI credits" };
const NOW_COP = { now: true, defaults: { backend: "copilot" } };
const LATER = { now: false, defaults: { backend: "copilot" } };
// The model row's write, as ToSection makes it: the launch, then the one transition.
const pickLaunch = (t, l, kept, at) => capOnStart(t, withLaunch(t, l), kept, BS, at, at);
// A When / defaults move, as ToSection's effect makes it.
const move = (t, kept, from, to) => capOnStart(t, t, kept, BS, from, to);

test("the Send sheet's model row: a backend change carries the cap by the same rule, and only a CHANGE does", () => {
  const t = { kind: "repo", cwd: "/r", budget: NAT, launch: { backend: "copilot" } };
  // Same backend, another model: nothing to decide.
  assert.deepEqual(pickLaunch(t, { backend: "copilot", model: "x" }, null, { now: true }), { target: { ...t, launch: { backend: "copilot", model: "x" } }, kept: null });
  // To claude: the cap leaves the target, is KEPT, and the sentence names it and the way back.
  const r = pickLaunch(t, { backend: "claude" }, null, { now: true });
  assert.deepEqual(r.target, { kind: "repo", cwd: "/r", launch: { backend: "claude" } });
  assert.deepEqual(r.kept.budget, NAT);
  assert.match(r.kept.said, /20 AI credits/);
  assert.match(r.kept.said, /set aside/);
  assert.match(r.kept.said, /comes back if you switch back/);
  // A dollar cap rides every switch.
  const usd = { ...t, budget: { unit: "usd", max: 2, interrupt: true } };
  assert.equal(pickLaunch(usd, { backend: "claude" }, null, { now: true }).target.budget.max, 2);
});

test("a navigation tap never deletes a typed cap: now → at a time → now brings it back (review r4-2 M1)", () => {
  const bare = { kind: "repo", cwd: "/r", budget: NAT };
  const out = move(bare, null, NOW_COP, LATER);
  assert.equal(out.target.budget, undefined, "a later run is not judged on the phone's copilot default");
  assert.deepEqual(out.kept.budget, NAT);
  const back = move(out.target, out.kept, LATER, NOW_COP);
  assert.deepEqual(back, { target: bare, kept: null }, "the cap is back on the target and the sentence is gone");
});

test("the model row: copilot → claude → copilot brings the typed cap back (review r4-2 M1)", () => {
  const t = { kind: "repo", cwd: "/r", budget: NAT, launch: { backend: "copilot" } };
  const away = pickLaunch(t, { backend: "claude" }, null, { now: true });
  assert.equal(away.target.budget, undefined);
  const home = pickLaunch(away.target, { backend: "copilot" }, away.kept, { now: true });
  assert.deepEqual(home, { target: t, kept: null });
  // A percent cap typed for a claude start comes back the same way after a copilot detour.
  const pct = { kind: "repo", cwd: "/r", budget: { unit: "sessionPct", max: 10, interrupt: true }, launch: { backend: "claude" } };
  const p1 = pickLaunch(pct, { backend: "copilot" }, null, { now: true });
  assert.match(p1.kept.said, /Copilot does not spend from claude's usage windows/);
  assert.deepEqual(pickLaunch(p1.target, { backend: "claude" }, p1.kept, { now: true }), { target: pct, kept: null });
});

test("a cap typed while one is set aside replaces it: the kept one never comes back over it (review r4-2 M1)", () => {
  const t = { kind: "repo", cwd: "/r", budget: NAT, launch: { backend: "copilot" } };
  const away = pickLaunch(t, { backend: "claude" }, null, { now: true });
  const usd = { unit: "usd", max: 3, interrupt: true };
  const typed = { ...away.target, budget: usd };
  const home = pickLaunch(typed, { backend: "copilot" }, away.kept, { now: true });
  assert.deepEqual(home.target.budget, usd);
  assert.equal(home.kept, null, "the newer words win and the kept cap is dropped");
  // …and dropped even when nothing about the start changed.
  assert.equal(pickLaunch(typed, { backend: "claude", model: "x" }, away.kept, { now: true }).kept, null);
});

test("a synced default backend arriving from another device sets the cap aside, and its return restores it (review r4-2 L1)", () => {
  const bare = { kind: "repo", cwd: "/r", budget: NAT };
  const nowClaude = { now: true, defaults: { backend: "claude" } };
  const away = move(bare, null, NOW_COP, nowClaude);
  assert.equal(away.target.budget, undefined);
  assert.match(away.kept.said, /Claude Code does not count AI credits/);
  // A second move to another start that cannot carry it keeps it, its sentence naming the start it is under now.
  const later = move(away.target, away.kept, nowClaude, LATER);
  assert.deepEqual(later.kept.budget, NAT);
  assert.match(later.kept.said, /desktop's own defaults/);
  assert.deepEqual(move(later.target, later.kept, LATER, NOW_COP), { target: bare, kept: null });
});

test("no backend change decides nothing; a session target leaves the kept cap alone (design round 4)", () => {
  const kept = { budget: NAT, said: "x" };
  const bare = { kind: "repo", cwd: "/r" };
  assert.deepEqual(move(bare, kept, NOW_COP, NOW_COP), { target: bare, kept });
  // A picked launch is the same backend whenever it runs.
  const picked = { kind: "repo", cwd: "/r", budget: NAT, launch: { backend: "copilot" } };
  assert.deepEqual(move(picked, null, NOW_COP, LATER), { target: picked, kept: null });
  const sess = { kind: "session", sessionId: "s" };
  assert.deepEqual(move(sess, kept, NOW_COP, LATER), { target: sess, kept });
  // A host that listed no backends knows of no difference: the cap stays.
  const t = { kind: "repo", cwd: "/r", budget: NAT };
  assert.deepEqual(capOnStart(t, t, null, null, NOW_COP, LATER), { target: t, kept: null });
});

test("\"use the defaults\" is judged by the backend the send will REALLY start on (review r3-1, C2-2)", () => {
  const bs = [
    { id: "claude", label: "Claude Code", caps: { slash: true, promptBoxes: true, hooks: true, transcript: true } },
    { id: "copilot", label: "Copilot", caps: { spendUnit: "AI credits" } },
  ];
  const nat = { unit: "native", max: 20, interrupt: true, nativeUnit: "AI credits" };
  const pick = (x, l, at) => capOnStart(x, withLaunch(x, l), null, bs, at, at);
  const t = { kind: "repo", cwd: "/r", budget: nat, launch: { backend: "copilot" } };
  const now = (backend) => ({ now: true, defaults: { backend } });
  // Where a send starts: the picked launch; else a now-send's phone defaults; else the desktop's (unknown: null).
  assert.equal(sendBackend(t, now("claude")), "copilot");
  assert.equal(sendBackend({ kind: "repo", cwd: "/r" }, now("copilot")), "copilot");
  assert.equal(sendBackend({ kind: "repo", cwd: "/r" }, { now: true }), undefined);
  assert.equal(sendBackend({ kind: "repo", cwd: "/r" }, { now: false, defaults: { backend: "copilot" } }), null);
  // Defaults ARE copilot: back to them changes no backend, so the typed cap stays.
  assert.deepEqual(pick(t, null, now("copilot")), { target: { kind: "repo", cwd: "/r", budget: nat }, kept: null });
  // Defaults are claude: a real change, and the sentence names Claude Code, never "this backend".
  const c = pick(t, null, now(undefined));
  assert.equal(c.target.budget, undefined);
  assert.match(c.kept.said, /Claude Code does not count AI credits/);
  // A later run with nothing picked opens on the DESKTOP's defaults: the sentence says that is the cause.
  const l = pick(t, null, { now: false, defaults: { backend: "copilot" } });
  assert.equal(l.target.budget, undefined);
  assert.match(l.kept.said, /desktop's own defaults/);
  assert.doesNotMatch(l.kept.said, /this backend/);
  // Picking the backend the defaults already name is no change either.
  const bare = { kind: "repo", cwd: "/r", budget: nat };
  assert.equal(pick(bare, { backend: "copilot" }, now("copilot")).kept, null);
});

test("a cleared cap names the backend it went to, claude included when no id is given (review r3-1)", () => {
  const bs = [
    { id: "claude", label: "Claude Code", caps: { slash: true, promptBoxes: true, hooks: true, transcript: true } },
    { id: "copilot", label: "Copilot", caps: { spendUnit: "AI credits" } },
  ];
  const nat = { unit: "native", max: 20, interrupt: true, nativeUnit: "AI credits" };
  assert.match(budgetAcrossBackend(nat, bs, undefined).cleared, /Claude Code does not count AI credits/);
});

import { readFileSync } from "node:fs";

test("ToSection's two start inputs (model row, When/defaults) both go through capOnStart, from the queued target", () => {
  // Wiring only — the behaviour is the capOnStart tests above.
  const src = readFileSync(new URL("./send/ToSection.tsx", import.meta.url), "utf8");
  assert.equal((src.match(/capOnStart\(t,/g) ?? []).length, 2, "one call per input of sendBackend, both from the updater's queued target");
});

import * as budgetInput from "./budgetInput.ts";

// The launch ask holds a backend and a cap, not a SendTarget: `capOnBackend` is `capOnStart` in its shapes.
const askPick = (cap, kept, from, to) => budgetInput.capOnBackend(cap, kept, BS, from, to);

test("the launch ask: copilot → claude → copilot brings the typed cap back (design round 4)", () => {
  const away = askPick(NAT, null, "copilot", "claude");
  assert.equal(away.budget, null, "claude cannot carry an AI-credit cap");
  assert.deepEqual(away.kept.budget, NAT, "set aside, never deleted");
  assert.match(away.kept.said, /20 AI credits is set aside: Claude Code does not count AI credits/);
  assert.deepEqual(askPick(away.budget, away.kept, "claude", "copilot"), { budget: NAT, kept: null });
  // An absent backend id is claude, as everywhere: the same round trip.
  const absent = askPick(NAT, null, "copilot", undefined);
  assert.deepEqual(absent.kept.budget, NAT);
  assert.deepEqual(askPick(absent.budget, absent.kept, undefined, "copilot"), { budget: NAT, kept: null });
  // A cap that rides, and a pick that changes no backend, decide nothing.
  const usd = { unit: "usd", max: 2, interrupt: true };
  assert.deepEqual(askPick(usd, null, "copilot", "claude"), { budget: usd, kept: null });
  assert.deepEqual(askPick(NAT, null, "copilot", "copilot"), { budget: NAT, kept: null });
});

test("the launch ask: a cap typed while one is set aside replaces it (design round 4)", () => {
  const away = askPick(NAT, null, "copilot", "claude");
  const usd = { unit: "usd", max: 3, interrupt: true };
  assert.deepEqual(askPick(usd, away.kept, "claude", "copilot"), { budget: usd, kept: null });
});

test("the launch ask: the caller's cap arriving on a start it cannot ride is set aside too, and comes back (design round 4)", () => {
  // `from` null: the backend the caller chose the cap for is not known here.
  const arrive = askPick(NAT, null, null, "claude");
  assert.equal(arrive.budget, null);
  assert.deepEqual(arrive.kept.budget, NAT);
  assert.deepEqual(askPick(arrive.budget, arrive.kept, "claude", "copilot"), { budget: NAT, kept: null });
  assert.deepEqual(askPick(NAT, null, null, "copilot"), { budget: NAT, kept: null });
  assert.deepEqual(askPick(null, null, null, "claude"), { budget: null, kept: null });
});

test("LaunchAskSheet crosses its cap only through capOnBackend — no one-way clear (design round 4)", () => {
  const src = readFileSync(new URL("./LaunchAskSheet.tsx", import.meta.url), "utf8");
  assert.ok(!src.includes("budgetAcrossBackend"), "the one-way clear is gone from the launch ask");
  assert.equal((src.match(/capOnBackend\(/g) ?? []).length, 2, "the arriving cap and the picker");
});

/**
 * Review r4-2b M1: "typed since the cap was set aside" was inferred from a non-null PARSED value
 * (`if (b) setKept(null)`), but BudgetField reports null for text that does not parse yet ("150"
 * in %) and for a unit change on an empty box. The kept cap then came back on the next backend
 * move and the field's remount wrote over the half-typed words. The signal is now the field's
 * own `onEdit` — any keystroke, unit, preset or mode change — and the rule is one function.
 */
test("any edit of the budget field discards a set-aside cap, parsed or not (design round 4, r4-2b M1)", () => {
  const away = askPick(NAT, null, "copilot", "claude");
  assert.ok(away.kept, "set aside first");
  // The field reported null (the text does not parse), but the person DID edit: kept goes.
  assert.equal(budgetInput.keptOnEdit(away.kept), null);
  // …so a move back to copilot restores nothing over their words.
  assert.deepEqual(askPick(null, budgetInput.keptOnEdit(away.kept), "claude", "copilot"), { budget: null, kept: null });
  assert.equal(budgetInput.keptOnEdit(null), null);
});

test("both sheets discard kept on the field's onEdit, never by inferring it from a parsed cap (r4-2b M1)", () => {
  const field = readFileSync(new URL("./BudgetField.tsx", import.meta.url), "utf8");
  assert.match(field, /onEdit\?: \(\) => void/, "BudgetField says when the person edited it");
  // `emit` runs only from the person's own handlers (text, unit, preset, mode, switch), so it is
  // where the edit is reported — BEFORE the parse, which is the half that can come back null.
  assert.match(field, /const emit = \([^)]*\) => \{\s*onEdit\?\.\(\);/, "emit reports the edit first, parsed or not");
  for (const f of ["./send/ToSection.tsx", "./LaunchAskSheet.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /if \(b\) setKept/, `${f}: "typed since" is not inferred from a parsed cap`);
    assert.match(src, /onEdit=\{[^}]*keptOnEdit/, `${f}: the field's onEdit discards kept by the one rule`);
  }
});

/**
 * Review r4-2b M2: `kept` was ToSection state, and the decision the Send sheet reports for the
 * annotator round trip (`onDecide` → `resume`) carried only target/when/sequential/parkedAt. Set a
 * copilot cap aside with *at a time*, attach a picture, come back: kept was gone, and *now* no
 * longer brought the cap back — after the sentence said "It comes back if you switch back".
 */
test("a set-aside cap survives the annotator round trip, and is never sent (r4-2b M2)", () => {
  const away = askPick(NAT, null, "copilot", "claude");
  const reported = { target: { kind: "repo", cwd: "/r" }, when: { kind: "at" }, sequential: false, kept: away.kept };
  assert.deepEqual(budgetInput.resumeKept(reported), away.kept, "the sheet comes back holding it");
  assert.equal(budgetInput.resumeKept(null), null, "a first mount holds nothing");
  assert.equal(budgetInput.resumeKept({ target: reported.target, when: reported.when, sequential: false }), null);
  // Back on a start that carries it, it is the target's cap again — by the same rule as before the trip.
  const t = { kind: "repo", cwd: "/r" };
  const cop = { backend: "copilot" };
  assert.deepEqual(budgetInput.capOnStart(t, t, budgetInput.resumeKept(reported), BS, { now: false, defaults: cop }, { now: true, defaults: cop }).target.budget, NAT);

  const src = readFileSync(new URL("./send/useSendSheet.ts", import.meta.url), "utf8");
  assert.match(src, /useState<KeptCap \| null>\(\(\) => resumeKept\(resume\)\)/, "seeded from the resume");
  assert.match(src, /decideRef\.current\?\.\(\{[^}]*\bkept\b[^}]*\}\)/, "reported with the decision, like parkedAt");
  assert.match(src, /\[target, when, sequential, kept\]/, "a change of kept is a change of the decision");
  assert.match(src, /const intent: SendIntent = \{ prompts, target, when, sequential \};/, "never part of what is sent");
  const to = readFileSync(new URL("./send/ToSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(to, /useState<KeptCap/, "ToSection reads the sheet's kept, holds none of its own");
});

/**
 * Review r4-2b L1: the set-aside sentence was drawn only inside the expanded *To* row, but the tap
 * that most often sets a cap aside — *at a time* — is made with *When* open and *To* collapsed
 * (one row open at a time). The cap just vanished from the To summary, unexplained (`ux` §1: a
 * change is said when it changes, on the screen the person is on).
 */
test("the set-aside sentence is drawn where the person is: under the To summary unless To is open (r4-2b L1)", () => {
  assert.equal(budgetInput.keptNoteAt("to"), "budget", "To open: beside the budget chip, where the field is");
  assert.equal(budgetInput.keptNoteAt("when"), "summary", "When open: under the To summary, on screen");
  assert.equal(budgetInput.keptNoteAt(null), "summary", "both collapsed: under the To summary");
  const src = readFileSync(new URL("./send/ToSection.tsx", import.meta.url), "utf8");
  assert.match(src, /kept && keptNoteAt\(open\) === "budget" && <SetWarn>\{kept\.said\}<\/SetWarn>/);
  assert.match(src, /kept && keptNoteAt\(open\) === "summary" && <SetWarn>\{kept\.said\}<\/SetWarn>/);
  assert.doesNotMatch(src, /\{kept && <SetWarn>/, "no placement that ignores which row is open");
});

test("a percent unit refused for undated records names that cause under its field (design round 4, r4-1 M2)", () => {
  const c = { checkedAt: NOW - 60_000, sessionUsdPerPct: null, weeklyUsdPerPct: null, weeklyUndated: 4 };
  assert.match(calibrationWords("weeklyPct", c, NOW), /4 records it could not date/);
  assert.match(calibrationWords("sessionPct", c, NOW), /has not run enough/, "no undated records in that window: the young-window sentence");
  const spark = { usageTok: 1000, costUsd: 0.5 };
  assert.match(budgetSpentLine("weeklyPct", spark, c, NOW), /4 records it could not date/);
});
