// What a build button may ASK for, and what it does with the answer
// (`shared/src/buildparams.ts`).
//
// Every rule here ends in a shell command on somebody's desktop, and three of
// them exist because the plausible alternative fails QUIETLY: an undeclared
// placeholder substituted to nothing builds the wrong thing successfully, a
// missing value defaulted to the first option picks an app for you at 3 a.m.,
// and a newline in a value is a second command line nobody typed.
//
// Pure: literals in, strings and verdicts out, no filesystem and no shell.
import test from "node:test";
import { BRAND, LEGACY } from "../dist/brand.js";
import assert from "node:assert/strict";
import {
  applyParams, buildRunTitle, cleanBuildParams, cleanParamValue, missingParamsText, paramEnv,
  paramEnvName, paramLabel, paramRefs, paramSummary, parseParamOptions, resolveParamValues,
  unknownParamRefs,
} from "../dist/buildparams.js";

test("a value is substituted verbatim, spaces in the braces or not", () => {
  const v = { app: "acorn-squirrel-watchface-v2" };
  assert.equal(applyParams("./shoot.sh --app {{app}}", v), "./shoot.sh --app acorn-squirrel-watchface-v2");
  assert.equal(applyParams("./shoot.sh --app {{ app }}", v), "./shoot.sh --app acorn-squirrel-watchface-v2");
  // The dir is substituted the same way — that is how one entry serves one
  // member of a monorepo.
  assert.equal(applyParams("apps/{{app}}", v), "apps/acorn-squirrel-watchface-v2");
});

test("a placeholder with no value is LEFT AS WRITTEN — an empty substitution is a different command that succeeds", () => {
  assert.equal(applyParams("./shoot.sh --app {{ap}}", { app: "x" }), "./shoot.sh --app {{ap}}");
  assert.equal(applyParams("./shoot.sh --app {{app}}", { app: "" }), "./shoot.sh --app {{app}}");
});

test("a value is one line, bounded, control characters stripped", () => {
  assert.equal(cleanParamValue("a\nrm -rf /"), "a rm -rf /");
  assert.equal(cleanParamValue("  spaced  "), "spaced");
  assert.equal(cleanParamValue("x".repeat(900)).length, 512);
  assert.equal(cleanParamValue(undefined), "");
});

test("every value is exported under the current AND each legacy env name, whatever the command line names", () => {
  assert.equal(paramEnvName("app"), `${BRAND.envPrefix}PARAM_APP`);
  const want = {};
  for (const [id, v] of [["APP", "acorn"], ["FLAVOUR", "debug"]]) {
    for (const prefix of [BRAND.envPrefix, ...LEGACY.map((l) => l.envPrefix)]) want[`${prefix}PARAM_${id}`] = v;
  }
  assert.deepEqual(paramEnv({ app: "acorn", flavour: "debug" }), want);
  // An id that could never have been declared is not smuggled into the
  // environment by a hand-edited row.
  assert.deepEqual(paramEnv({ "PATH;x": "evil" }), {});
});

test("a missing value refuses the run and NAMES the field — never the first option, never a blank", () => {
  const params = [
    { id: "app", kind: "choice", label: "Garmin app", options: ["acorn", "boulder"] },
    { id: "flavour", kind: "text", default: "debug" },
  ];
  const r = resolveParamValues(params, {});
  assert.deepEqual(r.values, { flavour: "debug" });
  assert.deepEqual(r.missing.map((p) => p.id), ["app"]);
  assert.equal(missingParamsText(r.missing), "needs a value for “Garmin app”");
  assert.equal(missingParamsText([{ id: "app", kind: "text" }, { id: "flavour", kind: "text" }]),
    "needs a value for “app”, “flavour”");
  assert.equal(missingParamsText([]), "");

  // Handed a value, nothing is missing — and what was handed in beats the default.
  const ok = resolveParamValues(params, { app: "boulder", flavour: "release" });
  assert.deepEqual(ok.values, { app: "boulder", flavour: "release" });
  assert.deepEqual(ok.missing, []);
});

