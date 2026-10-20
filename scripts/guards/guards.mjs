// The repo's guards (`tools/*.test.mjs`) and the EARLIEST moment each can run.
//
// The pre-push gate runs all of them, and stays the net — it is the only stage
// that sees exactly what is published and can afford a build. But a rule broken
// at 13:00 and reported at a push at 16:00 costs a context switch, a fix-up
// commit, and on a phone a whole new session. So each guard also runs earlier,
// where its cost and its inputs allow:
//
//   edit   — after every Edit/Write in a Claude session (`edit-hook.mjs`).
//            Reads files only: no build, no npm deps, no git. ~0.2–0.4 s each,
//            run in parallel, and only those whose `paths` the edit touched.
//   commit — git pre-commit over the STAGED tree (`precommit.mjs`), plus the
//            edit tier. May import `typescript`/`eslint` or spawn node; never
//            needs a `dist/`, git history or a server. Whole tier ≈ 9 s on 16
//            cores, a scoped commit far less.
//   push   — pre-push only: needs a built `dist/`, git history, or both.
//
// Every `tools/*.test.mjs` must be listed here (`tools/guards.test.mjs` holds
// that), so a new guard is a decision about when it runs, not a default.
// Measured, and the reasoning: docs/notes/testing-and-ops.md#guards-before-the-push
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = ["packages/web/src/**"];
const HOST = ["packages/host/src/**"];
const EXT = ["packages/extensions/**"];
const SKILLS = [".claude/skills/**"];

