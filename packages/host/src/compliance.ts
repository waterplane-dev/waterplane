/**
 * Repo setup compliance: is a repo wired the way this daemon expects, and
 * helpers to make it so. The daemon drives the `claude` CLI in repos that
 * should follow a few conventions so the phone side works smoothly:
 *
 *  - Agent instructions (CLAUDE.md) tell the agent to drop phone-facing
 *    artifacts into `.claude/outbox/` and read uploads from `.claude/inbox/`.
 *  - Those transport dirs are gitignored — their contents are phone↔repo
 *    plumbing, never source, so they must not land in history.
 *  - Secret `.env` files are gitignored (the secret writer enforces this on
 *    write; the checklist flags any that slipped through).
 *
 * Everything here is read-only inspection plus narrowly-scoped, idempotent
 * fixes. Auto-fixes only ADD (gitignore lines, a CLAUDE.md section, a helper
 * script) — they never delete or untrack, so a stray manual run can't lose work.
 * The one MOVE is `state-dir`: a legacy-named per-repo state dir renamed to the
 * current name (`branddirs.ts`' `adoptRepoStateDir` — merge without overwrite,
 * symlink back), offered only when git tracks nothing under it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";
import type { AutoCompactResolution, ComplianceCheck, ComplianceFixResult, ComplianceIgnoreResult, ComplianceLimitsResult, ComplianceReport, ContextLimitsView, ContextWeightLimits, RepoTarget, RepoSetupState, SkillWeight } from "@waterplane/shared";
import { ADVISORY_CHECKS, AUTO_COMPACT_ENV, CONFIRM_GATED_FIXES, autoCompactVerdict, isSetupFinding, resolveAutoCompact, resolveContextLimits, sanitizeContextLimits, skillDescChars, weighContext, withAutoCompactWindow } from "@waterplane/shared";
import { adoptRepoStateDir, legacyRepoStateDirs, repoStateDir } from "./branddirs.js";
import { env } from "./env.js";
import { claudeConfigDir } from "./claudeconfig.js";
import { contextLimitsStore, repoContextLimits } from "./contextlimits.js";
import { autoCompactDefault, ignoredChecks, setupPrefsStore } from "./setupprefs.js";
import { contained, inRoot } from "./paths.js";
import { INBOX_SUBDIR, OUTBOX_SUBDIR, OUTBOX_SUBDIRS } from "./files.js";
import { apkInstallCheck } from "./apkcheck.js";
import { ensureDesktopKey, linkKey } from "./signkey.js";
import { isAndroidRepo, probeAndroidEnv } from "./androidenv.js";
import { startToolchainInstall } from "./toolchain.js";
import { scanRepoBuilds } from "./buildscan.js";
import { contributedChecks, contributedFixes } from "./plugins/setupcontrib.js";
import { VISUAL_SKILL_REL, writeVisualCheckSkill } from "./visualskill.js";

/**
 * The env layer of the context-weight thresholds — only the fields actually
 * exported on this host, so an unset knob keeps falling through to the shipped
 * default instead of being frozen at today's value.
 *
 * Env-overridable because this checklist is swept with no client attached
 * (`setupwatch.ts`) — the same reason `budget.ts` is host-side rather than a
 * synced setting. It is the HOST's line; a repo that needs a different one gets
 * it from `contextlimits.ts`, which outranks this. Defaults, the resolution
 * order and the rule itself are `@waterplane/shared`'s `contextweight.ts`.
 */
function envContextLimits(): Partial<ContextWeightLimits> {
  const out: Partial<ContextWeightLimits> = {};
  const n = (v: string | undefined): number | undefined => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : undefined;
  };
  const pairs: [keyof ContextWeightLimits, string | undefined][] = [
    ["maxChars", env("CONTEXT_WARN_CHARS")],
    ["hardChars", env("CONTEXT_HARD_CHARS")],
    ["maxSkills", env("CONTEXT_MAX_SKILLS")],
  ];
  for (const [k, raw] of pairs) {
    const v = n(raw);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The thresholds in force for one worktree, and where each came from: this
 * repo's own override > this host's env > the shipped default.
 *
 * Exported because the sheet has to be able to SAY it. The row used to quote a
 * number as one "you asked to be warned at" when nobody had asked and nobody
 * could — that sentence is now attributed, and the editor needs the same view
 * to open on the stored override rather than on the resolved number.
 */
export function contextLimitsFor(worktree: string): ContextLimitsView {
  return resolveContextLimits(envContextLimits(), repoContextLimits(worktree));
}

/** Every `.claude/skills/<name>/SKILL.md` in a worktree, sized. */
function readSkills(worktree: string): SkillWeight[] {
  const dir = join(worktree, ".claude", "skills");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: SkillWeight[] = [];
  for (const name of names) {
    let text: string;
    try { text = readFileSync(join(dir, name, "SKILL.md"), "utf8"); } catch { continue; }
    out.push({ name, descChars: skillDescChars(text), bodyChars: text.length });
  }
  return out;
}

/** The repo file the `auto-compact` fix writes. */
const PROJECT_SETTINGS_REL = ".claude/settings.json";

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * The `autoCompactWindow` a claude session the daemon spawns in this worktree would
 * see, and where it comes from. The env layer is THIS daemon's environment,
 * because a spawned PTY starts from `ptyEnv()` = `process.env` plus a floor,
 * and the claude backend's `spawnEnv` carries only `DISABLE_AUTOUPDATER`. (A pane in an already-running
 * tmux server takes the SERVER's environment instead — a
 * value exported only there is invisible to this read.) The precedence and how
 * much of it was verified against the CLI bundle is `@waterplane/shared`'s
 * `autocompact.ts`. The user layer honours `CLAUDE_CONFIG_DIR` like the CLI.
 */
