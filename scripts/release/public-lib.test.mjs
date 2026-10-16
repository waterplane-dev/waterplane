import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildContext, checkLinks, classify, dirsOf, extractChangelogSection, groupPaths, hitToken, hostedName, parseAccept,
  rewriteHostedLinks, stripSessionIds,
  npmTarballProblems, parseAllowlist, resolveRel, scanPath, scanText, verifySteps,
} from "./public-lib.mjs";

const inc = (rules, p) => classify(p, parseAllowlist(rules)).included;

test("allow-list: default is private, last match wins", () => {
  const al = "packages/**\n!packages/app/android/keystore-*\n";
  assert.equal(inc(al, "packages/web/src/a.ts"), true);
  assert.equal(inc(al, "packages/app/android/keystore-release.txt"), false);
  assert.equal(inc(al, "docs/notes/x.md"), false);
  assert.equal(inc("!a/**\na/**\n", "a/b"), true, "later include re-includes");
});

test("allow-list: anchoring, basename patterns and directories", () => {
  assert.equal(inc("/README.md\n", "README.md"), true);
  assert.equal(inc("/README.md\n", "packages/x/README.md"), false);
  assert.equal(inc("*.md\n", "deep/er/x.md"), true, "no slash = any depth");
  assert.equal(inc("docs/\n", "docs/a/b.txt"), true, "dir pattern covers children");
  assert.equal(inc("docs/\n", "docs"), false, "dir-only pattern is not a file");
  assert.equal(inc("packages/**\n", "packagesx/a"), false);
});

test("allow-list: env files, keys and re-included template", () => {
  const al = "packages/**\n!**/.env\n!**/.env.*\n**/.env.example\n!**/*.jks\n";
  assert.equal(inc(al, "packages/host/.env"), false);
  assert.equal(inc(al, "packages/host/.env.local"), false);
  assert.equal(inc(al, "packages/host/.env.example"), true);
  assert.equal(inc(al, "packages/app/release.jks"), false);
});

test("allow-list: comments and blanks ignored, ** semantics", () => {
  const rules = parseAllowlist("# c\n\n  \na/**/z.txt\n");
  assert.equal(rules.length, 1);
  assert.equal(classify("a/z.txt", rules).included, true);
  assert.equal(classify("a/b/c/z.txt", rules).included, true);
  assert.equal(classify("a/b/y.txt", rules).included, false);
  assert.equal(classify("a/bz.txt", rules).included, false);
});

test("secrets: key shapes hit, examples and placeholders do not", () => {
  const ctx = buildContext();
  const ids = (text, path = "x.ts") => scanText(path, text, ctx).hits.map((h) => h.rule);
  assert.deepEqual(ids("-----BEGIN RSA " + "PRIVATE KEY-----"), ["private-key-block"]);
  assert.deepEqual(ids("k=AKIA" + "ABCDEFGHIJKLMNOP"), ["aws-access-key"]);
  assert.deepEqual(ids("AKIAIOSFODNN7EXAMPLE"), []);
  assert.deepEqual(ids("g=AIza" + "SyA1234567890abcdefghijklmnopqrstuv"), ["google-api-key"]);
  assert.deepEqual(ids("t=ghp_" + "a".repeat(36)), ["github-token"]);
  assert.deepEqual(ids("t=sk-ant-" + "a".repeat(30)), ["anthropic-key"]);
  assert.deepEqual(ids("t=eyJ" + "hbGciOiJIUzI1NiJ9.eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234"), ["jwt"]);
  assert.deepEqual(ids("nothing here"), []);
});

test("secrets: never print the whole secret", () => {
  const [h] = scanText("a.ts", "t=ghp_" + "b".repeat(36), buildContext()).hits;
  assert.ok(!h.excerpt.includes("b".repeat(20)));
});

