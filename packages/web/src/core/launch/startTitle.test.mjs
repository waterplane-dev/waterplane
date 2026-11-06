/**
 * The title `openRepo` hands `askLaunchFirst`. The ask rewords it ONCE (`shownTitleIn`, which
 * matches a title's leading FOLDER name), so the caller must pass the folder-named title — a title
 * already reworded would be read as a folder name and substituted a second time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoBranchLabel, shownTitleIn } from "@waterplane/shared";
import { repoStartTitle } from "./startTitle.ts";

const app = { repoName: "app", displayName: "web", isPrimary: true };
const web = { repoName: "web", displayName: "site", isPrimary: true };
const repos = [app, web];

test("the Start sheet says the repo as it is shown, once — a shown name that is another folder's name is not substituted again", () => {
  assert.equal(shownTitleIn(repos, repoStartTitle(app)), "web");
  assert.equal(shownTitleIn(repos, repoStartTitle(web)), "site");
  // The hazard this guards: an already-shown title read as a folder name.
  assert.equal(shownTitleIn(repos, repoBranchLabel({ ...app, repoName: "web" })), "site");
});

test("useLaunch.openRepo asks with the folder-named title (repoStartTitle), not a reworded one", () => {
  const src = readFileSync(new URL("./useLaunch.ts", import.meta.url), "utf8");
  const open = src.slice(src.indexOf("function openRepo(t: RepoTarget)"), src.indexOf("function openRepoWith"));
  assert.match(open, /askLaunchFirst\(repoStartTitle\(t\),/);
  assert.doesNotMatch(open, /withShownName/);
});
