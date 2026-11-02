/**
 * CodeQL `js/polynomial-redos` rewrites (alerts 11–22, 50): each regex that was quadratic on a
 * long run is now a scan. Every case here pins the OLD regex's answer beside the new code's —
 * a rewrite must neither widen nor narrow — and one pathological input that must finish fast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { trimEndChars, trimStartChars } from "../dist/lineartrim.js";
import { runStepOf, scriptDescOf, scanCandidates } from "../dist/buildscan.js";
import { parseCliVersion } from "../dist/clirestart.js";
import { instructionFileWeight } from "../dist/agentfiles.js";
import { desktopPathWords } from "../dist/alwaysonwords.js";
import { trimPathSlash } from "../dist/askrules.js";
import { artifactName } from "../dist/artifacts.js";
import { claudeConfigDirOf } from "../dist/claudeconfig.js";
import { maskGrid } from "../dist/clihealth.js";

const BIG = 50_000;
const fast = (fn, label) => {
  const t0 = Date.now();
  const out = fn();
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `${label} took ${ms} ms`);
  return out;
};

test("trimEndChars / trimStartChars answer what the trailing/leading class regexes did", () => {
  for (const s of ["", "/", "//", "a/", "a//", "/a", "a\\/\\", "a/b/", "\\\\", "a-.", "-.a.-", "-.-"]) {
    assert.equal(trimEndChars(s, "/"), s.replace(/\/+$/, ""), s);
    assert.equal(trimEndChars(s, "\\/"), s.replace(/[\\/]+$/, ""), s);
    assert.equal(trimStartChars(s, "-."), s.replace(/^[-.]+/, ""), s);
  }
  assert.equal(fast(() => trimEndChars("/".repeat(BIG) + "x", "/"), "trim"), "/".repeat(BIG) + "x");
});

test("path trims (#12 askrules, #17 claudeconfig, #50 alwaysonwords, #20 buildscan) keep their answers", () => {
  assert.equal(trimPathSlash("/repo//"), "/repo");
  assert.equal(trimPathSlash("///"), "/");
  assert.equal(claudeConfigDirOf({ home: "/Users/me/" }), "/Users/me/.claude");
  assert.equal(claudeConfigDirOf({ home: "/" }), "//.claude"); // one-char path is left alone, as before
  assert.equal(desktopPathWords("settings.json", "~/.claude\\/"), "~/.claude/settings.json");
  fast(() => trimPathSlash("/".repeat(BIG) + "a"), "trimPathSlash");
  fast(() => claudeConfigDirOf({ home: "\\/".repeat(BIG) + "h" }), "claudeConfigDirOf");
  fast(() => desktopPathWords("x", "/".repeat(BIG) + "d"), "desktopPathWords");
  // The candidate key: a configured `dir/` and a scanned `dir` are one candidate.
  const files = [{ path: "app/package.json", text: JSON.stringify({ scripts: { build: "vite build" } }) }];
  const plain = scanCandidates(files).candidates;
  const marked = scanCandidates(files, plain.map((c) => ({ name: c.name, cmd: c.cmd, dir: c.dir ? `${c.dir}///` : c.dir }))).candidates;
  assert.deepEqual(marked.map((c) => !!c.already), plain.map(() => true));
});

test("artifact slug edge trim (#11) strips the same edges, fast on a -.-. run", () => {
  const when = new Date(Date.UTC(2026, 9, 31, 12, 0));
  assert.equal(artifactName({ repoName: ".-tide-.", stem: "app-debug", ext: ".apk", version: "-.1.2.-", when }), "tide-debug-1.2.apk");
  fast(() => artifactName({ repoName: "r", stem: "app", ext: ".apk", version: "-.".repeat(BIG) + "x", when }), "slug");
});

test("instruction file kind (#13 rules, #14 commands) matches the old path regexes", () => {
  const oldKind = (p) => /(^|\/)\.claude\/rules\/.+\.md$/.test(p) ? "rule"
    : /(^|\/)\.claude\/agents\/[^/]+\.md$/.test(p) ? "subagent"
    : /(^|\/)\.claude\/commands\/.+\.md$/.test(p) ? "command" : null;
  for (const p of [".claude/rules/a.md", "x/.claude/rules/sub/a.md", "x.claude/rules/a.md", ".claude/rules/.md",
    ".claude/commands/go.md", "a/.claude/commands/b/c.md", ".claude/rules/a\n.md", "q\n/.claude/rules/z.md",
    ".claude/rules/a\n/.claude/rules/b.md", "x.claude/rules/.claude/rules/a.md", ".claude/agents/a.md", "README.md"]) {
    assert.equal(instructionFileWeight(p, "body")?.kind ?? null, oldKind(p), JSON.stringify(p));
  }
  fast(() => instructionFileWeight(".claude/rules/" + "/.claude/rules/".repeat(BIG / 10) + "x", "t"), "rules");
  fast(() => instructionFileWeight(".claude/commands/" + "/.claude/commands/".repeat(BIG / 10) + "x", "t"), "commands");
});

test("gradle plugin detection (#15, #16) is the plugin id's presence, as the regex always was", () => {
  const kinds = (text) => scanCandidates([{ path: "app/build.gradle.kts", text }]).candidates.map((c) => c.cmd);
  assert.ok(kinds(`plugins { id("com.android.application") }`).some((c) => c.includes("bundleRelease")));
  assert.ok(kinds(`apply plugin: 'com.android.library'`).some((c) => c.includes("assembleRelease")));
  assert.ok(!kinds(`plugins { id("java") }`).some((c) => c.includes("assembleDebug")));
  fast(() => kinds("id" + "\t".repeat(BIG)), "gradle");
});

test("workflow run: line (#18) captures what the old regex captured", () => {
  const re = /^\s*-?\s*run:\s*(?!\||>)(\S.*?)\s*$/;
  for (const line of ["      - run: npm test", "  run:   make  build  ", "- run: |", "  run: >-", "run:", "run:   ",
    "  - run: a\rb", "  - run: a b\r", "  -run: x", "  - - run: x", "  runs: x", "\t- run:\techo hi\t"]) {
    assert.equal(runStepOf(line), re.exec(line)?.[1] ?? null, JSON.stringify(line));
  }
  fast(() => runStepOf("\t".repeat(BIG) + "x"), "leading");
  fast(() => runStepOf("run: x" + "\t".repeat(BIG) + " "), "trailing");
});

test("script description (#19) captures what the old regex captured", () => {
  const re = /^#!.*\n(?:#\s*(.+)\n)/;
  for (const t of ["#!/bin/sh\n# ship all beta apps\necho", "#!/bin/sh\n#ship\n", "#!/bin/sh\n#   \nx", "#!/bin/sh\n#  \n\tfoo",
    "#!/bin/sh\r\n# crlf\r\n", "#!/bin/sh\necho\n# late\n", "#!\n#\n\n", "#!/bin/sh\n# no newline at end", "x\n# not a shebang\n"]) {
    assert.equal(scriptDescOf(t), re.exec(t)?.[1], JSON.stringify(t));
  }
  fast(() => scriptDescOf("#!\n#" + "\t".repeat(BIG)), "desc");
});

test("CLI version (#22) is the first d.d.d, fast on a dotless run of digits", () => {
  for (const s of ["2.1.283 (Claude Code)", "v10.20.30-beta", "1.2", "1.2.x 3.4.5", "1..2.3.4", "x12.3.45.6", "0.0.0"]) {
    assert.equal(parseCliVersion(s), /(\d+\.\d+\.\d+)/.exec(s)?.[1], s);
  }
  assert.equal(parseCliVersion(""), undefined);
  assert.equal(fast(() => parseCliVersion("0".repeat(BIG)), "version"), undefined);
  assert.equal(fast(() => parseCliVersion("1.".repeat(BIG) + "x"), "version dots"), "1.1.1");
});

test("fixture grid row trim (#21) is trimEnd — the same class as \\s+$", () => {
  for (const r of ["a  ", "a\t 　", "  a", "a﻿", ""]) assert.equal(r.trimEnd(), r.replace(/\s+$/, ""));
  fast(() => maskGrid("\t".repeat(BIG) + "x", () => true), "maskGrid");
});
