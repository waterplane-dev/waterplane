import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildContext, checkLinks, classify, dirsOf, extractChangelogSection, groupPaths, hitToken, parseAccept,
  parseAllowlist, resolveRel, scanPath, scanText, verifySteps,
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
  assert.deepEqual(line(verifySteps()), ["npm ci", "npm run build", "npm run lint", "npm run test:unit", "npm run test:host"]);
  assert.deepEqual(verifySteps().filter((x) => x.stop).map((x) => x.args.join(" ")), ["ci", "run build"]);
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
