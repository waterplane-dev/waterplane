/**
 * `local/feature-boundary`, pinned both ways.
 *
 * A boundary rule that is too loose is invisible (everything passes) and one
 * that is too tight is deleted the first time it blocks a legitimate import —
 * so each allowed edge is asserted as allowed, and each refused one as refused,
 * against the pure path decision and once through ESLint itself so the wiring
 * (filename → `src/`-relative path → report) is covered too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local, { featureBoundary } from "./eslint/rules.js";

const ok = (from, to) => assert.equal(featureBoundary(from, to), null, `${from} → ${to} should be allowed`);
const ok_type = (from, to) => assert.equal(featureBoundary(from, to, true), null, `${from} → type-only ${to} should be allowed`);
const no = (from, to, re) => {
  const why = featureBoundary(from, to);
  assert.ok(why, `${from} → ${to} should be refused`);
  if (re) assert.match(why, re);
};

test("a feature reaches its own folder, the SDK index and top-level modules", () => {
  ok("features/pull/index.ts", "features/pull/store");
  ok("features/pull/PullSheet.tsx", "features/pull");
  ok("features/pull/index.ts", "sdk");
  ok("features/pull/index.ts", "format");
  ok("features/pull/index.ts", "Sheet");
});

test("a feature never reaches another feature, core/, App or the registry", () => {
  no("features/pull/index.ts", "features/build", /never import each other/);
  no("features/pull/index.ts", "features/build/store", /never import each other/);
  no("features/pull/index.ts", "core/api", /core\//);
  no("features/pull/index.ts", "App", /never imports App/);
  ok_type("features/pull/index.ts", "App");
  no("features/pull/index.ts", "features/registry", /registry/);
  no("features/pull/index.ts", "sdk/store", /index/);
});

test("only the five core runners read the registry; sdk imports no feature", () => {
  ok("core/dispatch.ts", "features/registry");
  ok("core/sheets.ts", "features/registry");
  ok("core/settingsRows.ts", "features/registry");
  ok("core/toolbarItems.ts", "features/registry");
  ok("core/extensionPoints.ts", "features/registry");
  no("core/api.ts", "features/registry");
  no("core/launcher/LauncherScreen.tsx", "features/registry", /registry/);
  no("App.tsx", "features/registry");
  no("sdk/index.ts", "features/pull", /never imports a feature/);
  ok("sdk/index.ts", "core/api");
});

test("a core screen reaches a feature through its index, like App does", () => {
  ok("core/launcher/LauncherScreen.tsx", "features/schedule");
  no("core/launcher/LauncherScreen.tsx", "features/schedule/store", /index/);
  ok("core/api.ts", "features/pull");
  // The allowance is for core/, not for anything named like it.
  no("coreish.ts", "features/pull", /only App.tsx and core\//);
  no("Backlog.tsx", "features/pull", /only App.tsx and core\//);
});

test("outside features/, a feature is reached through its index only", () => {
  ok("App.tsx", "features/pull");
  no("App.tsx", "features/pull/store", /index/);
  ok("Backlog.tsx", "format");
});

test("the rule reports through ESLint on the resolved path", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [{ files: ["**/*.ts"], plugins: { local }, rules: { "local/feature-boundary": "error" } }];
  const lint = (file, code) => linter.verify(code, config, { filename: file }).map((m) => m.message);
  const root = "packages/web/src/";
  assert.deepEqual(lint(root + "features/pull/index.ts",
    `import { core } from "../../sdk/index.ts"; import { fmtSize } from "../../format"; import { x } from "./store";`), []);
  const bad = lint(root + "features/pull/index.ts",
    `import { a } from "../build"; export { b } from "../../core/api.ts"; const c = import("../../App");`);
  assert.equal(bad.length, 3, bad.join("\n"));
  assert.ok(bad.every((m) => m.startsWith("A change in features/<x> stays in features/<x>")));
  // A file outside the web tree is none of this rule's business.
  assert.deepEqual(lint("packages/host/src/x.ts", `import { a } from "../web/src/features/pull/store";`), []);
});

test("a feature takes no VALUE import of ws, outbox, routing, App or main — `import type` is fine", () => {
  for (const m of ["ws", "outbox", "routing", "App", "main"]) {
    no("features/pull/index.ts", m, new RegExp(`value import of \`${m}\``));
    ok_type("features/pull/index.ts", m);
  }
  // The deny-list is a list, not a prefix: a module merely NAMED like one is not on it.
  ok("features/pull/index.ts", "wsHealth");
  ok("features/pull/index.ts", "outboxView");
});

test("only App, core/ and the registry import a feature", () => {
  ok("App.tsx", "features/build");
  ok("core/dispatch.ts", "features/registry");
  ok("features/registry.ts", "features/build");
  no("Backlog.tsx", "features/build", /only App\.tsx and core\/ import a feature/);
  no("main.tsx", "features/pull", /only App\.tsx/);
  no("sdk/index.ts", "features/pull", /never imports a feature/);
});

test("the rule reads importKind: type-only imports pass, value and side-effect imports do not", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [{
    files: ["**/*.ts"], plugins: { local },
    languageOptions: { parser: tsParser },
    rules: { "local/feature-boundary": "error" },
  }];
  const lint = (file, code) => linter.verify(code, config, { filename: file }).map((m) => m.message);
  const f = "packages/web/src/features/pull/index.ts";
  assert.deepEqual(lint(f, `import type { Overlay } from "../../routing"; import { type Conn } from "../../ws"; export type { X } from "../../outbox";`), []);
  const bad = lint(f, `import { go } from "../../routing"; import { type A, b } from "../../ws"; import "../../main"; export { q } from "../../outbox";`);
  assert.equal(bad.length, 4, bad.join("\n"));
  assert.deepEqual(lint("packages/web/src/Backlog.ts", `import { openBuildFor } from "./features/build";`).length, 1);
});
