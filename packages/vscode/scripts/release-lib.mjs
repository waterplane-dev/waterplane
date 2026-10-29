// The pure half of `npm run release` (scripts/release.mjs): what the registries say, what the repo
// says, and the plan that follows. No network, no files — release.mjs feeds it, test/release.test.mjs
// pins it.

export const REGISTRIES = {
  marketplace: { label: "VS Code Marketplace", token: "VSCE_PAT" },
  openvsx: { label: "Open VSX", token: "OVSX_PAT" },
};

/** -1 / 0 / 1 for plain x.y.z versions; anything else compares as unknown (null). */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The versions a Marketplace extensionquery answer lists for one extension ([] when absent). */
export function marketplaceVersions(answer) {
  const ext = answer?.results?.[0]?.extensions?.[0];
  return ext ? ext.versions.map((v) => v.version) : [];
}

/** The versions an Open VSX `GET /api/{ns}/{name}` answer lists (`allVersions` also holds "latest"). */
export function openVsxVersions(answer) {
  return Object.keys(answer?.allVersions ?? {}).filter((v) => v !== "latest");
}

/** The relative images a README links (`](media/x.png)`), which the vsix rewrites to raw URLs. */
export function readmeImages(readme) {
  return [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((p) => !/^[a-z]+:/i.test(p));
}

/**
 * What a release of `version` would do, and why it can't, in sentences.
 * @param {object} f facts gathered by release.mjs
 * @param {string} f.name package.json name
 * @param {string} f.version package.json version
 * @param {string} f.changelog CHANGELOG.md text
 * @param {Record<string,string>} f.scripts package.json scripts
 * @param {string[]} f.dirty `git status --porcelain` lines for this package
 * @param {{url:string, status:number}[]} f.images README images and their HTTP status
 * @param {Record<string,string[]|null>} f.published versions per registry (null = could not ask)
 * @param {string[]} f.only registries asked for
 * @param {Record<string,boolean>} f.tokens which token env vars are set
 * @param {boolean} f.publish whether this run publishes (tokens are only required then)
 */
export function planRelease(f) {
  const problems = [];
  const vsix = `${f.name}-${f.version}.vsix`;
  if (!new RegExp(`^## ${f.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`, "m").test(f.changelog))
    problems.push(`CHANGELOG.md has no "## ${f.version} - <date>" section.`);
  if (/^## Unreleased/m.test(f.changelog))
    problems.push(`CHANGELOG.md still has an "## Unreleased" section: give it the version or fold it in.`);
  if (!f.scripts.package?.includes(`-o ${vsix}`) || !f.scripts.package?.includes(`check-vsix.mjs ${vsix}`))
    problems.push(`the "package" script does not write and check ${vsix}: update its vsix name.`);
  if (f.dirty.length)
    problems.push(`packages/vscode has uncommitted changes (${f.dirty.length}): commit them first, a release is what HEAD holds.`);
  for (const img of f.images)
    if (img.status !== 200) problems.push(`the listing image ${img.url} answers ${img.status || "nothing"}: run release:public first.`);

  const targets = [];
  const skipped = [];
  for (const id of f.only) {
    const reg = REGISTRIES[id];
    const have = f.published[id];
    if (have == null) { problems.push(`could not ask ${reg.label} which versions it has.`); continue; }
    if (have.includes(f.version)) { skipped.push(`${reg.label} already has ${f.version}.`); continue; }
    const newer = have.filter((v) => compareVersions(v, f.version) === 1);
    if (newer.length) { problems.push(`${reg.label} already has ${newer.join(", ")}, newer than ${f.version}.`); continue; }
    if (f.publish && !f.tokens[reg.token]) { problems.push(`${reg.token} is not set, so ${reg.label} cannot be published to.`); continue; }
    targets.push(id);
  }
  if (!problems.length && !targets.length) skipped.push(`nothing to publish.`);
  return { vsix, problems, targets, skipped };
}
