/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import type { AssessInput, AssessItem, AssessNote, Intent } from "@waterplane/shared";
import { ASSESS_IN_FILE, ASSESS_OUT_FILE, ASSESS_PLAN_FILE, ITEM_CATEGORIES, MAX_HEADLINE_CHARS, MAX_MERGE_SIZE, MAX_NEW, MIN_MERGE_SIZE } from "@waterplane/shared";
import { ASSESSABLE_STATES, ASSESS_CONTEXT_MAX, CONTEXT_STATES } from "./hassknobs.js";
import { promptText } from "../prompts.js";

// ── What goes in ─────────────────────────────────────────────────────────────

/**
 * The `<state dir>/assess-in.json` document: everything addressable by this `cwd`.
 *
 * Two stores, because since the give-ups ledger was folded into Activity there
 * are two: the intents the host holds for this repo, and the pad notes carrying
 * this `cwd`. A note is not a send that gave up — `retireToPad` is gone and a
 * failed row keeps its own words — it is a thought written with no target that
 * named a repo anyway, and skipping those re-asks the question the whole rework
 * was about.
 *
 * The split between `assessable` and `context` is the load-bearing part.
 * Finished, running and cancelled rows go in so the CLI can see what already
 * ran — that is how it tells that the item next to them was quietly
 * implemented — but `cleanAssessment` drops any verdict naming one. A row that
 * is mid-flight is not a candidate for retirement either: it is being worked on
 * right now.
 *
 * A chain's steps are joined rather than dropped: `steps[0]` is what everything
 * that reads an intent as one prompt uses, and a triage that judged an item by
 * its first turn alone would judge half of it.
 */
export function buildAssessInput(
  cwd: string,
  intents: readonly Intent[],
  notes: readonly AssessNote[],
  now: number,
  /**
   * **The cut this run was asked about.** Absent (or empty) is the whole repo —
   * every run before this parameter, and every run an older client starts.
   *
   * It narrows what may be JUDGED and deliberately nothing else. The finished
   * rows still go in as context, because they are the evidence a verdict rests
   * on rather than candidates for one — `cleanAssessment` already drops any
   * verdict naming one, so widening the context cannot widen the answer, while
   * narrowing it would make the scoped run a WORSE judge of the very rows it
   * was pointed at. "Assess these seven" is a question about seven rows, not an
   * instruction to forget what the repo has already done.
   *
   * Pad notes drop out of a scoped run for the opposite reason: they are
   * candidates, they carry no id the caller could have named on that screen,
   * and a count on a control has to equal the set the tap acts on. A scoped run
   * that also judged three notes nobody could see would be a button saying 7
   * and a proposal about 10.
   */
  ids?: readonly string[],
): AssessInput {
  const items: AssessItem[] = [];
  const context: AssessItem[] = [];
  const scope = ids && ids.length ? new Set(ids) : null;

  for (const i of intents) {
    if (!i || i.cwd !== cwd) continue;
    // A build run has no prose and is not a piece of work anyone can judge as
    // "still worth doing" — it is a command that either runs or does not.
    if (i.payload.kind !== "prompt") continue;
    const text = i.payload.steps.join("\n\n").trim();
    if (!text) continue;
    const row: AssessItem = {
      id: i.id,
      source: "intent",
      text,
      state: i.state,
      label: i.label,
      createdAt: i.createdAt,
      // WHICH failure this run is looking at — see `AssessItem.failedAt`.
      //
      // `state: "failed"` is a state and not an event: this document is written
      // at the start of a run a person applies twenty minutes later, and in
      // between the row can have been put back, run, and failed again on
      // something else. Applying *still wanted* then re-runs work on the
      // strength of a failure that is no longer the row's and that nobody has
      // read. So the instant travels, and `applyProposal` compares it with what
      // is on disk.
      //
      // Stamped only on a FAILED row, because `applyAssessment` only ever puts a
      // failed one on `AssessMutations.requeue` — a `done` row's `settledAt`
      // under this name would be a fact about a different question. Absent where
      // there is no stamp at all (a row written by an older build), and absence
      // is applied exactly as it was before this field existed.
      ...(i.state === "failed" && i.settledAt != null ? { failedAt: i.settledAt } : {}),
    };
    // The scope applies to CANDIDATES only — see the parameter's own note.
    if (ASSESSABLE_STATES.has(i.state)) { if (!scope || scope.has(i.id)) items.push(row); }
    else if (CONTEXT_STATES.has(i.state)) context.push({ ...row, context: true });
  }

  // A note has no id the caller could have named on the backlog screen, so a
  // scoped run leaves them out rather than judging rows its count did not
  // include.
  if (!scope) {
    for (const n of notes) {
      const text = typeof n?.text === "string" ? n.text.trim() : "";
      if (!n?.id || !text) continue;
      items.push({ id: n.id, source: "note", text, createdAt: n.createdAt });
    }
  }

  context.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return {
    version: 1, at: now, cwd,
    items: [...items, ...context.slice(0, ASSESS_CONTEXT_MAX)],
    ...(scope ? { scopedIds: [...scope] } : {}),
  };
}