test("secrets: password assignment only in config files, not placeholders", () => {
  const ctx = buildContext();
  assert.equal(scanText("android/gradle.properties", "storePassword=hunter22", ctx).hits.length, 1);
  assert.equal(scanText("android/gradle.properties", "storePassword=${KS_PASS}", ctx).hits.length, 0);
  assert.equal(scanText("android/gradle.properties", "# password=abcdef", ctx).hits.length, 0);
  assert.equal(scanText("src/a.ts", "const password = 'hunter22'", ctx).hits.length, 0, "code is not config");
});

test("secrets: key-store files are a hit by name", () => {
  assert.equal(scanPath("packages/app/release.jks").length, 1);
  assert.equal(scanPath("packages/app/a.ts").length, 0);
});

test("personal: email, home path, hostname", () => {
  const ctx = buildContext({ emails: ["Me@Example.org", "noreply@github.com"], home: "/Users/someone", hostnames: ["Box-One.local", "lo"] });
  const rules = (t) => scanText("a.md", t, ctx).hits.map((h) => h.rule);
  assert.deepEqual(rules("mail me@example.org"), ["personal-email"]);
  assert.deepEqual(rules("noreply@github.com"), []);
  assert.deepEqual(rules("cd /Users/someone/dev"), ["home-path"]);
  assert.deepEqual(rules("ssh box-one.local"), ["hostname"]);
  assert.deepEqual(rules("a lo b"), [], "short hostnames are ignored");
});

test("personal: tailscale addresses and names, placeholders excepted", () => {
  const ctx = buildContext();
  const rules = (t) => scanText("a.ts", t, ctx).hits.map((h) => h.rule);
  assert.deepEqual(rules("http://100.88.12.5:8770"), ["tailscale-ip"]);
  assert.deepEqual(rules("100.100.100.100"), []);
  assert.deepEqual(rules("1100.88.12.5 and 100.200.1.1"), [], "outside 100.64/10");
  assert.deepEqual(rules("https://desk-mac.tail1a2b.ts.net"), ["ts-net-name"]);
  assert.deepEqual(rules("https://<machine>.ts.net and *.ts.net and tailnet-name.ts.net"), []);
});

test("personal: LAN addresses are warnings, not hits", () => {
  const r = scanText("a.ts", "host 192.168.1.20 and 10.0.0.5", buildContext());
  assert.equal(r.hits.length, 0);
  assert.equal(r.warnings.length, 2);
  assert.equal(scanText("docs/a.md", "192.168.1.20", buildContext()).warnings[0].rule, "lan-ip-docs");
  assert.equal(scanText("a.ts", "v110.1.2.3", buildContext()).warnings.length, 0);
});

test("accept tokens are stable and change with the line", () => {
  const a = hitToken("p.ts", 3, "r", "  x = 1 ");
  assert.equal(a, hitToken("p.ts", 3, "r", "x = 1"));
  assert.notEqual(a, hitToken("p.ts", 3, "r", "x = 2"));
  const set = parseAccept(`# why\n${a}  # reviewed\n\n`);
  assert.deepEqual([...set], [a]);
  const [h] = scanText("p.ts", "t=ghp_" + "c".repeat(36), buildContext()).hits;
  assert.ok(parseAccept(h.token).has(h.token));
});

test("changelog: section for a version, with and without v / dash heading", () => {
  const md = "# Changelog\n\n## Unreleased\n\n- next\n\n## 0.2.0 — second\n\nBody A\n\n- b\n\n## 0.1.0\n\nOld\n";
  assert.equal(extractChangelogSection(md, "0.2.0"), "Body A\n\n- b");
  assert.equal(extractChangelogSection(md, "v0.1.0"), "Old");
  assert.equal(extractChangelogSection(md, "0.3.0"), null);
  assert.equal(extractChangelogSection(md, "0.2"), null, "no prefix matching");
});

