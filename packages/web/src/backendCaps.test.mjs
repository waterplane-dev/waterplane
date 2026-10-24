/**
 * The backend-capability slice, pinned without a browser.
 *
 * `backendCaps.ts` has no DOM and no value imports, so it runs the way
 * `setupRemedy.test.mjs` runs — `node --test` straight over the TypeScript.
 *
 *     node --test packages/web/src/backendCaps.test.mjs
 *
 * Three of these are rules the UI states in prose and would break silently:
 *
 *  - **No `backends` frame ⇒ no picker, and no `backend` on the wire.** A new
 *    phone talking to an old desktop must look and behave exactly as it did,
 *    and must never ask that desktop to spawn a binary it has never heard of.
 *  - **An absent capability is a SENTENCE naming the backend's own label** —
 *    never a greyed control, and never the literal "othercli" baked in, or a
 *    third backend reads as the second one.
 *  - **An unknown context window renders nothing.** Not 0, not claude's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_EFFORTS, freeTextNote,
  backendIdOf, backendMark, capReason, effortChoices, hasCap, launchFor, launchModeDropNote,
  HOSTED_DISCLAIMER, ZERO_COST_DISCLAIMER, isZeroCost,
  backendDrift, backendUnavailable, backendOptionLabel, sideChannelLine,
  launchAskStart, modelChoices, modelGroups, permModeChoices, launchModeChoices, sessionCants, shouldAskLaunch, showBackendPicker,
  showWhereFilter, windowNote,
  agentBackends, agentTabLabel, isShellBackend, shellBackend, shellQuietLine,
} from "./backendCaps.ts";

const caps = (o = {}) => ({
  contextMeter: true, usageLimits: true, transcript: true, slash: true,
  promptBoxes: true, hooks: true, effort: true, remoteControl: true,
  permissionModes: ["default", "plan"],
  ...o,
});

const CLAUDE = {
  id: "claude", label: "Claude Code", caps: caps(),
  models: { aliases: ["opus", "sonnet"], ids: ["claude-opus-4-8"] },
  contextWindowTokens: 200000,
};

/** The measured shape of the second backend: no gauge, no quota, no log, no
 *  choice boxes, no hooks, no effort knob, ids carrying a slash AND a colon,
 *  and — the point of the field being optional — no known window size. */
const OPENCODE = {
  id: "othercli", label: "othercli",
  caps: caps({ contextMeter: false, usageLimits: false, transcript: false, slash: false,
    promptBoxes: false, hooks: false, effort: false, remoteControl: false, permissionModes: [] }),
  models: { aliases: [], ids: ["ollama/qwen3-coder:30b", "anthropic/claude-sonnet-4-5"] },
};

const BOTH = [CLAUDE, OPENCODE];

test("no backends frame ⇒ no picker at all, and one backend is not a choice", () => {
  // null is "this host never said" — an OLD desktop. Not an empty list.
  assert.equal(showBackendPicker(null), false);
  assert.equal(showBackendPicker([]), false);
  assert.equal(showBackendPicker([CLAUDE]), false);
  assert.equal(showBackendPicker(BOTH), true);
});

test("with no frame every control behaves exactly as it did before backends existed", () => {
  for (const cap of ["contextMeter", "usageLimits", "transcript", "slash", "promptBoxes", "hooks", "effort", "remoteControl"]) {
    assert.equal(hasCap(null, undefined, cap), true, cap);
    assert.equal(capReason(null, undefined, cap), null, cap);
  }
  // No frame ⇒ no catalogue to read, and none is invented: a typed field + a sentence.
  assert.deepEqual(modelChoices(null), { aliases: [], ids: [], freeText: true });
  assert.match(freeTextNote(null), /not listed its models yet/);
  assert.match(freeTextNote(BOTH, "claude"), /did not name its models/);
  assert.deepEqual(effortChoices(null), CLAUDE_EFFORTS);
  assert.equal(backendMark(null, "othercli"), null);
});

test("an absent backend id means claude, which is a known value and wears no marker", () => {
  assert.equal(backendIdOf({}), "claude");
  assert.equal(backendIdOf({ backend: "othercli" }), "othercli");
  assert.equal(backendMark(BOTH, undefined), null);
  assert.equal(backendMark(BOTH, "claude"), null);
  assert.equal(backendMark(BOTH, "othercli"), "othercli");
  // A backend this host never described is not a marker either — the row looks
  // exactly as it always has rather than naming a string we cannot vouch for.
  assert.equal(backendMark(BOTH, "cline"), null);
});

