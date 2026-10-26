import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectMain, STANDARD_RULESETS } from "../dist/protectmain.js";

function repo(origin) {
  const wt = mkdtempSync(join(tmpdir(), "wp-protect-"));
  execFileSync("git", ["init", "-q"], { cwd: wt });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: wt });
  return wt;
}
/** A fake `gh`: answers the list with `have`, records each POST body. */
function fakeGh(have, refuse = null) {
  const posted = [];
  const run = (args, input) => {
    if (args.includes("POST")) {
      if (refuse) throw Object.assign(new Error("x"), { stderr: refuse });
      posted.push({ path: args[3], body: JSON.parse(input) });
      return "{}";
    }
    return JSON.stringify(have.map((name) => ({ name })));
  };
  return { run, posted };
}

test("protect-main adds only the missing standard rulesets on the origin's repo", () => {
  const wt = repo("git@github.com:me/thing.git");
  try {
    const g = fakeGh(["protect release tags"]);
    const r = protectMain(wt, g.run);
    assert.equal(r.applied, true);
    assert.deepEqual(g.posted.map((p) => [p.path, p.body.name]), [["repos/me/thing/rulesets", "protect main"]]);
    assert.deepEqual(g.posted[0].body.rules, [{ type: "non_fast_forward" }, { type: "deletion" }]);
    assert.deepEqual(g.posted[0].body.bypass_actors, []);
    assert.match(r.note, /set "protect main" on me\/thing.*direct pushes still work/);
    assert.match(r.note, /"protect release tags" already there — left as it is/);
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test("protect-main never asks for PRs or checks: the rules are force-push and deletion only", () => {
  for (const rs of STANDARD_RULESETS) assert.deepEqual(rs.rules.map((r) => r.type).sort(), ["deletion", "non_fast_forward"]);
});

test("protect-main: both present is a no-op; no github origin writes nothing; a refusal is quoted", () => {
  const wt = repo("https://github.com/me/thing");
  const bare = repo(null);
  try {
    const both = fakeGh(STANDARD_RULESETS.map((r) => r.name));
    const r = protectMain(wt, both.run);
    assert.equal(r.applied, false);
    assert.equal(both.posted.length, 0);
    const none = fakeGh([]);
    assert.match(protectMain(bare, none.run).note, /no github\.com origin/);
    assert.equal(none.posted.length, 0);
    const no = fakeGh([], "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n");
    const refused = protectMain(wt, no.run);
    assert.equal(refused.applied, false);
    assert.match(refused.note, /GitHub refused protect main: .*HTTP 403/);
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
});
