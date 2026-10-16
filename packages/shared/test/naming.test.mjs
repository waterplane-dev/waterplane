// What a machine may CALL somebody else's words (`shared/src/naming.ts`).
//
// A headline is the one string in this app that a model writes FOR a person,
// over words the person wrote — it sits on top of a row in a list and is what a
// reader scans instead of the sentence underneath it. So every case below is
// about that string knowing its place: it is dropped when it is merely the
// first words of its own item (the title that is really a truncation), the kind
// beside it is one of four words and is never guessed at from a near miss, and
// a row named twice keeps neither name.
//
// Pure, so all of it runs from literals against `shared/dist` with no host,
// nothing spawned and no clock.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ITEM_CATEGORIES,
  MAX_HEADLINE_CHARS,
  MAX_NAMING_NOTES,
  NAME_AUTHORS,
  NO_CATEGORY_LABEL,
  categoryLabel,
  categoryRefusedText,
  cleanAuthor,
  cleanCategory,
  cleanHeadline,
  cleanNamingDoc,
  cleanTabTitle,
  cleanCommitMessage,
  MAX_COMMIT_CHARS,
  MAX_COMMIT_SUBJECT,
  MAX_TAB_CHARS,
  MAX_TAB_WORDS,
  headlineRefusedText,
  itemHeadline,
  branchLabel,
  trimDefaultBranch,
  isDefaultBranch,
  repoBranchLabel,
  sessionName,
  sessionPickLabel,
} from "../dist/index.js";

// ── cleanHeadline ────────────────────────────────────────────────────────────

test("a title arrives dressed up, and the dressing is not part of the title", () => {
  // A model writes quoted, full-stopped, ragged prose. Refusing a whole naming
  // run over punctuation just means the user pays for the run twice.
  assert.equal(cleanHeadline('  "Uploader drops big files"  ', "some unrelated words"), "Uploader drops big files");
  assert.equal(cleanHeadline("Uploader drops big files.", "some unrelated words"), "Uploader drops big files");
  assert.equal(cleanHeadline("Uploader\n  drops   big files", "some unrelated words"), "Uploader drops big files");
  assert.equal(cleanHeadline("“Uploader drops big files”", "some unrelated words"), "Uploader drops big files");
});

test("an ellipsis is a model saying the title was cut off, and is not repaired into a typo", () => {
  // Stripping one period off "…" would leave ".." — the claim kept, dressed as
  // a mistake. Only a full stop standing alone goes.
  assert.equal(cleanHeadline("Uploader drops big files...", "unrelated"), "Uploader drops big files...");
});

test("a headline is a LABEL, so it is clipped and never dropped for length", () => {
  // The opposite of a prompt, which is dropped rather than cut short: half a
  // title is still a title, half an instruction is a different instruction.
  const long = `${"x".repeat(MAX_HEADLINE_CHARS + 40)}`;
  const out = cleanHeadline(long, "unrelated words");
  assert.equal(out.length, MAX_HEADLINE_CHARS);
  assert.equal(out, "x".repeat(MAX_HEADLINE_CHARS));
});

test("nothing is not a title", () => {
  assert.equal(cleanHeadline("", "unrelated"), undefined);
  assert.equal(cleanHeadline("   \n\t ", "unrelated"), undefined);
  assert.equal(cleanHeadline('""', "unrelated"), undefined);
  assert.equal(cleanHeadline(undefined, "unrelated"), undefined);
  assert.equal(cleanHeadline(42, "unrelated"), undefined);
});

test("a title that is only the first words of its own item is not a title", () => {
  // The failure this rule exists for: the same string twice on one card, cut
  // once by the slice and again by CSS ellipsis, the top copy being the less
  // useful of the two truncations.
  const text = "fix the uploader so it stops dropping files over ten megabytes";
  assert.equal(cleanHeadline("fix the uploader so it stops", text), undefined);
  // …and a real reading of those same words survives untouched.
  assert.equal(cleanHeadline("Uploader drops files over 10 MB", text), "Uploader drops files over 10 MB");
});

test("a title that OPENS with the whole of a short item is still a title", () => {
  // The rule borrowed `typedName`'s SECOND clause, which refuses a name that
  // starts with the text's own leading slice. That clause is right about a NAME
  // slot, which this app fills with `text.slice(0, 40)` when nobody typed one —
  // and wrong about a headline, which is never derived that way. The cost was
  // every title for a prompt under 40 characters that opened with the prompt:
  // refused, and (until `edit()` learned to say so) refused in silence.
  assert.equal(cleanHeadline("dark mode toggle for settings", "dark mode"), "dark mode toggle for settings");
  assert.equal(cleanHeadline("scroll restore on rotate", "scroll"), "scroll restore on rotate");
  // The one direction that still means "this is a truncation of the item" is
  // unchanged, at any length.
  assert.equal(cleanHeadline("dark mode", "dark mode toggle for settings"), undefined);
});

