/**
 * What a build leaves behind, and what it is called.
 *
 * Every rule here exists because of the same measured failure, seen across nine
 * repos on this desktop at once: a build button runs `./gradlew assembleDebug`,
 * the deliverable is `app-debug.apk` in `build/outputs/…`, and that is what the
 * phone is offered. Three things are wrong with it and none of them are visible
 * on the phone:
 *
 *  - **The name says nothing.** Three repos here produce a file called exactly
 *    `app-debug.apk`. The download list, the install log and the outbox all
 *    show one word that identifies neither the app nor the build.
 *  - **Nothing is ever removed.** 6.8 GB of transport files across fourteen
 *    repos was the measurement that produced the sweep; a build that appends a
 *    130 MB APK per tap is where most of it came from.
 *  - **The same bytes arrive twice.** A script that copies its output somewhere
 *    friendlier leaves the original in place, both are detected, both are
 *    queued, and the phone spends 454 MB fetching one 227 MB APK.
 *
 * The answer is host-side and not per-repo: nine repos cannot each be taught
 * this, and the tenth is written by an agent that has never read the other
 * nine. So a build's outputs are COLLECTED into `.claude/outbox/` under a name
 * that carries a version, older builds of the same artifact are pruned, and
 * duplicates are folded — by default, for every build, in every repo, unless
 * this project's policy says otherwise.
 *
 * This module is the rules half: pure, node-tested, and shared so the phone can
 * word the switches with the same vocabulary the host acts on. The disk half is
 * `host/artifacts.ts`.
 */

/**
 * What a repo does with what its builds produce. Stored per repo in
 * `<repoDir>/.waterplane/artifacts.json` — next to `builds.json` and
 * `autopull.json`, and for the same reason those live there: how a project
 * names and keeps its deliverables is a property of the project, not of the
 * desktop or of the phone that tapped the button.
 */
export interface ArtifactPolicy {
  /** Copy a build's outputs into `.claude/outbox/` under a versioned name. */
  collect: boolean;
  /** After collecting, delete older builds of the same artifact from the outbox. */
  prune: boolean;
  /** How many builds of one artifact survive a prune (the newest ones). */
  keep: number;
}

/**
 * On, on, and three.
 *
 * Both switches default ON because the failure they fix is invisible: nobody
 * reports a file called `app-debug.apk` or a 130 MB copy nobody removed, they
 * just live with them. `keep: 3` is the smallest number that still answers
 * "does the previous build work?" — the question an unnamed APK made
 * unanswerable in the first place.
 */
export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = { collect: true, prune: true, keep: 3 };

/** Hard ceiling on `keep`: past this the switch is not "tidy up" any more. */
export const MAX_ARTIFACT_KEEP = 50;

/** Sanitize a persisted/phone-supplied policy — this file is hand-editable and
 *  an agent writes the one beside it. An unreadable field falls back to the
 *  DEFAULT rather than to `false`: a policy nobody can parse must not silently
 *  turn the feature off. */
export function cleanArtifactPolicy(v: unknown): ArtifactPolicy {
  const raw = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const keep = Number(raw.keep);
  return {
    collect: raw.collect === undefined ? DEFAULT_ARTIFACT_POLICY.collect : !!raw.collect,
    prune: raw.prune === undefined ? DEFAULT_ARTIFACT_POLICY.prune : !!raw.prune,
    keep: Number.isFinite(keep) && keep >= 1 ? Math.min(Math.round(keep), MAX_ARTIFACT_KEEP) : DEFAULT_ARTIFACT_POLICY.keep,
  };
}

/** One line for a phone: what this repo will do with the next build's output. */
export function artifactPolicyText(p: ArtifactPolicy): string {
  if (!p.collect) return "builds are offered exactly where they land, under whatever name they have";
  return p.prune
    ? `collected into .claude/outbox with a versioned name · the newest ${p.keep} of each kept`
    : "collected into .claude/outbox with a versioned name · nothing is ever removed";
}

// ── Which artifact IS this ───────────────────────────────────────────────────

/**
 * Is this name token the VARIABLE part of an artifact name — the bit that
 * changes every time the same thing is produced again?
 *
 *  - all-digits (build number, epoch, `20260828`, a date component);
 *  - a hex run of 6+ that contains a digit (a commit/content hash). The digit is
 *    required so ordinary words that happen to be hex-only ("facade", "decade")
 *    stay STABLE — folding those out would merge unrelated artifacts;
 *  - a version (`v2`, `1.4.0` arrives pre-split as `1`, `4`, `0`).
 *
 * It only ever sees a token `NAME_SEP` produced, which is why that separator
 * set is part of this rule rather than a detail of it.
 */
export function isVariableToken(tok: string): boolean {
  if (/^\d+$/.test(tok)) return true;
  if (/^v\d+$/i.test(tok)) return true;
  return /^(?=.*\d)[0-9a-f]{6,}$/i.test(tok);
}