test("cleaning: a choice with nowhere to get options degrades to text, ids are checked, duplicates collapse to the first", () => {
  const params = cleanBuildParams([
    { id: "app", kind: "choice", optionsCmd: "ls -1 apps", label: "Garmin app" },
    { id: "empty", kind: "choice" },                       // no options, no command
    { id: "1bad", kind: "text" },                          // not an identifier
    { id: "PATH;x", kind: "text" },                        // nor this
    { id: "app", kind: "text", default: "second" },        // duplicate
    {},                                                    // nothing at all
  ]);
  assert.deepEqual(params.map((p) => [p.id, p.kind]), [["app", "choice"], ["empty", "text"]]);
  assert.equal(params[0].optionsCmd, "ls -1 apps");
  assert.equal(paramLabel(params[0]), "Garmin app");
  assert.equal(paramLabel(params[1]), "empty");   // the id, never a blank
  // Absent rather than [] when there is nothing to ask: this is written into a
  // file a person and an agent both edit.
  assert.equal(cleanBuildParams([]), undefined);
  assert.equal(cleanBuildParams("nope"), undefined);
  assert.equal(cleanBuildParams([{ id: "a", kind: "text", default: "x\ny" }])[0].default, "x y");
});

test("a placeholder nothing declares is reported, not repaired", () => {
  const cfg = { cmd: "./shoot.sh --app {{app}} --out {{outDir}}", dir: "apps/{{app}}", params: [{ id: "app", kind: "text" }] };
  assert.deepEqual(unknownParamRefs(cfg), ["outDir"]);
  assert.deepEqual(paramRefs("{{a}} {{b}} {{a}}"), ["a", "b"]);
  assert.deepEqual(unknownParamRefs({ cmd: "./b.sh", dir: "", params: [] }), []);
});

test("the values are what separates two runs of one button", () => {
  assert.equal(paramSummary({ app: "acorn", flavour: "debug" }), "app=acorn · flavour=debug");
  assert.equal(paramSummary({}), "");
  assert.equal(buildRunTitle("Screenshot", { app: "acorn" }), "Screenshot · app=acorn");
  // A paramless build reads exactly as it always did.
  assert.equal(buildRunTitle("Release APK", undefined), "Release APK");
});

test("a discovered option list is one per line, deduped, and says what it cut", () => {
  const r = parseParamOptions("acorn\n\nboulder\nacorn\n  spaced  \n");
  assert.deepEqual(r.options, ["acorn", "boulder", "spaced"]);
  assert.equal(r.total, 3);
  const many = parseParamOptions(Array.from({ length: 250 }, (_, i) => `app${i}`).join("\n"));
  assert.equal(many.options.length, 200);
  assert.equal(many.total, 250);   // the cut is SAYABLE, not silent
});

import { unsafeParamIds, unsafeParamsText } from "../dist/buildparams.js";

test("a value with a shell metacharacter is flagged only where the command line names it", () => {
  const bad = ["a;b", "a&&b", "a|b", "$(x)", "`x`", "a>b", "a<b", "a'b", 'a"b', "a\\b"];
  for (const v of bad) assert.deepEqual(unsafeParamIds("echo {{app}}", { app: v }), ["app"], v);
  // a value only the env copy / dir uses is not on the command line
  assert.deepEqual(unsafeParamIds("echo hi", { app: "a;b" }), []);
});

test("real values stay allowed, bare or inside the entry's own double quotes", () => {
  for (const v of ["acorn-squirrel_v2", "apps/foo.bar", "--flag=a,b", "two words", "none", "publish", "a@b+c:d", "x*"]) {
    assert.deepEqual(unsafeParamIds('[ "{{mode}}" = publish ]; echo {{mode}}', { mode: v }), [], v);
  }
});

test("the refusal sentence names the field and points at the env copy", () => {
  const s = unsafeParamsText(["app"]);
  assert.match(s, /“app”/);
  assert.match(s, /PARAM_APP/);
  assert.equal(unsafeParamsText([]), "");
});
