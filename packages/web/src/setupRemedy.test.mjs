/**
 * The setup checklist's agent-facing half, pinned without a browser.
 *
 * `setupRemedy.ts` has no DOM, so it runs the way `activityRows.test.mjs` runs
 * — `node --test` straight over the TypeScript, with `@waterplane/shared` resolved
 * from the built `shared/dist`.
 *
 *     node --test packages/web/src/setupRemedy.test.mjs
 *
 * What is worth pinning: every rule here is one the sheet states in prose and
 * breaks silently. A host-scope row handed to a repo's agent asks twenty repos
 * to set one daemon's API key. A finding that already has a `fix` handed over
 * as well gets patched and then described to an agent as still broken. A
 * paraphrase instead of the check's own `detail` loses the file names, which is
 * the only part of the finding that says what to touch. And a SERIES reading
 * turned into an instruction to edit is the same failure one step further out:
 * there is no threshold behind it, so there is not even a finding to justify
 * the edit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ADVISORY_CHECKS, isSetupConsider, isSetupFinding } from "@waterplane/shared";
import {
  agentFindings, agentVerb, bulkLabel, bulkNote, findingsCutWords, fixConfirmWords, fixNeedsConfirm, fixVerb,
  patchFindings, patchIds,
  remedyPrompt, setupRowLookup, seriesAbsenceWords, seriesAllRemedyPrompt, seriesRemedyPrompt,
} from "./setupRemedy.ts";

const check = (o) => ({ id: "x", label: "L", detail: "D", status: "warn", fix: null, ...o });

const REPORT = [
  check({ id: "claude-md", label: "CLAUDE.md present", status: "pass" }),
  check({ id: "gitignore-transport", label: "inbox/outbox gitignored", status: "fail", fix: "gitignore" }),
  check({ id: "claude-md-outbox", label: "Agent told about outbox", status: "warn", fix: "claude-md" }),
  check({ id: "env-gitignored", label: "Secrets (.env) gitignored", status: "warn",
    detail: "Tracked & not ignored: .env.nas — a secret here would be committed." }),
  check({ id: "context-weight", label: "Agent context weight", status: "warn", detail: "10k chars." }),
  check({ id: "gemini", label: "Gemini credential (optional)", status: "warn", scope: "host", fix: "gemini-script" }),
];

test("the two kinds of open finding are split, and nothing is in both", () => {
  const a = agentFindings(REPORT).map((c) => c.id);
  const p = patchFindings(REPORT).map((c) => c.id);
  assert.deepEqual(a, ["env-gitignored", "context-weight"]);
  assert.deepEqual(p, ["gitignore-transport", "claude-md-outbox"]);
  assert.equal(a.filter((id) => p.includes(id)).length, 0);
});

test("a host-scope finding is not counted by the PATCH half either", () => {
  // There were three copies of this predicate and one of them — this one —
  // omitted the host-scope exclusion, so the bulk button counted the daemon's
  // one Gemini credential as a finding in whichever repo was on screen, beside
  // a badge that has never counted it. Both halves read `isSetupFinding` now.
  const gemini = REPORT.find((c) => c.id === "gemini");
  assert.equal(isSetupFinding(gemini), false);
  assert.ok(gemini.fix, "it is still patchable — from its own row, where it is stated");
  assert.equal(patchFindings([gemini]).length, 0);
  assert.deepEqual(patchIds([gemini]), []);
});

test("a host-scope finding is never handed to a repo's agent", () => {
  // One key serves the whole daemon: every repo would be asked to fix it, and
  // none of them can.
  const only = [check({ id: "gemini", status: "warn", scope: "host" })];
  assert.deepEqual(agentFindings(only), []);
});

test("a passing check is never handed over, however it is scoped", () => {
  assert.deepEqual(agentFindings([check({ status: "pass" })]), []);
});

test("patch ids are distinct — one pass closes both CLAUDE.md rows", () => {
  const two = [
    check({ id: "a", status: "warn", fix: "claude-md" }),
    check({ id: "b", status: "warn", fix: "claude-md" }),
  ];
  assert.deepEqual(patchIds(two), ["claude-md"]);
});

test("the prompt quotes each check's own sentence, not a paraphrase", () => {
  const p = remedyPrompt(agentFindings(REPORT), "trading");
  assert.match(p, /\.env\.nas/);              // the file names survive
  assert.match(p, /10k chars\./);
  assert.match(p, /2 open findings in trading/);
  assert.match(p, /git rm --cached/);          // the part that is not an edit
  assert.match(p, /commit nothing/i);
  assert.match(p, /WRONG about this repo/);    // disagreeing is an answer
});

test("one finding is worded as one", () => {
  const p = remedyPrompt([REPORT[3]], "trading");
  assert.match(p, /one open finding in trading/);
  assert.doesNotMatch(p, /\d+ open findings/);
});

test("a finding with no guidance still gets an instruction", () => {
  const p = remedyPrompt([check({ id: "invented-later", label: "New rule", detail: "Something." })], "r");
  assert.match(p, /New rule — Something\./);
  assert.match(p, /Close this finding if it is real/);
});

test("the bulk button says what it is about to do", () => {
  assert.equal(bulkLabel(3, 0), "Fix all (3)");
  assert.equal(bulkLabel(2, 2), "Fix all (4)");
  assert.equal(bulkLabel(0, 1), "Hand it to the agent");
  assert.equal(bulkLabel(0, 3), "Hand all 3 to the agent");
});

test("the footnote appears only when one tap does two different things", () => {
  assert.equal(bulkNote(3, 0, "r"), null);
  assert.equal(bulkNote(0, 3, "r"), null);
  assert.match(bulkNote(2, 1, "trading"), /2 patched here.*1 needs work.*trading/);
});

// ───────────────────────────────────────────────────────────────────────────
// The other region's verb: a reading is a question, never a brief.
// ───────────────────────────────────────────────────────────────────────────

/** The real `size.p95` reading at bba067c, as the screen would hand it over. */
const SUBJECT = {
  key: "size.p95",
  label: "p95 file length",
  value: "1,352 lines",
  reading: "89th percentile of the last 22 readings back to 2026-06-18, rising",
  // A rank exists, so this one really is a reading — the flag is what lets the
  // prompt say "reads it as" about this and not about a refusal to read.
  ranked: true,
  detail: "149 occurrences over 143,176 lines.",
};

