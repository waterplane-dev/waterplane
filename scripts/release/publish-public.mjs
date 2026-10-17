#!/usr/bin/env node
// Build the PUBLIC snapshot of a release tag, scan it, and (only on request)
// commit it into a local clone of the public repo. It never pushes.
//
//   node scripts/release/publish-public.mjs --tag v0.2.0 --to ../public-clone            # dry run
//   node scripts/release/publish-public.mjs --tag v0.2.0 --to ../public-clone --commit   # write + commit
//
//   --tag <tag>      what to publish (default HEAD, with a warning: releases are tags)
//   --to <path>      a local clone of the public repo; may be empty (git init'ed on --commit)
//   --write          copy the snapshot over --to's working tree (never touches its .git, the
//                    directory of a clone or the file of a linked worktree)
//   --commit         --write, then make the commit. "Initial public release" if the target has
//                    no commits, else "Release <version>" with that CHANGELOG section as body.
//   --accept <file>  reviewed false positives, one `path:line:hash` per line (the report prints each)
//   --report <file>  also write the report as markdown
//   --allowlist <f>  use this allow-list instead of the one inside the tag
//   --media-to <p>   a local clone of the media repo (deploy/public-media.json): the hosted files
//                    the snapshot links to are copied there (and committed with --commit). Needed
//                    by --write whenever such a link exists. Push it BEFORE the public repo.
//
// On the way out, published markdown loses its Claude session ids and its links to hosted files
// are re-pointed at their hosted URLs (public-lib.mjs "rewriting"); the scans see the result.
// The snapshot is `git archive <tag>`: tracked files only, never the working tree.
// Any unaccepted scan hit exits 1 and writes nothing. Pure parts: public-lib.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContext, checkLinks, classify, dirsOf, extractChangelogSection, groupPaths, hitToken, hostedName, parseAccept,
  isTargetGit, parseAllowlist, rewriteHostedLinks, scanPath, scanText, stripSessionIds, topDir,
} from "./public-lib.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------ args

function parseArgs(argv) {
  const o = { tag: null, to: null, write: false, commit: false, accept: null, report: null, allowlist: null, mediaTo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "--tag") o.tag = val();
    else if (a === "--to") o.to = resolve(val());
    else if (a === "--write") o.write = true;
    else if (a === "--commit") { o.commit = true; o.write = true; }
    else if (a === "--accept") o.accept = resolve(val());
    else if (a === "--report") o.report = resolve(val());
    else if (a === "--allowlist") o.allowlist = resolve(val());
    else if (a === "--media-to") o.mediaTo = resolve(val());
    else if (a === "-h" || a === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 25).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
    else die(`unknown argument ${a}`);
  }
  if (o.write && !o.to) die("--write/--commit need --to <path>");
  return o;
}
function die(msg) { console.error(`publish-public: ${msg}`); process.exit(2); }

const git = (cwd, args, opts = {}) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const gitOk = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };

// ------------------------------------------------------------------------ walk

function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (isTargetGit(rel)) continue;
      if (e.isDirectory()) rec(abs); else out.push(rel);
    }
  };
  rec(root);
  return out.sort();
}

function pruneEmptyDirs(root) {
  const rec = (dir) => {
    let kept = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory() && !isTargetGit(relative(root, abs).split(sep).join("/"))) { if (rec(abs)) kept++; } else kept++;
    }
    if (kept === 0 && dir !== root) { rmdirSync(dir); return false; }
    return true;
  };
  rec(root);
}

const human = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// ------------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
const warnings = [];

let NAME = "project";
let GITHUB_ORG = null;
try { ({ NAME, GITHUB_ORG } = await import("../lib-brand.mjs")); } catch { warnings.push("scripts/lib-brand.mjs unavailable (run `npm run build:shared`): report title is generic"); }

