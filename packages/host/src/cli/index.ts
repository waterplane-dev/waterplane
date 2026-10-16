/**
 * The command-line entry a release ships (`bin/<slug>.mjs` → here).
 *
 * `start` and `doctor` run `main.js` IN THIS PROCESS, so launchd/systemd
 * supervise the daemon itself, not a wrapper. `service` and `update` are
 * written by other packages and loaded lazily: a build without them says so
 * in one line instead of failing to start.
 *
 * Dev checkouts keep `npm run start/doctor/restart`; those never come here. On win32 every
 * command goes to `windows.ts`, which runs the host inside WSL.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND, nodeMeetsMin, nodeTooOldSentence } from "@waterplane/shared";

// import.meta.dirname is undefined before Node 20.11 (and the host needs 20.12, NODE_MIN): refuse in words, not a TypeError.
if (!nodeMeetsMin(process.versions.node)) {
  console.error(`[${BRAND.slug}] ${nodeTooOldSentence(process.versions.node)}`);
  process.exit(1);
}

/** `packages/host/dist/cli` → the release root (or the checkout root). */
const ROOT_DIR = resolve(import.meta.dirname, "../../../..");
const MAIN_JS = resolve(import.meta.dirname, "../main.js");

interface Identity { name: string; version: string; commit: string | null; source: "release.json" | "checkout" }

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** `<40 hex>` or `<40 hex>-dirty` → ten characters, the suffix kept. */
const shortCommit = (c: string | null): string | null => (c ? c.replace(/^([0-9a-f]{10})[0-9a-f]*/, "$1") : null);

/** What this install is: `release.json` when present, else a dev checkout's package.json + git. */
export function identity(root: string = ROOT_DIR): Identity {
  const rel = readJson(join(root, "release.json"));
  if (rel) {
    return { name: str(rel.name) ?? BRAND.slug, version: str(rel.version) ?? "unknown", commit: shortCommit(str(rel.commit)), source: "release.json" };
  }
  const pkg = readJson(join(root, "package.json"));
  let commit: string | null = null;
  if (existsSync(join(root, ".git"))) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch { /* no git on PATH: the commit stays absent */ }
  }
  return { name: str(pkg?.name) ?? BRAND.slug, version: str(pkg?.version) ?? "unknown", commit, source: "checkout" };
}

/** The one line `version` prints, on every platform (the Windows launcher prints it too). */
export function versionLine(root: string = ROOT_DIR): string {
  const id = identity(root);
  return `${id.name} ${id.version}${id.commit ? ` (${id.commit})` : ""}${id.source === "checkout" ? " [dev checkout]" : ""}`;
}

const HELP = `${BRAND.slug} — ${BRAND.tagline}

usage: ${BRAND.slug} <command>

  start                       run the host in the foreground (default)
  doctor [--json]             preflight checks, then exit (1 on a failure);
                              --json: one JSON document on stdout, for scripts and agents
  version                     name, version and commit of this install
  service install|uninstall|status
                              register the host with launchd / systemd
  update [--check|--rollback|--restore-state]
                              check for, apply, or undo a newer release (with its state)
  pair [--port N] [--json]    mint a pairing code on this desktop's running host and
                              print the link and code to add it from a phone
  help                        this text
`;

/** Run main.js in this process. Never resolves: the daemon ends the process itself. */
async function runDaemon(extra: string[]): Promise<number> {
  // `env.ts`'s isDaemonEntry looks at argv[1]; this process IS the daemon.
  process.argv = [process.argv[0] ?? "node", MAIN_JS, ...extra];
  await import(MAIN_JS);
  return await new Promise<number>(() => { /* the daemon owns the process now */ });
}

/** A sibling module another package writes; its absence is a sentence, not a crash. */
async function lazy(file: string, what: string, args: string[]): Promise<number> {
  const unavailable = (): number => { console.error(`${BRAND.slug}: the ${what} command is not available in this build.`); return 1; };
  let m: { run?: (a: string[]) => Promise<number> };
  try { m = (await import(file)) as typeof m; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return unavailable();
    console.error(`${BRAND.slug}: the ${what} command failed to load: ${String(e)}`);
    return 1;
  }
  return typeof m.run === "function" ? m.run(args) : unavailable();
}

export async function main(argv: string[]): Promise<number> {
  // Native Windows cannot run the host (sessions need tmux): every command goes to the launcher,
  // which runs it inside WSL from this same install (`windows.ts`).
  if (process.platform === "win32") return (await import("./windows.js")).run(argv);
  const [cmd = "start", ...rest] = argv;
  switch (cmd) {
    case "start": return runDaemon([]);
    case "doctor": return runDaemon(["--doctor", ...rest.filter((a) => a === "--json")]);
    case "version": case "--version": case "-v": console.log(versionLine()); return 0;
    case "service": return lazy("./service.js", "service", rest);
    case "pair": return lazy("./pair.js", "pair", rest);
    case "update": return lazy("./selfupdate.js", "update", rest);
    case "help": case "--help": case "-h": console.log(HELP); return 0;
    default:
      console.error(`${BRAND.slug}: unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}