test("the prompt quotes the tool's own reading sentence verbatim", () => {
  // Verbatim, not paraphrased, for the reason `remedyPrompt` quotes a check's
  // detail: the window size, the day it opens and the slope are the only part
  // that says what is actually being claimed.
  const p = seriesRemedyPrompt(SUBJECT, "myapp");
  assert.ok(p.includes(SUBJECT.reading), "the reading sentence, character for character");
  assert.ok(p.includes(SUBJECT.detail), "and the detail sentence with it");
  assert.match(p, /p95 file length in myapp is 1,352 lines\./);
  assert.match(p, /`size\.p95`/, "the tool's own key, so the prompt names something greppable");
});

test("an odd sentence is still quoted rather than re-worded", () => {
  const weird = { ...SUBJECT, ranked: false, reading: "not enough history (8 of 14 readings)", detail: "" };
  const p = seriesRemedyPrompt(weird, "myapp");
  assert.ok(p.includes("not enough history (8 of 14 readings)"));
  assert.doesNotMatch(p, /percentile/);
});

test("the tool's refusal to read is not printed as a reading", () => {
  // The bug this test replaces was pinned by the one above it, which asserted
  // only that the sentence survived. `rankSentence` answers with the
  // percentile when there is a rank and with the tool's own reason when there
  // is not, and BOTH used to arrive wrapped in "reads it as:" — so a prompt
  // claimed a reading the series had explicitly declined to make, and handed
  // the agent a row with no comparative content in it at all. The only thing
  // left with any substance was how the number is built, and that is what came
  // back: seventeen tool calls inside the measuring script.
  const refused = { ...SUBJECT, ranked: false, reading: "not enough history (2 of 14 readings)", detail: "" };
  const p = seriesRemedyPrompt(refused, "myapp");
  assert.doesNotMatch(p, /reads it as/, "the series did not read it; it said it could not");
  assert.match(p, /has no reading of it yet/);
  assert.match(p, /entirely about the repo/, "and says the consequence, or the frame is just softer");

  // The ranked one keeps the frame it earned.
  const ranked = { ...SUBJECT, ranked: true };
  assert.match(seriesRemedyPrompt(ranked, "myapp"), /reads it as: 89th percentile/);
});

test("an unranked subject that never says so is treated as unranked", () => {
  // Absent means unranked, never "an older caller, assume the stronger one".
  // Built without the spread on purpose: `SUBJECT` carries `ranked: true`, and
  // a fixture that inherits it is not a caller that omitted the flag.
  const bare = { key: "size.p95", label: "p95 file length", value: "1,352 lines", reading: "not enough history (2 of 14)", detail: "" };
  const p = seriesRemedyPrompt(bare, "myapp");
  assert.doesNotMatch(p, /reads it as/);
});