test("the truncation test survives the item's own line breaks", () => {
  // The title is whitespace-collapsed before the comparison, so the text has to
  // be too — otherwise a prompt that wraps between two of its own opening words
  // reads as a different string and the truncation goes straight through.
  assert.equal(cleanHeadline("fix the uploader", "fix the\n  uploader so it stops dropping files"), undefined);
});

test("a row with no prose at all still gets to have a name", () => {
  // A build or a capture has no words to be a truncation of, and without this
  // every such row would be reported as a truncation of nothing.
  assert.equal(cleanHeadline("Nightly build", ""), "Nightly build");
});

// ── the refusals, as sentences ───────────────────────────────────────────────

test("a typed title this app will not write is REFUSED IN WORDS, naming what it was", () => {
  // The quiet half of "never overwrite typed words with words nobody typed":
  // never DROP typed words without saying so. `edit()` used to write nothing
  // and answer `true`, so the editor closed over a title that was gone.
  const said = headlineRefusedText("  fix the   uploader  ");
  assert.match(said, /^"fix the uploader"/, "it quotes the title, since a screen may hold two of them");
  assert.match(said, /already starts/);
  assert.match(said, /was kept$/, "…and says what became of the one that was there — refusing is not clearing");
});

test("a kind that is not one of the four says the four, never a guess at which was meant", () => {
  const said = categoryRefusedText("bugfix");
  assert.match(said, /^"bugfix"/);
  assert.match(said, /bug\/feature\/enhancement\/chore/);
  assert.doesNotMatch(said, /did you mean/i, "there is no synonym table here and no sentence that implies one");
});

// ── cleanCategory / cleanAuthor ──────────────────────────────────────────────

test("the four words, however they are capitalised", () => {
  for (const c of ITEM_CATEGORIES) {
    assert.equal(cleanCategory(c), c);
    assert.equal(cleanCategory(`  ${c.toUpperCase()}  `), c);
  }
  assert.deepEqual([...ITEM_CATEGORIES], ["bug", "feature", "enhancement", "chore"]);
});

test("a near miss is NOT rounded to the nearest kind — there is no synonym table", () => {
  // A synonym table is a second vocabulary, and a second vocabulary is how
  // "nobody said" becomes "chore" for every row nobody looked at. A row filed
  // under a heading its author never chose is a row they will not find.
  assert.equal(cleanCategory("bugfix"), undefined);
  assert.equal(cleanCategory("defect"), undefined);
  assert.equal(cleanCategory("improvement"), undefined);
  assert.equal(cleanCategory("features"), undefined);
  assert.equal(cleanCategory(""), undefined);
  assert.equal(cleanCategory(null), undefined);
});

test("an author is one of three or nobody, because `hand` is what makes a title safe", () => {
  for (const a of NAME_AUTHORS) assert.equal(cleanAuthor(a), a);
  assert.deepEqual([...NAME_AUTHORS], ["hand", "assess", "name"]);
  assert.equal(cleanAuthor("user"), undefined);
  assert.equal(cleanAuthor("machine"), undefined);
  assert.equal(cleanAuthor(true), undefined);
});

// ── cleanNamingDoc ───────────────────────────────────────────────────────────

const doc = (items) => ({ items });

test("a name for a row nobody asked about is dropped, and said out loud once", () => {
  const out = cleanNamingDoc(doc([
    { id: "a", headline: "Uploader drops files", category: "bug" },
    { id: "ghost", headline: "Something else entirely" },
  ]), ["a"]);
  assert.deepEqual(out.names, { a: { headline: "Uploader drops files", category: "bug" } });
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /1 name\(s\) were for items that were not in the list/);
});

test("a row named twice keeps neither name", () => {
  // `cleanAssessment`'s duplicate rule. Two titles say two things about what
  // the row is; picking the first is picking at random, and the words on the
  // row are still there to be read.
  const out = cleanNamingDoc(doc([
    { id: "a", headline: "Uploader drops files", category: "bug" },
    { id: "a", headline: "Retry logic is wrong", category: "chore" },
  ]), ["a"]);
  assert.deepEqual(out.names, {});
  assert.match(out.notes.join(" "), /named more than once/);
});