test("an absent capability is a sentence that names the backend by its own label", () => {
  const t = capReason(BOTH, "othercli", "transcript");
  assert.match(t, /^this session runs othercli, which keeps no Claude conversation log/);
  assert.match(t, /terminal scrollback is still on this screen/);

  const c = capReason(BOTH, "othercli", "contextMeter");
  assert.match(c, /^othercli doesn’t print a context gauge/);
  // A claim of NON-measurement, never a figure — the rule the whole descriptor
  // exists to make structural.
  assert.doesNotMatch(c, /\d/);

  // The label, not the id, and not a literal: a third backend must read right
  // with no edit to the wording.
  const third = [{ ...OPENCODE, id: "cline", label: "Cline" }];
  assert.match(capReason(third, "cline", "transcript"), /^this session runs Cline,/);
  assert.doesNotMatch(capReason(third, "cline", "contextMeter"), /othercli/);

  // A backend that HAS the capability gets no sentence — the control is drawn.
  assert.equal(capReason(BOTH, "claude", "transcript"), null);
  assert.equal(capReason(BOTH, "claude", "contextMeter"), null);
});

test("no sentence anywhere carries a usage-limit banner phrase", () => {
  // Printing one inside a session false-positives `limit.ts` repo-wide.
  for (const cap of ["contextMeter", "usageLimits", "transcript", "slash", "promptBoxes", "hooks", "effort", "remoteControl"]) {
    const s = capReason(BOTH, "othercli", cap) ?? "";
    assert.doesNotMatch(s, /(?:session|weekly|5-hour|usage) limit (?:reached|hit|exceeded)/i, cap);
    assert.doesNotMatch(s, /you'?ve (?:reached|hit) (?:your|the) [^\n]{0,40}?limit\b/i, cap);
    assert.doesNotMatch(s, /limit (?:will )?resets? at\b/i, cap);
  }
});

test("an unknown context window renders NOTHING — never 0, never claude's", () => {
  assert.equal(windowNote(BOTH, "othercli"), null);
  assert.equal(windowNote(null, "claude"), null);
  assert.equal(windowNote([{ ...OPENCODE, contextWindowTokens: 0 }], "othercli"), null);
  assert.equal(windowNote([{ ...OPENCODE, contextWindowTokens: undefined }], "othercli"), null);
  assert.equal(windowNote(BOTH, "claude"), "200k token window");
});

test("an empty model catalogue is a free-text field, never a guessed list", () => {
  const m = modelChoices(BOTH, "othercli");
  assert.deepEqual(m.aliases, []);
  assert.equal(m.freeText, false); // it HAS ids — the field is the fallback, not the rule
  const bare = modelChoices([{ ...OPENCODE, models: { aliases: [], ids: [] } }], "othercli");
  assert.equal(bare.freeText, true);
  assert.deepEqual(bare.ids, []);
  // Nothing may assume a model id is colon-free or slash-free.
  assert.ok(m.ids.includes("ollama/qwen3-coder:30b"));
  // The host's own claude catalogue wins over this app's literals.
  assert.deepEqual(modelChoices(BOTH, "claude").aliases, ["opus", "sonnet"]);
});

test("claude with NO models is a typed field like any other: the app carries no table", () => {
  const bare = { ...CLAUDE, models: { aliases: [], ids: [] } };
  const m = modelChoices([bare, OPENCODE], "claude");
  assert.deepEqual(m, { aliases: [], ids: [], freeText: true });
  assert.equal(modelChoices([bare, OPENCODE]).freeText, true);
  // A hidden built-in is simply absent from the wire list, and so from the picker.
  const hid = { ...CLAUDE, models: { aliases: ["opus"], ids: [] } };
  assert.deepEqual(modelChoices([hid], "claude"), { aliases: ["opus"], ids: [], freeText: false });
  // The result is a COPY: a caller that splices must not edit the host's descriptor.
  const m2 = modelChoices([CLAUDE], "claude");
  m2.ids.push("mutated");
  assert.equal(modelChoices([CLAUDE], "claude").ids.includes("mutated"), false);
});

test("the catalogue is read off the wire shape, ids verbatim", () => {
  const wire = { ...CLAUDE, models: { aliases: ["opus[1m]"], ids: ["claude-opus-5-5[1m]", "my-corp/model:7b"] } };
  const m = modelChoices([wire], "claude");
  assert.deepEqual(m.aliases, ["opus[1m]"]);
  assert.deepEqual(m.ids, ["claude-opus-5-5[1m]", "my-corp/model:7b"]);
  assert.equal(m.freeText, false);
});

test("effort and permission modes come from the backend, and empty means absent", () => {
  assert.deepEqual(effortChoices(BOTH, "othercli"), []);
  assert.deepEqual(effortChoices(BOTH, "claude"), CLAUDE_EFFORTS);
  assert.deepEqual(permModeChoices(BOTH, "othercli"), []);
  assert.deepEqual(permModeChoices(BOTH, "claude"), ["default", "plan"]);
  assert.match(capReason(BOTH, "othercli", "effort"), /no reasoning-effort setting/);
});

test("launchFor strips a backend an UNDESCRIBED host would have ignored", () => {
  // The gate, and the only shape of it: no list at all is an old desktop, one
  // that drops an unknown field and spawns claude with whatever `--model` came
  // beside it. Stripping the backend here is the same outcome reached one hop
  // earlier, on the side that can still do something about the model too.
  assert.deepEqual(launchFor({ backend: "othercli", model: "opus" }, null), { model: "opus" });
  // Absent means claude, so naming it is noise on the wire.
  assert.deepEqual(launchFor({ backend: "claude", model: "opus" }, BOTH), { model: "opus" });
  assert.deepEqual(launchFor({ backend: "othercli", model: "ollama/q:30b" }, BOTH),
    { backend: "othercli", model: "ollama/q:30b" });
});

test("a DESCRIBED host that lacks the id keeps it — the refusal is the host's, in words", () => {
  // This used to be stripped, and stripping it is the one failure the whole
  // refactor set out to make impossible: a list that EXISTS and does not name
  // this id is not an old desktop. It is a launch synced from a desktop with
  // more backends, or one rolled back to a claude-only build, or a queued
  // create replayed across either. Deleting the field there does not degrade
  // to absent — it degrades to a DIFFERENT BINARY, silently spending Anthropic
  // tokens the user deliberately routed away from, on a model string claude
  // has never heard of.
  //
  // So it goes out as written. `resolveBackend()` refuses it before anything
  // spawns and names both halves ("This host has no backend called "cline". It
  // can run: claude, othercli."), and `op.ack` lands that sentence on the queue
  // row. One wording, on the side that actually knows the answer.
  assert.deepEqual(launchFor({ backend: "cline", model: "x" }, BOTH), { backend: "cline", model: "x" });
  // …including against a host that describes only claude — the rollback case.
  assert.deepEqual(launchFor({ backend: "othercli" }, [CLAUDE]), { backend: "othercli" });
  // Nothing else is validated either: there is no descriptor to validate
  // against, and guessing that claude's flags apply is the same substitution
  // in a smaller form.
  assert.deepEqual(launchFor({ backend: "cline", effort: "high", permissionMode: "plan" }, BOTH),
    { backend: "cline", effort: "high", permissionMode: "plan" });
  // An empty list is still a list: this host answered, and it has none of them.
  assert.deepEqual(launchFor({ backend: "othercli" }, []), { backend: "othercli" });
});

test("launchFor is idempotent — a second pass is never a second decision", () => {
  // `relaunchWith` gates the opts to LABEL them truthfully and then hands the
  // same object to `createOp`, which gates again. Twice must equal once, or the
  // sentence on screen and the bytes on the wire are two different launches.
  for (const l of [
    { backend: "othercli", effort: "high", permissionMode: "plan", model: "ollama/q:30b" },
    { backend: "cline", model: "x" },
    { backend: "claude", effort: "high" },
    { backend: "othercli", model: "y" },
  ]) {
    for (const list of [null, BOTH, [CLAUDE]]) {
      const once = launchFor(l, list);
      assert.deepEqual(launchFor(once, list), once, `${JSON.stringify(l)} / ${list && list.length}`);
    }
  }
});

test("launchFor drops a flag the chosen backend has no concept of", () => {
  const l = { backend: "othercli", effort: "high", remoteControlled: true, permissionMode: "plan", model: "x" };
  assert.deepEqual(launchFor(l, BOTH), { backend: "othercli", model: "x" });
  // …and keeps every one claude understands.
  assert.deepEqual(launchFor({ effort: "high", remoteControlled: true, permissionMode: "plan" }, BOTH),
    { effort: "high", remoteControlled: true, permissionMode: "plan" });
  // An unknown host validates nothing: the flags go as they always did.
  assert.deepEqual(launchFor({ effort: "high", permissionMode: "bypassPermissions" }, null),
    { effort: "high", permissionMode: "bypassPermissions" });
  // The caller's object is not mutated — `launch` is React state.
  assert.deepEqual(l.effort, "high");
});

test("the per-session ask never fires on a resume, and never over a decision already made", () => {
  // The switch is necessary and not sufficient. Both refusals below are silent
  // failures if they ever regress: asking on a resume offers to continue a
  // conversation under a different binary, and asking over an override throws
  // away an answer a caller already supplied.
  assert.equal(shouldAskLaunch(true, false, false), true);
  assert.equal(shouldAskLaunch(true, true, false), false, "a resume is never asked");
  assert.equal(shouldAskLaunch(true, false, true), false, "an override has answered it");
  assert.equal(shouldAskLaunch(true, true, true), false);
  // Off is off — a fresh open on a device that never touched the switch is the
  // flow it has always had.
  assert.equal(shouldAskLaunch(false, false, false), false);
});

test("the per-session ask re-opens on the pair it was last answered with", () => {
  const defaults = { backend: undefined, model: "opus", effort: "high" };
  // Nothing remembered ⇒ the stored defaults, which is the behaviour the sheet
  // shipped with and still the right answer for a device that has never been
  // asked.
  assert.deepEqual(launchAskStart(BOTH, defaults, null), { backend: undefined, model: "opus" });
  assert.deepEqual(launchAskStart(BOTH, defaults, undefined), { backend: undefined, model: "opus" });
  // A remembered pair wins over the defaults — the whole point — and wins as a
  // PAIR: the model is only ever offered beside the backend it was chosen for.
  assert.deepEqual(launchAskStart(BOTH, defaults, { backend: "othercli", model: "ollama/qwen3-coder:30b" }),
    { backend: "othercli", model: "ollama/qwen3-coder:30b" });
  // Remembered claude is a hit, not a miss: absent `backend` means claude, so
  // "I picked claude with no model last time" must come back as exactly that
  // rather than falling through to a default model that was never re-chosen.
  assert.deepEqual(launchAskStart(BOTH, defaults, { backend: undefined, model: undefined }),
    { backend: undefined, model: undefined });
});

test("a remembered backend this host does not describe falls back to the defaults", () => {
  const defaults = { backend: undefined, model: "opus" };
  // The failure this refuses is not a bad spawn — `launchFor` lets an unknown
  // id go out on purpose so the host can name it. It is the CONTROL: a
  // `<select>` whose value matches no option renders as the first one, so the
  // sheet would read "Claude Code" while carrying `backend: "othercli"` into
  // the create. The model goes with it, because it belonged to that catalogue.
  assert.deepEqual(launchAskStart([CLAUDE], defaults, { backend: "othercli", model: "ollama/q:30b" }),
    { backend: undefined, model: "opus" });
  assert.deepEqual(launchAskStart(BOTH, defaults, { backend: "cline", model: "x" }),
    { backend: undefined, model: "opus" });
  // An old desktop that described nothing draws no picker at all, so a
  // remembered backend there would be an invisible choice.
  assert.deepEqual(launchAskStart(null, defaults, { backend: "othercli", model: "ollama/q:30b" }),
    { backend: undefined, model: "opus" });
  // A host that answered with an empty list has none of them either.
  assert.deepEqual(launchAskStart([], defaults, { backend: "othercli" }), { backend: undefined, model: "opus" });
});

test("the picker splits a catalogue by where the model RUNS, local first", () => {
  // Local first is a recommendation whether or not anybody calls it one: those
  // are the models that work with no tunnel and no bill, and the top of a list
  // is what people take.
  const ids = ["google/gemini-2.5-flash", "ollama/qwen3-coder:30b", "othercli/big-pickle", "ollama/gemma4:e4b"];
  const where = {
    "google/gemini-2.5-flash": "hosted",
    "ollama/qwen3-coder:30b": "local",
    "othercli/big-pickle": "hosted",
    "ollama/gemma4:e4b": "local",
  };
  assert.deepEqual(modelGroups(ids, where), [
    { where: "local", ids: ["ollama/qwen3-coder:30b", "ollama/gemma4:e4b"] },
    { where: "hosted", ids: ["google/gemini-2.5-flash", "othercli/big-pickle"] },
  ]);
});

test("an id the host said nothing about is UNKNOWN, never hosted", () => {
  // The whole reason `where` is a map and not a boolean. Filing a local model
  // under the heading that says "costs money and leaves the machine" is the one
  // mistake this field exists to prevent.
  const ids = ["a/x", "b/y", "c/z"];
  const groups = modelGroups(ids, { "a/x": "local" });
  assert.deepEqual(groups, [
    { where: "local", ids: ["a/x"] },
    { where: "unknown", ids: ["b/y", "c/z"] },
  ]);
  // …including a verdict a NEWER host invented: unrecognised is unknown.
  assert.deepEqual(modelGroups(["a/x"], { "a/x": "on-the-moon" }), [{ where: "unknown", ids: ["a/x"] }]);
});

test("no map at all ⇒ one group, so claude's picker keeps the shape it had", () => {
  // The host sets no locality for claude, and a new phone against an old
  // desktop gets none either. Both must look exactly as they did.
  assert.deepEqual(modelGroups(["opus", "sonnet"], undefined),
    [{ where: "unknown", ids: ["opus", "sonnet"] }]);
  assert.deepEqual(modelGroups([], undefined), []);
  assert.deepEqual(modelGroups([], {}), []);
});

test("an empty group is dropped rather than drawn empty", () => {
  // "Hosted (0)" is a control answering a question nobody asked, and it cannot
  // be tapped.
  const groups = modelGroups(["ollama/a", "ollama/b"], { "ollama/a": "local", "ollama/b": "local" });
  assert.deepEqual(groups, [{ where: "local", ids: ["ollama/a", "ollama/b"] }]);
});

test("the where-filter appears only when there is a choice to make", () => {
  // One group is not a filter, it is furniture implying a decision nobody has —
  // the same rule `showBackendPicker` applies to a host with one backend.
  assert.equal(showWhereFilter(modelGroups(["a/x"], { "a/x": "local" })), false);
  assert.equal(showWhereFilter(modelGroups(["opus"], undefined)), false);
  assert.equal(showWhereFilter(modelGroups([], undefined)), false);
  assert.equal(showWhereFilter(modelGroups(["a/x", "b/y"], { "a/x": "local", "b/y": "hosted" })), true);
});

test("a price this app was not told is never drawn as free", () => {
  // The direction that costs somebody money. Absent list, absent id, empty
  // list — all of them are UNKNOWN, and unknown must not read as "no charge".
  assert.equal(isZeroCost(undefined, "google/gemini-2.5-pro"), false);
  assert.equal(isZeroCost([], "google/gemini-2.5-pro"), false);
  assert.equal(isZeroCost(["othercli/big-pickle"], "google/gemini-2.5-pro"), false);
  assert.equal(isZeroCost(["othercli/big-pickle"], "othercli/big-pickle"), true);
});

test("the hosted disclaimer states what waterplane KNOWS, never an operator's policy", () => {
  // The rule that keeps this from becoming a lie: third-party terms change
  // without telling anybody, so the sentence may only assert the structural
  // fact (the data leaves this machine) and must send the reader to the terms
  // rather than summarising them.
  assert.match(HOSTED_DISCLAIMER, /leave this machine/);
  assert.match(HOSTED_DISCLAIMER, /operator’s terms, not waterplane’s/);
  // It must not name a vendor or claim what any of them do.
  for (const vendor of ["Google", "Meta", "NVIDIA", "othercli", "Anthropic", "OpenAI"]) {
    assert.ok(!HOSTED_DISCLAIMER.includes(vendor), `names ${vendor}`);
  }
  // Same rule for the free-tier line: a general, checkable caution about the
  // CLASS, never an assertion about a named vendor's current contract.
  assert.match(ZERO_COST_DISCLAIMER, /commonly/);
  for (const vendor of ["Google", "Meta", "NVIDIA", "Anthropic", "OpenAI"]) {
    assert.ok(!ZERO_COST_DISCLAIMER.includes(vendor), `names ${vendor}`);
  }
});

// ── the three optional capabilities, and their documented fallbacks ─────────
//
// `fork`, `resumePick` and `contextSeries` went on the wire OPTIONAL, not as
// `false`-defaulting booleans, for one reason: an old desktop's descriptor
// never mentions them, and read raw that `undefined` is falsy. Falsy would have
// silently deleted *fork from here*, the `--resume` picker and the context
// graph from every claude session on every host that had not upgraded yet.
//
// So `undefined` must resolve to the flag that USED to imply it —
// `fork ?? transcript`, `resumePick ?? transcript`, `contextSeries ??
// contextMeter` — and every consumer must go through `hasCap`/`capReason`
// rather than reading `b.caps.fork` itself. These cases are that contract.

/** A descriptor from a desktop that predates the split: it states the two old
 *  flags and has never heard of the three new ones. */
const OLD_HOST_CLAUDE = {
  id: "claude", label: "Claude Code", caps: caps(),
  models: { aliases: [], ids: [] },
};

/** What the host is flipping othercli to: a conversation that can be READ and
 *  a context series that can be PLOTTED, with no picker to drive and no cut it
 *  is allowed to make. The whole point of the three fields existing. */
const OC_READABLE = {
  id: "othercli", label: "othercli",
  caps: caps({
    contextMeter: false, usageLimits: false, slash: false, promptBoxes: false,
    hooks: false, effort: false, remoteControl: false, permissionModes: [],
    transcript: true, fork: false, resumePick: false, contextSeries: true,
  }),
  models: { aliases: [], ids: ["ollama/gemma4:e4b"] },
};

test("a host that sent NO backends frame answers true for everything — today's UI", () => {
  // The one gate that keeps a new phone against an old desktop pixel-identical.
  // Every capability, optional ones included.
  for (const cap of ["contextMeter", "usageLimits", "transcript", "slash", "promptBoxes",
    "hooks", "effort", "remoteControl", "fork", "resumePick", "contextSeries"]) {
    assert.equal(hasCap(null, undefined, cap), true, `${cap} on an undescribed host`);
    assert.equal(hasCap(null, "othercli", cap), true, `${cap} for an unknown id`);
    assert.equal(capReason(null, undefined, cap), null, `${cap} must draw no sentence`);
  }
});

test("an old host that sent transcript:true and no fork STILL offers fork", () => {
  // Read raw, `caps.fork` here is `undefined` — falsy — and the fork/reset rows
  // vanish from a claude session on a desktop whose only sin is being a version
  // behind. The fallback is the whole reason the field is optional.
  const list = [OLD_HOST_CLAUDE];
  assert.equal(OLD_HOST_CLAUDE.caps.fork, undefined); // the trap, stated
  assert.equal(hasCap(list, "claude", "fork"), true);
  assert.equal(hasCap(list, "claude", "resumePick"), true);
  assert.equal(hasCap(list, "claude", "contextSeries"), true);
  assert.equal(capReason(list, "claude", "fork"), null);
  assert.equal(capReason(list, "claude", "resumePick"), null);
  assert.equal(capReason(list, "claude", "contextSeries"), null);
});

test("absent inherits the flag that used to imply it — in BOTH directions", () => {
  // The fallback is not "true". A backend with no transcript and no explicit
  // `fork` must still answer no to fork, or the sentence and the button swap
  // places on exactly the backend that needs them right.
  const noLog = [{
    id: "x", label: "X",
    caps: caps({ transcript: false, contextMeter: false }),
    models: { aliases: [], ids: [] },
  }];
  assert.equal(hasCap(noLog, "x", "fork"), false);
  assert.equal(hasCap(noLog, "x", "resumePick"), false);
  assert.equal(hasCap(noLog, "x", "contextSeries"), false);
});

test("a STATED optional wins over what used to imply it, each way round", () => {
  // The reason the fields exist at all: a readable record that must not be
  // rewritten, and a plottable history with no gauge on screen.
  const list = [OC_READABLE];
  assert.equal(hasCap(list, "othercli", "transcript"), true);
  assert.equal(hasCap(list, "othercli", "fork"), false);        // stated false under a true transcript
  assert.equal(hasCap(list, "othercli", "resumePick"), false);  // same
  assert.equal(hasCap(list, "othercli", "contextMeter"), false);
  assert.equal(hasCap(list, "othercli", "contextSeries"), true); // stated true under a false meter
});

test("the three new sentences name the backend's own label, never a literal", () => {
  const list = [OC_READABLE];
  for (const cap of ["fork", "resumePick"]) {
    const s = capReason(list, "othercli", cap);
    assert.ok(s && s.startsWith("othercli"), `${cap}: ${s}`);
  }
  // A third backend must read correctly with no edit here.
  const third = [{ ...OC_READABLE, id: "cline", label: "Cline" }];
  assert.match(capReason(third, "cline", "fork"), /^Cline /);
  assert.ok(!capReason(third, "cline", "fork").includes("othercli"));
});

test("the fork sentence says the reader still works — it is not a second loss", () => {
  // It is only ever shown where a reader EXISTS. If it read like "no reader
  // either", the one control that DOES work on that screen would look broken.
  const s = capReason([OC_READABLE], "othercli", "fork");
  assert.match(s, /read/);
  assert.match(s, /reader works/);
});

// ── the cants strip, as one builder ────────────────────────────────────────

test("claude's session names NOTHING it cannot do — the byte-identical case", () => {
  // The acceptance rule for this whole change. `Unavailable` renders null on an
  // empty list, so an empty array here IS "the screen is unchanged".
  assert.deepEqual(sessionCants([CLAUDE], "claude"), []);
  assert.deepEqual(sessionCants([CLAUDE], undefined), []);       // absent backend ⇒ claude
  assert.deepEqual(sessionCants(BOTH, "claude"), []);
  assert.deepEqual(sessionCants([OLD_HOST_CLAUDE], "claude"), []); // …on an old host too
  assert.deepEqual(sessionCants(null, undefined), []);            // …and on one that said nothing
  // Even with chips that WOULD have been withheld elsewhere: claude takes them,
  // so there is no count and no sentence.
  assert.deepEqual(sessionCants(BOTH, "claude", { hiddenSlash: 2 }), []);
});

test("a readable-but-unforkable backend names fork, slash and the three unmeasured readers, and nothing else", () => {
  // With `transcript` and `contextSeries` true, the reader and the graph are
  // REAL on this screen — so their sentences must be gone, replaced by the
  // things themselves. What is left is what is genuinely absent.
  const rows = sessionCants([OC_READABLE], "othercli");
  assert.deepEqual(rows.map((r) => r.label), ["fork or reset to a turn", "usage limits", "turn-end reports", "readable choice boxes", "slash commands"]);
});

test("fork is silent when there is no reader to miss it from", () => {
  // Two sentences for one absence make it read as two separate losses. The
  // transcript row already says there is nothing to fork from.
  const rows = sessionCants(BOTH, "othercli"); // OPENCODE: transcript false
  assert.deepEqual(rows.map((r) => r.label), ["reader view", "context graph", "usage limits", "turn-end reports", "readable choice boxes", "slash commands"]);
  assert.ok(!rows.some((r) => r.label.includes("fork")));
});

test("the slash row CARRIES the count of chips withheld this render", () => {
  // A count on a control is a filter: the number and the cut are one function's
  // (`splitHeaderCmds`), handed straight in. Zero appends nothing — "0 of your
  // header chips" is noise on the screen somebody opened to find out.
  const plain = sessionCants([OC_READABLE], "othercli").find((r) => r.label === "slash commands");
  assert.ok(!/header chip/.test(plain.reason));

  const one = sessionCants([OC_READABLE], "othercli", { hiddenSlash: 1 }).find((r) => r.label === "slash commands");
  assert.match(one.reason, /1 of your header chips is a Claude slash command and is not offered here\.$/);

  const two = sessionCants([OC_READABLE], "othercli", { hiddenSlash: 2 }).find((r) => r.label === "slash commands");
  assert.match(two.reason, /2 of your header chips are Claude slash commands and are not offered here\.$/);
  // The capability sentence itself is still there in front of the count: the
  // count explains a consequence, it does not replace the reason.
  assert.ok(two.reason.startsWith("othercli"));
});

test("the count never appears on a backend that TAKES slash commands", () => {
  // A stale `hiddenSlash` from another session must not manufacture a row.
  assert.deepEqual(sessionCants([CLAUDE], "claude", { hiddenSlash: 9 }), []);
  const list = [{ ...OC_READABLE, caps: caps({ ...OC_READABLE.caps, slash: true }) }];
  assert.ok(!sessionCants(list, "othercli", { hiddenSlash: 9 }).some((r) => /header chip/.test(r.reason)));
});

test("the context row is keyed on the SERIES, not on the live gauge", () => {
  // The two came apart the moment a backend printed no gauge and still kept a
  // record. Keyed on `contextMeter` this row would refuse a graph that exists.
  assert.ok(!sessionCants([OC_READABLE], "othercli").some((r) => r.label === "context graph"));
  const noSeries = [{
    id: "y", label: "Y",
    caps: caps({ contextMeter: false, contextSeries: false, transcript: true, slash: true }),
    models: { aliases: [], ids: [] },
  }];
  const row = sessionCants(noSeries, "y").find((r) => r.label === "context graph");
  assert.match(row.reason, /^Y leaves no context history/);
  // A claim of NON-MEASUREMENT, never a zero and never an empty-conversation
  // claim about the person using it.
  assert.match(row.reason, /not a session that has run out of room/);
  assert.ok(!/0%/.test(row.reason));
});

test("an unavailable backend is still listed and carries its sentence; absent is null, never invented", () => {
  const list = [
    { id: "claude", label: "Claude Code", caps: {}, models: { aliases: [], ids: [] } },
    { id: "claude-local", label: "Claude (local)", unavailable: "Ollama not reachable at http://127.0.0.1:11434", caps: {}, models: { aliases: [], ids: [] } },
  ];
  assert.equal(backendUnavailable(list, "claude-local"), "Ollama not reachable at http://127.0.0.1:11434");
  assert.equal(backendUnavailable(list, "claude"), null);
  assert.equal(backendUnavailable(list, "nope"), null);
  assert.equal(backendUnavailable(null, "claude-local"), null);
  assert.match(backendOptionLabel(list[1]), /not available now/);
  assert.equal(backendOptionLabel(list[0]), "Claude Code");
  assert.equal(showBackendPicker(list), true);
});

test("an experimental backend says so in the picker; absent says nothing", () => {
  assert.equal(backendOptionLabel({ label: "othercli", experimental: true }), "othercli (experimental)");
  assert.equal(backendOptionLabel({ label: "othercli", experimental: true, unavailable: "x" }), "othercli (experimental, not available now)");
  assert.equal(backendOptionLabel({ label: "othercli" }), "othercli");
});

test("side channel line: up and absent say nothing; down says the note, or what is happening", () => {
  assert.equal(sideChannelLine(undefined), null);
  assert.equal(sideChannelLine({ state: "up", since: 1 }), null);
  assert.equal(sideChannelLine({ state: "down", since: 1, note: "the server exited" }), "the server exited");
  assert.match(sideChannelLine({ state: "down", since: 1 }), /channel is down/);
});

// ── the shell backend (WP4) ──────────────────────────────────────────────────
const SHELL = {
  id: "shell", label: "Shell", kind: "shell",
  caps: caps({ contextMeter: false, usageLimits: false, transcript: false, slash: false,
    promptBoxes: false, hooks: false, effort: false, remoteControl: false, permissionModes: [] }),
  models: { aliases: [], ids: [] },
};

test("a shell is identified by kind or id, and is not an agent choice", () => {
  assert.equal(isShellBackend([CLAUDE, SHELL], "shell"), true);
  assert.equal(isShellBackend([CLAUDE, SHELL], "claude"), false);
  assert.equal(isShellBackend(null, "shell"), true); // a live shell outlives the frame
  assert.equal(isShellBackend(null, undefined), false);
  assert.deepEqual(agentBackends([CLAUDE, SHELL]).map((b) => b.id), ["claude"]);
  assert.equal(agentBackends(null), null);
  assert.equal(shellBackend([CLAUDE]), null);      // older host: no action drawn
  assert.equal(shellBackend(null), null);
  assert.equal(shellBackend([CLAUDE, SHELL]).id, "shell");
});

test("claude + shell is one choice, not two: no backend picker", () => {
  assert.equal(showBackendPicker([CLAUDE, SHELL]), false);
  assert.equal(showBackendPicker([CLAUDE, OPENCODE, SHELL]), true);
});

test("a remembered shell is not offered back to the launch ask", () => {
  const d = { backend: undefined, model: undefined };
  assert.deepEqual(launchAskStart([CLAUDE, SHELL], d, { backend: "shell", model: "x" }), d);
});

test("a shell launch carries no model, effort or mode on the wire", () => {
  const l = launchFor({ backend: "shell", model: "opus", effort: "high", permissionMode: "plan" }, [CLAUDE, SHELL]);
  assert.deepEqual(l, { backend: "shell" });
});

test("a shell session gets one quiet line and no missing-feature strip", () => {
  assert.deepEqual(sessionCants([CLAUDE, SHELL], "shell"), []);
  assert.match(shellQuietLine([CLAUDE, SHELL], "shell"), /plain shell/);
  assert.equal(shellQuietLine([CLAUDE, SHELL], "claude"), null);
  assert.equal(shellQuietLine(null, undefined), null);
});

test("isShellBackend: a plugin backend of kind shell is a shell whatever its id", () => {
  const PLUG = { ...SHELL, id: "plug-term" };
  assert.equal(isShellBackend([CLAUDE, PLUG], "plug-term"), true);
  assert.equal(isShellBackend([CLAUDE, PLUG], "claude"), false);
});

test("effortChoices: the wire's ladder wins; an older host (no efforts, effort true) is claude's", () => {
  const withLadder = [{ ...OPENCODE, caps: caps({ effort: true, efforts: ["low", "high"] }) }];
  assert.deepEqual(effortChoices(withLadder, "othercli"), ["low", "high"]);
  assert.deepEqual(effortChoices([{ ...CLAUDE, caps: caps({ efforts: ["minimal", "max"] }) }], "claude"), ["minimal", "max"]);
  assert.deepEqual(effortChoices([{ ...OPENCODE, caps: caps({ effort: true }) }], "othercli"), CLAUDE_EFFORTS);
  assert.deepEqual(effortChoices([{ ...OPENCODE, caps: caps({ effort: false }) }], "othercli"), []);
  assert.deepEqual(permModeChoices(BOTH, "claude"), ["default", "plan"]);
});

test("the header's agent tab is named by the host's label, shortened only by label", () => {
  assert.equal(agentTabLabel(BOTH, "claude"), "Claude");
  assert.equal(agentTabLabel(BOTH, undefined), "Claude");
  assert.equal(agentTabLabel(BOTH, "othercli"), "othercli");
  assert.equal(agentTabLabel([{ ...OPENCODE, id: "x9", label: "Acme Agent" }], "x9"), "Acme Agent");
  assert.equal(agentTabLabel(null, undefined), "Claude");
  assert.equal(agentTabLabel(null, "gone"), "CLI");
});

test("backendDrift: the host's sentence verbatim, else null", () => {
  const SAY = "Acme was measured on 1.0.91, and this desktop is running 1.0.95 — its screens or records may read differently until the plugin is measured on 1.0.95. It still starts.";
  const acme = (measured) => ({ id: "acme", label: "Acme", caps: caps(), ...(measured ? { measured } : {}) });
  assert.equal(backendDrift(null, "acme"), null);
  assert.equal(backendDrift([acme()], "acme"), null);
  assert.equal(backendDrift([acme({ versions: ["1.0.91"] })], "acme"), null);
  const drifted = acme({ versions: ["1.0.91"], running: "1.0.95", drift: SAY });
  assert.equal(backendDrift([CLAUDE, drifted], "acme"), SAY);
  assert.equal(backendDrift([acme({ versions: ["1.0.91"], drift: "  " })], "acme"), null);
  assert.equal(backendDrift([CLAUDE, drifted], "claude"), null);
  // Drift is a sentence, not a cant: the refusal strip never carries it.
  assert.ok(!sessionCants([CLAUDE, drifted], "acme").some((c) => String(c.reason).includes("measured on")));
});

test("launchModes: the launch picker narrows, the live switch and the absent case do not", () => {
  const NARROW = { ...OPENCODE, id: "narrow", caps: caps({ permissionModes: ["default", "plan"], launchModes: ["default"] }) };
  const list = [CLAUDE, NARROW];
  assert.deepEqual(launchModeChoices(list, "narrow"), ["default"]);
  assert.deepEqual(permModeChoices(list, "narrow"), ["default", "plan"], "the live switch keeps permissionModes");
  assert.deepEqual(launchModeChoices(list, "claude"), ["default", "plan"], "absent inherits");
  assert.equal(launchFor({ backend: "narrow", permissionMode: "plan" }, list).permissionMode, undefined);
  assert.equal(launchFor({ backend: "narrow", permissionMode: "default" }, list).permissionMode, "default");
});

test("launchModes: a mode launchFor drops for a narrowed set is SAID, never silent (review minor 5)", () => {
  const NARROW = { ...OPENCODE, id: "narrow", label: "Narrow CLI", caps: caps({ permissionModes: ["default", "plan"], launchModes: ["default"] }) };
  const list = [CLAUDE, NARROW];
  const note = launchModeDropNote({ backend: "narrow", permissionMode: "plan" }, list);
  assert.match(note, /^Narrow CLI cannot start in "plan" mode \(it can switch to it once running\); it starts in: default\. This launch goes without it\.$/);
  assert.equal(launchFor({ backend: "narrow", permissionMode: "plan" }, list).permissionMode, undefined, "the note describes exactly what launchFor did");
  // Nothing dropped ⇒ nothing said: a mode it can start in, no mode, claude, an old host.
  assert.equal(launchModeDropNote({ backend: "narrow", permissionMode: "default" }, list), null);
  assert.equal(launchModeDropNote({ backend: "narrow" }, list), null);
  assert.equal(launchModeDropNote({ permissionMode: "plan" }, list), null, "claude starts in every mode it lists");
  assert.equal(launchModeDropNote({ backend: "narrow", permissionMode: "plan" }, null), null, "no list: no descriptor to judge by");
  // A mode the backend has no concept of is today's quiet strip, not this sentence.
  assert.equal(launchModeDropNote({ backend: "narrow", permissionMode: "bypassPermissions" }, list), null);
});