export function autoCompactFor(worktree: string): AutoCompactResolution {
  const userDir = claudeConfigDir();
  const layer = (path: string) => ({ path, text: readOrNull(path) });
  return resolveAutoCompact({
    env: process.env[AUTO_COMPACT_ENV],
    local: layer(join(worktree, ".claude", "settings.local.json")),
    project: layer(join(worktree, PROJECT_SETTINGS_REL)),
    user: layer(join(userDir, "settings.json")),
  });
}

/** Transport dirs that must be gitignored (phone↔repo plumbing, not source). */
const TRANSPORT_DIRS = Array.from(new Set([INBOX_SUBDIR, OUTBOX_SUBDIR, ...OUTBOX_SUBDIRS]));

/** Per-repo capture config — the same place `builds.ts` keeps `builds.json`. */
const captureConfigPath = (worktree: string) => join(repoStateDir(worktree), "capture.json");

/**
 * How many capture targets this repo has configured, read DEFENSIVELY.
 *
 * Parsed by shape rather than through a type, on purpose: this file is written
 * by a client that may be older or newer than this daemon, and the only question
 * asked here is "is there at least one target" — the narrowest fact that can be
 * true. Anything unreadable, half-written, or shaped differently answers 0,
 * which means the row below is simply not offered. A checklist that threw on a
 * malformed config would take the whole setup sheet down with it.
 */
function captureTargetCount(worktree: string): number {
  let raw: string;
  try { raw = readFileSync(captureConfigPath(worktree), "utf8"); } catch { return 0; }
  try {
    const obj = JSON.parse(raw) as { targets?: unknown };
    return Array.isArray(obj?.targets) ? obj.targets.length : 0;
  } catch {
    return 0;
  }
}

/** Marker so the CLAUDE.md guidance block is appended at most once — under the
 *  current name or any past one, so a repo fixed before a rename is not given
 *  the section a second time. */
const CLAUDE_MD_MARKER = `## ${BRAND.displayName} conventions`;
const CLAUDE_MD_MARKERS = [CLAUDE_MD_MARKER, ...LEGACY.map((l) => `## ${l.name} conventions`)];
const hasClaudeMdMarker = (text: string) => CLAUDE_MD_MARKERS.some((m) => text.includes(m));

function claudeMdBlock(): string {
  return `${CLAUDE_MD_MARKER}

This repo is driven via ${BRAND.displayName} (remote phone control of the \`claude\` CLI). Follow:

- **Outbox** — save screenshots / artifacts meant for the phone into
  \`${OUTBOX_SUBDIR}/\` (or a top-level \`.outbox/\`). Only these surface in the
  phone's curated gallery; anything else is buried in the broad "this repo" tab.
- **Inbox** — files sent from the phone land in \`${INBOX_SUBDIR}/\`; read uploads
  from there.
- Both inbox and outbox are gitignored — never commit their contents.
`;
}

// ── git probes (all return false outside a repo / on any error) ──────────────

function gitOk(wt: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: wt, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitOut(wt: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: wt, encoding: "utf8" });
  } catch {
    return "";
  }
}

const isIgnored = (wt: string, path: string) => gitOk(wt, ["check-ignore", "-q", "--", path]);
/** Files git tracks under `dir` (empty when none / not a repo). */
const trackedUnder = (wt: string, dir: string) =>
  gitOut(wt, ["ls-files", "--", dir]).split("\n").filter((l) => l.trim());

// ── checks ───────────────────────────────────────────────────────────────────

