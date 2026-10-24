/**
 * What a repo is allowed to SAY about its own always-on cost.
 *
 * The rule this encodes is the one that is easy to get backwards: a skill's
 * BODY is on-demand and must never be counted against the repo, or the check
 * tells somebody who correctly moved their reference out that they made it
 * worse — and then they move it back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_LIMITS,
  contextLimitError,
  resolveContextLimits,
  sanitizeContextLimits,
  skillDescChars,
  weighContext,
} from "../dist/contextweight.js";

const skill = (name, descChars, bodyChars) => ({ name, descChars, bodyChars });

test("a small repo says its size and nothing else", () => {
  const r = weighContext({ claudeMdChars: 3_000, skills: [] });
  assert.equal(r.verdict, "lean");
  assert.equal(r.advice, null);
  assert.match(r.note, /3k chars/);
});

test("moving reference into a skill IMPROVES the reading", () => {
  // The whole point. 60k in CLAUDE.md is steep; the same 60k split into a small
  // file plus one big skill is lean, because the body is not on every turn.
  const before = weighContext({ claudeMdChars: 60_000, skills: [] });
  const after = weighContext({ claudeMdChars: 8_000, skills: [skill("a", 200, 52_000)] });
  assert.equal(before.verdict, "steep");
  assert.equal(after.verdict, "lean");
  assert.ok(after.alwaysOnChars < before.alwaysOnChars / 6);
});

test("skill bodies are reported as moved, never as debt", () => {
  const r = weighContext({ claudeMdChars: 5_000, skills: [skill("a", 150, 20_000), skill("b", 150, 10_000)] });
  assert.equal(r.alwaysOnChars, 5_000 + 300);
  assert.equal(r.onDemandChars, (20_000 - 150) + (10_000 - 150));
  assert.match(r.note, /loaded only when needed/);
});

test("the thresholds are the ones configured, not the ones shipped", () => {
  const tight = { maxChars: 1_000, hardChars: 2_000, maxSkills: 1 };
  assert.equal(weighContext({ claudeMdChars: 1_500, skills: [] }, tight).verdict, "heavy");
  assert.equal(weighContext({ claudeMdChars: 2_500, skills: [] }, tight).verdict, "steep");
  // ...and the default is genuinely lenient at that size.
  assert.equal(weighContext({ claudeMdChars: 2_500, skills: [] }).verdict, "lean");
});

test("too many skills trips on the COUNT and says so", () => {
  // The size sentence would be quoting a number inside its own limit here, which
  // reads as the check contradicting itself.
  const many = Array.from({ length: DEFAULT_CONTEXT_LIMITS.maxSkills + 1 }, (_, i) => skill(`s${i}`, 100, 5_000));
  const r = weighContext({ claudeMdChars: 2_000, skills: many });
  assert.equal(r.verdict, "heavy");
  assert.match(r.note, /skills, past the/);
  assert.doesNotMatch(r.note, /over the .* you asked to be warned at/);
  assert.match(r.advice, /Descriptions are the always-on part/);
});

test("over on size names the groom preset, since that is the fix", () => {
  const r = weighContext({ claudeMdChars: 50_000, skills: [] });
  assert.equal(r.verdict, "steep");
  assert.match(r.advice, /groom CLAUDE.md/);
});

test("a repo that has already done the split is NOT flagged", () => {
  // The calibration case, measured: this repo after its reference moved into six
  // skills. A default that warns here is a default that gets ignored everywhere.
  const skills = Array.from({ length: 6 }, (_, i) => skill(`s${i}`, 460, 9_800));
  const r = weighContext({ claudeMdChars: 9_672, skills });
  assert.equal(r.verdict, "lean", `always-on was ${r.alwaysOnChars}`);
  // ...while the state that prompted the check still is.
  assert.equal(weighContext({ claudeMdChars: 148_582, skills: [] }).verdict, "steep");
});

test("tokens are stated, never used to decide", () => {
  const r = weighContext({ claudeMdChars: 40_000, skills: [] });
  assert.equal(r.alwaysOnTokens, Math.round(40_000 / CHARS_PER_TOKEN));
});

test("a negative or absent size cannot produce a negative reading", () => {
  const r = weighContext({ claudeMdChars: -5, skills: [skill("a", 10, 2)] });
  assert.ok(r.alwaysOnChars >= 0 && r.onDemandChars >= 0);
});

test("skillDescChars reads the always-loaded half of a skill file", () => {
  const one = `---\nname: x\ndescription: a short one\n---\n\n# body\n${"z".repeat(5000)}`;
  assert.equal(skillDescChars(one), "a short one".length);
  // A wrapped description must be measured whole, not as its first line.
  const wrapped = `---\nname: x\ndescription: line one\n  line two continues\nallowed-tools: Read\n---\n\nbody`;
  assert.ok(skillDescChars(wrapped) > "line one".length);
  // No frontmatter is zero, never a guess at the whole file.
  assert.equal(skillDescChars("# just a heading\n"), 0);
});

// ── Where the line came from ────────────────────────────────────────────────
//
// The sentence used to credit the user with a threshold they had never been
// offered: the knobs were env-only and host-wide, so on a desktop that had
// exported none of them, "the 16k you asked to be warned at" was about a
// shipped default nobody could see or change. These pin the attribution and the
// three-layer resolution the phone's editor writes into.

test("a shipped default is worded as a default, not as something you asked for", () => {
  const r = weighContext({ claudeMdChars: 20_000, skills: [] });
  assert.match(r.note, /over the 16k default/);
  assert.doesNotMatch(r.note, /you asked to be warned at/);
});

test("a threshold the user set IS worded as theirs, and a repo one says so", () => {
  const lim = { maxChars: 10_000, hardChars: 40_000, maxSkills: 12 };
  const env = weighContext({ claudeMdChars: 20_000, skills: [] }, lim, { maxChars: "env" });
  assert.match(env.note, /over the 10k you asked to be warned at/);
  const repo = weighContext({ claudeMdChars: 20_000, skills: [] }, lim, { maxChars: "repo" });
  assert.match(repo.note, /over the 10k you set for this repo/);
});

test("the skill-count sentence is attributed too", () => {
  const many = Array.from({ length: 5 }, (_, i) => skill(`s${i}`, 100, 5_000));
  const lim = { ...DEFAULT_CONTEXT_LIMITS, maxSkills: 4 };
  const r = weighContext({ claudeMdChars: 2_000, skills: many }, lim, { maxSkills: "repo" });
  assert.match(r.note, /past the 4 you set for this repo/);
});

test("repo beats env beats default, one field at a time", () => {
  const v = resolveContextLimits({ maxChars: 20_000, maxSkills: 20 }, { maxChars: 30_000 });
  assert.equal(v.effective.maxChars, 30_000);
  assert.equal(v.source.maxChars, "repo");
  // env is still doing the work for a field the repo said nothing about...
  assert.equal(v.effective.maxSkills, 20);
  assert.equal(v.source.maxSkills, "env");
  // ...and an untouched field keeps falling through to the shipped default,
  // rather than being frozen at whatever it is today.
  assert.equal(v.effective.hardChars, DEFAULT_CONTEXT_LIMITS.hardChars);
  assert.equal(v.source.hardChars, "default");
});

test("the editor can tell 'inheriting 20k' from 'pinned at 20k'", () => {
  // Same effective number, opposite meanings — pre-filling a form from
  // `effective` would silently convert the first into the second on save.
  const inherited = resolveContextLimits({ maxChars: 20_000 }, null);
  const pinned = resolveContextLimits({ maxChars: 20_000 }, { maxChars: 20_000 });
  assert.equal(inherited.effective.maxChars, pinned.effective.maxChars);
  assert.equal(inherited.repo, null);
  assert.deepEqual(pinned.repo, { maxChars: 20_000 });
});

test("a steep line under the warn line is raised AND said out loud", () => {
  // The likely way to get here is raising one repo's warn line above the
  // default steep line — i.e. the exact thing the override exists for. Silently
  // swallowing "heavy" would leave the warn number quoted in a sentence that
  // can never fire.
  const v = resolveContextLimits({}, { maxChars: 60_000 });
  assert.equal(v.effective.hardChars, 60_000);
  assert.match(v.note, /below the warn line/);
  // ...and nothing is said when there is nothing to say.
  assert.equal(resolveContextLimits({}, { maxChars: 20_000 }).note, undefined);
});

test("an out-of-range threshold is refused, never repaired", () => {
  const { limits, errors } = sanitizeContextLimits({ maxChars: 0, maxSkills: 16 });
  assert.equal(limits.maxChars, undefined, "a rejected field is not stored at a fixed-up value");
  assert.equal(limits.maxSkills, 16);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /maxChars/);
  // Absent and null both mean "inherit" — that is how one knob moves alone.
  assert.deepEqual(sanitizeContextLimits({ maxChars: null, hardChars: undefined }).limits, {});
  // A non-integer is a typo, not a threshold.
  assert.ok(contextLimitError("maxSkills", 2.5));
  assert.equal(contextLimitError("maxSkills", 2), null);
});

// A YAML loader reads these as a description; the strict match read 0 and called the whole file body.
test("skillDescChars: BOM, leading blank lines, quoted key, CRLF and block scalars", () => {
  const want = "does a thing".length;
  assert.equal(skillDescChars("﻿---\nname: a\ndescription: does a thing\n---\nbody"), want);
  assert.equal(skillDescChars("\n\n---\ndescription: does a thing\n---\nbody"), want);
  assert.equal(skillDescChars('---\n"description": does a thing\n---\n'), want);
  assert.equal(skillDescChars("---\r\ndescription: does a thing\r\n---\r\nbody"), want);
  assert.equal(skillDescChars("---\ndescription: >\n  does a\n  thing\n---\n"), want);
  assert.equal(skillDescChars("---\ndescription: |-\n  does a\n  thing\nname: x\n---\n"), want);
  assert.equal(skillDescChars("---\n---\nbody"), 0);
  assert.equal(skillDescChars("no frontmatter\n---\ndescription: x\n---"), 0);
});
