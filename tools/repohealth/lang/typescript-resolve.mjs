/**
 * Where a NON-relative import specifier points inside the tree, read from the
 * files the family resolves it with: `tsconfig*.json` / `jsconfig*.json`
 * (`compilerOptions.paths` and `baseUrl`) and every workspace `package.json`
 * (its `name`, `exports`, `main`/`module`/`types`, and `imports` for `#x`).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `metrics/graph.mjs` reads the import graph between a tree's own files. The
 * pack's `imports` follows relative specifiers only, and that is enough for
 * `untested`, whose error runs the safe way (a missed edge leaves a module ON
 * the list). For a graph it runs the dangerous way: a missed edge removes a
 * cycle and lowers a fan-out, so a tree the reader could not follow reads as
 * a CLEAN tree. And the trees this reading is for — a Vite or Next app whose
 * every import is `@/components/x` — are exactly the ones a relative-only
 * reader cannot follow. So the aliases are resolved, and what is still not
 * resolved is COUNTED, so the metric can go absent instead of reporting less
 * coupling than there is.
 *
 * ── What it returns: candidates, never a verdict ────────────────────────────
 *
 * `resolveSpecifier` answers with repo-relative candidate paths in the order
 * the resolver would try them, and whether the specifier is INTERNAL — names
 * this project's code, so a candidate that hits no file is a miss to count —
 * or only possibly so (a `baseUrl` lookup, which is also how a bare `react`
 * would be spelled). Which candidate exists is a question about the tree, and
 * the metric asks it; nothing here reads a file.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 *
 *   - **Bundler aliases.** `resolve.alias` in a `vite.config.*` or a webpack
 *     config is code, not data. A Vite app that declares `@` only there and
 *     not in `tsconfig` gets its `@/…` imports — and any bare import of a
 *     name no `package.json` in the tree declares, which is how an alias like
 *     `components/x` or `@ui/x` looks from here — counted as internal and
 *     unresolved, which is what drives the reading absent with the reason.
 *   - **`extends` from a package** (`@tsconfig/node18`). Only a relative
 *     `extends` inside the tree is followed; a published base config sets
 *     compiler flags, almost never `paths`.
 *   - **Conditions.** An `exports` condition object is read in a fixed order
 *     (`types`, `import`, `module`, `default`, `require`, `node`) and the first
 *     string wins: which one a bundler picks does not change WHICH module of
 *     this tree is named, only which emit of it.
 *
 * Nothing here may call a model, touch the network, or read a file.
 */
import { builtinModules } from "node:module";

