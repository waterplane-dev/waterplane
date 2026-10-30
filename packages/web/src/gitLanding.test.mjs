// Which stored failure the git view shows. A repo can hold one unhandled failed push per
// branch, so the newest is not always the one tapped (review A3b, medium): the tapped
// record's id travels here and selects exactly that record; no id is the newest.
import test from "node:test";
import assert from "node:assert/strict";
import { clearFailureFocus, failureFocus, focusFailure, landOnGit, openGitPlain, storedFailure, subscribeFailureFocus } from "./gitLanding.ts";

const A = { verb: "push", at: 1, error: "A's log", id: "A", branch: "feature" };
const B = { verb: "push", at: 2, error: "B's log", id: "B", branch: "fix" };

test("the tapped record is the one shown, not the newest", () => {
  assert.equal(storedFailure([B, A], B, "A"), A);
  assert.equal(storedFailure([B, A], B, "B"), B);
});

test("no id (an old link, the repo chip) is the newest, as before", () => {
  assert.equal(storedFailure([B, A], B, null), B);
  assert.equal(storedFailure(undefined, B, null), B, "an older host sends no list");
});

test("a tapped record that is no longer unhandled shows NO stored failure, never another one", () => {
  assert.equal(storedFailure([B], B, "A"), undefined);
});

test("an older host (no list) with a tapped id falls back to its one record", () => {
  assert.equal(storedFailure(undefined, B, "A"), B);
});

test("the tapped failure is the git screen's state: a remount reads it again, another repo never", () => {
  focusFailure("r1", "A");
  assert.equal(failureFocus("r2"), null);
  assert.equal(failureFocus("r1"), "A");
  assert.equal(failureFocus("r1"), "A", "Back from the Send sheet remounts the view: the same record, not the newest");
  clearFailureFocus();
  assert.equal(failureFocus("r1"), null, "closed: the next open from the chip is the newest");
});

test("a git tap sets the focus BEFORE the open, and re-targets a view already open", () => {
  const seen = [];
  const off = subscribeFailureFocus(() => seen.push(failureFocus("r1")));
  const opened = [];
  const openGit = (id) => openGitPlain(id, (r) => opened.push(r));
  landOnGit({ repoId: "r1", failureId: "A" }, openGit);
  landOnGit({ repoId: "r1", failureId: "B" }, openGit);
  assert.deepEqual(opened, ["r1", "r1"]);
  assert.equal(failureFocus("r1"), "B", "the plain open inside the tap must not wipe the tapped id");
  assert.equal(seen.filter((x) => x).at(-1), "B", "an open view is told, so it re-renders on B (the in-between clear is batched in one handler)");
  landOnGit({ repoId: "r1" }, openGit);
  assert.equal(failureFocus("r1"), null, "a receipt's tap (no failure) opens on the newest, never a stale id");
  off();
  clearFailureFocus();
});

test("A and B fail; tap A; Back (no close handler); the chip's plain open shows the newest", () => {
  landOnGit({ repoId: "r1", failureId: "A" }, (id) => openGitPlain(id, () => {}));
  assert.equal(failureFocus("r1"), "A");
  // Back = popstate: nothing is called. Then the red chip -> openGitFor:
  openGitPlain("r1", () => {});
  assert.equal(failureFocus("r1"), null, "newest, not the stale A");
  clearFailureFocus();
});

test("the stored failure's sentence names its branch, and what clears it, when known", async () => {
  const { storedFailureWords } = await import("./gitLanding.ts");
  assert.equal(storedFailureWords(A, "3 min ago"), "The last push of feature failed 3 min ago. A push of feature that goes through clears it; dismiss clears it now.");
  assert.equal(storedFailureWords({ ...A, branch: undefined }, "3 min ago"), "The last push failed 3 min ago. A push that goes through clears it; dismiss clears it now.", "no branch on record (detached, an older host): any push that goes through clears it");
  assert.equal(storedFailureWords({ verb: "pull", at: 1, error: "", id: "P" }, "now"), "The last pull failed now. A pull that goes through clears it; dismiss clears it now.");
});

