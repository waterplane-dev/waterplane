/**
 * No RUNTIME import cycle in shared, host or web.
 *
 * An ES module cycle is legal and usually works — until it does not. Which
 * module of the ring finishes evaluating first depends on which one was
 * ENTERED first, so a top-level read of an import (a cache seeded at load, a
 * `const x = imported()`, a class extending an import) is `undefined` or a TDZ
 * throw from one entry point and fine from another. The host and the phone both
 * hold module-level caches and stores, and a test that imports a slice directly
 * enters the ring at a different place from `main.ts`. Four such rings were cut
 * at once (the ledger readers, the HTTP client ↔ the link store, the link
 * store's own slices, `Repo readings`' two regions); this keeps them cut.
 *
 * A TYPE-ONLY edge is erased by the compiler and is not a cycle at runtime:
 * `import type` / `export type`, and a braced list whose every name is
 * `type X`, are skipped. A dynamic `import()` is lazy and is not read at all.
 * The graph is read off the TypeScript parser (no build, no import), each
 * package on its own, and the strongly connected components come out of
 * Tarjan's algorithm — every ring is printed with the edges that close it, so
 * the failure names the line to cut.
 *
 * The fix is never an exemption here. Move what both sides need into a leaf
 * (`claudeconfig.ts`, `link/linkBus.ts`, `repoHealthPlot.ts`'s keys), import
 * the slice a barrel re-exports rather than the barrel, or hand the dependency
 * in. Reasoning: docs/notes/testing-and-ops.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;

/** Package → its `src`, plus the bare specifiers its bundler resolves into
 *  that same tree (web's `vite.config.ts` aliases), which close rings too. */
const PACKAGES = {
  shared: { src: "packages/shared/src", alias: {} },
  host: { src: "packages/host/src", alias: {} },
  web: {
    src: "packages/web/src",
    alias: { "@waterplane/sdk": "sdk/index.ts", "@waterplane/kit": "kit/index.ts" },
  },
};

/** Every `.ts`/`.tsx` under `dir`, tests and declaration files left out. */
function sources(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !f.endsWith(".d.ts"))
    .sort();
}

/**
 * The runtime specifiers one file imports or re-exports, off the compiler's own
 * parse (a regex cannot tell a commented-out import, or `{ type A }`, from a
 * real edge). `import x from`, `import { a } from`, `import * as n from`,
 * `import "side"`, `export * from`, `export { a } from` — minus `import type`,
 * `export type`, and a braced list whose every name is `type X` (a default or a
 * namespace beside it keeps the edge).
 */
function runtimeSpecifiers(file, text) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const allTypes = (els) => els.length > 0 && els.every((e) => e.isTypeOnly);
  const out = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c?.isTypeOnly) continue;
      const nb = c?.namedBindings;
      if (c && !c.name && nb && ts.isNamedImports(nb) && allTypes(nb.elements)) continue;
      out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      const ec = st.exportClause;
      if (ec && ts.isNamedExports(ec) && allTypes(ec.elements)) continue;
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

function graphOf({ src, alias }) {
  const dir = join(ROOT, src);
  const files = sources(dir);
  const known = new Set(files);
  const resolveSpec = (from, spec) => {
    let base;
    if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else if (alias[spec]) base = join(dir, alias[spec]);
    else return null; // a package — outside this tree
    base = base.replace(/\.(js|ts|tsx)$/, "");
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (known.has(c)) return c;
    }
    return null;
  };
  const g = new Map();
  for (const f of files) {
    const deps = runtimeSpecifiers(f, readFileSync(f, "utf8"))
      .map((s) => resolveSpec(f, s))
      .filter((t) => t && t !== f);
    g.set(f, [...new Set(deps)]);
  }
  return { dir, g };
}

/** Tarjan's strongly connected components; only the rings (size > 1) back. */
function rings(g) {
  let idx = 0;
  const stack = [], onStack = new Set(), index = new Map(), low = new Map(), out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of g.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1) out.push(c);
    }
  };
  for (const v of g.keys()) if (!index.has(v)) visit(v);
  return out;
}

for (const [name, pkg] of Object.entries(PACKAGES)) {
  test(`${name}: no runtime import cycle`, (t) => {
    if (!existsSync(join(ROOT, pkg.src))) return t.skip(`${pkg.src} is not in this tree`);
    const { dir, g } = graphOf(pkg);
    const found = rings(g).map((ring) => {
      const inRing = new Set(ring);
      const rel = (f) => relative(dir, f);
      const edges = ring.sort().map((f) => `    ${rel(f)} -> ${g.get(f).filter((x) => inRing.has(x)).map(rel).join(", ")}`);
      return `  ring of ${ring.length}:\n${edges.join("\n")}`;
    });
    assert.deepEqual(
      found, [],
      `${pkg.src} has a runtime import cycle — ESM init order then depends on which file is entered\n` +
      `first. Cut one edge: a leaf both sides import, the slice instead of its barrel, or an\n` +
      `injected dependency (header of tools/importcycles.test.mjs).\n${found.join("\n")}`,
    );
  });
}