/** `a/b/../c/./d` -> `a/c/d`; `null` when it climbs out of the tree. */
export function normalise(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

const dirOf = (path) => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

const join = (dir, rel) => normalise(dir ? `${dir}/${rel}` : rel);

/**
 * JSON with comments and trailing commas — what `tsconfig.json` is written
 * in. Comments are stripped outside strings only, so a `"//"` inside a path
 * pattern survives. `null` for anything that still does not parse: a config
 * this reader cannot read declares no alias, and the imports it would have
 * resolved are counted as misses rather than guessed.
 */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** Which tree entries this resolver reads, as regex source. */
export const RESOLVE_CONFIG_PATH = "(?:^|/)(?:[tj]sconfig[\\w.-]*\\.json|package\\.json)$";

const TSCONFIG = /(?:^|\/)[tj]sconfig[\w.-]*\.json$/;

/**
 * A config's `compilerOptions` after its relative `extends` chain: `baseUrl`
 * as a repo path, and `paths` with every target already a repo path. TS
 * resolves `paths` against `baseUrl` when one is in effect and against the
 * config that wrote them otherwise, and a child's own key replaces its
 * parent's.
 */
function effectiveOptions(path, byPath, seen = new Set()) {
  const json = byPath.get(path);
  if (!json || seen.has(path)) return { baseUrl: null, paths: null };
  seen.add(path);
  const dir = dirOf(path);
  let inherited = { baseUrl: null, paths: null };
  const ext = json.extends;
  for (const e of Array.isArray(ext) ? ext : typeof ext === "string" ? [ext] : []) {
    if (typeof e !== "string" || !(e.startsWith("./") || e.startsWith("../"))) continue;
    const target = join(dir, e.endsWith(".json") ? e : `${e}.json`);
    if (target === null) continue;
    const parent = effectiveOptions(target, byPath, seen);
    inherited = { baseUrl: parent.baseUrl ?? inherited.baseUrl, paths: parent.paths ?? inherited.paths };
  }
  const co = json.compilerOptions && typeof json.compilerOptions === "object" ? json.compilerOptions : {};
  const baseUrl = typeof co.baseUrl === "string" ? join(dir, co.baseUrl) : inherited.baseUrl;
  let paths = inherited.paths;
  if (co.paths && typeof co.paths === "object") {
    const base = baseUrl ?? dir;
    paths = [];
    for (const [pattern, targets] of Object.entries(co.paths)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf("*");
      const resolved = targets.filter((t) => typeof t === "string").map((t) => join(base ?? "", t)).filter((t) => t !== null);
      paths.push({
        pattern,
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        star: star !== -1,
        targets: resolved,
      });
    }
  }
  return { baseUrl, paths };
}

/**
 * Everything `resolveSpecifier` needs, from the config entries of one tree.
 * Plain data, so a snapshot can carry it.
 *
 * Several configs in one directory (`tsconfig.json`, `tsconfig.app.json`,
 * `tsconfig.node.json` — the Vite template) are one SCOPE: their aliases are
 * unioned, because a file is compiled under one of them and this reader does
 * not know which.
 *
 * @param {{path: string, oid: string}[]} entries
 * @param {(entry: {path: string, oid: string}) => string} textOf
 */
export function buildResolveContext(entries, textOf) {
  const configs = new Map();
  const packages = [];
  for (const e of entries) {
    const json = parseJsonc(textOf(e));
    if (!json || typeof json !== "object") continue;
    if (TSCONFIG.test(e.path)) configs.set(e.path, json);
    else packages.push({ dir: dirOf(e.path), json });
  }

  /** dir -> {baseUrls, aliases} */
  const scopes = new Map();
  for (const path of [...configs.keys()].sort()) {
    const { baseUrl, paths } = effectiveOptions(path, configs);
    if (baseUrl === null && !paths) continue;
    const dir = dirOf(path);
    const s = scopes.get(dir) ?? { dir, baseUrls: [], aliases: [] };
    if (baseUrl !== null && !s.baseUrls.includes(baseUrl)) s.baseUrls.push(baseUrl);
    for (const a of paths ?? []) if (!s.aliases.some((b) => b.pattern === a.pattern && b.targets.join() === a.targets.join())) s.aliases.push(a);
    scopes.set(dir, s);
  }

  const workspaces = packages
    .filter((p) => typeof p.json.name === "string" && p.json.name)
    .map((p) => ({
      name: p.json.name,
      dir: p.dir,
      exports: p.json.exports ?? null,
      entry: ["types", "typings", "module", "main"].map((k) => p.json[k]).filter((v) => typeof v === "string"),
    }))
    // Longest name first, so `@a/b-extra` is never read as a subpath of `@a/b`.
    .sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1));
  const imports = packages
    .filter((p) => p.json.imports && typeof p.json.imports === "object")
    .map((p) => ({ dir: p.dir, imports: p.json.imports }));

  // Every package name any manifest in the tree declares. A bare import of a
  // name in none of them is not a package this project installs — it is an
  // alias this reader did not find (a bundler's `resolve.alias`), or a bug —
  // and either way it is a miss to count, never an external edge to drop.
  const deps = new Set(workspaces.map((w) => w.name));
  for (const p of packages) {
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const d = p.json[k];
      if (d && typeof d === "object") for (const name of Object.keys(d)) deps.add(name);
    }
  }

  const byDepth = (a, b) => b.dir.split("/").length - a.dir.split("/").length || (a.dir < b.dir ? -1 : 1);
  return {
    scopes: [...scopes.values()].sort(byDepth),
    workspaces,
    imports: imports.sort(byDepth),
    // `null` with no manifest at all: then nothing is known to be undeclared.
    deps: packages.length ? [...deps].sort() : null,
  };
}

/** Is `dir` the directory of `path` or one above it? `""` is the root. */
const contains = (dir, path) => dir === "" || path === dir || path.startsWith(`${dir}/`);

const CONDITIONS = ["types", "import", "module", "default", "require", "node"];

/** The first string an `exports` / `imports` value leads to, condition order fixed. */
function targetOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = targetOf(v);
      if (t) return t;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const c of CONDITIONS) if (c in value) {
      const t = targetOf(value[c]);
      if (t) return t;
    }
  }
  return null;
}

/** One key of an `exports`/`imports` map matched against `sub`, `*` patterns included. */
function lookupMap(map, sub) {
  if (!map || typeof map !== "object") return null;
  if (sub in map) return targetOf(map[sub]);
  for (const [k, v] of Object.entries(map)) {
    const star = k.indexOf("*");
    if (star === -1) continue;
    const pre = k.slice(0, star);
    const post = k.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const t = targetOf(v);
      if (t) return t.replace("*", sub.slice(pre.length, sub.length - post.length));
    }
  }
  return null;
}

