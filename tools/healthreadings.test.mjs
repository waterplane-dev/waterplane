import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  capFromConfig, lineCount, inCapScope, countNearCap, kbOf, bareHookDisables, isNoteLine, countCapSqueeze,
} from "./healthreadings.mjs";

const lines = (n) => Array.from({ length: n }, () => "x").join("\n") + "\n";

test("cap is read from the eslint config, with a fallback", () => {
  assert.equal(capFromConfig('"max-lines": ["error", { max: 700, skipBlankLines: false }]'), 700);
  assert.equal(capFromConfig("nothing here"), 900);
});

test("lineCount ignores one final newline", () => {
  assert.equal(lineCount(lines(3)), 3);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount(""), 0);
});

test("nearCap counts only in-scope files at or past cap - 50", () => {
  const f = (path, n) => ({ path, text: lines(n) });
  const files = [
    f("packages/web/src/a.tsx", 850),
    f("packages/web/src/b.ts", 849),
    f("packages/host/src/c.ts", 900),
    f("packages/host/dist/d.ts", 900),
    f("packages/host/test/fixtures/e.ts", 900),
    f("scripts/x.mjs", 900),
    f("packages/app/src/y.ts", 900),
  ];
  assert.equal(countNearCap(files, 900), 3 - 1 + 0 === 2 ? 2 : -1);
  assert.equal(inCapScope("packages/extensions/desktop/web/z.tsx"), true);
});

test("cap scope covers extension host/shared/cli halves and tools/ (.mjs and .js), never their tests", () => {
  assert.equal(inCapScope("packages/extensions/vault/host/index.mts"), true);
  assert.equal(inCapScope("packages/extensions/vault/shared/wire/push.mts"), true);
  assert.equal(inCapScope("packages/extensions/vault/cli/scan/logins.mjs"), true);
  assert.equal(inCapScope("tools/repohealth/narrate.mjs"), true);
  assert.equal(inCapScope("tools/healthreadings.test.mjs"), false);
  assert.equal(inCapScope("packages/extensions/vault/test/cli.test.mjs"), false);
  assert.equal(inCapScope("packages/extensions/vault/web/x.mts"), false);
  assert.equal(inCapScope("scripts/claude-stub-tui.mjs"), false);
  assert.equal(inCapScope("tools/eslint/rules.js"), true);
});

test("kbOf is one decimal", () => {
  assert.equal(kbOf(12345), 12.3);
  assert.equal(kbOf(0), 0);
});

test("bareHookDisables: reason inline or comment above is fine, bare is counted", () => {
  const src = [
    "// eslint-disable-next-line react-hooks/exhaustive-deps",       // 1 bare (nothing above)
    "const a = 1;",
    "// ref is stable across renders",
    "// eslint-disable-next-line react-hooks/exhaustive-deps",       // explained above
    "x();",
    "// eslint-disable-next-line react-hooks/exhaustive-deps -- id is stable", // inline reason
    "y();",
    "z(); // eslint-disable-line react-hooks/exhaustive-deps",       // 8 bare
    "{/* eslint-disable-next-line react-hooks/exhaustive-deps */}",  // 9 bare (prev is code)
  ].join("\n");
  assert.deepEqual(bareHookDisables(src), [1, 8, 9]);
  assert.deepEqual(bareHookDisables("const a = 1;\n"), []);
});

test("isNoteLine: comments and blanks are notes, code is not", () => {
  for (const l of ["", "  ", "// why", " * more", "/** doc", " */", "{/* jsx */}"]) assert.equal(isNoteLine(l), true, l);
  for (const l of ["const a = 1;", "x(); // trailing", "}"]) assert.equal(isNoteLine(l), false, l);
});

test("capSqueeze counts a comment-only shrink at 880+, not a code move or a file under 880", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capsqueeze-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: dir, env, stdio: "pipe" });
  const write = (p, text) => { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), text); };
  const file = (code, notes) => [...Array.from({ length: notes }, (_, i) => `// note ${i}`),
    ...Array.from({ length: code }, (_, i) => `export const c${i} = ${i};`)].join("\n") + "\n";
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); };
  git("init", "-q");
  write("packages/host/src/a.ts", file(800, 95));  // 895
  write("packages/host/src/b.ts", file(800, 95));  // 895
  write("packages/host/src/c.ts", file(800, 70));  // 870
  commit("base");
  write("packages/host/src/a.ts", file(800, 80));  // notes trimmed to fit: counts
  commit("squeeze a");
  write("packages/host/src/b.ts", file(780, 95));  // code moved out by subject: does not
  write("packages/host/src/b2.ts", file(20, 0));
  commit("split b");
  write("packages/host/src/c.ts", file(800, 50));  // under 880 before: does not
  commit("trim c");
  assert.equal(countCapSqueeze({ cwd: dir, cap: 900 }), 1);
});
