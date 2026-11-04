import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import {
  capFromConfig, inCapScope, countNearCap, kbOf, bareHookDisables, isNoteLine, countCapSqueeze,
  SEAMS, seamsUntested,
} from "./healthreadings.mjs";
import { codeLineCount, lineCount } from "./codelines.mjs";
import eslintConfig from "../eslint.config.js";

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

// ── The cap itself: the real config, run by the real rule ───────────────────

const capRules = eslintConfig.flatMap((b) => (b.rules?.["max-lines"] ? [b.rules["max-lines"]] : []));
const linter = new Linter({ configType: "flat" });
const lintConfig = (rule) => [{
  files: ["**/*.{ts,tsx,mts,mjs,js}"],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
  rules: { "max-lines": rule },
}];
const verdicts = (text, rule, filename) => linter.verify(text, lintConfig(rule), { filename });
const refused = (text, rule) => verdicts(text, rule, "a.ts").some((m) => m.ruleId === "max-lines");
const codeOf = (n) => Array.from({ length: n }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n";
const notesOf = (n) => Array.from({ length: n }, (_, i) => `// note ${i}`).join("\n") + "\n";

test("every max-lines block counts code: comments free, blanks counted, the number nearCap reads", () => {
  assert.equal(capRules.length, 2);
  for (const [, opts] of capRules) {
    assert.deepEqual(opts, { max: capFromConfig(readFileSync(new URL("../eslint.config.js", import.meta.url), "utf8")), skipBlankLines: false, skipComments: true });
  }
});

test("eslint refuses past 900 lines of code whatever the notes, and takes 800 of code with 300 of notes", () => {
  for (const rule of capRules) {
    assert.equal(refused(notesOf(300) + codeOf(901), rule), true, "901 code lines");
    assert.equal(refused(notesOf(300) + codeOf(900), rule), false, "900 code lines: the cap is the last line allowed");
    assert.equal(refused(notesOf(300) + codeOf(800), rule), false, "800 code lines, 1100 in all");
  }
});

test("codeLineCount agrees with eslint's own count on what a hand scan would get wrong", () => {
  const cases = {
    "a.ts": [
      "// a comment\nconst a = 1;\n",
      "const a = 1; // trailing keeps its line\n/* leading */ const b = 2;\n",
      "/* one\n\n   blank inside a comment is comment */\n\nconst a = 1;\n",
      "const a = 1; /* opens on code\n   and runs on\n   closes on code */ const b = 2;\n",
      "const s = \"// not a comment\";\nconst t = '/* nor this */';\n",
      "const t = `\n// in a template\n/* still */\n`;\n",
      "const r = /\\/\\*/;\nconst q = /[/*]/.test(\"x\");\n",
      "/** doc */\nexport function f() {}\n// at the end\n",
      "// only\n// comments\n",
      "const a = 1;\n/** a doc comment\n    closing the file */\n",
      "const a = 1;\n\n\nconst b = 2;",
      "const a = 1;\r\n// note\r\nconst b = 2;\r\n",
    ],
    "a.tsx": [
      "const a = <a href=\"x\">http://not.a.comment</a>;\n",
      "const a = (\n  <div>\n    {/* jsx note */}\n    {/* two\n        lines */}\n    // text, not a comment\n  </div>\n);\n",
    ],
    "a.mjs": ["#!/usr/bin/env node\n// note\nconst a = 1;\n"],
  };
  const opts = { max: 0, skipBlankLines: false, skipComments: true };
  for (const [filename, texts] of Object.entries(cases)) {
    for (const text of texts) {
      const msgs = verdicts(text, ["error", opts], filename);
      assert.equal(msgs.find((m) => m.fatal), undefined, text);
      const hit = msgs.find((m) => m.ruleId === "max-lines");
      const eslintCount = hit ? Number(/\((\d+)\)/.exec(hit.message)[1]) : 0;
      assert.equal(codeLineCount(text, filename), eslintCount, text);
    }
  }
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

test("nearCap reads code lines: a long file of notes is not near the cap", () => {
  assert.equal(countNearCap([{ path: "packages/host/src/a.ts", text: notesOf(300) + codeOf(849) }], 900), 0);
  assert.equal(countNearCap([{ path: "packages/host/src/a.ts", text: notesOf(300) + codeOf(850) }], 900), 1);
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

test("capSqueeze counts a notes-only shrink at 880+ lines of code, not a code move or a long file of notes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capsqueeze-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: dir, env, stdio: "pipe" });
  const write = (p, text) => { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), text); };
  const file = (code, notes) => [...Array.from({ length: notes }, (_, i) => `// note ${i}`),
    ...Array.from({ length: code }, (_, i) => `export const c${i} = ${i};`)].join("\n") + "\n";
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); };
  git("init", "-q");
  write("packages/host/src/a.ts", file(885, 15));
  write("packages/host/src/b.ts", file(885, 15));
  write("packages/host/src/c.ts", file(800, 95));  // 895 in all, 800 of code
  commit("base");
  write("packages/host/src/a.ts", file(885, 5));   // notes trimmed near the cap: counts
  commit("squeeze a");
  write("packages/host/src/b.ts", file(865, 15));  // code moved out by subject: does not
  write("packages/host/src/b2.ts", file(20, 0));
  commit("split b");
  write("packages/host/src/c.ts", file(800, 50));  // under 880 of code before: does not
  commit("trim c");
  assert.equal(countCapSqueeze({ cwd: dir, cap: 900 }), 1);
});

// ── seamUntested ────────────────────────────────────────────────────────────

test("seamsUntested counts only the seams on the untested list, a directory seam one level deep", () => {
  const seams = ["src/deliver.ts", "src/queue/"];
  const sources = ["src/deliver.ts", "src/other.ts", "src/queue/a.ts", "src/queue/b.tsx", "src/queue/deep/c.ts", "src/queuer.ts"];
  assert.deepEqual(seamsUntested(seams, sources, ["src/deliver.ts", "src/other.ts", "src/queue/b.tsx", "src/queue/deep/c.ts", "src/queuer.ts"]),
    ["src/deliver.ts", "src/queue/b.tsx"]);
  assert.deepEqual(seamsUntested(seams, sources, ["src/other.ts"]), [], "a real 0: every seam was found and none is listed");
});

test("seamsUntested refuses rather than answer 0 for what it could not count", () => {
  assert.throws(() => seamsUntested(["a.ts"], ["a.ts"], null), /no untested list/);
  assert.throws(() => seamsUntested(["a.ts", "gone.ts", "gone/"], ["a.ts"], []), /gone\.ts, gone\/.*stale/);
});

test("every seam names a file in the tree, so the declared list is not already stale", () => {
  assert.deepEqual(SEAMS.filter((s) => !existsSync(new URL(`../${s}`, import.meta.url))), []);
});
