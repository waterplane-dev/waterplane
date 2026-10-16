/** Git/filesystem scaffolding: new folder, new repo, new worktree. */
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";


// `realResolve` and `inRoot` now live in `paths.ts`, beside the lexical
// `contained()` they are deliberately different from. Re-exported so the
// callers that have always imported them from here are unchanged.
export { inRoot, realResolve } from "./paths.js";
import { inRoot } from "./paths.js";
import { BRAND } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";

function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function newFolder(root: string, parent: string, name: string): Promise<{ path: string } | { error: string }> {
  const safe = slug(name);
  if (!safe) return { error: "invalid name" };
  const target = inRoot(root, join(parent || root, safe));
  if (!target) return { error: "path escapes root" };
  if (existsSync(target)) return { error: "already exists" };
  mkdirSync(target, { recursive: true });
  return { path: target };
}

const DEFAULT_BRANCH = "main";

export interface NewRepoOpts {
  /**
   * Seed the waterplane working conventions (gitignore, README, CLAUDE.md, the
   * inbox/outbox drops). Default true — a repo created FROM the phone is by
   * definition going to be driven from the phone. Pass false for a bare
   * `git init` (the old behaviour).
   */
  setup?: boolean;
  /** One-line description; goes into the seeded README/CLAUDE.md. */
  description?: string;
  /**
   * Seed a runnable starter from `packages/host/templates/<template>/` instead of
   * the bare conventions (first-app plan, WP1). The name must then be usable as an
   * app id (see `templateName`). An unknown template is an error, never a path.
   */
  template?: TemplateId;
}

export const TEMPLATES = ["android-hello", "web-hello"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

/** Where the templates ship: beside `src/` and `dist/`, so one relative hop serves both. */
const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const RESERVED_SEGMENTS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue",
  "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if",
  "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private",
  "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
  "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null",
  "in", "is", "as", "fun", "val", "var", "object",
]);

/**
 * A name a template can be built around: starts with a letter, lower-case letters,
 * digits and single hyphens, at most 40. Lower-cased rather than refused (a phone's
 * keyboard capitalises the first letter). Anything else is an error in words —
 * the name becomes a folder AND an Android package segment, so it is not repaired.
 */
export function templateName(raw: string): { name: string } | { error: string } {
  const name = slug(raw).toLowerCase();
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length > 40) {
    return { error: "app name: use letters, digits and hyphens, starting with a letter (40 characters at most)" };
  }
  return { name };
}

/** `dev.<brand>.app.<name>` with the hyphens dropped (a package segment has none). */
export function packageId(name: string): string {
  let seg = name.replace(/-/g, "");
  if (RESERVED_SEGMENTS.has(seg)) seg += "app";
  return `dev.${BRAND.slug}.app.${seg}`;
}