test("links: relative resolution", () => {
  assert.equal(resolveRel("docs/a", "../notes/x.md"), "docs/notes/x.md");
  assert.equal(resolveRel("", "docs/x.md"), "docs/x.md");
  assert.equal(resolveRel("a", "../../x"), null);
});

test("links: reports links and mentions into excluded paths only", () => {
  const tracked = new Set(["CLAUDE.md", "docs/notes/a.md", "docs/notes/sub/b.md", "docs/requirements/r.md"]);
  const included = new Set(["CLAUDE.md", "docs/requirements/r.md"]);
  const ctx = { included, tracked, includedDirs: dirsOf(included) };
  const md = [
    "[a](docs/notes/a.md#top) and [r](docs/requirements/r.md) and [web](https://x.y/z.md)",
    "see `docs/notes/sub/b.md` and `not/a/file.md` and [dir](docs/notes/)",
    "[gone](docs/nowhere.md)",
    "```",
    "[fenced](docs/notes/a.md)",
    "```",
    "[ref]: docs/notes/a.md",
  ].join("\n");
  const found = checkLinks("CLAUDE.md", md, ctx);
  assert.deepEqual(found.map((f) => `${f.line}:${f.resolved}:${f.kind}:${f.via}`), [
    "1:docs/notes/a.md:excluded:link",
    "2:docs/notes:excluded:link",
    "2:docs/notes/sub/b.md:excluded:mention",
    "3:docs/nowhere.md:missing:link",
    "7:docs/notes/a.md:excluded:link",
  ]);
});

test("links: a link inside a code span is an example, not a link", () => {
  const tracked = new Set(["README.md"]);
  const included = new Set(["README.md"]);
  const f = checkLinks("README.md", "shipped: `[![a](x.gif)](x.mp4)`, and [real](gone.md)", { included, tracked, includedDirs: dirsOf(included) });
  assert.deepEqual(f.map((x) => `${x.resolved}:${x.kind}`), ["gone.md:missing"]);
});

test("links: a repo-root path in link position counts too", () => {
  const tracked = new Set(["a/b/x.md", "docs/notes/n.md"]);
  const included = new Set(["a/b/x.md"]);
  const f = checkLinks("a/b/x.md", "[n](docs/notes/n.md)", { included, tracked, includedDirs: dirsOf(included) });
  assert.deepEqual(f.map((x) => `${x.resolved}:${x.kind}`), ["docs/notes/n.md:excluded"]);
});

test("links: relative to the file's own directory", () => {
  const tracked = new Set([".claude/skills/x/SKILL.md", "docs/notes/a.md"]);
  const included = new Set([".claude/skills/x/SKILL.md"]);
  const f = checkLinks(".claude/skills/x/SKILL.md", "[n](../../../docs/notes/a.md)", { included, tracked, includedDirs: dirsOf(included) });
  assert.equal(f.length, 1);
  assert.equal(f[0].resolved, "docs/notes/a.md");
});

test("links: the outer target of an image inside a link counts too", () => {
  const tracked = new Set(["README.md", "docs/media/a.gif", "docs/media/a.mp4"]);
  const included = new Set(["README.md", "docs/media/a.gif"]);
  const f = checkLinks("README.md", "[![x](docs/media/a.gif)](docs/media/a.mp4)", { included, tracked, includedDirs: dirsOf(included) });
  assert.deepEqual(f.map((x) => x.resolved), ["docs/media/a.mp4"]);
  // The sized HTML spelling README uses for a phone-tall gif: both targets, a missing one named.
  const html = `<a href="docs/media/a.mp4"><img src="docs/media/b.gif" width="270" alt="x"></a>`;
  assert.deepEqual(checkLinks("README.md", html, { included, tracked, includedDirs: dirsOf(included) }).map((x) => [x.resolved, x.kind]),
    [["docs/media/a.mp4", "excluded"], ["docs/media/b.gif", "missing"]]);
});

