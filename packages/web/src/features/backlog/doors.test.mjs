// E3: the session toolbar's backlog door agrees with the other in-session doors
// (it targets the session's repo), the repo derived from `items` is pinned into
// the cut, and each door in actions.ts calls the transition it documents.
// actions.ts imports the SDK barrel, which node cannot load, so the door ->
// transition mapping is read from its source; the transitions run for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NO_BACKLOG_FILTER } from "../../backlogFilter.ts";
import { NO_CUT, cutForRepo, cutInRepo, cutOpenedOn } from "./logic.ts";

const here = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

test("the session toolbar opens the backlog on the session's repo, like the badge and the strip", () => {
  const src = here("../../core/session/runToolbar.ts");
  const line = src.split("\n").find((l) => l.includes('case "backlog"'));
  assert.match(line, /openBacklogIn\(active\?\.cwd\)/);
  assert.doesNotMatch(line, /setOverlay/);
});

test("each door in actions.ts writes the transition it documents", () => {
  const src = here("./actions.ts");
  const body = (name) => src.slice(src.indexOf(`export function ${name}`)).split("\n}\n")[0];
  assert.match(body("openBacklogFor"), /cutForRepo\(c, repo\.worktreePath\)/);
  assert.match(body("openBacklogIn"), /cutInRepo\(c, cwd\)/);
  assert.match(body("openBacklogCut"), /cutOpenedOn\(c, cwd, ids, label\)/);
});

test("the doors' transitions: a same-repo plain open keeps the ids chip, the launcher door drops it, a cut door replaces it", () => {
  const on = { repoDir: "/r/a", text: "t", filter: { ...NO_BACKLOG_FILTER, ids: ["x"] }, idsLabel: "x" };
  assert.equal(cutInRepo(on, "/r/a"), on);
  assert.equal(cutForRepo(on, "/r/a").filter.ids, null);
  assert.deepEqual(cutOpenedOn(on, "/r/a", ["y"], "l").filter.ids, ["y"]);
  assert.equal(cutInRepo(NO_CUT, "/r/a").repoDir, "/r/a", "the toolbar door lands on the session's repo over a hand-picked one");
  assert.equal(cutInRepo({ ...NO_CUT, repoDir: "/r/b" }, "/r/a").repoDir, "/r/a");
});