/**
 * **The judging guidance** — the verdict vocabulary, the evidence rule and the
 * pad-note rule: the part of the kickoff a fork may reword, as
 * `<config dir>/prompts/assess-guidance.md` (`prompts.ts`). Everything else in
 * `assessPrompt` is contract — the file names, the interpolated caps, the JSON
 * shape `cleanAssessment` reads — and stays in code. An override must keep the
 * five verdict words and the evidence rule: the parser enforces both.
 *
 * On the pad-note paragraph:
 * **Said out loud, because the answer now has somewhere to GO.**
 * A `wanted` verdict on a note is offered back to the person as a backlog
 * item carrying the note's own words — copied by `cleanAssessment`, never
 * by the CLI — so a run that also writes the note out under "new" produces
 * the same sentence twice on one sheet. The pure layer drops the copy; the
 * prompt is where it stops being written in the first place.
 */
export const ASSESS_GUIDANCE = [
  "Read that file, then work the repo — git log, the code each item names, the tests — and decide, per open item, exactly one of:",
  "  done        the behaviour exists in the codebase now",
  "  obsolete    what it targeted is gone, or its premise no longer holds",
  "  superseded  another item in the list already covers it (name that item's id in supersededBy)",
  "  wanted      still worth doing",
  "  unclear     you could not tell",
  "",
  'Items with "source": "note" are notes from the person\'s pad that name this repo. Judge them like the rest; "wanted" on one means the app offers it to the person as a backlog item in its own words — do not restate a note under "new".',
  "",
  "EVIDENCE IS REQUIRED for done, obsolete and superseded: a path:line, a commit, or one sentence saying exactly what changed.",
  "A verdict with no citation is REJECTED by the app and the item is left undecided, so do not guess —",
  '"unclear" costs nothing, and a wrong "done" retires words somebody wrote and cannot get back.',
  'Items marked "context": true are there for you to read; do not return verdicts for them.',
].join("\n");

/**
 * The kickoff prompt. Four paragraphs, and deliberately no items.
 *
 * It states the vocabulary, that evidence is REQUIRED and that a claim without
 * one is rejected rather than quietly softened, the merge rules and the caps —
 * so a group the pure layer would drop is one the CLI knew not to propose. The
 * caps are interpolated from the shared constants for the obvious reason: a
 * prompt that teaches a limit the parser does not enforce is worse than no
 * prompt at all.
 */