/** Inspect a worktree and return the setup checklist. Pure read — no writes. */
export function inspectRepo(worktree: string): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];

  // 1. CLAUDE.md present.
  const claudePath = join(worktree, "CLAUDE.md");
  const claudeMd = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : null;
  if (claudeMd == null) {
    checks.push({ id: "claude-md", label: "CLAUDE.md present", status: "fail",
      detail: "No CLAUDE.md — the agent has no project instructions. Run `/init` in this " +
        `repo to generate a real one (a stub with only ${BRAND.displayName}'s section would be near-useless), ` +
        "then re-check to add the outbox convention.", fix: null });
  } else {
    checks.push({ id: "claude-md", label: "CLAUDE.md present", status: "pass",
      detail: "CLAUDE.md exists.", fix: null });
    // 2. CLAUDE.md mentions the outbox convention.
    const mentionsOutbox = /outbox/i.test(claudeMd);
    checks.push(mentionsOutbox
      ? { id: "claude-md-outbox", label: "Agent told about outbox", status: "pass",
          detail: "CLAUDE.md references the outbox convention.", fix: null }
      : { id: "claude-md-outbox", label: "Agent told about outbox", status: "warn",
          detail: "CLAUDE.md never mentions the outbox — the agent won't know to drop phone artifacts there.",
          fix: "claude-md" });
  }

  // 2b. What this repo costs to have open, before anyone types.
  //
  // Deliberately a WARN at worst and never a `fail`, and it carries no `fix`:
  // there is no correct size, the split between "rule" and "reference" is a
  // judgement only the author can make, and a checklist that auto-trimmed a
  // CLAUDE.md would be deleting the very thing it cannot read. It names the
  // fan-out preset that does the work instead.
  {
    const extra = join(worktree, ".claude", "CLAUDE.md");
    const chars = (claudeMd?.length ?? 0) +
      (existsSync(extra) ? readFileSync(extra, "utf8").length : 0);
    if (chars > 0) {
      const lim = contextLimitsFor(worktree);
      const w = weighContext({ claudeMdChars: chars, skills: readSkills(worktree) }, lim.effective, lim.source);
      checks.push({
        id: "context-weight",
        label: "Agent context weight",
        status: w.verdict === "lean" ? "pass" : "warn",
        detail: w.advice ? `${w.note} ${w.advice}` : w.note,
        fix: null,
        // The same number the sentence states, carried as a figure: the
        // repo-health series measures this subject at the last COMMIT, and the
        // sheet prints the two clocks side by side rather than reconciling
        // them.
        alwaysOnChars: w.alwaysOnChars,
      });
    }
  }

  // 2c. How large one conversation may grow before the CLI compacts it.
  //
  // A WARN at worst, like context-weight: nothing is broken, a session is only
  // allowed to get expensive. The `fix` is offered only where writing this
  // repo's `.claude/settings.json` would actually CHANGE what the CLI sees —
  // not when the env var or settings.local.json outranks it, and not when that
  // file is unreadable (the write refuses rather than overwrite it). The phone
  // puts it behind a confirm and keeps it out of "Fix all" (`setupRemedy.ts`):
  // choosing a window is a setting, not a repair.
  {
    const r = autoCompactFor(worktree);
    const v = autoCompactVerdict(r, autoCompactDefault());
    const projectPath = join(worktree, PROJECT_SETTINGS_REL);
    const writable = (r.source === "project" || r.source === "user" || r.source === "unset") &&
      !r.unreadable.includes(projectPath);
    checks.push({
      id: "auto-compact",
      label: "Auto-compact window",
      status: v.status,
      detail: v.detail,
      fix: v.status === "warn" && writable ? "auto-compact" : null,
    });
  }

  // 3. Transport dirs gitignored.
  const notIgnored = TRANSPORT_DIRS.filter((d) => !isIgnored(worktree, d));
  checks.push(notIgnored.length === 0
    ? { id: "gitignore-transport", label: "inbox/outbox gitignored", status: "pass",
        detail: "All transport dirs are gitignored.", fix: null }
    : { id: "gitignore-transport", label: "inbox/outbox gitignored", status: "fail",
        detail: `Not gitignored: ${notIgnored.join(", ")} — phone↔repo files risk being committed.`,
        fix: "gitignore" });

  // 4. Nothing under the transport dirs is actually tracked (a stronger leak check).
  const tracked = TRANSPORT_DIRS.flatMap((d) => trackedUnder(worktree, d));
  if (tracked.length) {
    checks.push({ id: "transport-tracked", label: "No tracked transport files", status: "warn",
      detail: `Already tracked: ${tracked.slice(0, 5).join(", ")}${tracked.length > 5 ? "…" : ""}. ` +
        "gitignore won't untrack these — run `git rm --cached` yourself.", fix: null });
  } else {
    checks.push({ id: "transport-tracked", label: "No tracked transport files", status: "pass",
      detail: "No inbox/outbox files are committed.", fix: null });
  }

  // 4b. The per-repo state dir still under a past brand's name. Nothing is
  // broken — `repoStateDir` reads it — so a warn, and the move is a person's
  // tap, never automatic: a rename nobody asked for surfaces an untracked new
  // dir in a repo whose .gitignore names only the old one. Offered as a fix
  // only when git tracks nothing under it; a tracked state dir is the repo's
  // own decision and moving it would show as deletions.
  const legacyDirs = legacyRepoStateDirs(worktree);
  if (legacyDirs.length) {
    const names = legacyDirs.map((d) => basename(d));
    const trackedState = names.flatMap((n) => trackedUnder(worktree, n));
    checks.push({
      id: "state-dir", label: "State dir name", status: "warn",
      detail: trackedState.length
        ? `This repo keeps ${BRAND.displayName}'s per-repo files in ${names.map((n) => `\`${n}/\``).join(", ")}, ` +
          `the name from before the rename, and git tracks files there (${trackedState.slice(0, 3).join(", ")}` +
          `${trackedState.length > 3 ? "…" : ""}). They are still read. Moving them to \`${BRAND.stateDirName}/\` is ` +
          "a `git mv` for this repo to decide, so there is no one-tap fix."
        : `This repo keeps ${BRAND.displayName}'s per-repo files in ${names.map((n) => `\`${n}/\``).join(", ")}, ` +
          `the name from before the rename. They are still read and nothing is broken. The fix renames it to ` +
          `\`${BRAND.stateDirName}/\` (merging, never overwriting, if both exist), leaves a symlink at the old ` +
          `name, and adds \`${BRAND.stateDirName}\` to .gitignore.`,
      fix: trackedState.length ? null : "state-dir",
    });
  }

  // 5. .env secrets gitignored (the writer enforces it; flag any that slipped in).
  // Template dotenvs (.env.example etc) are meant to be committed and hold
  // placeholders, not secrets — never flag them as a leak.
  // A template is named by its LAST segment (`.env.example`, but also
  // `.env.production.example`) — anchoring the old pattern on the whole name
  // flagged every per-environment template as a leak, which is a warn nobody
  // can close: the file is meant to be committed and holds placeholders.
  const leaky = listRootEnvFiles(worktree)
    .filter((f) => !/\.(example|sample|template|dist)$/.test(f))
    .filter((f) => !isIgnored(worktree, f) && trackedUnder(worktree, f).length);
  checks.push(leaky.length === 0
    ? { id: "env-gitignored", label: "Secrets (.env) gitignored", status: "pass",
        detail: "No tracked, un-ignored .env files.", fix: null }
    : { id: "env-gitignored", label: "Secrets (.env) gitignored", status: "warn",
        detail: `Tracked & not ignored: ${leaky.join(", ")} — a secret here would be committed.`, fix: null });

  // 5b. Where this repo can take screenshots, does its agent know how to LOOK at
  // one without leaving it in the conversation for every remaining turn?
  //
  // **Configuring a capture target IS the opt-in.** This row is not emitted at
  // all for a repo with no targets: it would be advice about a loop that repo
  // does not run, on every repo on the machine, which is a warn nobody can close
  // and the exact failure `summarize()` keeps host-scope rows out of the badge
  // for. Warn rather than fail — nothing is broken without it, an
  // image is just paid for more times than it needed to be.
  const captureTargets = captureTargetCount(worktree);
  if (captureTargets > 0 && !existsSync(join(worktree, VISUAL_SKILL_REL))) {
    checks.push({
      id: "visual-check",
      label: "Agent told how to look at captures",
      status: "warn",
      detail: `${captureTargets} capture target${captureTargets === 1 ? "" : "s"} configured, but no ` +
        `${VISUAL_SKILL_REL}. Every turn re-sends the whole conversation, so a frame dropped into one is ` +
        `paid for again on every remaining turn — a six-frame matrix at turn 10 of a 40-turn session costs ` +
        `~180k tokens. The preset writes the ladder (deterministic check, text verdict, the phone's gallery, ` +
        `a subagent, looking directly) into this repo.`,
      fix: "visual-check",
    });
  }

  // 5c. Rows contributed by plugins and in-repo extensions (`api.setupCheck`),
  // in load order — today the requirements list (`packages/extensions/
  // requirements/`). Here, before the APK row, which is where that row always
  // sat; `requirementsrow.test.mjs` pins the place and the words.
  checks.push(...contributedChecks(worktree));

  // 5d. An Android app: can its builds reach the phone and update quietly?
  // Absent for every repo that builds none (`apkcheck.ts`).
  const apk = apkInstallCheck(worktree);
  if (apk) checks.push(apk);

  // 5e. Android repos only: can this desktop build it (JDK + SDK)?
  const toolchain = androidToolchainRow(worktree);
  if (toolchain) checks.push(toolchain);

  // 5f. Something buildable here, and the Build sheet has nothing configured?
  const builds = buildsConfiguredRow(worktree);
  if (builds) checks.push(builds);

  // A thing to consider, not a finding (`ADVISORY_CHECKS`): these rows read
  // what a repo costs against a line, and "leave it" is an answer. Marked here,
  // in one place, so no row's own code can forget it; the person's per-repo
  // ignores ride on the same pass.
  const ignored = new Set(ignoredChecks(worktree));
  for (const c of checks) {
    if (!ADVISORY_CHECKS.includes(c.id)) continue;
    c.advisory = true;
    if (ignored.has(c.id)) c.ignored = true;
  }
  return checks;
}