test("stripSessionIds: every form the requirements and notes use, prompt refs too, and nothing else", () => {
  const md = [
    "- asked: ec4932bb, 60aeda7b, 2026-09-11 (session 8c2bc4c6), 2026-09-12 (session 8c417efe, eb25ef1f)",
    "- asked: 2026-10-02 (session 01MLwEutenLZpjtnWKLfuQyv; an earlier request was not recorded)",
    "All items: asked by the owner 2026-10-05 (session 014XmzA8Z2UD2M66UU1CkRX3) — \"full control\".",
    "Measured on session `5630c7fb` (2026-09-12), one",
    "(session restored) and the session ended",
    "- asked: bfa500f5, 12f1e81f",
    "- asked: 2026-10-01 (session: extensions plan agreed that day, id not recorded)",
    "- shipped: 3f9e2a1",
  ].join("\n");
  const r = stripSessionIds("docs/requirements/x.md", md);
  assert.equal(r.text, [
    "- asked: 2026-09-11, 2026-09-12",
    "- asked: 2026-10-02 (an earlier request was not recorded)",
    "All items: asked by the owner 2026-10-05 — \"full control\".",
    "Measured (2026-09-12), one",
    "(session restored) and the session ended",
    "- asked: 2026-10-01 (session: extensions plan agreed that day, id not recorded)",
    "- shipped: 3f9e2a1",
  ].join("\n"));
  assert.equal(r.n, 9);
  assert.equal(stripSessionIds("a.ts", "(session 8c2bc4c6)").n, 0, "markdown only");
});

test("scan: a session id or session link left in published text is a hit", () => {
  const ctx = buildContext({});
  assert.deepEqual(scanText("docs/a.md", "see session 9c2215c5 for why", ctx).hits.map((h) => h.rule), ["session-id"]);
  assert.deepEqual(scanText("docs/a.md", "the session ended, session <id>", ctx).hits, []);
  assert.deepEqual(scanText("x.ts", "// session 9c2215c5", ctx).hits, [], "ids only in markdown");
  assert.deepEqual(scanText("x.ts", "https://claude.ai/code/session_0123456789abcdefXYZ", ctx).hits.map((h) => h.rule), ["session-url"]);
});

test("rewriteHostedLinks: both targets of a linked image, captions and refs; never fences or code spans", () => {
  const host = (p) => (p === "docs/media/x.mp4" ? "https://h.example/x-0123456789.mp4" : null);
  const md = [
    "[![a](media/x.gif)](media/x.mp4)",
    "*[The video](media/x.mp4#t=3), `[![…](x.gif)](media/x.mp4)`*",
    "[v]: ../docs/media/x.mp4",
    "```",
    "[f](media/x.mp4)",
    "```",
    "[elsewhere](https://example.com/x.mp4) [other](media/y.mp4)",
  ].join("\n");
  const r = rewriteHostedLinks("docs/guide.md", md, host);
  assert.equal(r.text, [
    "[![a](media/x.gif)](https://h.example/x-0123456789.mp4)",
    "*[The video](https://h.example/x-0123456789.mp4#t=3), `[![…](x.gif)](media/x.mp4)`*",
    "[v]: https://h.example/x-0123456789.mp4",
    "```",
    "[f](media/x.mp4)",
    "```",
    "[elsewhere](https://example.com/x.mp4) [other](media/y.mp4)",
  ].join("\n"));
  assert.equal(r.n, 3);
  assert.deepEqual([...r.used], ["docs/media/x.mp4"]);
  assert.equal(rewriteHostedLinks("README.md", "[a](docs/media/x.mp4)", host).n, 1, "repo-root path from the root README");
  // The sized HTML spelling: the film's href is re-pointed, the gif's src and the width kept.
  assert.equal(rewriteHostedLinks("docs/guide.md", `<a href="media/x.mp4"><img src="media/x.gif" width="270" alt="a"></a> \`<a href="media/x.mp4">\``, host).text,
    `<a href="https://h.example/x-0123456789.mp4"><img src="media/x.gif" width="270" alt="a"></a> \`<a href="media/x.mp4">\``);
});

