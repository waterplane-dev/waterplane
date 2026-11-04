/**
 * Import this FIRST, then `await import("./x.ts")`, to run a web module whose imports are extensionless
 * (Vite's spelling) under `node --test`. Node resolves neither that nor the parameter properties and JSX
 * further down the chain, which is why such a module otherwise gets a source-text test or none at all.
 *
 * The import must be dynamic: a static one is linked before this file's hooks exist. `typescript` here is
 * the repo's own, and only emits; nothing is type-checked. The hooks last for the test file's own process.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };

registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec) && ctx.parentURL?.startsWith("file:")) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const url = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url) || url.includes("/node_modules/")) return next(url, ctx);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