const ref = opts.tag ?? "HEAD";
if (!opts.tag) warnings.push("no --tag given: publishing HEAD. Releases should be tags (`git tag vX.Y.Z`).");
const commit = gitOk(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
if (!commit) die(`cannot resolve ${ref}`);
if (opts.tag && !gitOk(repoRoot, ["describe", "--exact-match", "--tags", commit])) warnings.push(`${ref} is not an annotated or lightweight tag on that commit`);
if (opts.to && resolve(opts.to) === resolve(repoRoot)) die("--to is this repo");
if (opts.to && (resolve(opts.to) + sep).startsWith(repoRoot + sep) && !resolve(opts.to).startsWith(tmpdir())) die("--to is inside this repo's working tree");
if (opts.mediaTo && (resolve(opts.mediaTo) === resolve(repoRoot) || resolve(opts.mediaTo) === resolve(opts.to ?? "/nonexistent"))) die("--media-to must be its own clone, not this repo or --to");

const work = mkdtempSync(join(tmpdir(), "public-snapshot-"));
const fullDir = join(work, "full");
const snapDir = join(work, "snap");
mkdirSync(fullDir);
mkdirSync(snapDir);
try {
  // 1. tracked files of the tag, nothing else
  const tar = join(work, "src.tar");
  execFileSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tar, commit]);
  execFileSync("tar", ["-xf", tar, "-C", fullDir]);
  rmSync(tar);
  const all = walk(fullDir);

  // 2. allow-list (from the tag unless overridden, so a run is reproducible)
  let allowText;
  let allowSource;
  if (opts.allowlist) { allowText = readFileSync(opts.allowlist, "utf8"); allowSource = opts.allowlist; }
  else if (existsSync(join(fullDir, "deploy/public-allowlist.txt"))) { allowText = readFileSync(join(fullDir, "deploy/public-allowlist.txt"), "utf8"); allowSource = `${ref}:deploy/public-allowlist.txt`; }
  else die(`${ref} has no deploy/public-allowlist.txt (pass --allowlist <file>)`);
  const rules = parseAllowlist(allowText);

  const included = [];
  const excluded = [];
  for (const p of all) (classify(p, rules).included ? included : excluded).push(p);
  for (const p of included) {
    mkdirSync(dirname(join(snapDir, p)), { recursive: true });
    renameSync(join(fullDir, p), join(snapDir, p));
  }

  // 2b. rewrite on the way out: session ids dropped, links to hosted files re-pointed. Before the
  // scans, so they judge what is actually published.
  let media = null;
  const mediaCfg = join(snapDir, "deploy/public-media.json");
  if (existsSync(mediaCfg)) {
    const c = JSON.parse(readFileSync(mediaCfg, "utf8"));
    const fill = (v) => {
      if (!String(v).includes("{org}")) return String(v);
      if (!GITHUB_ORG) die("deploy/public-media.json uses {org}: run `npm run build:shared` first");
      return String(v).replaceAll("{org}", GITHUB_ORG);
    };
    media = { repo: fill(c.repo), urlBase: fill(c.urlBase).replace(/\/$/, ""), rules: parseAllowlist((c.hosted ?? []).join("\n")) };
  }
  const excludedSet = new Set(excluded);
  const hosted = new Map(); // repo path -> { name, url, size }
  const hostOf = (p) => {
    if (!media || !excludedSet.has(p) || !classify(p, media.rules).included) return null;
    if (!hosted.has(p)) {
      const buf = readFileSync(join(fullDir, p));
      const name = hostedName(p, createHash("sha256").update(buf).digest("hex"));
      hosted.set(p, { name, url: `${media.urlBase}/${name}`, size: buf.length });
    }
    return hosted.get(p).url;
  };
  let sessionIds = 0;
  let hostedLinks = 0;
  const sessionFiles = [];
  for (const p of included) {
    if (!/\.md$/i.test(p)) continue;
    const abs = join(snapDir, p);
    if (lstatSync(abs).isSymbolicLink()) continue;
    const before = readFileSync(abs, "utf8");
    const a = stripSessionIds(p, before);
    const b = rewriteHostedLinks(p, a.text, hostOf);
    if (a.n) { sessionIds += a.n; sessionFiles.push(p); }
    hostedLinks += b.n;
    if (b.text !== before) writeFileSync(abs, b.text);
  }

  // 3. scans over the snapshot
  const emails = [
    gitOk(repoRoot, ["config", "user.email"]) ?? "",
    ...(gitOk(repoRoot, ["log", "--format=%ae%n%ce", commit]) ?? "").split("\n"),
  ].filter(Boolean);
  const names = [hostname(), hostname().split(".")[0]];
  if (process.platform === "darwin") {
    for (const k of ["LocalHostName", "HostName", "ComputerName"]) {
      const r = spawnSync("scutil", ["--get", k], { encoding: "utf8" });
      if (r.status === 0) names.push(r.stdout.trim());
    }
  }
  const ctx = buildContext({ emails, home: homedir(), hostnames: names });
  const accepted = opts.accept ? parseAccept(readFileSync(opts.accept, "utf8")) : new Set();
  const usedAccept = new Set();

  let hits = [];
  const lineWarnings = [];
  const large = [];
  const symlinks = [];
  let totalBytes = 0;
  const bytesByTop = new Map();
  for (const p of included) {
    const abs = join(snapDir, p);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) { symlinks.push(`${p} -> ${readlinkSync(abs)}`); continue; }
    totalBytes += st.size;
    bytesByTop.set(topDir(p), (bytesByTop.get(topDir(p)) ?? 0) + st.size);
    if (st.size > MAX_BYTES) large.push({ path: p, size: st.size });
    hits.push(...scanPath(p));
    if (st.size > 64 * MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    const r = scanText(p, buf.toString("utf8"), ctx);
    hits.push(...r.hits);
    lineWarnings.push(...r.warnings);
  }

  let gitleaks = "not on PATH (built-in scan only)";
  if (spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0) {
    const rp = join(work, "gitleaks.json");
    const r = spawnSync("gitleaks", ["detect", "--no-git", "--source", snapDir, "--report-format", "json", "--report-path", rp, "--no-banner", "--redact", "--exit-code", "0"], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(rp)) gitleaks = `failed (exit ${r.status}): ${(r.stderr || "").trim().slice(0, 200)}`;
    else {
      const findings = JSON.parse(readFileSync(rp, "utf8") || "[]");
      const realSnap = realpathSync(snapDir);
      for (const f of findings) {
        const p = relative(realSnap, realpathSync(f.File)).split(sep).join("/");
        const text = (readFileSync(join(snapDir, p), "utf8").split(/\r?\n/)[f.StartLine - 1]) ?? "";
        hits.push({ path: p, line: f.StartLine, rule: `gitleaks:${f.RuleID}`, category: "secret", excerpt: f.Description ?? f.RuleID, token: hitToken(p, f.StartLine, `gitleaks:${f.RuleID}`, text) });
      }
      gitleaks = `ran, ${findings.length} finding(s)`;
    }
  }

  // de-duplicate (gitleaks and the built-in pass often see the same line), then apply --accept
  const seen = new Set();
  hits = hits.filter((h) => { const k = `${h.path}:${h.line}:${h.rule}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const accepted_hits = [];
  hits = hits.filter((h) => {
    if (accepted.has(h.token)) { usedAccept.add(h.token); accepted_hits.push(h); return false; }
    return true;
  });
  const staleAccepts = [...accepted].filter((t) => !usedAccept.has(t));

  // 4. links out of included markdown into what is not published
  const includedSet = new Set(included);
  const trackedSet = new Set(all);
  const includedDirs = dirsOf(included);
  const links = [];
  for (const p of included) {
    if (!/\.md$/i.test(p)) continue;
    links.push(...checkLinks(p, readFileSync(join(snapDir, p), "utf8"), { included: includedSet, tracked: trackedSet, includedDirs }));
  }
  const danglingExcluded = links.filter((l) => l.kind === "excluded");
  const brokenAlready = links.filter((l) => l.kind === "missing");

  // 5. version, commit message, target state
  let version = "";
  try { version = JSON.parse(readFileSync(join(snapDir, "package.json"), "utf8")).version ?? ""; } catch { /* no package.json in the snapshot */ }
  const changelog = existsSync(join(snapDir, "CHANGELOG.md")) ? readFileSync(join(snapDir, "CHANGELOG.md"), "utf8") : "";
  const section = version ? extractChangelogSection(changelog, version) : null;
  const targetGit = opts.to && existsSync(join(opts.to, ".git"));
  const targetHasCommits = !!(targetGit && gitOk(opts.to, ["rev-parse", "--verify", "HEAD"]));
  const message = targetHasCommits ? `Release ${version}${section ? `\n\n${section}` : ""}` : "Initial public release";
  if (targetHasCommits && !section) warnings.push(`CHANGELOG.md has no section for ${version}: the commit body will be empty`);

  // 6. report
  const topDirs = [...new Set(all.map(topDir))].sort();
  const rows = topDirs.map((d) => {
    const inc = included.filter((p) => topDir(p) === d).length;
    const exc = excluded.filter((p) => topDir(p) === d).length;
    return `| ${d} | ${inc} | ${exc} | ${human(bytesByTop.get(d) ?? 0)} |`;
  });
  const q = (s) => String(s).replace(/`/g, "'").replace(/\n/g, " ");
  const byRule = new Map();
  for (const h of hits) byRule.set(`${h.category}/${h.rule}`, (byRule.get(`${h.category}/${h.rule}`) ?? 0) + 1);
  const lanCount = new Map();
  for (const w of lineWarnings) lanCount.set(w.rule, (lanCount.get(w.rule) ?? 0) + 1);

  const md = [];
  const headline = `${included.length} of ${all.length} tracked files public (${human(totalBytes)}); ${hits.length} scan hit(s); ${danglingExcluded.length} link(s) into unpublished paths`;
  md.push(`# ${NAME} public snapshot: ${ref}`, "");
  md.push(`- commit \`${commit.slice(0, 12)}\`, version \`${version || "?"}\`, allow-list \`${allowSource}\``);
  md.push(`- target: ${opts.to ? `\`${opts.to}\` (${targetHasCommits ? "has commits" : "no commits yet"})` : "none (dry run)"}`);
  md.push(`- **${headline}**`);
  md.push(`- verdict: ${hits.length ? "**BLOCKED**, resolve or `--accept` every hit" : "clean, safe to write"}`);
  for (const w of warnings) md.push(`- warning: ${w}`);
  md.push("", "## Included and excluded by top-level directory", "", "| dir | included | excluded | included size |", "|---|---:|---:|---:|", ...rows, "");

  md.push("## Scan hits (gate the release)", "", `- gitleaks: ${gitleaks}`, "- built-in pass: private keys, cloud/forge/LLM key shapes, JWTs, password assignments in config files, key-store files, personal email/home path/hostname, Tailscale IPs and ts.net names");
  if (!hits.length) md.push("", "None.");
  else {
    md.push("", ...[...byRule].sort().map(([k, n]) => `- ${k}: ${n}`), "");
    for (const cat of ["secret", "personal"]) {
      const list = hits.filter((h) => h.category === cat);
      if (!list.length) continue;
      md.push(`### ${cat}`, "");
      for (const h of list) md.push(`- \`${h.path}${h.line ? `:${h.line}` : ""}\` ${h.rule}: \`${q(h.excerpt)}\` accept: \`${h.token}\``);
      md.push("");
    }
  }
  if (accepted_hits.length) md.push("", `### Accepted (${accepted_hits.length}, from \`${opts.accept}\`)`, "", ...accepted_hits.map((h) => `- \`${h.path}:${h.line}\` ${h.rule}`));
  if (staleAccepts.length) md.push("", "### Stale accept entries (match nothing now)", "", ...staleAccepts.map((t) => `- \`${t}\``));

  md.push("", "## Warnings (never gate)", "");
  if (!lineWarnings.length && !large.length && !symlinks.length) md.push("None.");
  for (const [rule, n] of lanCount) md.push(`- ${rule}: ${n} private-network address(es), judge each (test fixtures and doc examples are usually fine)`);
  for (const w of lineWarnings) md.push(`  - \`${w.path}:${w.line}\` \`${q(w.excerpt)}\``);
  for (const f of large) md.push(`- large file (> 5 MB): \`${f.path}\` ${human(f.size)}`);
  for (const s of symlinks) md.push(`- symlink not scanned: \`${s}\``);

  md.push("", "## Links from published markdown into unpublished paths", "");
  md.push(`${danglingExcluded.length} dangling (${danglingExcluded.filter((l) => l.via === "link").length} markdown links, ${danglingExcluded.filter((l) => l.via === "mention").length} \`path.md\` mentions)${brokenAlready.length ? `; plus ${brokenAlready.length} already-broken link(s) to files that exist nowhere` : ""}.`, "");
  const byTarget = new Map();
  for (const l of danglingExcluded) {
    const k = l.resolved;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(l);
  }
  for (const [target, ls] of [...byTarget].sort()) md.push(`- \`${target}\` (${ls.length}): ${ls.slice(0, 6).map((l) => `\`${l.path}:${l.line}\``).join(", ")}${ls.length > 6 ? ", ..." : ""}`);
  if (brokenAlready.length) md.push("", "Already broken (target is in no tree):", ...brokenAlready.map((l) => `- \`${l.path}:${l.line}\` -> \`${l.target}\``));

  md.push("", "## Rewritten on the way out", "");
  md.push(`- Claude session ids: ${sessionIds} removed from ${sessionFiles.length} markdown file(s)`);
  if (!media) md.push("- hosted files: none (no deploy/public-media.json)");
  else {
    const bytes = [...hosted.values()].reduce((n, h) => n + h.size, 0);
    md.push(`- hosted files: ${hosted.size} (${human(bytes)}) in \`${media.repo}\`, ${hostedLinks} link(s) re-pointed at \`${media.urlBase}/\``);
    for (const [p, h] of [...hosted].sort()) md.push(`  - \`${p}\` -> \`${h.name}\` (${human(h.size)})`);
  }
  md.push("", "## Excluded (private)", "");
  for (const [key, list] of groupPaths(excluded)) {
    md.push(`- \`${key}\` (${list.length})${list.length <= 6 ? `: ${list.map((p) => `\`${p}\``).join(", ")}` : ""}`);
  }
  md.push("", `## Final snapshot`, "", `${included.length} files, ${human(totalBytes)}.`, "");
  const report = md.join("\n");

  if (opts.report) { mkdirSync(dirname(opts.report), { recursive: true }); writeFileSync(opts.report, report); }
  // Console: the headline and the counts; the full list goes in the report.
  if (opts.report) {
    console.log(`${headline}\nverdict: ${hits.length ? "BLOCKED" : "clean"}`);
    for (const [k, n] of [...byRule].sort()) console.log(`  ${k}: ${n}`);
    console.log(`rewritten: ${sessionIds} session id(s) removed, ${hostedLinks} link(s) to ${hosted.size} hosted file(s)`);
    console.log(`full report: ${opts.report}`);
  } else console.log(report);
  for (const w of warnings) console.error(`warning: ${w}`);

  if (hits.length) { console.error(`\n${hits.length} scan hit(s): nothing written.`); process.exitCode = 1; }
  else if (opts.write) {
    // 7a. the hosted files first: a public tree whose links point at files nobody hosts is worse
    // than no public tree, so a media problem stops the run before anything else is written.
    if (hosted.size) {
      if (!opts.mediaTo) die(`${hosted.size} hosted file(s) are linked (deploy/public-media.json): pass --media-to <a clone of github.com/${media.repo}>`);
      if (!existsSync(join(opts.mediaTo, ".git"))) die(`--media-to ${opts.mediaTo} is not a git clone (of github.com/${media.repo})`);
      if (git(opts.mediaTo, ["status", "--porcelain"])) die(`${opts.mediaTo} has uncommitted changes: commit or discard them first`);
      let added = 0;
      // Never delete: an older release's README still links to the names it was written with.
      for (const [p, h] of hosted) {
        const dst = join(opts.mediaTo, h.name);
        if (!existsSync(dst)) { copyFileSync(join(fullDir, p), dst); added++; }
      }
      // Pages would otherwise run Jekyll over a folder of videos.
      if (!existsSync(join(opts.mediaTo, ".nojekyll"))) writeFileSync(join(opts.mediaTo, ".nojekyll"), "");
      console.log(`media: ${added} new of ${hosted.size} hosted file(s) in ${opts.mediaTo}`);
      if (opts.commit) {
        git(opts.mediaTo, ["add", "--all", "--", "."]);
        if (git(opts.mediaTo, ["status", "--porcelain"])) {
          if (!gitOk(opts.mediaTo, ["config", "user.email"])) die(`no git identity in ${opts.mediaTo}: set a public one (git -C ${opts.mediaTo} config user.email ...)`);
          execFileSync("git", ["-C", opts.mediaTo, "commit", "-q", "-m", `Media for ${version ? `${NAME} ${version}` : ref}`]);
          console.log(`media committed (${git(opts.mediaTo, ["rev-parse", "--short", "HEAD"])})`);
        }
      }
    }
    // 7b. write: make the target equal the snapshot, never touching its .git
    mkdirSync(opts.to, { recursive: true });
    if (!targetGit) git(opts.to, ["init", "-b", "main"]);
    else if (git(opts.to, ["status", "--porcelain"])) die(`${opts.to} has uncommitted changes: commit or discard them first`);
    const want = new Set(included.filter((p) => !lstatSync(join(snapDir, p)).isDirectory()));
    for (const p of walk(opts.to)) if (!want.has(p)) rmSync(join(opts.to, p), { force: true });
    for (const p of want) {
      const src = join(snapDir, p);
      const dst = join(opts.to, p);
      mkdirSync(dirname(dst), { recursive: true });
      rmSync(dst, { force: true });
      const st = lstatSync(src);
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
      else { copyFileSync(src, dst); chmodSync(dst, st.mode & 0o777); }
    }
    pruneEmptyDirs(opts.to);
    console.log(`wrote ${want.size} files to ${opts.to}`);
    if (opts.commit) {
      git(opts.to, ["add", "--all", "--", "."]);
      if (!git(opts.to, ["status", "--porcelain"])) console.log("nothing changed: no commit made");
      else {
        const who = gitOk(opts.to, ["config", "user.email"]);
        if (!who) die(`no git identity in ${opts.to}: set a public one (git -C ${opts.to} config user.email ...)`);
        if (emails.map((e) => e.toLowerCase()).includes(who.toLowerCase())) console.error(`warning: the commit author is ${who}, an email from the private history. Set a public identity in the target first if that is not intended.`);
        execFileSync("git", ["-C", opts.to, "commit", "-q", "-F", "-"], { input: message });
        console.log(`committed: ${message.split("\n")[0]} (${git(opts.to, ["rev-parse", "--short", "HEAD"])})`);
      }
      console.log(`\nNot pushed. When you are happy with it:${hosted.size ? `\n  git -C ${opts.mediaTo} push origin main   # first: the links point there` : ""}\n  git -C ${opts.to} push origin main`);
    }
  } else {
    console.log(`\ndry run: nothing written. To publish:\n  node scripts/release/publish-public.mjs --tag ${opts.tag ?? "<tag>"} --to <public-clone> --commit`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
