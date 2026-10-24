/**
 * Per-repo build commands, runnable from the phone WITHOUT a claude session —
 * the token-limit escape hatch. You wire named build commands into the UI once
 * (persisted in <repoDir>/<shared dir>/builds.json, see below); tapping one spawns a plain shell
 * in the repo, streams its output to the phone like a session, and surfaces the
 * produced artifact (APK/zip/…) for download. No tokens are spent — this is the
 * fallback when Claude itself is rate-limited.
 *
 * Two files, one list. `<repoDir>/<shared dir>/builds.json` is COMMITTED with the
 * repo, so every clone and every desktop gets the same buttons; the gitignored
 * `<repoDir>/<state dir>/builds.json` holds what is true of THIS desktop only (a
 * JAVA_HOME path, a local SDK). `list()` is shared then local, and a local entry
 * with a shared entry's id REPLACES it in place — a machine override, never a
 * second button. `save()` partitions the phone's whole list back over the two
 * (`local` ids named by the caller, else wherever an id lives today, else shared),
 * keeps a shadowed shared entry as it is, and writes a file only when its content
 * changed so a no-op save never dirties the working tree.
 *
 * Trust model: same as spawning `claude` — the daemon already runs arbitrary
 * code on the host, and Tailscale network identity is the only boundary. The
 * shared file is part of the checkout and exactly as trusted as the checkout
 * itself (whose `package.json` scripts and gradle files the same buttons run
 * anyway); the local one is what the phone edits over Tailscale. A run is a
 * SNAPSHOT of the command at fire time, so a later pull changes the next run,
 * never one already recorded. The optional per-build working dir is
 * traversal-guarded to the repo.
 *
 * ── What is here, and what is the store's ──────────────────────────────────
 *
 * Everything mechanical is here: the pty spawn with `CI=1`, the output ring and
 * the streaming frames (keyed by `runId`, which IS the intent id — so
 * `build.output` is unchanged on the wire), `cancel`, and `detectArtifacts`
 * including its stale fallback.
 *
 * The run LIST is not. It was an in-memory ring with a hand-written "never evict
 * a still-running run" loop, because evicting one would orphan its process and
 * leak its output; the store's compaction rule already guarantees that — nothing
 * queued, starting or running may leave the file at all — and it guarantees the
 * other half too, which the ring never did: a build that was running when the
 * daemon died is a row that says so, rather than a run nobody can account for.
 */
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { spawnFailure } from "./ptycap.js";
import type { BuildArtifact, BuildParamAnswer, BuildConfig, BuildRun, Intent } from "@waterplane/shared";
import {
  applyParams, buildRunTitle, unsafeParamIds, unsafeParamsText, cleanBuildParams, missingParamsText, paramEnv, parseParamOptions,
  resolveParamValues, logTag,
} from "@waterplane/shared";
import { hostStateDir, repoSharedDir, repoStateDir } from "./branddirs.js";
import { ROOT } from "./env.js";
import { targetId } from "./repos.js";
import type { ExecutorResult, IntentManager } from "./intents/manager.js";
import { intentToBuildRun, isBuildRow } from "./intents/adapters.js";
import { contained } from "./paths.js";
import { artifactPolicy, collectArtifacts } from "./artifacts.js";
import { execFileP } from "./proc.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const SHELL = process.env.SHELL || "/bin/bash";
/** ASYNC, deliberately: this runs on the loop that pumps every live PTY, and a
 *  six-second synchronous listing is a six-second outage for every session. */
/** Retained output per run (chars) — enough to review a build, capped so a
 *  chatty build can't grow memory without bound. */
const OUT_RING = 200_000;
/** Runs shown per repo (newest first). The store keeps far more than this and
 *  never drops one that has not settled; this is what a sheet renders. */
const MAX_RUNS = 40;

/** Extensions treated as build deliverables when detecting what a run produced. */
const BUILD_ART_EXT = new Set([
  ".apk", ".aab", ".ipa", ".zip", ".jar", ".dmg", ".exe", ".deb", ".rpm",
  ".tar", ".gz", ".tgz", ".msi", ".pkg", ".whl", ".appimage",
  // Garmin Connect IQ: .iq is the store package, .prg the sideload build.
  ".iq", ".prg",
  // A VS Code extension package (`vsce package`).
  ".vsix",
]);
/** Dirs never worth descending for build outputs. NOTE: unlike the artifact
 *  gallery we DO descend into build/dist/target — that's where outputs land. */
