// A module's export surface read off the type checker — names AND whether each
// is a value or a type — for the pin tests that hold a split or a barrel to its
// public API (`*surface.test.mjs`, `*pins.test.mjs`).
//
// Why the checker and not `Object.keys(await import(…))`: half of a surface is
// TYPES, which a compiled module does not carry at all. The checker sees both
// halves through a barrel's re-exports.
//
// There is deliberately no "update the pins" mode. A pin list changes because
// someone decided the API changes, never to make a refactor pass; the failure
// therefore names exactly what to add or remove, and the edit stays by hand.
import assert from "node:assert/strict";
import { relative } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;

/** The compiler setup a file builds under: the web's Vite resolution (`.ts`
 *  extensions, JSX) under packages/web, node's everywhere else. */
function optionsFor(file) {
  if (/\.tsx$/.test(file) || /packages[\\/]web[\\/]/.test(file)) {
    return {
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
    };
  }
  return {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    noEmit: true, skipLibCheck: true,
  };
}

/** Each export of `file` as `name:value` or `name:type`, sorted. */
export function exportSurface(file) {
  const program = ts.createProgram([file], optionsFor(file));
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${relative(ROOT, file)} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

/** `file` exports exactly `pinned` (any order). On a mismatch, says which
 *  entries are new and which are gone, instead of a diff of the whole list. */
export function assertSurface(file, pinned) {
  const got = exportSurface(file);
  const want = [...pinned].sort();
  const added = got.filter((x) => !want.includes(x));
  const gone = want.filter((x) => !got.includes(x));
  if (!added.length && !gone.length && got.length === want.length) return;
  const lines = [`${relative(ROOT, file)} no longer exports exactly its pinned surface.`];
  if (added.length) lines.push(`  exported, not pinned — pin it if the API really grew: ${added.map((x) => JSON.stringify(x)).join(", ")}`);
  if (gone.length) lines.push(`  pinned, not exported — unpin it if dropping it is meant: ${gone.map((x) => JSON.stringify(x)).join(", ")}`);
  if (!added.length && !gone.length) lines.push("  the pin list holds a duplicate");
  assert.fail(lines.join("\n"));
}
