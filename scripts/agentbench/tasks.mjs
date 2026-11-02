// The benchmark's tasks: a prompt as a person would type it on the phone, an optional
// setup that breaks something first, and a grader that reads the clone afterwards.
// A grader returns { score 0..1, pass, notes[] } and never trusts the agent's own words.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E } from "../lib-brand.mjs";

const sh = (cwd, cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300_000, ...opts });
const read = (repo, p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : "");
const diffNames = (repo) => execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .concat(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean));
export const buildShared = (repo) => sh(repo, "npx", ["tsc", "-p", "packages/shared"]);
const tscWeb = (repo) => sh(repo, "npx", ["tsc", "-p", "packages/web", "--noEmit"]);
const tally = (checks) => {
  const notes = checks.map(([ok, label]) => `${ok ? "ok" : "MISS"}: ${label}`);
  const score = checks.filter(([ok]) => ok).length / checks.length;
  return { score: Math.round(score * 100) / 100, pass: checks.every(([ok]) => ok), notes };
};

const BAR = "packages/web/src/UpdateBanner.tsx";
const BAR_CSS = "packages/web/src/styles/11-token-stats.css";
const CAL = "packages/shared/src/calday.ts";

export const TASKS = {
  // UI tweak: position + colour, in a component whose CSS lives in a file named for something else.
  ui: {
    kind: "UI tweak (position + colour)",
    prompt:
      "On the phone, the bar that says \"A newer build is ready and verified on this phone.\" — move its × (not now) button " +
      "to the far left, before the arrow icon, and make the bar's border the warning colour instead of the accent colour. " +
      "Keep everything else as it is.",
    grade(repo) {
      const tsx = read(repo, BAR);
      const ret = tsx.slice(tsx.indexOf("return ("));
      const xAt = ret.indexOf('className="staged-bar-x"'), arrowAt = ret.indexOf("<ArrowUpCircle");
      const css = read(repo, BAR_CSS);
      const block = (/\.staged-bar \{[^}]*\}/.exec(css) || [""])[0];
      const tsc = tscWeb(repo);
      return tally([
        [xAt > 0 && arrowAt > 0 && xAt < arrowAt, "× button rendered before the arrow icon"],
        [/border:[^;]*var\(--warn[a-z-]*\)/.test(block), "bar border uses a --warn colour"],
        [!/border:[^;]*var\(--accent\)/.test(block), "accent border gone"],
        [tsc.status === 0, "web type-check passes"],
        [diffNames(repo).every((f) => /UpdateBanner|styles\/|\.bench/.test(f)), "touched only the bar's files"],
      ]);
    },
  },

  // Bug investigation from a pasted error: the person pastes a failing test run.
  bug: {
    kind: "bug from an error message",
    setup(repo) {
      const src = read(repo, CAL);
      const broken = src.replace(
        /return Math\.round\(\n\s+\(Date\.UTC[^;]+;/,
        "return Math.floor((b - a) / MS_PER_DAY);",
      );
      if (broken === src) throw new Error("bug setup: pattern not found in calday.ts");
      writeFileSync(join(repo, CAL), broken);
      buildShared(repo);
      const run = sh(repo, "node", ["--test", "packages/web/src/kit/chart/calday.test.mjs"]);
      const out = (run.stdout + run.stderr).split("\n").filter((l) => /not ok|AssertionError|actual|expected|\+|-|✖|calday/.test(l)).slice(0, 30).join("\n");
      return { errorText: out };
    },
    prompt: (ctx) =>
      "The tests fail since this morning and I don't know why. This is what I get from " +
      "`node --test packages/web/src/kit/chart/calday.test.mjs`:\n\n" + ctx.errorText +
      "\n\nFind the cause and fix it properly.",
    grade(repo) {
      const b = buildShared(repo);
      const t1 = sh(repo, "node", ["--test", "packages/web/src/kit/chart/calday.test.mjs"]);
      const t2 = sh(repo, "node", ["--test", "tools/calday.test.mjs"]);
      const names = diffNames(repo);
      return tally([
        [b.status === 0, "shared builds"],
        [t1.status === 0, "calday web tests pass (from rebuilt source)"],
        [t2.status === 0, "calday ratchet passes"],
        [names.includes(CAL), "fixed in packages/shared/src/calday.ts"],
        [!names.some((f) => /test\.mjs$/.test(f)), "did not edit the tests"],
      ]);
    },
  },

  // Small logic change + a test for it.
  logic: {
    kind: "logic change + test",
    prompt:
      "nodeMeetsMin should also accept a version with no patch number, like \"22.12\" or \"v23.1\" (a missing patch counts as 0). " +
      "Today it says false for those. Change it and add a test for the new case.",
    grade(repo) {
      const b = buildShared(repo);
      const probe = sh(repo, "node", ["--input-type=module", "-e",
        "import { nodeMeetsMin as f } from '@waterplane/shared';" +
        "const r=[f('22.12'),f('v23.1'),!f('22.11'),!f('v21.9'),f('22.12.0'),!f('22.11.9'),!f('banana'),f('v24.0.1')];" +
        "console.log(JSON.stringify(r)); process.exit(r.every(Boolean)?0:1)"]);
      const added = diffNames(repo).filter((f) => /test\.mjs$/.test(f));
      const addedText = added.map((f) => read(repo, f)).join("\n");
      const runAdded = added.length ? sh(repo, "node", ["--test", ...added]) : { status: 1 };
      return tally([
        [b.status === 0, "shared builds"],
        [probe.status === 0, `behaviour right (${(probe.stdout || "").trim()})`],
        [/nodeMeetsMin/.test(addedText) && /["']v?\d+\.\d+["']/.test(addedText), "a test exercises a two-part version"],
        [runAdded.status === 0, "the test file passes"],
      ]);
    },
  },

  // Locate: answer a question about this repo, written to a file so every backend is graded alike.
  locate: {
    kind: "locate (repo knowledge)",
    prompt:
      "Don't change any code. Question: when a session runs Claude Code on a local Ollama model, which source file decides " +
      "the reduced tool set it starts with, and which environment variable turns that off? Write the answer as two lines " +
      "(the file path, then the variable name) into .bench/answer.txt.",
    grade(repo) {
      const a = read(repo, ".bench/answer.txt");
      const code = diffNames(repo).filter((f) => !f.startsWith(".bench/"));
      return tally([
        [/claude-local\.ts/.test(a), "names backends/claude-local.ts"],
        [new RegExp(`${E.CLAUDE_LOCAL_LEAN}\\b`).test(a), `names ${E.CLAUDE_LOCAL_LEAN}`],
        [code.length === 0, "changed no code"],
      ]);
    },
  },

  // A rule from CLAUDE.md the change must follow (never window.confirm; Confirm.tsx / askConfirm).
  rule: {
    kind: "rule-following (repo convention)",
    prompt:
      "Tapping \"Restart into it\" on the update bar restarts the app at once, and I lost a half-written prompt that way. " +
      "Make it ask me first.",
    grade(repo) {
      const tsx = read(repo, BAR);
      const diff = execFileSync("git", ["diff", "HEAD"], { cwd: repo, encoding: "utf8" });
      const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
      const tsc = tscWeb(repo);
      return tally([
        [/askConfirm|<Confirm\b|ConfirmButton/.test(added), "uses the repo's askConfirm / Confirm / ConfirmButton"],
        [!/window\.confirm|\bconfirm\(/.test(added.replace(/askConfirm\(/g, "")), "no window.confirm"],
        [/applyNow/.test(tsx), "restart still reachable"],
        [tsc.status === 0, "web type-check passes"],
      ]);
    },
  },
};