const SKIP = new Set([".git", "node_modules", ".dart_tool", "__pycache__", ".venv", "venv", ".gradle",
  // Gradle's scratch: `R.jar`, classes jars, merged-dex zips. Every one has a
  // deliverable extension and none is a deliverable — a docs run that built no
  // APK was offered `R.jar` from here as its "already up to date" output.
  "intermediates"]);
/** Files with a deliverable extension that are SOURCE, not output: the gradle
 *  wrapper is checked into every Android repo and was the other half of that
 *  offer. Matched on the name, so it is skipped wherever it sits. */
const NOT_ARTIFACT = new Set(["gradle-wrapper.jar"]);

/** Dir names that usually hold build output — visited FIRST, so a repo with a
 *  huge data/asset tree can't burn the walk budget before reaching the APK. */
const ART_DIRS = new Set(["build", "dist", "out", "outputs", "target", "bin", "release", "artifacts", "public"]);

/**
 * Scan the repo for build deliverables touched at/after `sinceMs` (the run's
 * start), biggest first (the APK, not a stray tiny zip). Bounded so a giant
 * tree can't stall the host.
 *
 * Two things keep the bound from silently hiding the artifact: the walk reads
 * dirents (no `stat` per entry — only candidate files are stat'ed), so the
 * budget buys far more entries than it looks like; and output-looking dirs are
 * popped first. Tiptoi is the case that forced both — 47k entries, 41k of them
 * under `service/data/`, against a flat 40k budget that stat'ed everything: the
 * debug APK's detection depended on readdir order. Symlinks are never followed
 * (the old `statSync` did, so a self-referential link was a walk cycle bounded
 * only by the budget).
 */
export function detectArtifacts(repoDir: string, root: string, sinceMs: number, buildDir?: string): BuildArtifact[] {
  const repoId = targetId(repoDir);
  const out: BuildArtifact[] = [];
  /**
   * Where a STALE file may come from. The fallback below claims "this build's
   * output, already up to date" — so it must be a file this build could have
   * written: under its own `dir` when it has one, and never in `.claude/`,
   * where the outbox holds what EVERY build collected. A VS Code install run
   * in `packages/vscode` was offered three Android APKs from the outbox, days
   * old, as its own unchanged output.
   */
  const transport = join(root, ".claude") + sep;
  const scope = buildDir && resolve(buildDir) !== resolve(root) ? resolve(buildDir) + sep : null;
  const staleOk = (full: string) => !full.startsWith(transport) && (!scope || full.startsWith(scope));
  /**
   * Deliverables the run did NOT touch — the fallback, see below.
   *
   * Bounded: `.zip`/`.gz` are ordinary files in plenty of trees, and this list
   * only ever contributes its newest few entries, so there is no reason to hold
   * thousands. Kept unsorted and trimmed at the end (a full sort per push would
   * make the walk quadratic on a tree full of tarballs).
   */
  const untouched: BuildArtifact[] = [];
  /**
   * Did this run write into an output dir at all — regardless of extension?
   * One `statSync` per `ART_DIRS` hit (rare: `build`/`dist`/`out`/…), not one
   * per file, so this stays cheap in a tree the size the budget above was set
   * for. A web build writes `.js`/`.css`/`.html`/`.txt` into `dist` — none of
   * them `BUILD_ART_EXT` — and without this signal that looked identical to a
   * `dir` that has not been touched since the last real build, so the stale
   * fallback below handed back an unrelated Android APK from a week ago
   * labelled "already up to date" for a run that had just rewritten `dist`.
   */
  let wroteOutput = false;
  const stack = [root];
  let budget = 200000; // hard bound on directory entries examined
  while (stack.length && budget > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const hot: string[] = [];
    for (const ent of entries) {
      if (budget-- <= 0) break;
      const name = ent.name;
      if (SKIP.has(name) || ent.isSymbolicLink()) continue;
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (ART_DIRS.has(name)) {
          hot.push(full);
          if (!wroteOutput) {
            try { if (statSync(full).mtimeMs >= sinceMs - 1000) wroteOutput = true; } catch { /* gone already */ }
          }
        } else stack.push(full);
        continue;
      }
      if (!ent.isFile() || !BUILD_ART_EXT.has(extname(name).toLowerCase()) || NOT_ARTIFACT.has(name)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      const art: BuildArtifact = {
        repoId, name, relPath: relative(root, full).split(sep).join("/"), size: st.size, mtime: st.mtimeMs,
      };
      if (st.mtimeMs >= sinceMs - 1000) out.push(art);
      else if (untouched.length < 400 && staleOk(full)) untouched.push({ ...art, stale: true });
    }
    for (const h of hot) stack.push(h); // pushed last ⇒ popped first
  }
  out.sort((a, b) => b.size - a.size);
  if (out.length) return out.slice(0, 12);
  // A run that rewrote an output dir but produced nothing `BUILD_ART_EXT`
  // recognises is not a no-op — it built something that just is not a
  // packaged binary (a web bundle). Say so honestly (empty list ⇒ "no
  // downloadable file found") rather than reaching for the fallback below.
  if (wroteOutput) return [];
  // Nothing was written. That is the NORMAL outcome of an incremental build
  // whose outputs are already current — gradle prints BUILD SUCCESSFUL and "50
  // up-to-date", and the APK the button exists to hand you is sitting in
  // build/outputs, older than this run. Reporting zero artifacts there reads as
  // "the build produced nothing", which is what made a working setup look
  // broken. Offer the newest matching files instead, flagged `stale` so the row
  // can say the run didn't write them.
  untouched.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return untouched.slice(0, 4);
}

