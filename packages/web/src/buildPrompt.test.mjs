// The words the Build sheet hands an agent (`buildPrompt.ts`).
//
// A prompt is a contract with a machine, and the three things pinned here are
// the ones that fail silently when they drift: the file format is written ONCE
// and both prompts carry it (two copies drift, and the drifting one is always
// the one an agent is reading); the one-entry wand says what NOT to touch, or it
// comes back having merged a second opinion over five working buttons; and an
// empty form makes it ASK rather than invent a build button nobody wanted.
import test from "node:test";
import assert from "node:assert/strict";
import { paramEnvName } from "@waterplane/shared";
import {
  ARTIFACT_RULES, BUILDS_SCHEMA, ONE_BUILD_ASK, ONE_BUILD_LABEL, ONE_BUILD_NOTHING, SETUP_PROMPT,
  oneBuildPrompt, oneBuildToast, paramsRowNote,
} from "./buildPrompt.ts";

test("both prompts carry the one copy of the file format", () => {
  assert.ok(SETUP_PROMPT.includes(BUILDS_SCHEMA));
  assert.ok(oneBuildPrompt({ name: "x" }).includes(BUILDS_SCHEMA));
  // And the format documents the parameter half — the whole reason a monorepo
  // does not get forty buttons.
  assert.ok(BUILDS_SCHEMA.includes("optionsCmd"));
  assert.ok(BUILDS_SCHEMA.includes(paramEnvName("x").slice(0, -1)));
  assert.ok(BUILDS_SCHEMA.includes("{{id}}"));
});

test("what is typed in the form IS the brief", () => {
  const p = oneBuildPrompt({ name: "Screenshot app", cmd: "./tools/shoot.sh", dir: "apps" }, "garmin");
  assert.ok(p.includes('"Screenshot app"'));
  assert.ok(p.includes("./tools/shoot.sh"));
  assert.ok(p.includes("apps"));
  assert.ok(p.includes("garmin"));
  // ONE entry, and the others left alone.
  assert.ok(/ADD exactly ONE entry/.test(p));
  assert.ok(/Keep every entry already in the file exactly as it is/.test(p));
});

test("the brief is the person's own words, quoted first", () => {
  const p = oneBuildPrompt({ brief: "screenshot one Garmin app, let me pick which", name: "Screenshot" });
  assert.ok(p.includes("What I want: screenshot one Garmin app, let me pick which"));
  assert.ok(p.indexOf("What I want:") < p.indexOf("Button label so far"));
  assert.ok(/treat it as the brief/.test(p));
  // The words alone are enough — the three fields may all be empty.
  assert.ok(/treat it as the brief/.test(oneBuildPrompt({ brief: "build the watch face" })));
});

test("an empty form asks instead of inventing a button", () => {
  const p = oneBuildPrompt({});
  assert.ok(/ASK me what I want before writing anything/.test(p));
  assert.ok(!/treat it as the brief/.test(p));
  assert.equal(oneBuildToast({}), "opening a session — tell it what the button should do");
  assert.ok(oneBuildToast({ brief: "screenshot an app" }).includes("writes the button itself"));
  assert.ok(oneBuildToast({ name: "APK" }).includes("writes the button itself"));
});

test("the wand on an existing entry edits THAT id in place", () => {
  const p = oneBuildPrompt({ id: "b7", name: "Release APK", existing: true });
  assert.ok(p.includes("`b7`"));
  assert.ok(/Do not add a second entry/.test(p));
  assert.ok(!/ADD exactly ONE entry/.test(p));
});

test("a parameterised button says so on its row", () => {
  assert.equal(paramsRowNote({ params: [{ id: "app", kind: "choice", label: "Garmin app" }, { id: "flavour", kind: "text" }] }),
    "asks for Garmin app, flavour");
  assert.equal(paramsRowNote({}), "");
  assert.equal(ONE_BUILD_LABEL, "work it out");
  // The question is asked on the PHONE — a prompt that merely requests one is
  // not a gate, which is what the first version of this button proved.
  assert.ok(ONE_BUILD_ASK.endsWith("?"));
  assert.ok(ONE_BUILD_NOTHING.length > 0);
});

test("both prompts forbid the three things the first generation of them produced", () => {
  // Measured across nine repos: `app-debug.apk` in three of them, a script
  // copying its output and leaving the original so the phone fetched 227 MB
  // twice, and nothing anywhere that removed an old build. The app does all three
  // now (`shared/artifacts.ts`), so a command that also does them does them a
  // second time, differently.
  for (const [what, text] of [["setup", SETUP_PROMPT], ["one build", oneBuildPrompt({ brief: "release apk" })]]) {
    assert.ok(text.includes(ARTIFACT_RULES), `${what} carries the one copy of the artifact rules`);
    assert.match(text, /Do NOT copy artifacts into/, `${what} says it`);
    assert.match(text, /removes older builds of the same artifact/, `${what} says who does it instead`);
  }
});
