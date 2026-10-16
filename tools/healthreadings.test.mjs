import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capFromConfig, lineCount, inCapScope, countNearCap, kbOf, bareHookDisables,
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