/**
 * The `fix` id the `android-toolchain` row offers: `toolchain.ts`'s user-local install. It is
 * `CONFIRM_GATED_FIXES` (two taps, never in "Fix all") because the second tap IS the licence consent.
 */
export const ANDROID_TOOLCHAIN_FIX = "android-toolchain";

/**
 * The `android-toolchain` row: a JDK and the Android SDK, found on this desktop. Absent for a repo
 * that is not Android (a Node repo is never told about a JDK). A warn naming what is missing and
 * about how much an install would download; never a fail, nothing applies itself. The probe is
 * read-only (`androidenv.ts`).
 */
export function androidToolchainRow(worktree: string, probe = probeAndroidEnv): ComplianceCheck | null {
  if (!isAndroidRepo(worktree)) return null;
  const r = probe();
  if (!r.missing.length) {
    return { id: "android-toolchain", label: "Android toolchain on this desktop", status: "pass",
      detail: `JDK${r.jdk?.major ? ` ${r.jdk.major}` : ""} at ${r.jdk?.home}; Android SDK at ${r.sdk?.root} ` +
        `(${r.sdk?.platforms.length} platform${r.sdk?.platforms.length === 1 ? "" : "s"}, licences accepted).`, fix: null };
  }
  const remedy = r.missing.includes("licences") && r.missing.length === 1
    ? "Accept them with `sdkmanager --licenses` (or Android Studio's SDK Manager); " + BRAND.displayName + " never accepts a licence for you."
    : "Install Android Studio (it brings both), or `brew install openjdk@21` for the JDK and the SDK command-line tools from " +
      "developer.android.com/studio#command-line-tools-only.";
  return { id: "android-toolchain", label: "Android toolchain on this desktop", status: "warn",
    detail: `${r.summary} ${remedy}`, fix: ANDROID_TOOLCHAIN_FIX };
}