test("the notes are AGGREGATED — one per kind of drop, with a count", () => {
  // A naming run touches every row in a repo, so one note per bad row would be
  // a scroll in place of a sheet. The fact worth showing is how many.
  const out = cleanNamingDoc(doc([
    { id: "g1", headline: "x" }, { id: "g2", headline: "y" }, { id: "g3", headline: "z" },
    { id: "a", category: "bugfix" },
    { id: "b", category: "defect" },
  ]), ["a", "b"]);
  assert.equal(out.notes.length, 2);
  assert.match(out.notes[0], /^3 name\(s\) were for items that were not in the list/);
  assert.match(out.notes[1], /^2 kind\(s\) were not one of bug\/feature\/enhancement\/chore/);
});

test("a title that is only the first words of its item is counted, not kept", () => {
  const items = [
    { id: "a", text: "fix the uploader so it stops dropping big files" },
    { id: "b", text: "rewrite the settings sheet from scratch" },
  ];
  const out = cleanNamingDoc(doc([
    { id: "a", headline: "fix the uploader so it stops" },
    { id: "b", headline: "rewrite the settings sheet" },
  ]), items);
  assert.deepEqual(out.names, {});
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /^2 headline\(s\) were only the first words of their item and were left off$/);
});

test("the notes are capped, the way every other refusal list here is", () => {
  // Unreachable by construction while the notes stay aggregated — which is the
  // point of pinning it: a future note added per ROW would show up here first.
  const out = cleanNamingDoc(doc(Array.from({ length: 500 }, (_, i) => ({ id: `ghost${i}`, headline: "x" }))), ["a"]);
  assert.equal(out.notes.length <= MAX_NAMING_NOTES, true);
});

test("a bare array and {rows:[…]} are the same document as {items:[…]}", () => {
  // Tolerant about SHAPE, strict about CLAIMS — the difference is the model's
  // and the cost would be the user's.
  const expect = { a: { headline: "Uploader drops files" } };
  assert.deepEqual(cleanNamingDoc([{ id: "a", headline: "Uploader drops files" }], ["a"]).names, expect);
  assert.deepEqual(cleanNamingDoc({ rows: [{ id: "a", headline: "Uploader drops files" }] }, ["a"]).names, expect);
  assert.deepEqual(cleanNamingDoc({ items: [{ id: "a", title: "Uploader drops files" }] }, ["a"]).names, expect);
});

test("junk in, no names and no throw", () => {
  assert.deepEqual(cleanNamingDoc(null, ["a"]), { names: {}, notes: [] });
  assert.deepEqual(cleanNamingDoc("nope", ["a"]), { names: {}, notes: [] });
  assert.deepEqual(cleanNamingDoc({ items: [7, null, { id: "" }] }, ["a"]), { names: {}, notes: [] });
});

test("a row the run had nothing usable to say about is absent, never an empty name", () => {
  // Absent means nobody said. An `{}` under an id would be a name a reader has
  // to open to discover is not one.
  const out = cleanNamingDoc(doc([{ id: "a", headline: "  ", category: "bugfix" }]), ["a"]);
  assert.deepEqual(out.names, {});
});

// ── itemHeadline ─────────────────────────────────────────────────────────────

test("a name a PERSON typed beats the machine's, always", () => {
  assert.equal(
    itemHeadline({ label: "Uploader", text: "fix the uploader", headline: "Uploader drops big files" }),
    "Uploader",
  );
});

test("a label that is only a slice of the row's own prose loses to a real headline", () => {
  // The backlog derives a name by slicing the text at 40 when nobody typed one,
  // so most `label`s are truncations rather than names — and a truncation is
  // exactly what a headline is there to replace.
  const text = "fix the uploader so it stops dropping files over ten megabytes on a slow tunnel";
  const it = { label: text.slice(0, 40), text, headline: "Uploader drops files over 10 MB" };
  assert.equal(itemHeadline(it), "Uploader drops files over 10 MB");
});

test("no name of either kind is null, never the words", () => {
  // The caller decides whether a nameless row shows its first line or shows
  // nothing; what must not differ by screen is which of the two strings wins.
  assert.equal(itemHeadline({ text: "fix the uploader" }), null);
  assert.equal(itemHeadline({ label: "  ", text: "fix the uploader", headline: "  " }), null);
});

// ── The words ────────────────────────────────────────────────────────────────