export function assessPrompt(input: AssessInput): string {
  const n = input.items.filter((i) => !i.context).length;
  const ctx = input.items.length - n;
  return [
    `Assess what is left to do in this repo. ${ASSESS_IN_FILE} lists ${n} open item(s)` +
      (ctx ? ` plus ${ctx} already-finished item(s) marked "context": true` : "") +
      `, each with an id and the words a person actually wrote.`,
    // **Said out loud, because otherwise the CLI infers the wrong thing.**
    // A scoped run hands over a file listing seven open items in a repo whose
    // git history plainly shows sixty-two, and a model reading that gap without
    // being told about it has one obvious explanation available: the other
    // fifty-five were finished. That reading produces confident `done` verdicts
    // for rows nobody asked about and, worse, `superseded` pointing at ids that
    // are not in the file — which the pure layer then downgrades, turning a
    // scoped run into a pile of `unclear`. The repo is still the evidence; the
    // list is just not all of it.
    ...(input.scopedIds?.length
      ? [
        "",
        `This is a SCOPED run: the open items above are a subset a person chose, not everything open in this repo.`,
        "Other open work exists and is deliberately not listed. Judge only what is in the file, and do not read the",
        "absence of an item as evidence that it was finished.",
      ]
      : []),
    "",
    promptText("assess-guidance", ASSESS_GUIDANCE),
    "",
    `You may also propose MERGE GROUPS: ${MIN_MERGE_SIZE} to ${MAX_MERGE_SIZE} items that are facets of ONE piece of work, with a prompt`,
    "you write to cover all of them and a rationale saying why they are one job. An id may appear in at most one group and must",
    "carry no other verdict; a group outside that size, or with an empty prompt, is dropped and its items keep their own words.",
    `You may add up to ${MAX_NEW} genuinely missing pieces under "new". Do not restate existing items as new ones.`,
    "",
    // ── What each thing is CALLED ──────────────────────────────────────────
    //
    // Every cap here is INTERPOLATED from the shared constants the parser
    // enforces (`MAX_HEADLINE_CHARS`, `ITEM_CATEGORIES`), which is this file's
    // existing rule about the merge sizes applied to one more pair of limits: a
    // prompt that teaches a limit the parser does not enforce is worse than no
    // prompt at all, because the model complies with the wrong number and the
    // app silently throws the answer away.
    //
    // "not simply the item's first words" is said out loud because it is the one
    // thing `cleanHeadline` REFUSES outright rather than clips — a title that is
    // a truncation of the prose under it is not a title, and a run that spends a
    // repo read producing eighty of them produces eighty drops and one note.
    // "never guess" is the same posture `cleanCategory` takes: four words and no
    // synonyms, so a fifth reads as nothing rather than as the nearest of the
    // four.
    `For EVERY open item, merge group and new item also give \`headline\` — a title of 3 to 8 words, at most ${MAX_HEADLINE_CHARS} characters,`,
    `that is not simply the item's first words — and \`category\`, exactly one of ${ITEM_CATEGORIES.join(" | ")}.`,
    "Leave `category` out if none fits; never guess.",
    "",
    `Then write BOTH of these files, each in ONE write, and change nothing else in the repo:`,
    "",
    `${ASSESS_OUT_FILE} — JSON only, no prose, no code fence:`,
    '{"items":[{"id":"<id>","verdict":"done|obsolete|superseded|merged|wanted|unclear","evidence":"<citation>","rank":1,"supersededBy":"<id>","headline":"<title>","category":"bug|feature|enhancement|chore"}],',
    ' "merges":[{"gid":"g1","ids":["<id>","<id>"],"prompt":"<the prompt that covers them>","rank":1,"rationale":"<why they are one job>","headline":"<title>","category":"bug|feature|enhancement|chore"}],',
    ' "new":[{"prompt":"<the missing piece, ready to run>","rank":1,"headline":"<title>","category":"bug|feature|enhancement|chore"}]}',
    'Every open item must appear in "items". "rank" is an integer sort position over the wanted set — the order to work them in, 1 first.',
    "",
    `${ASSESS_PLAN_FILE} — the reasoning, in order, for a person and for the next agent in this repo: what you found, what you`,
    "retired and on what evidence, what stayed ambiguous and why, and the sequence you would work the rest in.",
  ].join("\n");
}