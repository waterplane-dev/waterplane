// A host list's `[]` is two states: not read yet, and read with nothing in it. Both readers of the
// repo list — the launcher and the git screen with no repo — take the decision from the rows AND
// the read time, through the one `listRead`, so an unread list never says "none" (the launcher on
// a first boot did) and a read empty one never waits for ever (the git screen on a host with no
// repos did). Design round 2026-10-30 W4.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listRead } from "./listRead.ts";
import { gitNoRepoWords } from "./gitLanding.ts";
import { noReposWords } from "./core/launcher/model.ts";

test("listRead: rows win, an empty list is unread until the host has answered for it", () => {
  assert.equal(listRead({ rows: [], readAt: 0 }), "unread");
  assert.equal(listRead({ rows: [], readAt: 1_700_000_000_000 }), "empty");
  assert.equal(listRead({ rows: [{ id: "a" }], readAt: 1_700_000_000_000 }), "rows");
  assert.equal(listRead({ rows: [{ id: "a" }], readAt: 0 }), "rows", "a snapshot from before the read time was kept still has rows to show");
});

test("both readers: unread/empty waits, read/empty says none", () => {
  const unread = listRead({ rows: [], readAt: 0 });
  const none = listRead({ rows: [], readAt: 5 });
  assert.equal(noReposWords(unread), "Waiting for the desktop's repo list.");
  assert.equal(noReposWords(none), "No repos under host root.");
  assert.equal(noReposWords(listRead({ rows: [{ id: "a" }], readAt: 5 })), null, "a list with rows draws them, no sentence");
  assert.equal(gitNoRepoWords(null, unread, true), "Waiting for the desktop's repo list to find this session's repo. Go back, then open a session or a repo's git view from the launcher.");
  assert.equal(gitNoRepoWords(null, none, true), "The open session's folder is not one of this desktop's repos, so there is nothing to review. Go back, then open a session or a repo's git view from the launcher.", "a host with no repos never waits for ever");
  assert.equal(gitNoRepoWords("app", none), "No repo called app is on this desktop's list, so there is nothing to review. Go back, then open a session or a repo's git view from the launcher.");
});

test("wiring: both readers pass the repo list's read time, never its length alone", () => {
  const ov = readFileSync(new URL("./core/route/overlayViews.tsx", import.meta.url), "utf8");
  assert.match(ov, /<GitNoRepo focus=\{focus\} list=\{listRead\(\{ rows: repos, readAt: reposAt \}\)\}/);
  const launcher = readFileSync(new URL("./core/launcher/LauncherScreen.tsx", import.meta.url), "utf8");
  assert.match(launcher, /noReposWords\(listRead\(\{ rows: repos, readAt: reposAt \}\)\)/);
  assert.doesNotMatch(launcher, /repos\.length === 0 && <Empty>No repos under host root\./);
});

test("sdk: a feature reads the repo list WITH its read time, and the same listRead", () => {
  const types = readFileSync(new URL("./sdk/types.ts", import.meta.url), "utf8");
  assert.match(types, /readonly repos: RepoTarget\[\];\n(\s+\/\*\*[^\n]*\n(\s+\*[^\n]*\n)*)?\s+readonly reposAt: number;/);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /world: \{\n\s+sessions, repos, reposAt, /);
  const sdk = readFileSync(new URL("./sdk/index.ts", import.meta.url), "utf8");
  assert.match(sdk, /export \{ listRead, type HostList, type ListRead \} from "\.\.\/listRead\.ts";/);
});
