// The question as the CLI itself wrote it, not as the terminal cut it.
//
// `AskUserQuestion` is a TOOL CALL: its question, every option label and every
// option's full description are written to the conversation jsonl the moment the
// assistant asks, before anyone answers. The screen's copy of that text is
// lossy in three ways at once — truncated at the right edge, cut again by the
// preview pane drawn beside the options, and on a tall box scrolled off
// entirely — which leaves the phone showing a one-tap button labelled
// "A + B + C" with the paragraph explaining it nowhere on the device.
//
// So the scraped box is ENRICHED from the log. The rules that must hold, and
// each of them is a way to get it silently wrong:
//   • only a PENDING call counts (a tool_result means that box is gone),
//   • matching is by LABEL, never by index — the TUI appends its own rows
//     ("Type something.", "Chat about this") after the tool's, and a truncated
//     box starts above 1,
//   • a label the terminal cut is a PREFIX of the real one, so containment runs
//     in that direction only,
//   • and nothing here may claim a box it does not recognise.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askMatches, descFor, pendingAskQuestions } from "../packages/host/dist/askbox.js";
import { E, SLUG } from "./lib-brand.mjs";

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

const home = mkdtempSync(join(tmpdir(), `${SLUG}-askbox-`));
process.env[E.CLAUDE_HOME] = home;
const CWD = "/Users/x/dev/demo";
const dir = join(home, ".claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });

const SID = "11111111-2222-3333-4444-555555555555";
const ask = (id, questions) => JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
});
const result = (id) => JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "answered" }] },
});
const noise = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking about AskUserQuestion" }] } });

const SCOPE = [{
  question: "Which scope should I build?",
  header: "Scope",
  multiSelect: false,
  options: [
    { label: "A + B + C (Recommended)", description: "Persist the closed stack, add an Archive sheet reading the on-disk jsonl per repo." },
    { label: "B only — Archive sheet", description: "New host module listing the CLI's own project logs, tap to resume." },
    { label: "A + C only", description: "Cheap: persist recentlyClosed to <state>/closed.json, raise the caps." },
    { label: "Nothing yet — just the answer", description: "You wanted to know the state of play, not a build." },
  ],
}];

const write = (...lines) => writeFileSync(join(dir, SID + ".jsonl"), lines.join("\n") + "\n");

// -- A pending call is the box on screen --
write(noise, ask("toolu_1", SCOPE));
let got = pendingAskQuestions(CWD, SID);
check(got.length === 1, "the pending AskUserQuestion is found");
check(got[0]?.question === "Which scope should I build?", "the question is the CLI's own, not a scrape");
check(got[0]?.header === "Scope", "the header rides along");
check(got[0]?.options.length === 4, "every option is there");
check(got[0]?.options[0].desc?.startsWith("Persist the closed stack"),
  "...each with the description the terminal truncated");
// The one handle on a box that a repaint cannot move (`prompt.ts`'s `sameBox`):
// the CALL's id and WHICH of its questions this is. The `#n` is load-bearing —
// one AskUserQuestion may carry several questions and the TUI draws them one at
// a time, so the tool_use id alone would call two different boxes one box.
check(got[0]?.id === "toolu_1#0", `a question is named by its call and its place in it (got ${got[0]?.id})`);
write(noise, ask("toolu_multi", [SCOPE[0], { question: "And then?", options: [{ label: "Left" }, { label: "Right" }] }]));
check(JSON.stringify(pendingAskQuestions(CWD, SID).map((q) => q.id)) === JSON.stringify(["toolu_multi#0", "toolu_multi#1"]),
  "two questions of one call are two boxes");

// -- Answered means gone. Enriching a box that has been answered would put the
//    previous question's words under the CURRENT one's buttons. --
write(noise, ask("toolu_1", SCOPE), result("toolu_1"));
check(pendingAskQuestions(CWD, SID).length === 0, "an answered call is not pending");

// -- Newest pending wins: a box re-asked after a refusal leaves the older one
//    stranded in the same window. --
const OTHER = [{ question: "Delete it?", options: [{ label: "Yes", description: "Gone." }, { label: "No", description: "Kept." }] }];
write(ask("toolu_1", OTHER), ask("toolu_2", SCOPE));
check(pendingAskQuestions(CWD, SID)[0]?.question === "Which scope should I build?", "the newest pending call wins");

// -- No conversation id (a session whose claude id isn't known yet) reads nothing
//    rather than guessing at a file. --
check(pendingAskQuestions(CWD, undefined).length === 0, "no conversation id ⇒ no enrichment, never a guess");
check(pendingAskQuestions(CWD, "no-such-session").length === 0, "a missing log is not an error");

// -- Multi-select rides along: a digit TOGGLES there, which the phone must know. --
write(ask("toolu_3", [{ question: "Which?", multiSelect: true, options: [{ label: "One" }, { label: "Two" }] }]));
check(pendingAskQuestions(CWD, SID)[0]?.multi === true, "multiSelect is carried");

// -- Matching the logged question to the scraped box --
write(ask("toolu_1", SCOPE));
const q = pendingAskQuestions(CWD, SID)[0];
// The TUI's own rows are appended after the tool's, and the terminal cut the
// long labels — this is exactly what `prompt.ts` hands over.
const SCRAPED = ["A + B + C (Recommended)", "B only — Archive sheet", "A + C only", "Nothing yet — just the answer", "Type something.", "Chat about this"];
check(askMatches(q, SCRAPED), "the logged question matches the scraped box despite the TUI's extra rows");
check(descFor(q, "A + C only")?.startsWith("Cheap:"), "a label finds its own description");
check(descFor(q, "Type something.") === undefined, "a row the TUI added has none, and invents none");

// A label the terminal CUT still resolves — containment runs prefix-only, in the
// direction truncation actually works.
check(descFor(q, "Nothing yet — just the ans")?.startsWith("You wanted"),
  "a label the terminal truncated still finds its description");
check(descFor(q, "A + ") === undefined, "...but a stub too short to identify anything matches nothing");

// A different box entirely must not be claimed. One shared label is not enough:
// two questions in a row can both offer "Yes".
check(!askMatches(q, ["Yes", "No"]), "a different box is not claimed");
const yn = { question: "Delete it?", options: [{ label: "Yes" }, { label: "No" }] };
check(!askMatches(yn, ["Yes", "Keep everything", "Cancel"]), "one shared label is not a match");
check(askMatches(yn, ["Yes", "No"]), "...both of them is");

rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