// The wiring cannot load under node (GitView/overlayViews/App are TSX, useRoute is an effect — its body is landRoute.ts;
// actions.ts imports the sdk barrel by extensionless paths), so it is SOURCE-pinned: revert any one line and this fails.
test("wiring: the view reads the screen's state, a tap sets it, the close ends it", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const view = src("./GitView.tsx");
  assert.match(view, /const tappedFailure = useFailureFocus\(repoId\);/, "GitView reads the focus as state, never a one-shot");
  assert.match(view, /const stored = storedFailure\(failures, newestStored, tappedFailure\);/, "and shows exactly that record");
  assert.doesNotMatch(view, /take\w*Failure/, "no take-on-mount");
  assert.match(src("./features/notifications/actions.ts"), /case "git": \{[\s\S]{0,400}landOnGit\(t, c\.nav\.openGit\)/, "a git tap goes through landOnGit");
  const app = src("./App.tsx");
  assert.match(app, /function openGitFor\(repoId: string\) \{ openGitPlain\(/, "every plain open (chip, badges, What's new) files its repo with no focus");
  assert.match(app, /const gitRepoId = useGitRoute\(\)\?\.repoId \?\? null;/, "App's repo is a VIEW of the route entry");
  assert.doesNotMatch(app, /setGitRepoId/, "nothing beside the route holds the git repo");
  const ov = src("./core/route/overlayViews.tsx");
  assert.match(ov, /failures=\{gitRepo\?\.gitFailures\}/, "the overlay hands the view every failure");
  assert.match(ov, /onClose=\{\(\) => \{ setOverlay\(null\); refreshRepos\(\); \}\}/, "the close is a Back onto an entry holding neither");
  assert.doesNotMatch(ov, /setGitRepoId/, "no repo slot beside the route");
  const route = src("./core/route/landRoute.ts");
  assert.match(route, /routeLanded\(r\.depth, routeStack\.keys\[r\.depth\] \?\? "", r\.adopt \? "push" : "return"\);/, "a pop reads the entry it lands on");
  assert.match(src("./core/route/useRoute.ts"), /landRoute\(activeId, overlay, focusRepo, first\);\n  \}, \[activeId, overlay, focusRepo, asks\]\);/, "the effect lands through landRoute, and a re-target re-runs it");
  assert.match(src("./core/route/landRoute.ts"), /routeLanded\(routeStack\.depth, routeStack\.keys\[routeStack\.depth\] \?\? "", plan\.how\);\n  if \(plan\.kind === "go"\) history\.go\(plan\.delta\);\n/, "and files the ask with the entry it lands on (routeLanding)");
});

// bughunt 2026-10-29 (review A3d, same cause): the repo and the tapped failure are the git
// route ENTRY's, so a Back that closes the view takes them with it.
test("toolbar diff after a Back that closed the git view opens the active repo, not the previous", async () => {
  const { routeStack, routeLanded } = await import("./backStep.ts");
  const { routeKey } = await import("./routing.ts");
  const { gitRoute } = await import("./gitLanding.ts");
  routeStack.keys = [routeKey(null, null), routeKey("s1", null)];
  routeStack.depth = 1;
  landOnGit({ repoId: "prev", failureId: "A" }, (id) => openGitPlain(id, () => {}));
  routeStack.keys[2] = routeKey("s1", "git"); routeStack.depth = 2;
  routeLanded(2, routeKey("s1", "git"), "push");
  assert.deepEqual(gitRoute(), { repoId: "prev", failureId: "A" });
  // the phone's Back: popstate, no close handler
  routeStack.depth = 1;
  routeLanded(1, routeKey("s1", null), "return");
  assert.equal(gitRoute(), null);
  assert.equal(failureFocus("prev"), null, "the focus died with the entry");
  // the toolbar's diff: a bare setOverlay("git") — the view falls back to the active repo
  routeStack.keys[2] = routeKey("s1", "git"); routeStack.depth = 2;
  routeLanded(2, routeKey("s1", "git"), "push");
  assert.equal(gitRoute(), null);
});

// bughunt 2026-10-29 (review R2-2 b): the toolbar's diff was a BARE `setOverlay("git")`, so with a
// git entry for another repo under Send (wide layout: the session's toolbar stays on screen) it
// unwound to that entry and showed ITS repo. Every door to the git view now says which repo.
test("toolbar diff over Send covering git{X} shows the session's repo, not X", async () => {
  const { routeStack, routeLanded } = await import("./backStep.ts");
  const { routeKey } = await import("./routing.ts");
  const { gitRoute } = await import("./gitLanding.ts");
  routeStack.keys = [routeKey(null, null), routeKey("s1", null)];
  routeStack.depth = 1;
  landOnGit({ repoId: "X", failureId: "A" }, (id) => openGitPlain(id, () => {}));
  routeStack.keys[2] = routeKey("s1", "git"); routeStack.depth = 2;
  routeLanded(2, routeKey("s1", "git"), "push");
  routeStack.keys[3] = routeKey("s1", "send"); routeStack.depth = 3;
  routeLanded(3, routeKey("s1", "send"), "push");
  // the toolbar's own door (review R2-2b L1: through openToolbarGit, never openGitPlain by hand):
  // its setOverlay("git") makes the route unwind onto git{X}, a fresh open
  const { openToolbarGit } = await import("./gitLanding.ts");
  const opened = [];
  assert.equal(openToolbarGit("A-repo", (o) => {
    opened.push(o);
    routeStack.depth = 2;
    routeLanded(2, routeKey("s1", "git"), "open");
  }), true);
  assert.deepEqual(opened, ["git"]);
  assert.deepEqual(gitRoute(), { repoId: "A-repo", failureId: null });
  assert.equal(openToolbarGit(null, () => opened.push("bare")), false, "no repo: no open, the caller says so");
  assert.deepEqual(opened, ["git"]);
});