/**
 * The separators an artifact name is built from.
 *
 * `+` and `~` are SEPARATORS, not letters. They are how the two commonest
 * machine-written version strings attach a build to a release —
 * `picture-app-1.1.0+343.apk` (semver build metadata, which is what Flutter,
 * pub and Gradle's `versionName+versionCode` produce) and `app-1.1.0~rc1.apk`
 * (the Debian spelling). Splitting on `[-_. ]` alone left the last version
 * digit fused to the build number as one token, `0+343`, which is neither all
 * digits nor hex and therefore read as a STABLE WORD: every build of that app
 * was its own family, nothing ever superseded anything, and the phone fetched
 * 130 MB again per build and kept the previous one queued beside it. The
 * artifacts whose names carry a version are exactly the ones these rules exist
 * for, so a separator they do not know about defeats them precisely where it
 * matters most.
 */
export const NAME_SEP = /[-_. +~]+/;

/**
 * The supersede key: "which artifact IS this", independent of which BUILD of it.
 *
 * `tiptoi-debug-0f98c1ab.apk` and `tiptoi-debug-39a2f7e1.apk` are the same thing
 * twice — queueing both means the phone spends 46 MB of a roaming link to end up
 * with one file it wants and one it doesn't. `app-debug.apk` and
 * `app-release.apk` are NOT the same thing, so only the tokens that actually
 * vary are folded out; every stable word is kept, which is what stops a rule
 * this aggressive from eating a sibling artifact.
 *
 * The directory and extension are part of the key for the same reason. When
 * EVERY token is variable (`1000074170.jpg`) there is no name left to compare,
 * so the key falls back to the exact path: a regeneration at the same path still
 * supersedes (that is the common build-overwrites-its-output case), and two
 * differently-named photos never do.
 *
 * Lives here rather than beside the download queue that first needed it,
 * because the prune below asks the SAME question — "is this an older build of
 * the thing I just made?" — and two answers to it would mean the phone
 * de-duplicating one way while the desktop deletes another.
 */
export function familyKey(relPath: string): string {
  const path = relPath.replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  // `_2` is what files.ts appends to keep a name unique — the same artifact, not
  // another one.
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/_\d+$/, "");
  const stable = stem.split(NAME_SEP).filter((t) => t && !isVariableToken(t));
  if (!stable.length) return `${dir}${base.toLowerCase()}`;
  return `${dir}${stable.join("-").toLowerCase()}${ext}`;
}

// ── What a collected artifact is called ──────────────────────────────────────

/** Does this stem already say WHICH build it is? A name with a variable token
 *  in it has a version, a date or a hash in it already, and renaming it would
 *  only make it longer and less like what the build printed. */
export function hasVersionToken(stem: string): boolean {
  return stem.split(NAME_SEP).some((t) => t && isVariableToken(t));
}

/** `MMDD-HHMM` in local time — the fallback identifier when a repo has neither a
 *  version nor a git sha to offer. Local, not UTC: it is read beside a build row
 *  that is already showing a local clock. */
export function stampOf(when: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
}

/** Everything a name can be built from. Every field but `stem`/`ext` is
 *  optional, and a missing one is simply not said — a name is never padded with
 *  "unknown". */
export interface ArtifactNaming {
  /** The repo's directory name — what a person calls the project. */
  repoName: string;
  /** The produced file's name without its extension (`app-debug`). */
  stem: string;
  /** Extension WITH the dot, lower-cased (`.apk`). */
  ext: string;
  /** The project's own version, if one could be read (`1.1.0+344`, `2.3`). */
  version?: string;
  /** Short git sha of the commit built, `-dirty` already appended if it was. */
  sha?: string;
  /** When the build finished. */
  when: Date;
}

/** Only what a filename may hold, with the separators this module splits on
 *  preserved. Anything else becomes a `-`, and runs collapse. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9.+~_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * The name a collected artifact gets.
 *
 * Three rules, in this order:
 *
 *  1. **A name that already says which build it is, is kept.** Flutter's
 *     `picture-app-debug-v1.1.0-344.apk` and a timestamped
 *     `fp-functions-bundle-20260922-1042.tgz` are better than anything this
 *     function would invent, and renaming them would break the link between
 *     what the build printed and what arrived on the phone.
 *  2. **The repo's name leads.** `app-debug.apk` exists in three repos here;
 *     the download list is one list.
 *  3. **Then the variant, then the version.** `app` and the repo's own name are
 *     dropped from the variant — `picture-app` + `app-debug` reads
 *     `picture-app-debug`, not `picture-app-app-debug`. The version is the
 *     project's if one could be read, else the git sha, else the date; a repo
 *     that can offer both gets both, because a version answers "which release"
 *     and a sha answers "which code".
 */