function titleCase(name: string): string {
  return name.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** Copied byte-for-byte, never substituted. */
const BINARY_EXT = new Set([".jar", ".png", ".webp", ".jpg", ".ico"]);

/**
 * Copy a template tree into `dir`, replacing `{{name}}` `{{label}}` `{{package}}`
 * `{{description}}` `{{state}}` `{{shared}}` in text files and `__PKGPATH__` in paths. `_gitignore` is
 * stored under that name because npm never publishes a `.gitignore`; `_state/` becomes
 * the brand's (gitignored) state dir and `_shared/` its committed config dir, which the
 * initial commit picks up. Never overwrites. Returns the repo-relative paths written.
 */
function copyTemplate(id: TemplateId, dir: string, vars: Record<string, string>): string[] {
  const src = join(TEMPLATE_ROOT, id);
  const written: string[] = [];
  const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  const walk = (rel: string) => {
    for (const ent of readdirSync(join(src, rel), { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const from = join(rel, ent.name);
      if (ent.isDirectory()) { walk(from); continue; }
      let out = from.split(sep).map((seg, i) => (i === 0 && seg === "_state" ? BRAND.stateDirName : i === 0 && seg === "_shared" ? BRAND.sharedDirName : seg))
        .join(sep).replace("__PKGPATH__", vars.package.split(".").join(sep));
      if (out === "_gitignore") out = ".gitignore";
      const to = join(dir, out);
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      const ext = ent.name.slice(ent.name.lastIndexOf(".")).toLowerCase();
      if (BINARY_EXT.has(ext)) copyFileSync(join(src, from), to);
      else writeFileSync(to, sub(readFileSync(join(src, from), "utf8")));
      const mode = statSync(join(src, from)).mode & 0o777;
      if (mode & 0o111) chmodSync(to, mode);
      written.push(out.split(sep).join("/"));
    }
  };
  walk("");
  return written;
}

export interface NewRepoResult {
  path: string;
  branch: string;
  /** Repo-relative paths written by the scaffold (empty when `waterplane: false`). */
  files: string[];
  /** Non-fatal problem worth showing (e.g. no git identity configured). */
  warning?: string;
}

/**
 * A repo created from the phone starts life ready for the phone: the paths the
 * daemon and the agent both rely on (`.claude/outbox`, `.claude/inbox`,
 * `.waterplane`) exist and are ignored, and CLAUDE.md tells the agent that dropping
 * a file into the outbox is how you show something to a human holding a phone.
 * Without this every new project starts with an agent printing 200 lines of
 * terminal output nobody can read on a 6" screen.
 */
export async function newRepo(
  root: string,
  parent: string,
  name: string,
  opts: NewRepoOpts = {},
): Promise<NewRepoResult | { error: string }> {
  let folderName = name;
  if (opts.template !== undefined) {
    if (!(TEMPLATES as readonly string[]).includes(opts.template)) return { error: "unknown template" };
    const n = templateName(name);
    if ("error" in n) return n;
    folderName = n.name;
  }
  const made = await newFolder(root, parent, folderName);
  if ("error" in made) return made;
  const dir = made.path;
  try {
    // `-b` needs git ≥ 2.28; older git reaches the same state via symbolic-ref,
    // which is legal while the repo has no commits.
    await pexec("git", ["init", "-b", DEFAULT_BRANCH], { cwd: dir }).catch(async () => {
      await pexec("git", ["init"], { cwd: dir });
      await pexec("git", ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`], { cwd: dir }).catch(() => {});
    });
  } catch (err) {
    return { error: `git init failed: ${String(err)}` };
  }

  const projectName = dir.split(sep).pop() || slug(name);
  let files: string[];
  if (opts.template !== undefined) {
    const desc = (opts.description || "").trim();
    const vars = {
      name: projectName,
      label: titleCase(projectName),
      package: packageId(projectName),
      description: desc || "TODO: what this is.",
      state: BRAND.stateDirName,
      shared: BRAND.sharedDirName,
    };
    files = copyTemplate(opts.template, dir, vars);
    // The transport dirs exist even though the template wrote nothing into them.
    for (const d of [".claude/inbox", ".claude/outbox"]) mkdirSync(join(dir, d), { recursive: true });
    if (!existsSync(join(dir, "README.md"))) {
      writeFileSync(join(dir, "README.md"), `# ${projectName}\n\n${vars.description}\n`);
      files.push("README.md");
    }
  } else {
    files = opts.setup === false ? [] : seedProject(dir, projectName, opts.description);
  }
  // An initial commit (empty if nothing was seeded) so `git worktree add` — and
  // therefore backlog parallel mode — works immediately.
  const warning = await firstCommit(dir, files.length ? "Initial project scaffold" : "init");
  const branch = await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })
    .then((r) => r.stdout.trim())
    .catch(() => DEFAULT_BRANCH);
  return { path: dir, branch, files, ...(warning ? { warning } : {}) };
}

/**
 * Commit whatever is in the tree. A fresh machine often has no `user.email`
 * configured, which fails the commit and leaves the repo without the HEAD
 * `git worktree add` needs — so fall back to a placeholder identity and say so
 * rather than silently shipping a repo that can't spawn worktrees.
 */
async function firstCommit(dir: string, message: string): Promise<string | undefined> {
  await pexec("git", ["add", "-A"], { cwd: dir }).catch(() => {});
  const commit = ["commit", "--allow-empty", "-m", message, "--no-gpg-sign"];
  try {
    await pexec("git", commit, { cwd: dir });
    return undefined;
  } catch { /* most likely: no committer identity */ }
  try {
    await pexec("git", ["-c", `user.name=${BRAND.name}`, "-c", `user.email=${BRAND.name}@localhost`, ...commit], { cwd: dir });
    return "initial commit used a placeholder identity — set git user.name / user.email";
  } catch (err) {
    return `initial commit failed: ${String(err)}`;
  }
}

/** Write the starter files + working dirs. Never overwrites an existing file. */
function seedProject(dir: string, projectName: string, description?: string): string[] {
  const desc = (description || "").trim();
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(dir, rel);
    if (existsSync(p)) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    written.push(rel);
  };

  // The phone↔repo drops and the per-repo state dir. Created up front so the
  // gallery's outbox tab and the build/backlog config have somewhere to land.
  for (const d of [".claude/inbox", ".claude/outbox", BRAND.stateDirName]) mkdirSync(join(dir, d), { recursive: true });

  put(".gitignore", GITIGNORE);
  put("README.md", `# ${projectName}\n\n${desc || "TODO: what this is."}\n`);
  put("CLAUDE.md", claudeMd(projectName, desc));
  return written;
}

const GITIGNORE = `node_modules/
dist/
build/
*.log
.DS_Store
.env
.env.local

# ${BRAND.name}: per-repo daemon state + the phone↔repo file drops.
${BRAND.stateDirName}/
.claude/inbox/
.claude/outbox/
.claude/settings.local.json
`;

function claudeMd(projectName: string, desc: string): string {
  return `# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in **${projectName}**.

## What this is

${desc || "TODO: one paragraph — what this project is and the one design choice that explains the rest."}

## Commands

TODO: build / run / test, one line each.

## Working from a phone (${BRAND.name})

This repo is driven remotely from a phone, so three paths are load-bearing:

- **\`.claude/outbox/\`** — put anything a human should LOOK at here: screenshots,
  reports, diffs, build artifacts. It is the only place the phone gallery's
  "outbox" tab scans, and a new file there notifies the phone with a download
  link. Prefer writing a file over printing a wall of terminal output — long
  output is unreadable on a phone.
  **A build artifact is the exception: don't copy one here by hand.** ${BRAND.name}
  collects what a build produced into this directory itself, under a name
  carrying the repo, the variant and the project's own version, and removes
  older builds of the same artifact. A copy made by hand gets neither — it is
  a second copy under a second name that nothing will ever prune, which is how
  one repo here came to hold 33 APKs and 4.5 GB.
- **\`.claude/inbox/\`** — images uploaded from the phone land here; prompts
  reference them by path.
- **\`${BRAND.stateDirName}/\`** — per-repo state (backlog items, stars/pins, build
  commands true of this desktop only), written by the daemon. Don't hand-edit.

All three are gitignored. **\`${BRAND.sharedDirName}/\`** is not: its \`builds.json\` holds the
phone's build buttons and is committed, so every checkout gets them.
`;
}

export async function newWorktree(
  root: string,
  repoDir: string,
  branch: string,
  basePath?: string,
): Promise<{ path: string; branch: string } | { error: string }> {
  const b = slug(branch);
  if (!b) return { error: "invalid branch" };
  // Default sibling location: <repo>/../<repo>-worktrees/<branch>
  const want = basePath
    ? resolve(basePath)
    : resolve(repoDir, "..", `${join(repoDir).split(sep).pop()}-worktrees`, b);
  // Same containment rule as newFolder/newRepo. `basePath` comes straight off
  // the request body, so without this a caller could plant a worktree — and a
  // checkout of the repo's contents — anywhere the daemon can write.
  const wtPath = inRoot(root, want);
  if (!wtPath) return { error: "path escapes root" };
  // Idempotent: a worktree at this path already exists (e.g. a re-fired backlog
  // item, or a prior run whose path wasn't recorded) → reuse it, don't error.
  if (existsSync(wtPath)) return { path: wtPath, branch: b };
  mkdirSync(resolve(wtPath, ".."), { recursive: true });
  try {
    // -b creates the branch; fall back to attaching an existing branch.
    await pexec("git", ["worktree", "add", "-b", b, wtPath], { cwd: repoDir }).catch(async () => {
      await pexec("git", ["worktree", "add", wtPath, b], { cwd: repoDir });
    });
    return { path: wtPath, branch: b };
  } catch (err) {
    return { error: `git worktree add failed: ${String(err)}` };
  }
}

// ── Clone ────────────────────────────────────────────────────────────────

/**
 * A remote the phone may ask this desktop to clone, or why not. The URL is typed
 * on a phone and handed to `git`, so it is held to the three shapes a person
 * actually pastes — `https://`, `ssh://` and scp-like `user@host:path` — and
 * everything git would ALSO accept is refused: `ext::` (runs a command),
 * `file://` and bare local paths (reads outside the root), `http://` (cleartext),
 * a leading `-` (an option, not a URL). `cloneRepo` backs this with
 * `protocol.allow=never`, so a shape that slips past here still cannot reach a
 * transport git was not told to allow.
 */
export function cloneUrl(raw: string): { url: string; name: string } | { error: string } {
  const url = String(raw || "").trim();
  if (!url) return { error: "no URL" };
  if (url.length > 2048) return { error: "URL too long" };
  if (/[\s\x00-\x1f\x7f]/.test(url)) return { error: "URL contains spaces or control characters" };
  if (url.startsWith("-")) return { error: "not a URL" };
  if (url.includes("::")) return { error: "only https://, ssh:// or git@host:path URLs" };
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s !== "https" && s !== "ssh") {
      return { error: s === "http" ? "http:// is cleartext — use the https:// URL" : `${s}:// is not allowed — only https:// or ssh://` };
    }
    let u: URL;
    try { u = new URL(url); } catch { return { error: "not a valid URL" }; }
    if (!u.hostname || u.hostname.startsWith("-")) return { error: "URL has no usable host" };
    path = u.pathname;
  } else {
    // scp-like: [user@]host:path — git's own rule is "a colon before any slash".
    const m = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/\/)(.+)$/.exec(url);
    if (!m || !m[1]) return { error: "only https://, ssh:// or git@host:path URLs" };
    path = m[2];
  }
  const last = path.replace(/\/+$/, "").split("/").pop() || "";
  const name = slug(last.replace(/\.git$/i, ""));
  if (!name || name === "." || name === "..") return { error: "cannot tell a folder name from this URL — name it" };
  return { url, name };
}