/** The `fix` id of the `builds-configured` row: write `builds.json` from what `buildscan` found. */
export const BUILDS_CONFIGURED_FIX = "builds-configured";
const BUILDS_SEED_MAX = 8;
const BUILDS_LABEL = "Build commands configured";

/** The one place the seeded file's path is made: a fixed name in the state dir, contained and realpath-checked. */
function buildsJsonPath(worktree: string): string | null {
  const lexical = contained(worktree, join(basename(repoStateDir(worktree)), "builds.json"));
  return lexical && inRoot(worktree, lexical) ? lexical : null;
}

/** What the fix would write: the scan's ordinary candidates (never one it FLAGGED as publishing or
 *  deploying; those stay a person's choice in the Build sheet), capped. */
function buildsSeed(worktree: string) {
  const { candidates } = scanRepoBuilds(worktree);
  const safe = candidates.filter((c) => !c.note);
  return { found: candidates.length, safe: safe.slice(0, BUILDS_SEED_MAX) };
}

/**
 * The `builds-configured` row: this repo describes something buildable (`buildscan.ts`' detection)
 * and has no `builds.json`, so the Build sheet is empty. Absent when nothing buildable is found.
 * Pass when the file exists and parses to a list. Warn with `fix` when the scan has ordinary
 * candidates to write; warn WITHOUT a fix (an agent's job, `setupRemedy.ts` GUIDANCE) when the file
 * exists but is unreadable, or the scan found only commands it flags (publishing). The fix never
 * overwrites: it writes with `wx`, and a file that appeared meanwhile is left alone.
 */
