// Pure: build an npm-shrinkwrap.json for the npm tarball FROM the root package-lock.json (never by
// re-resolving against the registry), so `npm i -g <pkg>` installs the transitive versions the repo
// tested. Walks the production closure of the staged package's `dependencies` through lock.packages,
// resolving like npm does: a dep of `node_modules/a` is `node_modules/a/node_modules/x` first, then up.

const FIELDS = ["version", "resolved", "integrity", "license", "dependencies", "optionalDependencies",
  "peerDependencies", "peerDependenciesMeta", "os", "cpu", "libc", "hasInstallScript", "engines", "bin", "funding"];

/** The lock key a dependency `name` required from `fromKey` ("" = the root) resolves to, or null. */
export function resolveDep(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const cand = `${base ? base + "/" : ""}node_modules/${name}`;
    if (packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i === -1 ? "" : base.slice(0, i);
  }
}

/**
 * @param lock         parsed package-lock.json (lockfileVersion 2/3)
 * @param stagedPkg    the staged package.json ({name, version, dependencies, bundleDependencies})
 * @param bundled      { name: {version, dependencies?} } for deps shipped inside the tarball (not in lock as registry packages)
 */
export function buildShrinkwrap(lock, stagedPkg, bundled = {}) {
  const packages = lock.packages ?? {};
  const out = {};
  const missing = [];
  const walk = (fromKey, name, optional) => {
    if (bundled[name] && fromKey === "") return;
    const key = resolveDep(packages, fromKey, name);
    if (!key) { if (!optional) missing.push(`${name} (from ${fromKey || "root"})`); return; }
    if (out[key]) return;
    const src = packages[key];
    if (src.link) throw new Error(`${key} is a workspace link; it must be bundled, not locked`);
    const e = {};
    for (const f of FIELDS) if (src[f] !== undefined) e[f] = src[f];
    if (src.optional) e.optional = true;
    out[key] = e;
    for (const d of Object.keys(src.dependencies ?? {})) walk(key, d, false);
    for (const d of Object.keys(src.optionalDependencies ?? {})) walk(key, d, true);
    // npm installs non-optional peers; an optional peer only if something else pulled it in.
    for (const d of Object.keys(src.peerDependencies ?? {})) walk(key, d, true);
  };
  for (const d of Object.keys(stagedPkg.dependencies ?? {})) walk("", d, false);
  if (missing.length) throw new Error(`not in package-lock.json: ${missing.join(", ")}`);

  const root = { name: stagedPkg.name, version: stagedPkg.version };
  for (const f of ["license", "dependencies", "bundleDependencies", "bin", "engines"]) if (stagedPkg[f] !== undefined) root[f] = stagedPkg[f];
  const packagesOut = { "": root };
  for (const [name, b] of Object.entries(bundled)) {
    packagesOut[`node_modules/${name}`] = { version: b.version, inBundle: true, ...(b.dependencies ? { dependencies: b.dependencies } : {}) };
  }
  for (const k of Object.keys(out).sort()) packagesOut[k] = out[k];
  return { name: stagedPkg.name, version: stagedPkg.version, lockfileVersion: 3, requires: true, packages: packagesOut };
}
