// The attention key's format is one contract with ONE writer and ONE reader
// (`attentionKey` / `parseAttentionKey`), used by the host and the phone alike.
// Phones in the field read it with an older pattern, so the format is frozen:
// a failed push's branch rides beside it (`NotificationItem.branch`), never in it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attentionKey, parseAttentionKey, gitAttentionKey, buildAttentionKey, gitPushFailureKey, prAttentionKey } from "../dist/index.js";

test("every key the writer makes, the reader gives back whole", () => {
  for (const k of [
    { kind: "git", repoId: "a1b2c3d4e5", verb: "push" },
    { kind: "git", repoId: "a1b2c3d4e5", verb: "pull" },
    { kind: "build", repoId: "a1b2c3d4e5", buildId: "apk" },
    { kind: "git", repoId: "C:/x", verb: "pull" },
    { kind: "build", repoId: "C:/x", buildId: "web" },
    { kind: "pr", repoId: "a1b2c3d4e5", number: 42 },
    { kind: "pr", repoId: "C:/x", number: 1 },
  ]) assert.deepEqual(parseAttentionKey(attentionKey(k)), k);
});

test("the named builders are the writer, spelled as phones in the field read it", () => {
  assert.equal(gitAttentionKey("abc", "push"), "git:abc:push");
  assert.equal(buildAttentionKey("abc", "apk"), "build:abc:apk");
  assert.equal(gitPushFailureKey("abc"), "git:abc:push");
  assert.equal(prAttentionKey("abc", 42), "pr:abc:42");
});

// A PR notice's key was spelled by hand in prs.ts as `pr:<repoId>:<number>` until design round 4;
// attention files on disk still hold that exact string. The host resolves a PR item by the whole
// key string (`resolveAttention`), so the writer must spell the same bytes or a merge never resolves
// the "check failed" it was filed under; the reader taking it back keeps the phone's narrowing honest.
test("a pr key an older host stored parses, and the writer spells it byte for byte", () => {
  for (const [old, want] of [
    ["pr:9f8e7d6c5b:17", { kind: "pr", repoId: "9f8e7d6c5b", number: 17 }],
    ["pr:C:/dev/x:3", { kind: "pr", repoId: "C:/dev/x", number: 3 }],
  ]) {
    assert.deepEqual(parseAttentionKey(old), want, old);
    assert.equal(prAttentionKey(want.repoId, want.number), old);
  }
});

// The writer is total for what the reader accepts: a PR number that is not a positive safe integer
// would be written as a key the reader refuses ("pr:abc:0", "pr:abc:NaN", "pr:abc:1.5", "pr:abc:1e+21"),
// filing a notice nothing can ever resolve. That is a programming error in the host (a PR number
// comes from the forge as an integer), so the builder throws rather than write it (design round 5).
test("a pr number the reader would refuse is refused by the writer, loudly", () => {
  for (const n of [0, -2, 1.5, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => prAttentionKey("abc", n), /PR number/, String(n));
    assert.throws(() => attentionKey({ kind: "pr", repoId: "abc", number: n }), /PR number/, String(n));
  }
  for (const n of [1, 7, 10, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseAttentionKey(prAttentionKey("abc", n)), { kind: "pr", repoId: "abc", number: n });
  }
});

test("anything else is null, never a wrong repo or verb", () => {
  for (const bad of [undefined, null, "", "git:", "git::push", "git:abc", "git:abc:merge",
    "prompt:s1", "followup:s1", "build:abc:", "xgit:abc:push",
    "pr:abc", "pr::3", "pr:abc:", "pr:abc:x", "pr:abc:0", "pr:abc:-2", "pr:abc:1.5", "pr:abc:07", "pr-abc-3",
    // the host-only per-branch identity: the old regex read it as repo "abc:push", verb "feature"
    gitPushFailureKey("abc", "feature")]) {
    assert.equal(parseAttentionKey(bad), null, String(bad));
  }
});

// Every former hand-written parser now calls the one reader. The scan is scoped to ATTENTION KEY
// literals — `git:` has no other meaning in this repo, while `build:` is also a queue lane
// (`build:<dir>`), so a `build:` hit needs the key's two-segment form. Caught: an alternation of
// the two kinds in either order, `startsWith("git:")`, a `/^git:` or `/^build:` pattern, and a
// key spelled by hand (`"git:" +`, `` `git:${…}` ``, `` `build:${…}:` ``). Review A3c (low).
const HAND_PARSE = [
  /\((?:git\|build|build\|git)\)/,
  /startsWith\(\s*["'`]git:/,
  /[/"'`]\^(?:git|build):/,
  /["'`]git:["'`]\s*\+/,
  /["'`]git:\$\{/,
  /build:\$\{[^}]+\}:/,
  /\|pr\)|\(pr\|/,
  /startsWith\(\s*["'`]pr:/,
  /[/"'`]\^pr:/,
  /["'`]pr:["'`]\s*\+/,
  /["'`]pr:\$\{/,
];
const handParses = (src) => HAND_PARSE.some((re) => re.test(src));

test("the hand-parse detector: the shapes a reader re-grows, and not the build LANE", () => {
  for (const bad of [
    'const m = /^(git|build):(.+):([^:]+)$/.exec(k);', 'new RegExp("^(build|git):")', 'if (key.startsWith("git:")) x();',
    "key.startsWith('git:')", 'if (/^git:/.test(k)) x();', 'Pattern.compile("^build:(.+):")', 'const k = "git:" + id + ":push";',
    "const k = `git:${id}:push`;", "const k = `build:${id}:${b}`;",
    "const prKey = (repoId, n) => `pr:${repoId}:${n}`;", 'if (key.startsWith("pr:")) x();', "/^pr:(.+):(\\d+)$/",
    'const k = "pr:" + id + ":" + n;', "/^(git|build|pr):/",
  ]) assert.ok(handParses(bad), bad);
  for (const ok of [
    "export const buildLane = (repoDir) => `build:${repoDir}`;", 'if (e.sessionId.startsWith("build:")) x();',
    'const tag = `git-${id}-push`;', "const tag = `pr-${id}-${n}`;", "parseAttentionKey(n.key)?.kind === \"git\"", "// a git: remote url",
  ]) assert.ok(!handParses(ok), ok);
});

test("no source file outside the pair parses or spells the key by hand — host, web, shared, extensions, VS Code, the APK", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dirs = ["packages/web/src", "packages/host/src", "packages/shared/src", "packages/extensions", "packages/vscode/src",
    "packages/vscode/webview", "packages/web/public", "packages/app/android/app/src/main/java", "packages/app/scripts"].map((d) => join(root, d));
  const SKIP = new Set(["node_modules", "dist", "test", "e2e", "assets"]); // assets: vendored bundles
  const hits = [];
  let files = 0;
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (!SKIP.has(name)) walk(p); continue; }
      if (!/\.(ts|tsx|mts|js|mjs|java|kt)$/.test(name) || /\.test\./.test(name)) continue;
      files++;
      if (p.endsWith(join("wire", "notify.ts"))) continue;
      if (handParses(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  dirs.forEach(walk);
  assert.ok(files > 500, `the walk reached the tree (${files} files)`);
  assert.deepEqual(hits, []);
});

test("the callers that read a key back go through parseAttentionKey", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const f of ["packages/web/src/features/whatsnew/logic.ts", "packages/web/src/features/notifications/logic.ts", "packages/host/src/attentionstore.ts"]) {
    assert.ok(readFileSync(join(root, f), "utf8").includes("parseAttentionKey("), f);
  }
});