export function buildsConfiguredRow(worktree: string): ComplianceCheck | null {
  const path = buildsJsonPath(worktree);
  if (!path) return null;
  const rel = join(basename(dirname(path)), "builds.json");
  const id = "builds-configured";
  if (existsSync(path)) {
    let arr: unknown = null;
    try { arr = JSON.parse(readFileSync(path, "utf8")); } catch { /* unparsable */ }
    if (Array.isArray(arr)) {
      return { id, label: BUILDS_LABEL, status: "pass", detail: `${arr.length} build command${arr.length === 1 ? "" : "s"} in ${rel}.`, fix: null };
    }
    return { id, label: BUILDS_LABEL, status: "warn", fix: null,
      detail: `${rel} exists but is not a JSON list of builds, so the Build sheet shows none. It is left as it is.` };
  }
  const { found, safe } = buildsSeed(worktree);
  if (!found) return null;
  if (!safe.length) {
    return { id, label: BUILDS_LABEL, status: "warn", fix: null,
      detail: `This repo describes ${found} build command${found === 1 ? "" : "s"}, all of them publishing or deploying ones, and has no builds.json. None is written for you.` };
  }
  return { id, label: BUILDS_LABEL, status: "warn", fix: BUILDS_CONFIGURED_FIX,
    detail: `Found ${safe.length} buildable command${safe.length === 1 ? "" : "s"} (${safe.map((c) => c.name).join(", ")}; from ` +
      `${[...new Set(safe.map((c) => c.source))].join(", ")}) and no builds.json, so the Build sheet is empty. ` +
      "The fix writes them as the file; it never overwrites one." };
}

/**
 * Boil a checklist down to the repo-row rollup. HOST-scope rows are excluded on
 * purpose: `ok` here answers "is THIS repo wired right", and a fact about the
 * daemon (the retired Gemini-key row was one) would otherwise flag every repo
 * on the machine at once — a badge that is always on says nothing.
 * `checkedAt`/`firstSeenAt` are stamped by the caller that owns the store.
 *
 * **What counts as a finding is `@waterplane/shared`'s `isSetupFinding`, not a
 * predicate written here.** The number below is a badge and the phone cuts the
 * same checklist down to the rows behind it; two spellings of "host-scope rows
 * do not count" drift the moment either end gains a scope, and the failure is
 * silent — a badge that counts 3 over a list showing 4, with no way to tell
 * from either screen which one is lying. One predicate, imported by both.
 */
export function summarize(checks: ComplianceCheck[]): Pick<RepoSetupState, "ok" | "issues" | "fixable"> {
  const repoScope = checks.filter((c) => c.scope !== "host");
  const issues = checks.filter(isSetupFinding);
  return {
    // Two numbers, two questions — and a third field for either is a bug, not a
    // convenience (a `failing` twin of `ok` shipped for a few hours and was
    // dropped from the store on reload, so a broken repo wore the amber style
    // for six hours after every restart; see `RepoSetupState`).
    //
    // `ok` is "nothing is FAILING" — warns allowed. That is the right meaning
    // for the word and the wrong gate for the badge: the launcher chip hung off
    // `!ok`, so a repo whose only findings were warns showed nothing at all, and
    // most of these checks can only ever warn. Measured when the context-weight
    // row was added: its sheet said 35k chars in amber while the launcher row it
    // rolls up to was blank. So `issues > 0` is what the badge RENDERS on, and
    // `!ok` is only how it renders. (Reaching the checklist with NO findings is
    // a different job, done by the repo menu's always-drawn entry, not by
    // widening this gate.)
    ok: repoScope.every((c) => c.status !== "fail"),
    issues: issues.length,
    // "one-tap fixable" on the launcher: a confirm-gated fix (a CHOSEN
    // setting, `CONFIRM_GATED_FIXES`) is neither one tap nor in "Fix all".
    fixable: new Set(issues.map((c) => c.fix).filter((f): f is string => !!f && !CONFIRM_GATED_FIXES.includes(f))).size,
  };
}

/** Build the full report (adds repo id/name + pass rollup). */
export function checkRepoCompliance(target: RepoTarget): ComplianceReport {
  const checks = inspectRepo(target.worktreePath);
  return {
    repoId: target.id,
    repoName: target.repoName,
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    // Sent even when the `context-weight` row is absent (a repo with no
    // CLAUDE.md has nothing to weigh): the thresholds are still the ones this
    // repo will be measured against the moment it gets one, and the sheet is
    // the only place they can be seen or changed.
    contextLimits: contextLimitsFor(target.worktreePath),
    contextLimitsSetAt: contextLimitsStore()?.setAt(target.worktreePath) ?? null,
    autoCompactDefault: autoCompactDefault(),
  };
}

/**
 * Ignore (or stop ignoring) one advisory row in this repo, and hand back the
 * re-run report so the row folds or unfolds without a second read. Refuses in
 * words for any id outside `ADVISORY_CHECKS` — a finding is not something a
 * person can switch off.
 */
