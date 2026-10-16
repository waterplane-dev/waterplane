/**
 * The early guard runs (scripts/guards/): which guard runs when, and whose
 * failure a failure is.
 *
 * The cases are the real ones that motivated it: a skill bullet naming
 * `gitFailPrompt.ts` broke two claudemd checks and was reported at a push
 * three commits later, while another session's unfinished GalleryViewer.tsx
 * was failing webshape in the same shared tree. The first must block the edit
 * that caused it; the second must never be blamed on an unrelated edit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDS, blames, editTokens, globRe, guardsFor, runGuards } from "../scripts/guards/guards.mjs";
import { classify, parseAllowlist } from "../scripts/release/public-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const rules = parseAllowlist(readFileSync(join(ROOT, "deploy/public-allowlist.txt"), "utf8"));

/**
 * Listed guards with no file on disk that are NOT excused. A guard the allow-list keeps private
 * (`deploy/public-allowlist.txt`, the one record of that decision) is legitimately absent from the
 * public snapshot; any other missing guard file is a stale GUARDS row.
 */
const unexcusedAbsent = (listed, onDisk, allowRules) =>
  listed.filter((t) => !onDisk.includes(t) && classify(`tools/${t}.test.mjs`, allowRules).included !== false);

test("every tools/*.test.mjs has a tier, and every listed guard exists", () => {
  const onDisk = readdirSync(join(ROOT, "tools")).filter((f) => f.endsWith(".test.mjs")).map((f) => f.replace(/\.test\.mjs$/, "")).sort();
  const listed = GUARDS.map((g) => g.test);
  assert.deepEqual([...new Set(listed)].length, listed.length, "a guard is listed twice");
  assert.deepEqual(
    onDisk.filter((t) => !listed.includes(t)), [],
    "New guard file(s) with no tier. Add each to GUARDS in scripts/guards/guards.mjs: `edit` if it only\n" +
    "reads files, `commit` if it needs typescript/eslint or spawns node, `push` (with a why) if it needs\n" +
    "a dist/ or git history.",
  );
  assert.deepEqual(unexcusedAbsent(listed, onDisk, rules), [],
    "GUARDS names a guard file that is gone (and the allow-list does not keep it private)");
});

test("a listed guard may be absent only when the allow-list keeps it private", () => {
  const al = parseAllowlist("tools/**\n!tools/secret.test.mjs\n");
  assert.deepEqual(unexcusedAbsent(["secret"], [], al), [], "private and absent: the public snapshot, tolerated");
  assert.deepEqual(unexcusedAbsent(["shown"], [], al), ["shown"], "public and absent: a stale row, still a failure");
  assert.deepEqual(unexcusedAbsent(["unlisted"], [], parseAllowlist("README.md\n")), [],
    "private by default (no rule matches): tolerated the same way");
  assert.deepEqual(unexcusedAbsent(["shown"], ["shown"], al), [], "present is never a finding");
});

test("guardsFor drops a guard whose file is not under the root", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guards-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "tools/uipace.test.mjs"), "");
  const got = guardsFor(["scripts/ui/a.mjs"], "commit", dir);
  assert.deepEqual(got, ["tools/uipace.test.mjs"], "the guard that exists runs; uicaptions and uiteaser (absent) do not");
  // Under the real root a listed guard runs exactly when its file is there (the public tree lacks the private ones).
  const real = guardsFor(["scripts/ui/a.mjs"], "commit", ROOT);
  for (const t of ["uicaptions", "uipace", "uiteaser"]) {
    assert.equal(real.includes(`tools/${t}.test.mjs`), readdirSync(join(ROOT, "tools")).includes(`${t}.test.mjs`), t);
  }
});

test("a tier earlier than push says what it reads; push says why it waits", () => {
  for (const g of GUARDS) {
    if (g.tier === "push") assert.ok(g.why, `${g.test}: a push-only guard says why it cannot run earlier`);
    else assert.ok(g.paths.length, `${g.test}: an ${g.tier} guard with no paths would never run`);
  }
});