/** Sanitize one persisted build entry (defensive against a hand-edited file —
 *  and this file is one an AGENT writes, which is the point of the sheet's two
 *  wand buttons). Parameters are `shared/buildparams.ts`'s rules, so the phone's
 *  form and this file cannot hold two opinions about what a value may be. */
function cleanConfig(v: any, i: number): BuildConfig | null {
  if (!v || typeof v.cmd !== "string" || !v.cmd.trim()) return null;
  return {
    id: typeof v.id === "string" && v.id ? v.id : `b_${i}`,
    name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : "build",
    cmd: v.cmd,
    dir: typeof v.dir === "string" && v.dir.trim() ? v.dir.trim() : undefined,
    params: cleanBuildParams(v.params),
  };
}

/** One builds file's cleaned entries, or null when it is absent or not a JSON list. */
export function readBuildsFile(path: string): BuildConfig[] | null {
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(arr)) return arr.map(cleanConfig).filter((b): b is BuildConfig => b !== null);
  } catch { /* no file / bad json → none */ }
  return null;
}

/** Shared then local; a local entry with a shared id takes that entry's place. */
export function mergeBuilds(shared: BuildConfig[], local: BuildConfig[]): BuildConfig[] {
  const over = new Map(local.map((b) => [b.id, b]));
  const out = shared.map((b) => over.get(b.id) ?? b);
  const seen = new Set(out.map((b) => b.id));
  for (const b of local) if (!seen.has(b.id)) { out.push(b); seen.add(b.id); }
  return out;
}

/**
 * Split the phone's whole list back over the two files. An id in `local` (or,
 * with no `local`, an id the local file holds today) goes local; everything
 * else goes shared. A local entry that shadows a shared one leaves the shared
 * entry exactly as it is — overriding on this desktop never edits what every
 * other checkout runs. An id absent from `list` is gone from both.
 */
export function partitionBuilds(list: BuildConfig[], curShared: BuildConfig[], curLocal: BuildConfig[], local?: string[]): { shared: BuildConfig[]; local: BuildConfig[] } {
  const localSet = new Set(Array.isArray(local) ? local.filter((x) => typeof x === "string") : curLocal.map((b) => b.id));
  const sharedById = new Map(curShared.map((b) => [b.id, b]));
  const shared: BuildConfig[] = [], loc: BuildConfig[] = [];
  for (const b of list) {
    if (localSet.has(b.id)) {
      loc.push(b);
      const kept = sharedById.get(b.id);
      if (kept) shared.push(kept);
    } else shared.push(b);
  }
  return { shared, local: loc };
}