test("a reading with no sentence at all still produces a prompt", () => {
  const p = seriesRemedyPrompt({ ...SUBJECT, reading: null, detail: "" }, "myapp");
  assert.match(p, /p95 file length in myapp is 1,352 lines\./);
  assert.doesNotMatch(p, /undefined|null/);
});

test("the prompt contains no verb that applies anything", () => {
  const p = seriesRemedyPrompt(SUBJECT, "myapp");
  // It asks for an explanation and a proposal. Every one of these would turn a
  // reading — which has no threshold behind it and therefore no finding — into
  // an instruction to edit the repo.
  for (const verb of ["fix it", "refactor", "split the file", "reduce", "bring it down", "clean up", "apply", "commit the"]) {
    assert.doesNotMatch(p, new RegExp(verb, "i"), `"${verb}" would make a reading into a brief`);
  }
  assert.match(p, /Change no file, run no fix, commit nothing\./);
  assert.match(p, /it is not a finding/);
  assert.match(p, /artefact of how it was measured/, "disagreeing with the reading is an answer");
});

test("the question is about the thing, and it is the first verb", () => {
  // The prompt that shipped before this opened with "Explain what is behind
  // this reading", and got back an explanation of the reading: seventeen tool
  // calls inside the measuring script and a section headed "What 2.210 is".
  // It already asked for the judgment further down — "propose what could be
  // done about it", "finish with the options as you see them" — and that was
  // ignored, which is the whole lesson. The FIRST verb decides what gets
  // researched; a later clause only decides how it is written up. So this
  // asserts position, not presence.
  const p = seriesRemedyPrompt(SUBJECT, "myapp");
  const body = p.slice(p.indexOf("\n\n"));
  assert.match(body.trimStart(), /^Is this serving myapp, and what would you change\?/);
  assert.doesNotMatch(p, /Explain what is behind/, "that verb is the bug, not a wording preference");
  assert.match(p, /The number above is what prompted the question, not the subject of it/);
});

test("changing nothing is offered as a complete answer, and early", () => {
  // Without it, six tiles each asking "is this serving you" with no way to say
  // yes is six manufactured to-dos — worse than the metrology it replaces,
  // which was at least true. Early, because the old prompt granted metrology a
  // terminus and nothing else.
  const p = seriesRemedyPrompt(SUBJECT, "myapp");
  assert.match(p, /"It is serving you; change nothing" is a complete answer/);
  assert.ok(
    p.indexOf("change nothing") < p.indexOf("Finish with the options"),
    "an answer offered only after the options have been asked for is not offered",
  );
  assert.match(seriesAllRemedyPrompt(ALL, "myapp", null), /is a complete answer for any of these/);
});

test("the prompt asks for a judgment without reopening the threshold door", () => {
  // The line: the prompt may judge the SUBJECT, never characterize the NUMBER.
  // "five skills is too few for this repo" holds no threshold — it was formed
  // by reading the repo, it names what it rests on, and it does not transfer.
  // A fixed number chosen in advance would. This guard is narrower than region
  // 2's verdict-word ban, which is scoped to the SCREEN and must not be
  // extended here: `remedyPrompt` in this same file already ships "Close it."
  for (const p of [seriesRemedyPrompt(SUBJECT, "myapp"), seriesAllRemedyPrompt(ALL, "myapp", null)]) {
    for (const word of ["too high", "too low", "too long", "excessive", "bloated", "wordy", "unwieldy"]) {
      assert.ok(!p.toLowerCase().includes(word), `"${word}" characterizes the value; the tool holds no threshold`);
    }
    assert.match(p, /nothing above says (it|any of them) is too much or too little/);
    assert.match(p, /A judgment you form by reading this repo/);
    assert.match(p, /keep it about this repo rather than repos in general/);
  }
});