test("a kind becomes a word in exactly one place, and 'nobody said' has its own", () => {
  for (const c of ITEM_CATEGORIES) assert.equal(typeof categoryLabel(c), "string");
  assert.equal(categoryLabel("bug"), "bug");
  assert.equal(categoryLabel("enhancement"), "enhancement");
  // Absent is an answer with its own word — never a fifth category, and never
  // "chore" standing in for a row nobody looked at.
  assert.equal(NO_CATEGORY_LABEL, "no kind");
  assert.equal(ITEM_CATEGORIES.includes(NO_CATEGORY_LABEL), false);
});

// ── cleanTabTitle ────────────────────────────────────────────────────────────
//
// The other string a machine writes for a person here, in a quarter of the
// width: a session tab. Three words, and no truncation mark — a label that ends
// in an ellipsis in 90 px is a label claiming there is more to read when the
// whole point is that there is not.

test("a tab title is at most four words, and quotes and a full stop come off", () => {
  assert.equal(cleanTabTitle("tab strip"), "tab strip");
  assert.equal(cleanTabTitle('  "session tabs"  '), "session tabs");
  assert.equal(cleanTabTitle("session tabs."), "session tabs");
  assert.equal(cleanTabTitle("fixing the flaky upload test"), "fixing the flaky upload");
  // Four, because the session screen shows these words in full when it opens —
  // the tab clips to its own width either way.
  assert.equal(MAX_TAB_WORDS, 4);
});

test("words come off the END until the label fits, and a single long word is refused", () => {
  // Two of the three words is still a title; a strip-wide one is not, and
  // clipping it would put the truncation mark back on a label that is not prose.
  const long = cleanTabTitle("internationalization pipeline rewrite now");
  assert.ok(long.length <= MAX_TAB_CHARS, long);
  assert.equal(long, "internationalization pipeline");
  assert.equal(cleanTabTitle("internationalizationpipelinerewrite"), undefined);
});

test("it refuses rather than guesses — absent is what the tab survives", () => {
  assert.equal(cleanTabTitle(""), undefined);
  assert.equal(cleanTabTitle("   "), undefined);
  assert.equal(cleanTabTitle(undefined), undefined);
  assert.equal(cleanTabTitle(42), undefined);
  // A model saying it cut the answer off is not a title: the tab keeps the repo
  // and branch it already had rather than wearing a claim.
  assert.equal(cleanTabTitle("fixing the auth…"), undefined);
  assert.equal(cleanTabTitle("fixing the auth..."), undefined);
});

// ── The commit message a model wrote for a diff ─────────────────────────────
//
// Same posture as the tab title one level up: tolerant about the wrapper, hard
// about the two things that would put words nobody wrote into somebody's
// commit. It is the only string here that ends up in a repo's permanent record.

test("a fenced, quoted, labelled answer still yields the words", () => {
  assert.equal(cleanCommitMessage("```\nFix the auth token expiry check\n```"), "Fix the auth token expiry check");
  assert.equal(cleanCommitMessage('"Fix the auth token expiry check"'), "Fix the auth token expiry check");
  assert.equal(cleanCommitMessage("Subject: Fix the auth token expiry check"), "Fix the auth token expiry check");
  // A trailing full stop on a subject is a model finishing a sentence nobody
  // asked for; `git log` shows that line to everybody for ever.
  assert.equal(cleanCommitMessage("Fix the auth token expiry check."), "Fix the auth token expiry check");
});

test("the blank line between subject and body is PUT BACK", () => {
  // Without it git reads line 2 as part of the subject and `%s` shows the lot.
  assert.equal(cleanCommitMessage("Fix expiry\nIt used < where it wanted <=."),
    "Fix expiry\n\nIt used < where it wanted <=.");
  assert.equal(cleanCommitMessage("Fix expiry\n\n\n\nIt used < where it wanted <=."),
    "Fix expiry\n\nIt used < where it wanted <=.");
});

test("an attribution trailer never travels into a person's commit", () => {
  // The model reproduces these unasked, and on a commit somebody else is making
  // both are false claims about who wrote the change.
  const msg = cleanCommitMessage([
    "Fix expiry",
    "",
    "It used < where it wanted <=.",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    "Claude-Session: https://example.invalid/x",
  ].join("\n"));
  assert.equal(msg, "Fix expiry\n\nIt used < where it wanted <=.");
  assert.ok(!/co-authored/i.test(msg));
});