export function setCheckIgnored(target: RepoTarget, id: string, ignore: boolean): ComplianceIgnoreResult {
  const store = setupPrefsStore();
  if (!store) return { ok: false, error: "no setup-preferences store on this host" };
  const r = store.setIgnored(target.worktreePath, id, ignore);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, report: checkRepoCompliance(target) };
}

/**
 * Write (or clear) this repo's threshold override and hand back the re-run
 * report, so the row the user was looking at re-states itself against the line
 * they just set rather than requiring a second read to believe it.
 *
 * Refuses in words and writes NOTHING when a value is out of range — a stored
 * repaired number is a number the user did not choose, quoted back at them in a
 * sentence that claims they did.
 */
export function setRepoContextLimits(
  target: RepoTarget,
  patch: unknown,
  opts: { reset?: boolean } = {},
): ComplianceLimitsResult {
  const store = contextLimitsStore();
  if (!store) return { ok: false, error: "no context-limit store on this host" };
  const { limits, errors } = opts.reset ? { limits: {}, errors: [] as string[] } : sanitizeContextLimits(patch);
  if (errors.length) return { ok: false, error: errors.join(" ") };
  store.set(target.worktreePath, limits);
  const report = checkRepoCompliance(target);
  return { ok: true, report, limits: report.contextLimits };
}

// ── fixes (additive + idempotent) ─────────────────────────────────────────────

/** Append lines to .gitignore that aren't already present (any form). `exact`
 *  compares lines as written: `.x/` is then NOT `.x`, which matters for a
 *  symlink — a trailing-slash pattern matches only a real directory. */