test("neither prompt asserts a path that is not in the repo it lands in", () => {
  // `tools/repohealth.mjs` is false in twelve of the thirteen repos on this
  // desktop: the host runs the worktree's own copy where there is one and this
  // desktop's bundled waterplane copy otherwise. The row prompt named that file and
  // the set prompt named a `tools/repohealth/` DIRECTORY, and an agent told a
  // file exists goes and looks for it. The KEY is true everywhere; the path is
  // not, so only the key survives.
  for (const p of [seriesRemedyPrompt(SUBJECT, "myapp"), seriesAllRemedyPrompt(ALL, "myapp", null)]) {
    assert.doesNotMatch(p, /tools\/repohealth/, "a path this repo may not have");
    assert.match(p, /probably not in this repo/, "and it says so, or the key alone invites the hunt");
    assert.match(p, /`size\.p95`/, "the key stays: it is the tool's own name and it is true everywhere");
  }
});

test("the findings cut says what it is hiding, against the unfiltered list", () => {
  assert.equal(findingsCutWords(2, 7), "2 of 7 — open findings only, the rest of the checklist is hidden");
});

// ── every reading at once ──────────────────────────────────────────────────

const ALL = [
  SUBJECT,
  {
    key: "retouch.rate",
    label: "the re-touch rate",
    value: "0.61",
    reading: "18th percentile of the last 20 readings back to 2026-08-19, falling",
    ranked: true,
    detail: "113 re-touches out of 185 touches over 14 days.",
  },
  {
    key: "dups.rate",
    label: "duplicate blocks",
    value: "—",
    reading: null,
    detail: "",
    absent: "not read on the latest day — no parser for kotlin",
  },
];

const ENGINE = "read by this desktop's engine, pointed at the worktree · version 2026-09-21f+2c11ef67 · packs kotlin 176";

test("the set prompt carries every reading, not a summary of them", () => {
  // The whole point of the second verb: a row prompt cannot hold what is
  // between rows, so this one has to hold all of it or it is the row prompt
  // with more words.
  const p = seriesAllRemedyPrompt(ALL, "tiptoi", ENGINE);
  for (const s of ALL) {
    assert.ok(p.includes(s.label), `${s.label} is in the prompt`);
    assert.ok(p.includes(`\`${s.key}\``), `${s.key} is named as the tool names it`);
    if (s.reading) assert.ok(p.includes(s.reading), "the reading sentence, character for character");
    if (s.detail) assert.ok(p.includes(s.detail), "and the detail with it");
  }
  assert.match(p, /3 readings of tiptoi, all taken from the same commit/);
});

test("an absent reading travels as an absence with its reason, never as a gap", () => {
  const p = seriesAllRemedyPrompt(ALL, "tiptoi", ENGINE);
  assert.match(p, /duplicate blocks \(`dups\.rate`\) — no reading/);
  assert.ok(p.includes("not read on the latest day"), "and which day it is about");
  assert.ok(p.includes("no parser for kotlin"), "the metric's own reason");
  // And the instruction that stops the agent hunting for the missing figure.
  assert.match(p, /absent is a fact about this repo/);
});

test("the engine line rides along, because a reading is read beside what was measured", () => {
  assert.ok(seriesAllRemedyPrompt(ALL, "tiptoi", ENGINE).includes(ENGINE));
  // A host too old to say is not a blank line and not the word null.
  const none = seriesAllRemedyPrompt(ALL, "tiptoi", null);
  assert.doesNotMatch(none, /undefined|null/);
});

test("the narrative is deliberately not in it", () => {
  // It is the desktop's own cross-reading of these same rows. Quoting it into
  // a prompt that ASKS for a cross-reading hands the agent an answer as
  // evidence — so nothing here takes a narrative argument at all.
  assert.equal(
    seriesAllRemedyPrompt.length, 4,
    "series, repoName, engine, scope — and nothing that could carry the narrative in",
  );
});

test("the set prompt asks the cross question a row prompt cannot", () => {
  const p = seriesAllRemedyPrompt(ALL, "tiptoi", ENGINE);
  assert.match(p, /one tree on one day/);
  assert.match(p, /move for the same reason/);
  assert.match(p, /disagree/);
});

test("the set prompt applies nothing either", () => {
  const p = seriesAllRemedyPrompt(ALL, "tiptoi", ENGINE);
  for (const verb of ["fix it", "refactor", "split the file", "reduce", "bring it down", "clean up", "apply", "commit the"]) {
    assert.doesNotMatch(p, new RegExp(verb, "i"), `"${verb}" would make ten readings into a brief`);
  }
  assert.match(p, /Change no file, run no fix, commit nothing\./);
  assert.match(p, /it is not a finding/);
  assert.match(p, /artefact of how it is measured/);
});

test("one reading through the set prompt is still grammatical", () => {
  const p = seriesAllRemedyPrompt([SUBJECT], "myapp", null);
  assert.match(p, /1 reading of myapp/);
  assert.doesNotMatch(p, /1 readings/);
});