test("a refusal dressed as a message is refused, not committed", () => {
  for (const raw of ["I cannot see a diff here.", "Sorry, there is nothing to describe.", "", "   ", 7, null]) {
    assert.equal(cleanCommitMessage(raw), undefined, `${String(raw)} is not a commit message`);
  }
});

test("the subject REFUSES past its cap; the body is trimmed from the end", () => {
  // A subject is one line everybody reads for ever — cutting one mid-thought
  // writes a sentence nobody wrote, so the whole suggestion is dropped and the
  // box keeps what was typed in it.
  assert.equal(cleanCommitMessage("x".repeat(MAX_COMMIT_SUBJECT + 1)), undefined);
  assert.equal(cleanCommitMessage("x".repeat(MAX_COMMIT_SUBJECT)), "x".repeat(MAX_COMMIT_SUBJECT));
  const long = ["Fix expiry", "", ...Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(40)}`)].join("\n");
  const out = cleanCommitMessage(long);
  assert.ok(out.length <= MAX_COMMIT_CHARS, "it fits");
  assert.ok(out.startsWith("Fix expiry\n\nline 0 "), "the subject and the first body lines are what survive");
});

// ── branchLabel ──────────────────────────────────────────────────────────────

test("git's own two branch names say nothing, and a chosen one says something", () => {
  assert.equal(isDefaultBranch("main"), true);
  assert.equal(isDefaultBranch("MASTER"), true);
  assert.equal(isDefaultBranch(" main "), true);
  // Chosen names are kept, whatever a team happens to call home.
  for (const b of ["develop", "trunk", "mainline", "feature/main", "", null, 7]) {
    assert.equal(isDefaultBranch(b), false, `${String(b)} was chosen`);
  }
});

test("a worktree keeps its branch even when the branch is `main`", () => {
  // The primary's branch is the ordinary place; a worktree's branch is the only
  // thing telling it from its siblings, and RepoPicker titles the row with it.
  assert.equal(branchLabel({ branch: "main", isPrimary: true }), undefined);
  assert.equal(branchLabel({ branch: "main", isPrimary: false }), "main");
  assert.equal(branchLabel({ branch: "main" }), "main");
  assert.equal(branchLabel({ branch: "fix-ui", isPrimary: true }), "fix-ui");
  assert.equal(branchLabel({ branch: "  ", isPrimary: false }), undefined);
});

test("the repo line drops the separator with the branch, never leaving a dangling dot", () => {
  assert.equal(repoBranchLabel({ repoName: "myapp", branch: "main", isPrimary: true }), "myapp");
  assert.equal(repoBranchLabel({ repoName: "myapp", branch: "fix-ui", isPrimary: true }), "myapp \u00b7 fix-ui");
  assert.equal(repoBranchLabel({ repoName: "myapp", branch: "main", isPrimary: false }), "myapp \u00b7 main");
});

test("a title stored as `<repo> · main` loses the branch when it is DRAWN", () => {
  assert.equal(trimDefaultBranch("myapp \u00b7 main"), "myapp");
  assert.equal(trimDefaultBranch("myapp \u00b7 fix-ui"), "myapp \u00b7 fix-ui");
  // Only the last segment, and only with something in front of it.
  assert.equal(trimDefaultBranch("main"), "main");
  assert.equal(trimDefaultBranch("main \u00b7 myapp"), "main \u00b7 myapp");
  assert.equal(trimDefaultBranch("a \u00b7 b \u00b7 master"), "a \u00b7 b");
  assert.equal(trimDefaultBranch(undefined), "");
});

test("a session's derived name is the host's or nothing at all", () => {
  assert.equal(sessionName({ tabTitle: "fix the sheet" }), "fix the sheet");
  assert.equal(sessionName({ tabTitle: "  fix the sheet  " }), "fix the sheet");
  // Absent means the host has derived nothing. Never the repo wearing the
  // derived name's clothes — that is what made four pickers unanswerable.
  assert.equal(sessionName({}), "");
  assert.equal(sessionName({ tabTitle: "   " }), "");
});

test("one string picks a session: repo and branch first, the derived name after", () => {
  assert.equal(
    sessionPickLabel({ title: "myapp \u00b7 main", tabTitle: "fix the sheet" }),
    "myapp \u00b7 main \u00b7 fix the sheet");
  // With nothing derived it is exactly what it always was, and never a
  // trailing separator with nothing behind it.
  assert.equal(sessionPickLabel({ title: "myapp \u00b7 main" }), "myapp \u00b7 main");
  assert.doesNotMatch(sessionPickLabel({ title: "myapp", tabTitle: "  " }), /\u00b7/);
});