test("wiring: both toolbar doors to the git view ask for the active repo", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const run = src("./core/session/runToolbar.ts");
  assert.match(run, /case "diff": if \(!openToolbarGit\(activeRepoId, setOverlay\)\) showToast\("not a known repo"\); break;/);
  const menu = src("./core/session/ToolbarMenu.tsx");
  assert.match(menu, /onClick=\{\(\) => \{ dismiss\(\); openToolbarGit\(activeRepo\.id, setOverlay\); \}\}/);
  for (const s of [run, menu]) assert.doesNotMatch(s, /setOverlay\("git"\)|openGitPlain/, "the toolbar's one door is openToolbarGit");
});

// review R2-2 (a), R2-2b M2: a git overlay with no entry params and no session under it (a reload or
// an update resume over the launcher) once drew nothing; then it guessed the repo with the newest
// failure — the commit screen, push and pull included, on a repo nobody asked for. Now it names the
// repo the entry, the `?repo=` focus or the session names, and with none of them says so.
test("gitViewRepoId: the entry's repo, else the session's, else the ?repo= focus, else none — never a guess", async () => {
  const { gitViewRepoId } = await import("./gitLanding.ts");
  const repos = [
    { id: "a", repoName: "alpha" },
    { id: "b", repoName: "beta", gitFailed: { at: 5 } },
    { id: "c", repoName: "gamma", gitFailed: { at: 9 } },
    { id: "g2", repoName: "gamma", isPrimary: false },
  ];
  assert.equal(gitViewRepoId("x", "beta", "a", repos), "x");
  assert.equal(gitViewRepoId(null, "beta", null, repos), "b", "with no session, the URL being resumed names its repo");
  // review R2-2c: a session in gamma's worktree under a `?repo=gamma` focus — the commit screen is
  // the session's checkout, never the primary one the focus resolves to.
  assert.equal(gitViewRepoId(null, "gamma", "g2", repos), "g2", "the session's checkout beats the focus");
  assert.equal(gitViewRepoId(null, "beta", "a", repos), "a");
  assert.equal(gitViewRepoId(null, "gamma", null, repos), "c", "a focus over worktrees is the primary checkout");
  assert.equal(gitViewRepoId(null, "nope", null, repos), null, "a focus no repo answers to names nothing");
  assert.equal(gitViewRepoId(null, null, "a", repos), "a");
  assert.equal(gitViewRepoId(null, null, null, repos), null, "the newest failure is not a request");
});

test("gitNoRepoWords: why nothing is drawn, and the way back", async () => {
  const { gitNoRepoWords } = await import("./gitLanding.ts");
  assert.equal(gitNoRepoWords(null), "Nothing names a repo for this screen — no session is open and the link it came back on carried none — so there is nothing to review. Go back, then open a session or a repo's git view from the launcher.");
  assert.equal(gitNoRepoWords("nope"), "No repo called nope is on this desktop's list, so there is nothing to review. Go back, then open a session or a repo's git view from the launcher.");
  assert.equal(gitNoRepoWords("nope", "unread"), "Waiting for the desktop's repo list to find nope. Go back, then open a session or a repo's git view from the launcher.", "an unread list is not a claim the repo is gone");
  // review R2-2c low: an unread list says waiting whatever named the repo, and an open session is never denied.
  assert.equal(gitNoRepoWords(null, "unread", true), "Waiting for the desktop's repo list to find this session's repo. Go back, then open a session or a repo's git view from the launcher.", "a resume over a session before the list loads");
  assert.equal(gitNoRepoWords(null, "rows", true), "The open session's folder is not one of this desktop's repos, so there is nothing to review. Go back, then open a session or a repo's git view from the launcher.", "never 'no session is open' over one");
  assert.equal(gitNoRepoWords(null, "unread", false), "Waiting for the desktop's repo list. Go back, then open a session or a repo's git view from the launcher.");
});

test("wiring: the git overlay names its repo through gitViewRepoId, and with none draws the reason", async () => {
  const { readFileSync } = await import("node:fs");
  const ov = readFileSync(new URL("./core/route/overlayViews.tsx", import.meta.url), "utf8");
  assert.match(ov, /const gitId = gitViewRepoId\(gitRepoId, focus, activeRepoId, repos\);/);
  assert.match(ov, /if \(!gitId\) return <GitNoRepo focus=\{focus\} list=\{listRead\(\{ rows: repos, readAt: reposAt \}\)\} session=\{!!active\} onClose=\{\(\) => setOverlay\(null\)\} \/>;/, "never an invisible screen");
  assert.doesNotMatch(ov, /gitRepoId \?\? activeRepoId/);
  const view = readFileSync(new URL("./GitView.tsx", import.meta.url), "utf8");
  assert.match(view, /export function GitNoRepo\([\s\S]{0,400}gitNoRepoWords\(focus, list, session\)/);
});
