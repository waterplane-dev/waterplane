// What `api.ts` exports — names AND value/type — pinned off the type checker,
// so moving its routes into `routes/api*.ts` cannot quietly add, drop or
// retype an export `server/http.ts` and the host tests import
// (`handleApi`, `answerPreflight`, `isLoopbackAddr`). The shape of
// packages/shared/test/intentsurface.test.mjs; reasoning in
// docs/notes/host-architecture.md, "api.ts — the HTTP routes as tables".
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const FILE = fileURLToPath(new URL("../src/api.ts", import.meta.url));
const SURFACE = ["answerPreflight:value", "handleApi:value", "isLoopbackAddr:value"];

test("api.ts exports exactly its pinned surface", () => {
  const program = ts.createProgram([FILE], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(FILE));
  assert.ok(mod, "src/api.ts did not parse as a module");
  const got = checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
  assert.deepEqual(got, SURFACE);
});