test("the three ways a reading can have no number are three different sentences", () => {
  // They were one em-dash. `the always-on skill descriptions — —` reached a
  // real prompt off a live repo: a document whose whole claim is that it says
  // what was measured, printing a blank where the answer was "this repo has
  // none of them". Two of these three must not send anybody looking.
  assert.equal(
    seriesAbsenceWords({ absent: "no parser for kotlin", last: null, readings: 0 }),
    "not read on the latest day — no parser for kotlin",
  );
  assert.match(
    seriesAbsenceWords({ last: null, readings: 12 }),
    /no value on the latest day, though earlier days/,
  );
  assert.match(
    seriesAbsenceWords({ last: null, readings: 0 }),
    /nothing of this kind has ever been measured here/,
  );
  // A reading that HAS a number gets no sentence at all — an absence note on a
  // present value is the same defect pointing the other way.
  assert.equal(seriesAbsenceWords({ last: 1352, readings: 22 }), undefined);
});

test("a series the latest day never read never reaches the prompt as a dash", () => {
  const p = seriesAllRemedyPrompt(
    [{ key: "context.descChars", label: "the always-on skill descriptions", value: "—",
       reading: "not enough history (0 of 14 readings)", detail: "",
       absent: seriesAbsenceWords({ last: null, readings: 0 }) }],
    "tiptoi", null,
  );
  assert.doesNotMatch(p, /— —/, "the em-dash value must never be what the prompt says");
  assert.match(p, /nothing of this kind has ever been measured here/);
});