export interface CloneResult {
  path: string;
  branch: string;
  /** Non-fatal problem worth showing. */
  warning?: string;
}

/** How long a clone may run before it is killed. A phone is waiting on the answer. */
const CLONE_TIMEOUT_MS = 15 * 60_000;

/** `git clone` runner — injectable so the argv and refusals are testable without a network. */
export type CloneRun = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<unknown>;
const runGit: CloneRun = (args, opts) => pexec("git", args, { ...opts, maxBuffer: 8 * 1024 * 1024 });

/**
 * Clone a remote into a new folder under `parent` (inside `root`) — the "I have no
 * repo for this yet" start. Same containment as `newRepo`: the folder is named by
 * `name` or the URL's last segment, must resolve inside the root, and must not
 * exist. Nothing is fetched beyond the default branch's checkout (no submodules),
 * nothing prompts (no terminal on a phone: a credential or host-key question is a
 * failure in words), and the cloned project is never edited — the phone's
 * transport dirs are excluded through `.git/info/exclude`, which is local to this
 * checkout, so the clone has no diff the person did not make.
 */
export async function cloneRepo(
  root: string,
  parent: string,
  rawUrl: string,
  name?: string,
  run: CloneRun = runGit,
): Promise<CloneResult | { error: string }> {
  const u = cloneUrl(rawUrl);
  if ("error" in u) return u;
  const folder = slug(name || "") || u.name;
  const target = inRoot(root, join(parent || root, folder));
  if (!target) return { error: "path escapes root" };
  if (existsSync(target)) return { error: `${folder} already exists — name the folder` };
  const cwd = dirname(target);
  if (!existsSync(cwd)) return { error: "parent folder does not exist" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // A person's own ssh command wins; otherwise never stop to ask about a host key or passphrase.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
  const args = [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    "clone", "--no-recurse-submodules", "--", u.url, target,
  ];
  try {
    await run(args, { cwd, env, timeout: CLONE_TIMEOUT_MS });
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message?: string };
    if (e.killed) return { error: "clone took longer than 15 minutes and was stopped" };
    const said = String(e.stderr || e.message || err).trim().split("\n").filter((l) => !/^Cloning into/.test(l)).slice(-3).join(" ");
    return { error: `git clone failed: ${said || "no reason given"}` };
  }
  let warning: string | undefined;
  try {
    for (const d of [".claude/inbox", ".claude/outbox"]) mkdirSync(join(target, d), { recursive: true });
    const exclude = join(target, ".git", "info", "exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    const have = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const want = [".claude/inbox/", ".claude/outbox/", `${BRAND.stateDirName}/`].filter((l) => !have.split("\n").includes(l));
    if (want.length) {
      appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}# ${BRAND.name}: the phone↔repo drops, local to this clone\n${want.join("\n")}\n`);
    }
  } catch (err) {
    warning = `cloned, but the phone's inbox/outbox were not set up: ${String(err)}`;
  }
  const branch = await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target })
    .then((r) => r.stdout.trim())
    .catch(() => "");
  return { path: target, branch, ...(warning ? { warning } : {}) };
}