function sameList(a: BuildConfig[], b: BuildConfig[] | null): boolean {
  return b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** How long a parameter's `optionsCmd` may take before the form gives up on it
 *  and says so. It is a listing — `ls`, a `find`, a `jq` over a manifest — and a
 *  person is waiting on a phone with the keyboard already up. */
const OPTIONS_TIMEOUT_MS = 6000;
/** And how much of its stdout is read. 200 options are already more than a
 *  drop-down is worth; this is the bound under that bound. */
const OPTIONS_MAX_BYTES = 256_000;

/** True only when git ANSWERS "this path is not tracked" (`ls-files
 *  --error-unmatch` exits 1 inside a repo). Exit 128 (not a repo), a missing git
 *  binary, a timeout: all false — the caller fails closed. argv + `--`, no shell.
 *  The probe asks about the file's REAL path: git never sees a path through a
 *  symlink, so a committed `.waterplane -> payload` would otherwise read as
 *  "untracked" while serving committed bytes. A real path outside the repo is
 *  refused outright. `cwd` is the repo, so its own `.git/config` (fsmonitor,
 *  hooks) is consulted — the same pre-existing exposure as every other git call
 *  this daemon makes in a repo; `.git/config` is never cloned. */
async function localFileUntracked(repoDir: string, file: string): Promise<boolean> {
  let real: string, repoReal: string;
  try { real = realpathSync.native(file); repoReal = realpathSync.native(repoDir); } catch { return false; }
  const rel = relative(repoReal, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    await execFileP("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: repoReal, timeout: 5000 });
    return false; // exit 0: tracked
  } catch (e) {
    return (e as { code?: unknown }).code === 1;
  }
}

export class BuildManager extends EventEmitter {
  private procs = new Map<string, IPty>();     // runId → live process
  private output = new Map<string, string>();  // runId → retained output tail
  /** Runs the phone called off. The pty's exit is what finalizes a build, and
   *  an exit code from a `kill` is indistinguishable from a failing command —
   *  so the fact that it was cancelled has to be remembered here. */
  private cancelled = new Set<string>();

  private approvalsPath: string;

  constructor(private intents: IntentManager, root: string = ROOT) {
    super();
    this.approvalsPath = join(hostStateDir(root), "build-approvals.json");
  }

  /* An `optionsCmd` is a shell command. One from the SHARED file arrived with a
     checkout (clone/pull of a repo somebody else wrote), so running it when the
     form merely OPENS would be code execution without a tap. One from the LOCAL
     file was written on this desktop. The person's approval of a shared command
     is remembered here as (repo, sha256(command)) in the host's own state — a
     changed command is a different hash and asks again. Running a build does
     NOT approve it: approval is its own explicit tap (`build.options` with
     `approve`). */
  private approvalKey(repoDir: string, cmd: string): string {
    let repo: string;
    try { repo = realpathSync.native(repoDir); } catch { repo = resolve(repoDir); }
    return createHash("sha256").update(repo).update("\0").update(cmd).digest("hex");
  }
  private readApprovals(): string[] {
    const v = readJsonGuarded<unknown>(this.approvalsPath, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }
  private approve(repoDir: string, cmd: string): void {
    const key = this.approvalKey(repoDir, cmd);
    const cur = this.readApprovals();
    if (cur.includes(key)) return;
    try { writeJsonAtomic(this.approvalsPath, [...cur, key].slice(-2000), { space: 2 }); } catch { /* not remembered: asks again */ }
  }
  /** May this entry's `optionsCmd` run without a tap? Only a LOCAL-file entry
   *  whose file git reports as NOT tracked — the local dir sits INSIDE the
   *  checkout, so "local" is a gitignore convention a hostile repo controls: a
   *  committed `.waterplane/builds.json` is shared in every way that matters.
   *  Fails CLOSED: not a git repo, git missing or any probe error asks for the
   *  tap (one tap, remembered by hash), never runs unasked. */
  private async optionsTrusted(repoDir: string, buildId: string, cmd: string): Promise<boolean> {
    const lp = this.localPath(repoDir);
    if ((readBuildsFile(lp) ?? []).some((b) => b.id === buildId) && await localFileUntracked(repoDir, lp)) return true;
    return this.readApprovals().includes(this.approvalKey(repoDir, cmd));
  }

  private sharedPath(repoDir: string): string { return join(repoSharedDir(repoDir), "builds.json"); }
  private localPath(repoDir: string): string { return join(repoStateDir(repoDir), "builds.json"); }

  /** A repo's configured builds (empty if none/unreadable): the shared file's
   *  entries, then the local file's — a local entry with a shared id replaces
   *  that entry where it stands (a machine override). */
  list(repoDir: string): BuildConfig[] {
    return mergeBuilds(readBuildsFile(this.sharedPath(repoDir)) ?? [], readBuildsFile(this.localPath(repoDir)) ?? []);
  }

  /** The ids the LOCAL (this-desktop-only) file holds — what the phone shows as
   *  "this desktop only" and sends back as `local` on a save. */
  localIds(repoDir: string): string[] {
    return (readBuildsFile(this.localPath(repoDir)) ?? []).map((b) => b.id);
  }

  /**
   * Persist a repo's whole build list over the two files; returns the merged
   * list as it now reads. `local` names the ids that belong in the local file;
   * absent, an id stays where it lives today and a new one goes to the SHARED
   * file (the point of the shared file is that a new button reaches every
   * checkout). A file is written only when its content changes; an emptied
   * local file is deleted; a shared file is never created to hold nothing.
   */
  save(repoDir: string, builds: BuildConfig[], local?: string[]): BuildConfig[] {
    const clean = (Array.isArray(builds) ? builds : []).map(cleanConfig).filter((b): b is BuildConfig => b !== null);
    const sharedP = this.sharedPath(repoDir), localP = this.localPath(repoDir);
    const curShared = readBuildsFile(sharedP), curLocal = readBuildsFile(localP);
    const plan = partitionBuilds(clean, curShared ?? [], curLocal ?? [], local);
    // A file that exists but does not parse is somebody's hand edit mid-way:
    // never overwritten (or deleted) from here — the list just reads without it.
    const sharedBroken = curShared === null && existsSync(sharedP);
    const localBroken = curLocal === null && existsSync(localP);
    try {
      if (!sharedBroken && !sameList(plan.shared, curShared) && (plan.shared.length || curShared !== null)) {
        writeJsonAtomic(sharedP, plan.shared, { space: 2, newline: true });
      }
      if (!localBroken) {
        if (!plan.local.length) { if (curLocal !== null) rmSync(localP, { force: true }); }
        else if (!sameList(plan.local, curLocal)) writeJsonAtomic(localP, plan.local, { space: 2 });
      }
    } catch { /* best-effort */ }
    return this.list(repoDir);
  }

  /**
   * What each of a build's discovered parameters may be set to.
   *
   * One entry per parameter that declares an `optionsCmd` — a static list needs
   * no round trip, the phone already has it on the config. The command is a
   * LISTING (`ls -1 apps`, a `find`, a `jq` over a manifest) run in the repo
   * root, and it runs when the form OPENS rather than when the button is
   * pressed: that is the one thing about this worth knowing, it comes out of the
   * same file as the build it belongs to and the form shows it for that reason.
   *
   * Always at the repo ROOT, never the entry's `dir` — the dir may itself be
   * parameterised (`apps/{{app}}`), so resolving it would need the answer this
   * call exists to produce.
   *
   * A failure is a SENTENCE per parameter, never an empty list: "that command
   * failed" and "this monorepo has no apps" are opposite facts, and only one of
   * them means the form should quietly offer a typed field instead.
   */
  async paramOptions(repoDir: string, buildId: string, approve?: { paramId?: string; cmd?: string }): Promise<Record<string, BuildParamAnswer>> {
    const cfg = this.list(repoDir).find((b) => b.id === buildId);
    const out: Record<string, BuildParamAnswer> = {};
    if (!cfg) return out;
    const root = resolve(repoDir);
    for (const p of cfg.params ?? []) {
      if (!p.optionsCmd) continue;
      // The approval is for the text the person READ: if the file moved under
      // them (autopull, a replayed queue), approve nothing and show the new text.
      if (approve?.paramId === p.id && approve.cmd === p.optionsCmd) this.approve(repoDir, p.optionsCmd);
      if (!(await this.optionsTrusted(repoDir, buildId, p.optionsCmd))) {
        out[p.id] = { needsApproval: true, cmd: p.optionsCmd };
        continue;
      }
      try {
        const { stdout } = await execFileP(SHELL, ["-lc", p.optionsCmd], {
          cwd: root, encoding: "utf8", timeout: OPTIONS_TIMEOUT_MS, maxBuffer: OPTIONS_MAX_BYTES,
          env: { ...process.env, CI: "1" },
        });
        const { options, total } = parseParamOptions(stdout);
        // stderr is deliberately not read: a listing that warns on the way is
        // still a listing, and the warning would otherwise become an option.
        out[p.id] = options.length ? { options, total } : { error: `${p.optionsCmd} listed nothing` };
      } catch (e) {
        const why = (e as { killed?: boolean }).killed
          ? `took longer than ${Math.round(OPTIONS_TIMEOUT_MS / 1000)}s`
          : ((e as Error).message || "failed").split("\n")[0].slice(0, 200);
        out[p.id] = { error: `${p.optionsCmd}: ${why}` };
      }
    }
    return out;
  }

  /** This repo's runs, newest first — rendered from the rows that are them. */
  runsFor(repoDir: string): BuildRun[] {
    return this.intents.list().filter((i) => isBuildRow(i) && i.cwd === repoDir).slice(0, MAX_RUNS).map(intentToBuildRun);
  }

  /** The newest run still going in this repo, for the launcher's spinner — no subprocess. */
  runningIn(repoDir: string): { runId: string; name: string } | undefined {
    const r = this.runsFor(repoDir).find((x) => x.status === "running");
    return r && { runId: r.runId, name: r.name };
  }

  getOutput(runId: string): string { return this.output.get(runId) ?? ""; }

  /**
   * Run one configured build now.
   *
   * The config is RESOLVED here and snapshotted onto the row — name, command and
   * the traversal-guarded working dir — for two reasons: `builds.json` is edited
   * between runs and a row that renames itself afterwards is a lie about what
   * ran; and every refusal ("unknown build", "invalid working dir") is answered
   * synchronously, while there is still a socket to tell, rather than minutes
   * later inside an executor.
   */
  run(repoDir: string, buildId: string, given?: Record<string, string>): BuildRun | { error: string } {
    const cfg = this.list(repoDir).find((b) => b.id === buildId);
    if (!cfg) return { error: "unknown build" };

    /*
     * Parameters are resolved HERE, with the other two refusals, and for the
     * same reason: a build that cannot say which app it is screenshotting must
     * be refused while there is still a socket to tell — not minutes later
     * inside an executor, and never by picking a value on somebody's behalf. An
     * unattended fire (a schedule, a chain, Activity's "run it now") arrives
     * with no values at all and lands exactly here, on the stored defaults or on
     * this sentence.
     */
    const { values, missing } = resolveParamValues(cfg.params, given);
    if (missing.length) return { error: missingParamsText(missing) };
    // A value is substituted verbatim, so a shell metacharacter in one would be
    // a second command. Refused here, synchronously, for every origin of a value.
    const unsafe = unsafeParamIds(cfg.cmd, values);
    if (unsafe.length) return { error: unsafeParamsText(unsafe) };

    // Resolve the working dir, guarding the optional per-build subdir to the
    // repo. Substituted FIRST: `apps/{{app}}` is how one entry serves one member
    // of a monorepo, and the guard is what makes that safe — it runs on the
    // resolved path, so a value cannot walk out of the repo.
    const root = resolve(repoDir);
    let cwd = root;
    const dir = cfg.dir ? applyParams(cfg.dir, values) : "";
    if (dir) {
      const full = contained(root, dir);
      if (full === null) return { error: "invalid working dir" };
      if (!existsSync(full)) return { error: `working dir not found: ${dir}` };
      cwd = full;
    }

    const cmd = applyParams(cfg.cmd, values);
    const runId = "br_" + randomUUID().slice(0, 8);
    const posted = this.intents.post({
      id: runId,
      cwd: repoDir,
      payload: { kind: "build", buildId, name: cfg.name, cmd, cwd, params: Object.keys(values).length ? values : undefined },
      target: { kind: "shell" },
      trigger: { kind: "now" },
      // The values are IN the title, so Activity, the notification and the run
      // row can tell this run from the four above it. `buildRunTitle` leaves a
      // paramless build reading exactly as it always did.
      title: buildRunTitle(cfg.name, values),
    });
    if (!posted.ok || !posted.intent) return { error: posted.reason || "could not be written down" };
    return intentToBuildRun(posted.intent);
  }

  /**
   * The executor: spawn the command and resolve when it exits.
   *
   * The one executor in this daemon that can legitimately take an hour. It
   * resolves on the process's own exit rather than on "started", because a build
   * has no turn to watch and its exit code IS its verdict.
   */
  execute(i: Intent): Promise<ExecutorResult> {
    const p = i.payload.kind === "build" ? i.payload : null;
    if (!p?.cmd) return Promise.resolve({ ok: false, detail: "that build no longer has a command" });
    const runId = i.id;
    const root = resolve(i.cwd);
    const cwd = p.cwd || root;
    const startedAt = Date.now();
    this.output.set(runId, "");
    this.cancelled.delete(runId);

    let proc: IPty;
    try {
      // CI=1 nudges tools (gradle, npm…) toward non-interactive, less-animated output.
      proc = pty.spawn(SHELL, ["-lc", p.cmd], {
        name: "xterm-256color", cols: 120, rows: 40, cwd,
        // The values are in the command line already (substituted at fire time),
        // and here as well: a command that would rather read "$<PREFIX>PARAM_APP"
        // than trust a verbatim substitution gets to, and a script the button
        // calls can read one the command line never mentions.
        env: { ...process.env, TERM: "xterm-256color", CI: "1", ...paramEnv(p.params ?? {}) },
      });
    } catch (e) {
      // A build is a PTY like a session is, so it fails the same way when the
      // system pty table is full — and said as `posix_spawnp failed` it reads
      // as a broken build command instead of a machine-wide condition.
      const why = spawnFailure(e);
      const msg = `\r\n${logTag} failed to start build: ${why}\r\n`;
      this.append(runId, msg);
      this.emit("output", runId, msg); // stream it so an open sheet shows why, not "(no output)"
      return Promise.resolve({ ok: false, detail: `could not start the build: ${why}`, exitCode: null });
    }

    this.procs.set(runId, proc);
    proc.onData((chunk) => { this.append(runId, chunk); this.emit("output", runId, chunk); });
    return new Promise<ExecutorResult>((done) => {
      proc.onExit(({ exitCode, signal }) => {
        this.procs.delete(runId);
        if (this.cancelled.delete(runId)) {
          done({ ok: false, canceled: true, detail: "cancelled from the phone", exitCode });
          return;
        }
        // A signal death (external kill / OOM) reports exitCode 0 but isn't success.
        const ok = exitCode === 0 && !signal;
        done({
          ok,
          detail: ok ? "build succeeded" : `build failed${exitCode != null ? ` (exit ${exitCode})` : ""}`,
          exitCode,
          // What a run produced is DETECTED, then made into something a person
          // can use: one entry per artifact rather than one per path the same
          // bytes sit at, named so the download list can tell three repos'
          // `app-debug.apk` apart, and the builds it replaces removed
          // (`artifacts.ts`, both halves). Every line of it goes into this
          // run's own output — a file appearing in the outbox and an older one
          // ceasing to exist must both be sentences somebody can read.
          artifacts: this.finishArtifacts(runId, i.cwd, root, startedAt, cwd),
        });
      });
    });
  }

  /**
   * Detect, collect, fold and prune — and say so in the run's output.
   *
   * Wrapped rather than inlined because it must NEVER fail a build: a repo on
   * a filesystem that refuses hard links, an unwritable outbox or a file that
   * vanished between the walk and the link is a build that still succeeded and
   * still has an artifact to offer.
   */
  private finishArtifacts(runId: string, repoDir: string, root: string, startedAt: number, buildDir: string): BuildArtifact[] {
    const found = detectArtifacts(repoDir, root, startedAt, buildDir);
    try {
      return collectArtifacts(repoDir, found, artifactPolicy(repoDir), (line) => {
        this.append(runId, line);
        this.emit("output", runId, line);
      });
    } catch {
      return found;
    }
  }

  /** Kill a running build. The pty's exit is what finalizes it — this only
   *  records that the death was asked for, so it settles `cancelled` rather
   *  than as another non-zero exit. */
  cancel(runId: string): boolean {
    const p = this.procs.get(runId);
    if (!p) return false;
    this.cancelled.add(runId);
    try { p.kill(); } catch { /* already gone */ }
    return true;
  }

  private append(runId: string, chunk: string): void {
    const cur = (this.output.get(runId) ?? "") + chunk;
    this.output.set(runId, cur.length > OUT_RING ? cur.slice(-OUT_RING) : cur);
  }
}