test("hostedName: stem plus ten hex of the content hash", () => {
  assert.equal(hostedName("docs/media/first-look.mp4", "abcdef0123456789"), "first-look-abcdef0123.mp4");
  assert.equal(hostedName("x/README", "abcdef0123456789"), "README-abcdef0123");
});

test("groupPaths: two-level prefixes", () => {
  const g = groupPaths(["a.md", "docs/x.md", "docs/notes/a.md", "docs/notes/b.md"]);
  assert.deepEqual(g.map(([k, v]) => [k, v.length]), [["(root)", 1], ["docs", 1], ["docs/notes", 2]]);
});

test("privateExtensions: the allow-list's whole-folder extension carve-outs, in order", async () => {
  const { privateExtensions } = await import("./public-lib.mjs");
  const text = "packages/**\n!packages/extensions/alpha/**\n# !packages/extensions/commented/**\n!packages/extensions/beta/**\n!packages/extensions/gamma/one.ts\n!packages/extensions/alpha/**\n";
  assert.deepEqual(privateExtensions(text), ["alpha", "beta"]);
});

test("verify-public-tree: a real npm ci first, then build, lint and both test layers; install and build failures stop the run", () => {
  const line = (st) => st.map((x) => [x.cmd, ...x.args].join(" "));
  assert.deepEqual(line(verifySteps()), [
    "npm ci", "npm run build", "npm run release:build -- --unsigned", "node scripts/release/check-npm-tarball.mjs",
    "npm run lint", "npm run test:unit", "npm run test:host",
  ]);
  assert.deepEqual(verifySteps().filter((x) => x.stop).map((x) => x.args.join(" ")), ["ci", "run build", "run release:build -- --unsigned"]);
  assert.equal(line(verifySteps({ e2e: "git,plugin" })).at(-1), "node scripts/run-e2e.mjs git plugin");
  const src = readFileSync(new URL("../verify-public-tree.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /symlinkSync\(join\(ROOT, "node_modules"/, "never this checkout's node_modules");
  assert.match(src, /verifySteps\(/, "the script runs the tested list");
});

test("the allow-list publishes .npmrc, so the public tree's npm ci keeps install scripts off", () => {
  const al = parseAllowlist(readFileSync(new URL("../../deploy/public-allowlist.txt", import.meta.url), "utf8"));
  assert.equal(classify(".npmrc", al).included, true);
  assert.equal(classify("package-lock.json", al).included, true);
});

test("verify-public-tree rehearses CI's tarball: release:build --unsigned, then the .tgz is this version with its shrinkwrap", () => {
  const wf = readFileSync(new URL("../../deploy/public-workflows/npm-publish.yml", import.meta.url), "utf8");
  assert.match(wf, /run: npm run release:build -- --unsigned/, "the step being rehearsed is still the workflow's");
  const ok = { slug: "waterplane", version: "1.2.3", listing: ["package/package.json", "package/npm-shrinkwrap.json"], pkgJson: '{"name":"waterplane","version":"1.2.3"}' };
  assert.deepEqual(npmTarballProblems(ok), []);
  assert.match(npmTarballProblems({ ...ok, listing: ["package/package.json"] })[0], /no package\/npm-shrinkwrap\.json/);
  assert.match(npmTarballProblems({ ...ok, pkgJson: '{"name":"waterplane","version":"1.2.2"}' })[0], /waterplane@1\.2\.2, not waterplane@1\.2\.3/);
  assert.match(npmTarballProblems({ ...ok, pkgJson: null })[0], /missing or unreadable/);
  assert.equal(npmTarballProblems({ ...ok, listing: [], pkgJson: "nope" }).length, 2, "every failure is listed");
});