/**
 * Specifiers that are this project's code by the family's own conventions —
 * `@/x` and `~/x` (the alias the Vite, Next and Nuxt templates write), a
 * `#x` subpath import, and a `src/x` written against a `baseUrl` — and so a
 * MISS when nothing above resolved them, never an external package.
 */
const LOOKS_INTERNAL = /^(?:@\/|~\/|#|src\/)/;

const BUILTINS = new Set(builtinModules);
const DEPS_MEMO = new WeakMap();

/**
 * A bare specifier whose package no manifest in the tree declares. A `:` is a
 * protocol or a bundler's virtual module (`node:fs`, `virtual:pwa-register`),
 * never a package name, so it is not asked about.
 */
function undeclared(spec, ctx) {
  if (!ctx?.deps || spec.includes(":") || spec.startsWith(".") || spec.startsWith("/")) return false;
  const segs = spec.split("/");
  const name = spec.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0];
  if (BUILTINS.has(name)) return false;
  let deps = DEPS_MEMO.get(ctx);
  if (!deps) DEPS_MEMO.set(ctx, (deps = new Set(ctx.deps)));
  return !deps.has(name);
}

/**
 * Where one non-relative specifier written in `fromPath` points.
 *
 * @param {string} spec
 * @param {string} fromPath  Repo-relative path of the importing file.
 * @param {ReturnType<typeof buildResolveContext> | null} ctx
 * @returns {{internal: boolean, candidates: string[]} | null}
 *   `null` for an external package: no edge, and no miss.
 */
export function resolveSpecifier(spec, fromPath, ctx) {
  if (ctx && !spec.startsWith("node:")) {
    // 1. `compilerOptions.paths` of the nearest scope that declares any. TS
    //    takes the matching pattern with the longest prefix; an exact pattern
    //    is the longest of all.
    const scope = ctx.scopes.find((s) => contains(s.dir, fromPath));
    if (scope) {
      let best = null;
      for (const a of scope.aliases) {
        const hit = a.star
          ? spec.startsWith(a.prefix) && spec.endsWith(a.suffix) && spec.length >= a.prefix.length + a.suffix.length
          : spec === a.pattern;
        if (!hit) continue;
        const weight = a.star ? a.prefix.length : Infinity;
        if (!best || weight > best.weight) best = { a, weight };
      }
      if (best) {
        const { a } = best;
        const middle = a.star ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : "";
        const candidates = a.targets.map((t) => normalise(a.star ? t.replace("*", middle) : t)).filter((t) => t !== null);
        return { internal: true, candidates };
      }
    }

    // 2. A workspace package by its manifest name, through its `exports` or
    //    its entry fields, with the source layout as the last resort.
    for (const w of ctx.workspaces) {
      if (spec !== w.name && !spec.startsWith(`${w.name}/`)) continue;
      const rest = spec.slice(w.name.length + 1);
      const sub = rest ? `./${rest}` : ".";
      const out = [];
      const mapped = typeof w.exports === "string" ? (sub === "." ? w.exports : null) : lookupMap(w.exports, sub);
      if (mapped) out.push(mapped);
      if (sub === ".") out.push(...w.entry, "src/index", "index");
      else out.push(rest, `src/${rest}`);
      return { internal: true, candidates: out.map((t) => join(w.dir, t)).filter((t) => t !== null) };
    }

    // 3. `#x`: the `imports` map of the nearest manifest declaring one.
    if (spec.startsWith("#")) {
      const owner = ctx.imports.find((p) => contains(p.dir, fromPath));
      const mapped = owner ? lookupMap(owner.imports, spec) : null;
      if (mapped) return { internal: true, candidates: [join(owner.dir, mapped)].filter((t) => t !== null) };
    }
  }

  // 4. `baseUrl`: a bare specifier MAY be a path under it. Not internal on its
  //    own say-so — `react` is spelled the same way — so it counts only when a
  //    candidate turns out to be a file, unless it is spelled like ours or
  //    names a package no manifest declares.
  const looksInternal = LOOKS_INTERNAL.test(spec) || undeclared(spec, ctx);
  const scope = ctx?.scopes.find((s) => s.baseUrls.length && contains(s.dir, fromPath));
  if (scope) {
    const candidates = scope.baseUrls.map((b) => join(b, spec)).filter((t) => t !== null);
    return { internal: looksInternal, candidates };
  }
  return looksInternal ? { internal: true, candidates: [] } : null;
}