test("a scoped reading names the subtree, never the repo it sits in", () => {
  // The number is about `apps/ba3-web`. Handed the monorepo's name, the agent
  // would go looking for a p95 across eighteen apps to explain one app's.
  const one = seriesRemedyPrompt(SUBJECT, "garmin-monorepo", "apps/ba3-web");
  assert.match(one, /p95 file length in garmin-monorepo, under apps\/ba3-web is 1,352 lines\./);
  // And the two consequences of measuring a subtree as a repo: what a path
  // resolves against, and which commits the window was taken over.
  assert.match(one, /only the commits that touched it/);
  assert.match(one, /every path above is relative to apps\/ba3-web\//);

  const all = seriesAllRemedyPrompt(ALL, "garmin-monorepo", ENGINE, "apps/ba3-web");
  assert.match(all, /3 readings of garmin-monorepo, under apps\/ba3-web/);
  assert.match(all, /relative to apps\/ba3-web\//);
});

test("an unscoped prompt says nothing about subtrees at all", () => {
  // The clause is a consequence of a scope; printed without one it describes a
  // measurement nobody took.
  for (const p of [seriesRemedyPrompt(SUBJECT, "myapp"), seriesAllRemedyPrompt(ALL, "myapp", ENGINE)]) {
    assert.doesNotMatch(p, /measured as though it were the repo/);
    assert.doesNotMatch(p, /relative to/);
  }
});

// The requirements row's own words are pinned where they now live:
// packages/extensions/requirements/web/setupRow.test.mjs. What stays true of the CORE is below.
const ROW = { check: "requirements", fix: "requirements", fixVerb: "set up", agentVerb: "update the list in this repo", guidance: "Run the thing quoted above." };

test("with no contributed rows the verbs and the guidance are the generic ones", () => {
  assert.equal(fixVerb("requirements"), "fix");
  assert.equal(agentVerb("requirements"), "fix in this repo");
  const c = check({ id: "requirements", label: "Requirements list", detail: "d" });
  assert.match(remedyPrompt([c], "r"), /Close this finding if it is real/);
});

test("a contributed row changes the verb, the agent verb and the guidance, and only for its own check", () => {
  const rows = setupRowLookup([ROW]);
  assert.deepEqual(rows.refused, []);
  assert.equal(fixVerb("requirements", undefined, rows), "set up");
  assert.equal(agentVerb("requirements", rows), "update the list in this repo");
  assert.equal(fixVerb("gitignore", undefined, rows), "fix");
  assert.equal(agentVerb("claude-md", rows), "fix in this repo");
  const c = check({ id: "requirements", label: "Requirements list", detail: "d" });
  assert.match(remedyPrompt([c], "r", rows), /Run the thing quoted above\./);
});

test("a def that names a core guidance key or a core fix is refused and changes nothing", () => {
  const rows = setupRowLookup([
    { check: "claude-md", agentVerb: "take over" },
    { check: "mine", fix: "gitignore", fixVerb: "hijack" },
    { check: "also-mine", fix: "auto-compact", fixVerb: "hijack" },
  ]);
  assert.deepEqual(rows.refused, ["claude-md", "mine", "also-mine"]);
  assert.equal(agentVerb("claude-md", rows), "fix in this repo");
  assert.equal(fixVerb("gitignore", undefined, rows), "fix");
  assert.match(fixVerb("auto-compact", "400k", rows), /set 400k in/);
  assert.equal(rows.byCheck("mine"), undefined);
});

test("an advisory row is a thing to consider: never a finding, never in Fix all or the agent hand-off", () => {
  const cw = check({ id: "context-weight", label: "Agent context weight", status: "warn", fix: null, advisory: true });
  const ac = check({ id: "auto-compact", label: "Auto-compact window", status: "warn", fix: "auto-compact", advisory: true });
  const ignored = { ...cw, ignored: true };
  assert.equal(isSetupFinding(cw), false);
  assert.equal(isSetupConsider(cw), true);
  assert.equal(isSetupConsider(ignored), false, "ignored is neither");
  assert.equal(isSetupFinding(ignored), false);
  assert.equal(isSetupConsider({ ...cw, status: "pass" }), false);
  assert.ok(!agentFindings([...REPORT, cw, ac]).some((c) => c.advisory));
  assert.ok(!patchFindings([...REPORT, cw, ac]).some((c) => c.advisory));
  assert.deepEqual([...ADVISORY_CHECKS].sort(), ["apk-install", "auto-compact", "context-weight"]);
});

test("auto-compact's write CHOOSES a setting: never in Fix all, never handed to the agent, two taps", () => {
  const ac = check({ id: "auto-compact", label: "Auto-compact window", status: "warn", fix: "auto-compact" });
  const all = [...REPORT, ac];
  assert.ok(!patchFindings(all).some((c) => c.id === "auto-compact"), "not in Fix all");
  assert.ok(!patchIds(all).includes("auto-compact"));
  assert.ok(!agentFindings(all).some((c) => c.id === "auto-compact"), "the row has its own write");
  assert.equal(fixNeedsConfirm("auto-compact"), true);
  assert.equal(fixNeedsConfirm("gitignore"), false);
  assert.match(fixVerb("auto-compact"), /400k.*\.claude\/settings\.json/);
  assert.match(fixConfirmWords("auto-compact"), /400k/);
  // The size is the desktop's choice when it sent one.
  assert.match(fixVerb("auto-compact", "300k"), /set 300k in/);
  assert.match(fixConfirmWords("auto-compact", "300k"), /write 300k/);
  // Where the repo file would not win (env / settings.local.json), the host
  // sends no fix, and the row goes to the agent with guidance that changes
  // nothing in that case.
  const envRow = check({ id: "auto-compact", label: "Auto-compact window", status: "warn", fix: null });
  assert.deepEqual(agentFindings([envRow]).map((c) => c.id), ["auto-compact"]);
  assert.match(remedyPrompt([envRow], "r"), /change nothing/);
});

test("the toolchain and the signing key are core fixes behind their own consent words (first-app WP3/WP4 handover)", async () => {
  const { ANDROID_TOOLCHAIN_CONSENT, SIGNING_KEY_CONSENT } = await import("@waterplane/shared");
  for (const fix of ["android-toolchain", "signing-key"]) {
    assert.equal(fixNeedsConfirm(fix), true, `${fix} takes two taps`);
    const c = check({ id: fix, label: fix, status: "warn", fix });
    assert.ok(!patchFindings([...REPORT, c]).some((x) => x.id === fix), `${fix} is never in Fix all`);
    assert.notEqual(fixVerb(fix), "fix", `${fix} names what it does`);
  }
  assert.equal(fixConfirmWords("android-toolchain"), ANDROID_TOOLCHAIN_CONSENT, "the armed label IS the consent text");
  assert.match(fixConfirmWords("android-toolchain"), /developer\.android\.com\/studio\/terms/);
  assert.equal(fixConfirmWords("signing-key"), SIGNING_KEY_CONSENT);
  const rows = setupRowLookup([{ check: "x", fix: "android-toolchain", fixVerb: "hijack" }, { check: "y", fix: "signing-key", fixVerb: "hijack" }]);
  assert.deepEqual(rows.refused, ["x", "y"], "an extension may not take either fix over");
});