test("globRe: ** spans directories, * stays in one", () => {
  assert.ok(globRe("packages/web/src/**").test("packages/web/src/gallery/GalleryViewer.tsx"));
  assert.ok(globRe(".claude/skills/**").test(".claude/skills/web-work/SKILL.md"));
  assert.ok(globRe("packages/extensions/*/web/**").test("packages/extensions/desktop/web/a.tsx"));
  assert.ok(!globRe("packages/extensions/*/web/**").test("packages/extensions/desktop/host/web/a.tsx"));
  assert.ok(globRe("tools/*.test.mjs").test("tools/claudemd.test.mjs"));
  assert.ok(!globRe("README.md").test("docs/README.md"));
  assert.ok(!globRe("docs/assets/**").test("docs/assetsX/a.svg"));
});

test("guardsFor scopes by path and tier", () => {
  const skill = guardsFor([".claude/skills/web-work/SKILL.md"], "edit");
  assert.ok(skill.includes("tools/claudemd.test.mjs"));
  assert.ok(!skill.includes("tools/webshape.test.mjs"));

  const web = guardsFor(["packages/web/src/GitView.tsx"], "edit");
  assert.ok(web.includes("tools/webshape.test.mjs"));
  assert.ok(!web.includes("tools/apppins.test.mjs"), "a typescript-loading guard is not an edit-time cost");
  assert.ok(guardsFor(["packages/web/src/GitView.tsx"], "commit").includes("tools/apppins.test.mjs"));

  assert.deepEqual(guardsFor(["packages/web/src/GitView.tsx"], "commit").filter((t) => t.includes("activitypins")), [],
    "a push-only guard never runs before push");
  assert.deepEqual(guardsFor(["some/unrelated.txt"], "commit"), []);
  assert.ok(guardsFor(["tools/lockfile.test.mjs"], "edit").includes("tools/lockfile.test.mjs"), "editing a guard runs it");
});

test("blame: the skill edit that named an undocumented module owns that failure", () => {
  const tokens = editTokens(".claude/skills/web-work/SKILL.md", {
    new_string: "  **A failed push or pull offers `fix in a new session…`** (`gitFailPrompt.ts`, pinned): …",
  });
  assert.ok(blames({ message: "These modules are named in CLAUDE.md …", actual: ["gitFailPrompt.ts"] }, tokens));
  assert.ok(blames({ message: "Over the 28000-char sub-skill budget.", actual: ["web-work: 28407 chars"] }, tokens),
    "the size failure names the skill, not the file");
});

test("blame: another session's unfinished file is never this edit's fault", () => {
  const gitView = editTokens("packages/web/src/GitView.tsx", { new_string: "const x = 1;" });
  const gallery = { message: "…", actual: ["gallery/GalleryViewer.tsx: 174 lines, over its 150 cap"] };
  assert.ok(!blames(gallery, gitView));
  assert.ok(blames(gallery, editTokens("packages/web/src/gallery/GalleryViewer.tsx", {})));

  // Every claudemd message says "CLAUDE.md"; a skill whose new text mentions it must not own them all.
  const skill = editTokens(".claude/skills/host/SKILL.md", { new_string: "see CLAUDE.md and README.md" });
  assert.ok(!blames({ message: "named in CLAUDE.md or a skill", actual: ["otherModule.ts"] }, skill));
  assert.ok(!blames({ message: "Over budget", actual: ["web-work: 28407 chars"] }, skill), "`host:` is not `web-work:`");
});

test("blame: CLAUDE.md's own size failure is the CLAUDE.md edit's", () => {
  const md = editTokens("CLAUDE.md", { new_string: "one more line" });
  assert.ok(blames({ message: "CLAUDE.md is 12900 chars, over the 12800 budget by 100.", actual: false }, md));
});

test("runGuards reports each failing test, offenders included, through the reporter", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guards-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x.test.mjs"), [
    'import test from "node:test"; import assert from "node:assert/strict";',
    'test("fine", () => {});',
    'test("fat", () => assert.deepEqual(["web-work: 28407 chars"], [], "Over the cap."));',
  ].join("\n"));
  const fails = runGuards(["x.test.mjs"], dir);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].name, "fat");
  assert.deepEqual(fails[0].actual, ["web-work: 28407 chars"]);
  assert.deepEqual(runGuards([], dir).length, 0);
});