/** @type {{test: string, tier: "edit"|"commit"|"push", paths: string[], why?: string}[]} */
export const GUARDS = [
  // ── edit: pure file readers ────────────────────────────────────────────────
  { test: "claudemd", tier: "edit", paths: ["CLAUDE.md", ...SKILLS, "docs/notes/**", "tools/skillmap.mjs", "packages/host/src/visualskill.ts"] },
  { test: "webshape", tier: "edit", paths: [...WEB, ...EXT] },
  { test: "cssshape", tier: "edit", paths: ["packages/web/src/styles.css", "packages/web/src/styles/**", "tools/csssource.mjs"] },
  { test: "backlogpins", tier: "edit", paths: WEB },
  { test: "backstep", tier: "edit", paths: WEB },
  { test: "trafficarchive", tier: "edit", paths: ["scripts/traffic-archive.mjs"] },
  { test: "tokenstatspins", tier: "edit", paths: [...WEB, "packages/extensions/*/web/**"] },
  { test: "hostshape", tier: "edit", paths: [...HOST, ...SKILLS, "eslint.config.js", "tools/skillmap.mjs"] },
  { test: "hostpins", tier: "edit", paths: HOST },
  { test: "hostsyncpins", tier: "edit", paths: HOST },
  { test: "atomicwrites", tier: "edit", paths: HOST },
  { test: "reposkill", tier: "edit", paths: HOST },
  { test: "sharedshape", tier: "edit", paths: ["packages/shared/src/**"] },
  { test: "extensionclasses", tier: "edit", paths: EXT },
  { test: "brandassets", tier: "edit", paths: ["brand/**", "packages/app/android/**", "packages/web/public/manifest.webmanifest", "scripts/brand-assets.mjs"] },
  { test: "diagrams", tier: "edit", paths: ["docs/assets/**", "docs/notes/architecture.md", "README.md", ...EXT] },
  { test: "agentinstall", tier: "edit", paths: ["docs/install.md", "package.json", "scripts/oswrap.mjs", ...SKILLS] },
  { test: "lockfile", tier: "edit", paths: ["package-lock.json", "packages/app/package-lock.json"] },
  { test: "uicaptions", tier: "edit", paths: ["scripts/ui/**", "scripts/media/apk-install.mjs"] },
  { test: "uipace", tier: "edit", paths: ["scripts/ui/**"] },
  { test: "uiteaser", tier: "edit", paths: ["scripts/ui/**"] },
  { test: "uifilm", tier: "edit", paths: ["scripts/ui/**", "packages/web/src/core/session/TermArea.tsx", "packages/web/src/ZoomPair.tsx", "packages/web/src/features/demoTour/DemoHook.tsx"] },
  { test: "repohealth-packs", tier: "edit", paths: ["tools/repohealth/**"] },
  { test: "screenfixtures", tier: "edit", paths: ["tools/screenfixtures.mjs", "packages/host/test/fixtures/**"] },
  { test: "healthreadings", tier: "edit", paths: ["tools/healthreadings.mjs", ".claude/skills/**", ".*-shared/health.json"] }, // the shared config dir by glob: this file cannot import BRAND
  { test: "site", tier: "edit", paths: ["README.md", "site/**", "scripts/site/**", "docs/media/**", "docs/assets/**"] },
  { test: "e2ewatchdog", tier: "edit", paths: ["scripts/e2e-*.mjs", "scripts/lib-watchdog.mjs", "packages/extensions/*/e2e/**"] },
  { test: "guards", tier: "edit", paths: ["scripts/guards/**", "tools/*.test.mjs"] },

  // ── commit: typescript / eslint / child processes, still no build ─────────
  { test: "apppins", tier: "commit", paths: WEB },
  { test: "assesspins", tier: "commit", paths: WEB },
  { test: "pulllinkpins", tier: "commit", paths: WEB },
  { test: "sendpins", tier: "commit", paths: WEB },
  { test: "transcriptpins", tier: "commit", paths: WEB },
  { test: "importcycles", tier: "commit", paths: ["packages/**"] },
  { test: "spenderssplit", tier: "commit", paths: HOST },
  { test: "hostsplitpins", tier: "commit", paths: HOST },
  { test: "plugindocs", tier: "commit", paths: ["packages/shared/src/plugin.ts", "docs/plugins-api.md", "deploy/public-allowlist.txt", "scripts/gen-plugin-docs.mjs"] },
  { test: "extensionboundary", tier: "commit", paths: ["tools/eslint/**", "eslint.config.js"] },
  { test: "featureboundary", tier: "commit", paths: ["tools/eslint/**", "eslint.config.js"] },
  { test: "hostboundary", tier: "commit", paths: ["tools/eslint/**", "eslint.config.js"] },
  { test: "nosilentsend", tier: "commit", paths: ["tools/eslint/**", "eslint.config.js"] },
  { test: "portlock", tier: "commit", paths: ["scripts/lib-portlock.mjs"] },
  { test: "stublogo", tier: "commit", paths: ["scripts/media/**", "scripts/claude-stub-tui.mjs"] },
  { test: "uiencode", tier: "commit", paths: ["scripts/ui/**"] },
  { test: "withtmp", tier: "commit", paths: ["scripts/with-tmp.mjs", "scripts/lib-testtmp.mjs"] },

  // ── push only ─────────────────────────────────────────────────────────────
  { test: "activitypins", tier: "push", paths: [], why: "imports web sources that load @waterplane/shared's dist" },
  { test: "plotpins", tier: "push", paths: [], why: "imports web sources that load @waterplane/shared's dist" },
  { test: "annotatorpins", tier: "push", paths: [], why: "esbuild bundle resolves @waterplane/shared's dist" },
  { test: "webclientpins", tier: "push", paths: [], why: "esbuild bundle resolves @waterplane/shared's dist" },
  { test: "hostrestpins", tier: "push", paths: [], why: "imports packages/host/dist" },
  { test: "demo-scenario", tier: "push", paths: [], why: "imports @waterplane/shared's dist" },
  { test: "repohealth-narrate", tier: "push", paths: [], why: "imports @waterplane/shared's dist" },
  { test: "brand", tier: "push", paths: [], why: "git grep over the tracked tree, and shared's dist" },
  { test: "publictree", tier: "push", paths: [], why: "git ls-files" },
  { test: "repohealth", tier: "push", paths: [], why: "git history, and shared's dist" },
  { test: "repohealth-own", tier: "push", paths: [], why: "git repos and child processes, and shared's dist" },
  { test: "repohealth-central", tier: "push", paths: [], why: "git repos and child processes, and shared's dist" },
];

const TIER_RANK = { edit: 0, commit: 1, push: 2 };

/** `**` any depth, `*` within one segment. Minimal on purpose: node's path.matchesGlob is 22.5+, engines say 20.12. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * The guard files to run for these changed paths at this tier: every guard at
 * that tier OR EARLIER whose `paths` match one of them, as `tools/<x>.test.mjs`.
 * A changed guard file itself always runs (if its tier allows). A guard whose file is not under
 * `root` is dropped: the public snapshot leaves some out (`deploy/public-allowlist.txt`).
 */
export function guardsFor(changed, tier, root = REPO_ROOT) {
  const out = [];
  for (const g of GUARDS) {
    if (TIER_RANK[g.tier] > TIER_RANK[tier]) continue;
    const file = `tools/${g.test}.test.mjs`;
    if (!existsSync(join(root, file))) continue;
    const res = g.paths.map(globRe);
    if (changed.some((p) => p === file || res.some((r) => r.test(p)))) out.push(file);
  }
  return out;
}

const REPORTER = fileURLToPath(new URL("./reporter.mjs", import.meta.url));

