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
import { ADVISORY_CHECKS, isSetupConsider, isSetupFinding, sharedRel } from "@waterplane/shared";
import { HEALTH_ENTRY_MEASURE } from "./healthIndexWords.ts";
import {
  agentFindings, agentVerb, engineAdoptPrompt, bulkLabel, bulkNote, findingsCutWords, fixConfirmWords, fixNeedsConfirm, fixTitle, fixVerb,
  patchFindings, patchIds,
  healthAskContextOf, healthIndexRemedyPrompt, healthTrendRemedyPrompt, remedyPrompt, setupRowLookup, seriesAbsenceWords, seriesAllRemedyPrompt, seriesRemedyPrompt,
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
  assert.deepEqual([...ADVISORY_CHECKS].sort(), ["apk-install", "auto-compact", "context-weight", "exposure"]);
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

test("the build-list patch has a short button and its exact effect as text under it", () => {
  assert.equal(fixVerb("builds-configured"), "write build list");
  assert.equal(
    fixTitle("builds-configured"),
    `write ${sharedRel("builds.json")} from this repo's build commands; existing lists stay untouched`,
  );
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


const INDEX_WEEK = {
  week: "2026-10-12", prevWeek: "2026-10-05", index: 130.4, delta: 3.1,
  movers: [
    { key: "size", name: "File length", points: 0 },
    { key: "retouch", name: "Re-touched files", points: 2.8 },
    { key: "hatches", name: "Escape hatches", points: 0.1 },
    { key: "untested", name: "Untested modules", points: -0.2 },
  ],
};

test("the health-index ask is about the picked week's commits, biggest mover first", () => {
  const p = healthIndexRemedyPrompt(INDEX_WEEK, "myapp");
  assert.match(p, /was 130 in the week of 2026-10-12 \(\+3\.1 against the week before\)/);
  assert.match(p, /between the week of 2026-10-05 and the week of 2026-10-12/);
  // The opening question is about what happened in the repo, never the arithmetic.
  assert.match(p, /What happened in myapp .* that moved these readings/);
  const order = ["Re-touched files", "Untested modules", "Escape hatches", "File length"].map((n) => p.indexOf(`- ${n}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "movers are listed biggest first");
  assert.match(p, /Re-touched files \(`retouch`\): \+2\.8 — pushed it up \(that reading shrank\)\. It is a rate over the last 14 days/);
  assert.match(p, /Untested modules \(`untested`\): −0\.2 — pulled it down \(that reading grew\)\. It is a share/);
  assert.match(p, /File length \(`size`\): ±0\.0 — barely moved it/);
});

test("the health-index ask offers 'nothing to do' and applies nothing", () => {
  const p = healthIndexRemedyPrompt(INDEX_WEEK, "myapp");
  assert.match(p, /nothing needs doing" is a complete answer/);
  assert.ok(p.indexOf("complete answer") < p.indexOf("Finish with the options"));
  assert.match(p, /Change no file, run no fix, commit nothing\./);
});

test("a week with no link states no delta and no span it does not have", () => {
  const p = healthIndexRemedyPrompt({ ...INDEX_WEEK, prevWeek: null, delta: null }, "myapp");
  assert.doesNotMatch(p, /against the week before/);
  assert.match(p, /What happened in myapp in the week of 2026-10-12 that moved/);
});

const TREND = [
  { week: "2026-08-17", index: 100, gap: false, lnLink: null, contributions: {} },
  { week: "2026-08-24", index: 97, gap: false, lnLink: -0.03, contributions: { size: -2, retouch: -1 } },
  { week: "2026-08-31", index: 97, gap: true, lnLink: null, contributions: {} },
  { week: "2026-09-07", index: 104, gap: false, lnLink: 0.07, contributions: { size: 1, retouch: 6 } },
];

test("both asks carry the cap and the alerts when there are some, and the new scoring words, never the old ones", () => {
  const alerts = ["severe: src/a.ts is 5,200 lines (good: under 1,000)"];
  const cap = "Capped at 62 by file length (32 of 100): the entries average 67, and the score stays within 30 of its worst entry.";
  const week = healthIndexRemedyPrompt({ ...INDEX_WEEK, alerts, cap }, "myapp");
  const trend = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", { now: { alerts, cap } });
  for (const p of [week, trend]) {
    assert.match(p, /What is holding the score down/);
    assert.ok(p.includes(alerts[0]) && p.includes(cap));
    assert.match(p, /score out of 100 against fixed good values/);
    assert.doesNotMatch(p, /chained|baseline week|100 is the|Weeks carried/);
  }
  assert.doesNotMatch(healthIndexRemedyPrompt(INDEX_WEEK, "myapp"), /holding the score down/, "nothing to say, nothing said");
  assert.doesNotMatch(healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp"), /holding the score down/);
});

test("the trend ask lists every week, the gaps as gaps, and each reading's total", () => {
  const p = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp");
  assert.match(p, /went from 100 in the week of 2026-08-17 to 104 in the week of 2026-09-07/);
  assert.match(p, /- 2026-08-17: 100 — first scored week/);
  assert.match(p, /- 2026-08-24: 97 \(−3\.0\) — File length −2\.0, Re-touched files −1\.0/);
  assert.match(p, /- 2026-08-31: 97 — move not compared/);
  assert.match(p, /Re-touched files \(`retouch`\): \+5\.0 over 2 weeks/);
  assert.doesNotMatch(p, /Escape hatches \(`hatches`\)/, "a reading with no contribution has no total, not a zero");
});

test("the trend ask reads the trend first, asks which proposals to keep, then posts only those as held backlog rows", () => {
  const p = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp");
  assert.match(p, /Is myapp getting healthier\?/);
  assert.ok(p.indexOf("getting healthier?") < p.indexOf("propose what to change"), "the trend is read before anything is proposed");
  assert.match(p, /POST \/api\/agent\/backlog`, no `when`/, "a proposal is a backlog add, never a timed run");
  assert.match(p, /one row per change/);
  assert.match(p, /key per change/, "asking twice does not post twice");
  assert.match(p, /may move none of them/);
  assert.match(p, /propose one of this repo's own/);
  assert.match(p, /ask the person which ones to put in the backlog, and stop: post nothing until they answer/, "no row is posted before the person picks");
  assert.ok(p.indexOf("which ones to put in the backlog") < p.indexOf("POST /api/agent/backlog"), "the ask comes before the post");
  assert.match(p, /post only the ones they picked/);
  assert.match(p, /Change no file, run no fix, commit nothing: the backlog rows the person picked are the only thing you write\./);
});

/* ── what the two index prompts say about the tree beside the numbers ── */

const pt = (day, v) => ({ day, sha7: "abc1234", v });
const PLOT = {
  classics: { loc: [], deps: [], packages: [], files: [pt("2026-08-16", 30), pt("2026-08-17", 35), pt("2026-08-25", null), pt("2026-09-08", 1500)] },
  own: {
    file: ".waterplane-shared/health.json", declared: true,
    series: [
      { key: "fixtures", source: "repo", label: "Screen fixtures", unit: "", last: 5, reading: { rank: null, n: 0 }, detail: "",
        means: "Signals with a real capture.", better: "higher", points: [pt("2026-09-07", null), pt("2026-09-08", 5)] },
      { key: "never", source: "repo", label: "Never read", unit: "", last: null, reading: { rank: null, n: 0 }, detail: "",
        means: "x", better: null, points: [pt("2026-09-08", null)] },
    ],
  },
};

test("the engine is named from the wire: own copy, bundled, or nothing at all", () => {
  const own = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", { engine: "repo" });
  assert.match(own, /measured by this repo's own tools\/repohealth\.mjs/);
  assert.doesNotMatch(own, /not part of this repo|do not go hunting/);
  const bundled = healthIndexRemedyPrompt(INDEX_WEEK, "myapp", { engine: "bundled" });
  assert.match(bundled, /measured by \S+'s bundled engine.*it is not part of this repo/);
  for (const p of [healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp"), healthIndexRemedyPrompt(INDEX_WEEK, "myapp")]) {
    assert.doesNotMatch(p, /engine|tools\/repohealth|not part of this repo|probably not in this repo/, "absent engine says nothing about where it is");
  }
});

test("a link across weeks with no row says how many, and the backlog commit is named", () => {
  const weeks = [...TREND, { week: "2026-10-26", index: 110, gap: false, lnLink: 0.05, contributions: { size: 6 } }];
  const p = healthTrendRemedyPrompt(weeks, "2026-08-17", "myapp");
  assert.match(p, /- 2026-10-26: 110 \(\+6\.0\) \(one link over 7 weeks with no measured week between\) — File length \+6\.0/);
  assert.doesNotMatch(p, /2026-09-07: 104 \(\+7\.0\) \(one link/, "a link two weeks after a CARRIED week is still one week from its row");
  assert.match(p, /single commit carries most of it before attributing/);
  const w = healthIndexRemedyPrompt({ ...INDEX_WEEK, prevWeek: "2026-08-24" }, "myapp");
  assert.match(w, /and the week of 2026-10-12 \(one link over 7 weeks with no measured week between\)/);
  assert.doesNotMatch(healthIndexRemedyPrompt(INDEX_WEEK, "myapp"), /one link over/);
});

test("every listed reading says what kind of number it is, from the one table", () => {
  const p = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp");
  assert.ok(p.includes(`File length (\`size\`): −1.0 over 2 weeks. It is ${HEALTH_ENTRY_MEASURE.size}.`));
  assert.ok(p.includes(HEALTH_ENTRY_MEASURE.retouch));
  assert.match(HEALTH_ENTRY_MEASURE.hatches, /density: UNEXPLAINED.*per 1,000 source lines.*carry no reason.*explained ones and TODO\/FIXME marks are reported apart and never counted/);
  assert.match(HEALTH_ENTRY_MEASURE.retouch, /REWORK.*change or remove lines it added.*only adds lines.*never counted/);
  assert.match(HEALTH_ENTRY_MEASURE.context, /CLAUDE\.md plus every skill's description; skill bodies.*not counted/);
  assert.match(HEALTH_ENTRY_MEASURE.untested, /share.*imported is not covered/);
  assert.match(HEALTH_ENTRY_MEASURE.size, /line-weighted mean file length.*longest file/);
});

test("the tree's growth from the baseline week is said only when the files series carries both ends", () => {
  const ctx = healthAskContextOf(PLOT, "repo", "2026-08-17");
  assert.deepEqual(ctx.tree, { baselineFiles: 35, nowFiles: 1500 }, "the baseline week's LAST reading, the latest non-null now");
  assert.match(healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", ctx), /The tree went from 35 source files at the first scored week to 1,500 now/);
  const none = healthAskContextOf(PLOT, null, "2026-07-06");
  assert.equal(none.tree, undefined);
  assert.equal(none.engine, undefined);
  assert.doesNotMatch(healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", none), /The tree went from/);
});

test("the repo's own readings are listed apart, and the advice starts from them", () => {
  const ctx = healthAskContextOf(PLOT, "repo", "2026-08-17");
  assert.deepEqual(ctx.own.readings.map((r) => r.key), ["fixtures"], "a reading with no value is not listed as one");
  const p = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", ctx);
  assert.match(p, /This repo's own readings, declared in \.waterplane-shared\/health\.json — not part of the index/);
  assert.match(p, /- Screen fixtures \(`fixtures`\): 5 on 2026-09-08 \(its only reading so far\); the repo wants it higher\. Signals with a real capture\./);
  assert.match(p, /- Start from this repo's own readings above: say whether they moved/);
  assert.ok(p.indexOf("Start from this repo's own") < p.indexOf("Say plainly that the five"));
  assert.doesNotMatch(p, /no slot for one/);
  assert.match(healthIndexRemedyPrompt(INDEX_WEEK, "myapp", ctx), /This repo's own readings, declared in/);
});

test("a repo declaring none is told the slot exists; no own block on the wire says nothing", () => {
  const none = healthAskContextOf({ ...PLOT, own: { file: ".waterplane-shared/health.json", declared: false, series: [] } }, null, "2026-08-17");
  const p = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", none);
  assert.match(p, /This repo declares no readings of its own; \.waterplane-shared\/health\.json is where one would be declared/);
  assert.match(p, /this repo has none of its own yet, propose one of this repo's own .* as a proposal to declare it in \.waterplane-shared\/health\.json with a script that prints it\./);
  assert.doesNotMatch(p, /Start from this repo's own/);
  const old = healthTrendRemedyPrompt(TREND, "2026-08-17", "myapp", healthAskContextOf({ classics: PLOT.classics }, null, "2026-08-17"));
  assert.doesNotMatch(old, /declares no readings|own readings, declared/);
  assert.match(old, /a proposal to declare it in \S+health\.json/);
});

test("the index prompts name the repo's disables and overrides, the engine's detail, and the vs-weeks figure", () => {
  const plot = {
    classics: null, own: undefined,
    central: { file: ".cfg/health.json" },
    series: [
      { key: "size.p95", label: "p95 file length", detail: "3 files within 10% of the largest (900 lines).", points: [], unit: "lines",
        variant: { kind: "override", why: "generated code", means: "p95 of hand-written files", unit: "lines", points: [], last: 300, since: "2026-10-12" } },
      { key: "hatches.perKloc", label: "unexplained escape hatches per kLOC", detail: "20 unexplained of 30 escapes over 9,000 lines (10 carry their reason); 4 TODO/FIXME marks reported apart, never counted.", points: [], unit: "" },
      { key: "context.claudeMdChars", label: "CLAUDE.md", detail: "", points: [], unit: "chars" },
      { key: "context.descChars", label: "the always-on skill descriptions", detail: "2 skills; their bodies, loaded only when one is invoked, are 9,000 chars more.", points: [], unit: "chars" },
      { key: "untested.count", label: "untested", detail: "", points: [], unit: "",
        variant: { kind: "disabled", why: "tests are in another repo" } },
      { key: "context.skillCount", label: "skills", detail: "not an index reading", points: [], unit: "" },
    ],
  };
  const ctx = healthAskContextOf(plot, null, "2026-08-17", { delta: 18.4, thenWeek: "2026-06-22", weeks: 14 });
  assert.deepEqual(ctx.variants.map((v) => [v.key, v.kind]), [["size", "override"], ["untested", "disabled"]]);
  assert.deepEqual(ctx.details.map((d) => d.key), ["size", "hatches", "context"], "only index readings, only with a sentence");
  const weeks = [
    { week: "2026-08-17", index: 100, gap: false, lnLink: null, contributions: {} },
    { week: "2026-10-12", index: 101, gap: true, lnLink: null, contributions: {}, gapReason: "central" },
    { week: "2026-10-19", index: 103, gap: false, lnLink: 0.02, contributions: { size: 2 } },
  ];
  const trend = healthTrendRemedyPrompt(weeks, "2026-08-17", "myapp", ctx);
  const week = healthIndexRemedyPrompt({ week: "2026-10-19", prevWeek: "2026-10-12", index: 103, delta: 2, movers: [{ key: "size", name: "File length", points: 2 }] }, "myapp", ctx);
  for (const p of [trend, week]) {
    assert.ok(p.includes("Built from 4 of"), p);
    assert.ok(p.includes("Untested modules is disabled here; File length reads this repo's own version."));
    assert.ok(p.includes("in .cfg/health.json (`central`)"));
    assert.ok(p.includes("- Untested modules (`untested`): disabled — still measured, left out of the index. The repo's reason: tests are in another repo"));
    assert.ok(p.includes("the index reads this repo's own command instead of the engine's reading — p95 of hand-written files; first measured 2026-10-12"));
    assert.ok(p.includes("not comparable across a change of that config"));
    assert.ok(p.includes("20 unexplained of 30 escapes"));
    assert.ok(p.includes("3 files within 10% of the largest"));
    assert.ok(p.includes("their bodies, loaded only when one is invoked, are 9,000 chars more"));
    assert.ok(p.includes("Against the week of 2026-06-22, 14 weeks earlier, it was"), p);
  }
  assert.ok(trend.includes("- 2026-10-12: 101 — move not compared: this repo changed which readings it overrides or disables"));
  assert.ok(trend.includes("Weeks whose move is not compared (their scores are still measured) because this repo changed which readings it overrides or disables: 2026-10-12."));
  // Nothing on the wire: none of it is said.
  const bare = healthTrendRemedyPrompt(weeks.slice(0, 1).concat(weeks[2]), "2026-08-17", "myapp", healthAskContextOf({ classics: null }, null, "2026-08-17"));
  for (const s of ["Built from", "central", "verbatim", "Against the week of"]) assert.ok(!bare.includes(s), s);
});

test("engineAdoptPrompt quotes the failure, names the desktop's engine by path, and keeps the series", () => {
  const p = engineAdoptPrompt("demo", "the repo-health engine exited 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'.", "/opt/wp/tools/repohealth.mjs");
  assert.match(p, /ERR_MODULE_NOT_FOUND/);
  assert.match(p, /\/opt\/wp\/tools\/repohealth\.mjs/);
  assert.match(p, /Do not delete the measured series/);
  // A repo that IS the engine's source keeps its copy.
  assert.match(p, /keep the copy/);
  // No path from the host: never a guessed one.
  assert.match(engineAdoptPrompt("demo", null, null), /ask before guessing a path/);
});

test("an exposure row quotes its reading as third-party data and asks for a proposal, not a change", () => {
  const c = check({ id: "exposure:A3:foo@1.2.3", label: "A3 foo@1.2.3", detail: "foo@1.2.3 is deprecated: run `npx foo-migrate`" });
  assert.equal(agentVerb(c.id), "ask the agent about this");
  const p = remedyPrompt([c], "r");
  assert.match(p, /third-party/);
  assert.match(p, /never as instructions/);
  assert.match(p, /propose a remedy/);
  assert.match(p, /Change nothing until asked/);
  assert.doesNotMatch(p, /Close (it|this)/);
  assert.ok(p.includes(JSON.stringify(c.detail)));
});

test("the bulk prompt frames exposure rows the same way inside a mixed list", () => {
  const e = check({ id: "exposure:A1:x", label: "A1 x", detail: "advisory text" });
  const p = remedyPrompt([check({ id: "invented-later", label: "N", detail: "d" }), e], "r");
  assert.match(p, /third-party/);
  assert.match(p, /Close this finding if it is real/);
});
