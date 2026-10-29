// node --test: the exposure watch's targets.json (tools/exposure/targets.mjs). Pure; no files, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseTargets, targetRunArgv, unsetTargetVars, unsetVarsSentence } from "./exposure/targets.mjs";

test("parseTargets keeps valid entries in order and names every skipped one", () => {
  const { targets, problems } = parseTargets({ version: 1, targets: [
    { name: "a", dir: "/x/a", gh: "O/a", addedBy: "phone", future: 1 },
    { name: "A", dir: "/x/b" },
    { name: "c", dir: "rel/c" },
    { name: "a", dir: "/x/dup" },
    { name: "d", dir: "/x/d", gh: "not a slug" },
    { name: "e", dir: "/x/e", args: ["--only", 3] },
    { name: "f", dir: "/x/f", play: true, args: ["--play", "p"] },
    null,
  ] });
  assert.deepEqual(targets.map((t) => t.name), ["a", "f"]);
  assert.equal(targets[0].play, false);
  assert.equal(targets[1].play, true);
  assert.equal(problems.length, 6);
  assert.match(problems.join("\n"), /duplicate name/);
});

test("parseTargets: a wrong shape is no targets with a reason", () => {
  for (const d of [null, [], {}, { targets: "x" }]) {
    const r = parseTargets(d);
    assert.deepEqual(r.targets, []);
    assert.equal(r.problems.length, 1);
  }
});

test("targetRunArgv: flags verbatim, {HOME}/{SITE} expanded, 2FA date only for an npm target", () => {
  const vars = { HOME: "/h", SITE: "https://s", NPM_2FA_CONFIRMED: "2026-10-01" };
  const t = { name: "w", dir: "/d", gh: "O/w", play: false, args: ["--npm", "w", "--privacy-url", "{SITE}/p q.html", "--era-check", "{HOME}/e.py"] };
  assert.deepEqual(targetRunArgv(t, vars, ["--json"]), ["/d", "--name", "w", "--gh", "O/w", "--npm", "w", "--privacy-url", "https://s/p q.html", "--era-check", "/h/e.py", "--npm-2fa-confirmed", "2026-10-01", "--json"]);
  assert.deepEqual(targetRunArgv({ name: "n", dir: "/d", play: false, args: [] }, vars), ["/d", "--name", "n"]);
  assert.ok(!targetRunArgv(t, { ...vars, NPM_2FA_CONFIRMED: "" }).includes("--npm-2fa-confirmed"));
});

test("unsetTargetVars: a {SITE} target with EXPOSURE_SITE empty is refused, never run against a half address", () => {
  const t = { name: "w", dir: "/d", play: false, args: ["--privacy-url", "{SITE}/privacy.html", "--era-check", "{HOME}/e.py"] };
  assert.deepEqual(unsetTargetVars(t, { HOME: "/h", SITE: "" }), ["SITE"]);
  assert.deepEqual(unsetTargetVars(t, { HOME: "/h", SITE: "https://s" }), []);
  assert.deepEqual(unsetTargetVars({ name: "n", dir: "/d", play: false, args: ["--npm", "n"] }, { HOME: "/h", SITE: "" }), []);
  assert.match(unsetVarsSentence(t, ["SITE"]), /\{SITE\}.*EXPOSURE_SITE is empty.*not run/);
});