/** Run guard files under `cwd`; resolve to their failures ({file, name, message, actual}). */
export function runGuards(tests, cwd, env = process.env) {
  // An empty list is not "nothing": `node --test` with no files discovers every test under cwd.
  if (!tests.length) return [];
  const pre = existsSync(join(cwd, "scripts/lib-testtmp.mjs")) ? ["--import", "./scripts/lib-testtmp.mjs"] : [];
  // Launched from inside a test run, the child would inherit NODE_TEST_CONTEXT and
  // stream its results to the parent runner instead of to our reporter.
  const { NODE_TEST_CONTEXT: _, ...childEnv } = env;
  const r = spawnSync(process.execPath, [...pre, "--test", `--test-reporter=${REPORTER}`, ...tests], {
    cwd, env: childEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  const failures = [];
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.startsWith("{")) continue;
    try { failures.push(JSON.parse(line)); } catch { /* not ours */ }
  }
  if (r.status !== 0 && !failures.length) {
    failures.push({
      file: "", name: r.error ? `guard run (${r.error.code ?? r.error.message})` : "guard run",
      message: (r.stderr || "exited non-zero with no test failure").slice(-1500),
    });
  }
  return failures;
}

/** Names too generic to say a failure is about THIS file (every skill is `SKILL.md`). */
const GENERIC = new Set(["SKILL.md", "README.md", "CLAUDE.md", "index.ts", "index.tsx", "logic.ts", "package.json"]);

/**
 * What a failure must name to be blamed on this edit: the path itself, its
 * file name, the skill it belongs to (`web-work:` — how the claudemd guards
 * list a skill), and every module the NEW text names. That last one is how a
 * skill bullet naming `gitFailPrompt.ts` owns "gitFailPrompt.ts is described
 * nowhere in docs/notes" even though the failure never mentions SKILL.md.
 */
export function editTokens(rel, toolInput = {}) {
  const tokens = new Set([rel]);
  const base = basename(rel);
  if (!GENERIC.has(base)) tokens.add(base);
  const skill = /^\.claude\/skills\/([^/]+)\//.exec(rel);
  if (skill) tokens.add(`${skill[1]}:`);
  const text = [toolInput.new_string, toolInput.content, ...(toolInput.edits ?? []).map((e) => e.new_string)]
    .filter((s) => typeof s === "string").join("\n");
  for (const m of text.matchAll(/[A-Za-z][\w-]*\.(?:ts|tsx|mjs|md)\b/g)) {
    if (!GENERIC.has(m[0])) tokens.add(m[0]);
  }
  return tokens;
}

/**
 * Whether a failure names this edit. An offender list (`actual` an array or
 * object — what the deepEqual guards fail with) is matched on its own: it IS
 * the list of what is wrong, and the prose around it names CLAUDE.md in every
 * message. Otherwise the message is all there is.
 */
export function blames(failure, tokens) {
  const a = failure.actual;
  const hay = a !== null && typeof a === "object" ? JSON.stringify(a) : String(failure.message ?? "");
  for (const t of tokens) if (hay.includes(t)) return true;
  return false;
}

export function formatFailure(f) {
  const where = f.file ? `${basename(f.file)} › ` : "";
  const msg = String(f.message ?? "").trim();
  return `✖ ${where}${f.name}\n${msg.length > 1500 ? msg.slice(0, 1500) + "\n…" : msg}`;
}

/**
 * How close a size-capped doc is to its cap, said BEFORE it fails: the cap
 * was met exactly once, by the fix for the failure that motivated all this,
 * and the next bullet anyone adds there fails. Reads the caps out of
 * `tools/claudemd.test.mjs` so there is one copy of each number.
 */
export function headroom(root, rel) {
  let cap;
  let src;
  try { src = readFileSync(join(root, "tools/claudemd.test.mjs"), "utf8"); } catch { return null; }
  const num = (name) => {
    const m = new RegExp(`const ${name} = ([\\d_]+)`).exec(src);
    return m ? Number(m[1].replace(/_/g, "")) : null;
  };
  const routers = (/const ROUTERS = \[([^\]]*)\]/.exec(src)?.[1] ?? "").match(/[\w-]+/g) ?? [];
  const skill = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(rel)?.[1];
  if (rel === "CLAUDE.md") cap = num("MAX_CHARS");
  else if (skill && routers.includes(skill)) cap = num("MAX_ROUTER_CHARS");
  else if (skill && /^(web|host)-/.test(skill)) cap = num("MAX_SUBSKILL_CHARS");
  if (!cap) return null;
  let len;
  try { len = readFileSync(join(root, rel), "utf8").length; } catch { return null; }
  if (len > cap || len < cap * 0.95) return null; // over: the guard itself says so, and blocks
  return {
    bucket: "near",
    text: `${rel} is ${len} of its ${cap}-char cap (tools/claudemd.test.mjs) — ${cap - len} chars of room. ` +
      `Before adding to it, move reasoning to docs/notes/ and leave the rule, or split the file.`,
  };
}