function ensureGitignore(worktree: string, entries: string[], exact = false): string[] {
  const gi = join(worktree, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const norm = (l: string) => (exact ? l.trim() : l.trim().replace(/\/$/, ""));
  const have = new Set(cur.split("\n").map(norm));
  const missing = entries.filter((e) => !have.has(norm(e)));
  if (!missing.length) return [];
  const block = `\n# ${BRAND.displayName} phone↔repo transport — do not commit\n` + missing.join("\n") + "\n";
  writeFileSync(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + block);
  return missing;
}

export function fixRepoCompliance(target: RepoTarget, fixes: string[]): ComplianceFixResult {
  const wt = target.worktreePath;
  const applied: string[] = [];
  const notes: string[] = [];
  try {
    if (fixes.includes("gitignore")) {
      // Bare paths (no trailing slash) so `git check-ignore` matches even before
      // the dir exists — a trailing-slash pattern only matches real directories.
      const added = ensureGitignore(wt, TRANSPORT_DIRS);
      if (added.length) { applied.push("gitignore"); notes.push(`gitignore += ${added.join(", ")}`); }
      else notes.push("gitignore already covered transport dirs");
    }

    if (fixes.includes("claude-md")) {
      const path = join(wt, "CLAUDE.md");
      const cur = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (cur == null) {
        // Never scaffold a bare CLAUDE.md — `/init` writes a useful one; we only
        // graft our conventions onto an existing file.
        notes.push("no CLAUDE.md — run `/init` first, then re-run this fix to add the outbox convention");
      } else if (!hasClaudeMdMarker(cur)) {
        writeFileSync(path, cur + (cur.endsWith("\n") ? "" : "\n") + "\n" + claudeMdBlock());
        applied.push("claude-md"); notes.push(`appended ${BRAND.displayName} conventions to CLAUDE.md`);
      } else {
        notes.push(`CLAUDE.md already has the ${BRAND.displayName} conventions section`);
      }
    }

    if (fixes.includes("visual-check")) {
      // Never overwrite an existing one: the preset asks its reader to measure
      // the subagent baseline on this machine and edit the number in, so a
      // re-run that rewrote the file would delete the only part of it that was
      // ever true here.
      const r = writeVisualCheckSkill(wt);
      if (r.written) { applied.push("visual-check"); notes.push(`wrote ${r.relPath}`); }
      else notes.push(`${r.relPath} already present — left as it is`);
    }

    if (fixes.includes("state-dir")) {
      // Re-checked here rather than trusted from the row: the tap may be minutes
      // old, and a dir git started tracking since is no longer ours to move.
      const legacyNow = legacyRepoStateDirs(wt);
      const tracked = legacyNow.flatMap((d) => trackedUnder(wt, basename(d)));
      if (!legacyNow.length) {
        notes.push(`no legacy state dir — already ${BRAND.stateDirName}/`);
      } else if (tracked.length) {
        notes.push(`git tracks files under ${legacyNow.map((d) => basename(d)).join(", ")} — left as it is`);
      } else {
        const r = adoptRepoStateDir(wt);
        if (r.action === "renamed" || r.action === "merged") {
          applied.push("state-dir");
          notes.push(r.note ?? `moved to ${BRAND.stateDirName}/`);
          // Ignore the new name, and the symlink left at the old one: a
          // trailing-slash pattern (`<old>/`) matches a directory, never the
          // symlink that now stands there. Both ADD lines only.
          const ignore = [BRAND.stateDirName, ...legacyNow.map((d) => basename(d))]
            .filter((n) => !isIgnored(wt, n));
          const added = ignore.length ? ensureGitignore(wt, ignore, true) : [];
          if (added.length) notes.push(`gitignore += ${added.join(", ")}`);
        } else {
          notes.push(r.note ?? "the state dir could not be moved — left as it is");
        }
      }
    }

    // Contributed fixes (`api.setupFix`) — the ids their rows name in `fix`.
    // A core id can never be one (`CORE_FIX_IDS`), so no fix runs twice.
    for (const { id, outcome } of contributedFixes(fixes, wt)) {
      if (outcome.applied) applied.push(id);
      notes.push(outcome.note);
    }

    if (fixes.includes("auto-compact")) {
      // A fixed relative path joined onto the trusted worktree (`contained`),
      // then realpath-checked (`inRoot`) so a `.claude` symlinked out of the
      // repo is refused rather than written through.
      const lexical = contained(wt, PROJECT_SETTINGS_REL);
      const path = lexical && inRoot(wt, lexical) ? lexical : null;
      if (!path) {
        notes.push(`${PROJECT_SETTINGS_REL} resolves outside this repo — left as it is`);
      } else {
        const value = autoCompactDefault();
        const r = withAutoCompactWindow(readOrNull(path), value);
        if (!r.ok) {
          notes.push(`${PROJECT_SETTINGS_REL}: ${r.error}`);
        } else {
          mkdirSync(dirname(path), { recursive: true });
          const tmp = `${path}.${BRAND.slug}-tmp`;
          writeFileSync(tmp, r.text);
          renameSync(tmp, path);
          applied.push("auto-compact");
          notes.push(`set "autoCompactWindow": "${value}" in ${PROJECT_SETTINGS_REL}`);
        }
      }
    }

    if (fixes.includes(ANDROID_TOOLCHAIN_FIX)) {
      // Background and single-flight: the install outlives this request. The confirm tap is the
      // licence consent (`ANDROID_TOOLCHAIN_CONSENT`); progress is the log named in the note.
      const r = startToolchainInstall({ acceptLicences: true });
      if (r.started) { applied.push(ANDROID_TOOLCHAIN_FIX); notes.push("started the Android toolchain install (user-local, no sudo); the row updates when it finishes"); }
      else notes.push("an Android toolchain install is already running");
    }

    if (fixes.includes("signing-key")) {
      // The desktop key, made once (`signkey.ts`), then this repo's gitignored pointer to it.
      const made = ensureDesktopKey();
      const linked = made.ok ? linkKey(wt) : null;
      if (made.ok && linked?.ok) { applied.push("signing-key"); notes.push(made.note, linked.note); }
      else notes.push(!made.ok ? made.error : (linked as { error: string }).error);
    }

    if (fixes.includes(BUILDS_CONFIGURED_FIX)) {
      const path = buildsJsonPath(wt);
      const { safe } = buildsSeed(wt);
      if (!path) notes.push("the state dir resolves outside this repo — left as it is");
      else if (existsSync(path)) notes.push("builds.json already exists — left as it is");
      else if (!safe.length) notes.push("nothing buildable to write — left as it is");
      else {
        const list = safe.map((c, i) => ({ id: `scan_${i}`, name: c.name, cmd: c.cmd, ...(c.dir ? { dir: c.dir } : {}) }));
        mkdirSync(dirname(path), { recursive: true });
        try {
          writeFileSync(path, JSON.stringify(list, null, 2), { flag: "wx" });
          applied.push(BUILDS_CONFIGURED_FIX);
          notes.push(`wrote ${list.length} build${list.length === 1 ? "" : "s"} to ${join(basename(dirname(path)), "builds.json")}`);
        } catch { notes.push("builds.json appeared meanwhile — left as it is"); }
      }
    }

    return { ok: true, applied, notes, report: checkRepoCompliance(target) };
  } catch (e) {
    return { ok: false, applied, notes, error: String((e as Error).message || e) };
  }
}

/** Root-level dotenv file names (.env / .env.*) — for the secret-leak check. */
function listRootEnvFiles(worktree: string): string[] {
  try {
    return readdirSync(worktree).filter((n) => {
      if (!/^\.env(\.[A-Za-z0-9_.-]+)?$/.test(n)) return false;
      try { return statSync(join(worktree, n)).isFile(); } catch { return false; }
    });
  } catch {
    return [];
  }
}