export function artifactName(n: ArtifactNaming): string {
  const ext = n.ext.toLowerCase();
  const stem = slug(n.stem);
  if (hasVersionToken(stem)) {
    // Rule 1. The repo name is still prefixed when the stem does not carry it,
    // because "which app" is the half a version can never supply.
    const repo = slug(n.repoName);
    const has = stem.toLowerCase().startsWith(repo.toLowerCase());
    return `${has ? stem : `${repo}-${stem}`}${ext}`;
  }
  const repoTokens = new Set(slug(n.repoName).split(NAME_SEP).filter(Boolean).map((t) => t.toLowerCase()));
  const variant = stem.split(NAME_SEP)
    .filter(Boolean)
    .filter((t) => !repoTokens.has(t.toLowerCase()))
    // `app` is what a build system calls the module, never what a person calls
    // the app. `output`/`bundle` the same.
    .filter((t) => !["app", "output", "outputs"].includes(t.toLowerCase()));
  const version = n.version ? slug(n.version) : "";
  const sha = n.sha ? slug(n.sha) : "";
  const parts = [slug(n.repoName), ...variant, version, sha].filter(Boolean);
  // Neither a version nor a sha ⇒ the clock is the only identifier there is,
  // and a name with no identifier at all is the bug this function exists for.
  if (!version && !sha) parts.push(stampOf(n.when));
  return `${parts.join("-")}${ext}`;
}

// ── Which of a run's outputs are the same bytes under two names ──────────────

/** One candidate for folding: enough of a file to say whether two of them are
 *  the same artifact, and which name is worth keeping. */
export interface FoldCandidate {
  relPath: string;
  size: number;
  /** A cheap content fingerprint, supplied by the caller (`host/artifacts.ts`
   *  hashes the head and tail). Absent ⇒ never folded with anything: a fold
   *  this module cannot justify is one it must not make. */
  fingerprint?: string;
}

/** Is this path inside the transport dir a person's phone reads? */
export function inOutbox(relPath: string): boolean {
  return /^\.?(claude\/)?outbox\//.test(relPath.replace(/\\/g, "/"));
}

/**
 * Of two names for the same bytes, which one survives.
 *
 * Higher wins: already in the outbox (a script put it where a person looks),
 * then a name that says which build it is, then the longer name — `app-debug`
 * against `picture-app-debug-v1.1.0-344`, the second is the one somebody chose.
 */
function nameScore(c: FoldCandidate): number {
  const base = c.relPath.split("/").pop() ?? c.relPath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return (inOutbox(c.relPath) ? 100 : 0) + (hasVersionToken(stem) ? 10 : 0) + Math.min(stem.length / 100, 0.99);
}

/**
 * Fold a run's outputs down to the DISTINCT artifacts among them.
 *
 * One `flutter build apk` plus a script that copies the result to a friendlier
 * name is two detected files, 227 MB each, the same bytes — and the phone,
 * which fetches one download at a time, spends 454 MB on it. Identity is size
 * AND the caller's fingerprint, never size alone: two ABI splits of one app are
 * within bytes of each other and folding them would silently drop a release.
 *
 * Returns the survivors in the input's order, plus what each of them absorbed,
 * so the build log can SAY it rather than a file quietly not appearing.
 */
export function foldDuplicates<T extends FoldCandidate>(files: T[]): { kept: T[]; folded: { kept: T; dropped: T[] }[] } {
  const groups = new Map<string, T[]>();
  const singles: T[] = [];
  for (const f of files) {
    if (!f.fingerprint) { singles.push(f); continue; }
    const key = `${f.size}:${f.fingerprint}`;
    const g = groups.get(key);
    if (g) g.push(f); else groups.set(key, [f]);
  }
  const winners = new Set<T>();
  const folded: { kept: T; dropped: T[] }[] = [];
  for (const g of groups.values()) {
    const best = g.reduce((a, b) => (nameScore(b) > nameScore(a) ? b : a));
    winners.add(best);
    if (g.length > 1) folded.push({ kept: best, dropped: g.filter((f) => f !== best) });
  }
  for (const s of singles) winners.add(s);
  return { kept: files.filter((f) => winners.has(f)), folded };
}

// ── What a prune removes ─────────────────────────────────────────────────────

/** A file the prune may consider: an outbox entry with a clock on it. */
export interface PruneCandidate {
  relPath: string;
  mtime: number;
}

/**
 * Which older builds a finished run makes removable.
 *
 * Deliberately narrow, and narrower than the sweep: only files whose
 * `familyKey` matches something this run just produced, only the ones older
 * than the newest `keep` of that family, and never the artifacts of the run
 * itself. A build cleans up after ITSELF — it never touches a family it did not
 * just rebuild, which is what keeps "delete files automatically" from being the
 * thing that removes the one APK you were about to install.
 *
 * `protect` is the run's own output (paths, not families): equal mtimes are
 * routine when a build writes two files in one second, and an artifact this run
 * produced must never be a victim of the same run's prune.
 */
export function pruneVictims(files: PruneCandidate[], produced: string[], keep: number, protect: string[] = produced): PruneCandidate[] {
  const families = new Set(produced.map(familyKey));
  const safe = new Set(protect);
  const byFamily = new Map<string, PruneCandidate[]>();
  for (const f of files) {
    const k = familyKey(f.relPath);
    if (!families.has(k)) continue;
    const g = byFamily.get(k);
    if (g) g.push(f); else byFamily.set(k, [f]);
  }
  const out: PruneCandidate[] = [];
  for (const g of byFamily.values()) {
    g.sort((a, b) => b.mtime - a.mtime);
    for (const f of g.slice(Math.max(1, keep))) if (!safe.has(f.relPath)) out.push(f);
  }
  return out;
}
